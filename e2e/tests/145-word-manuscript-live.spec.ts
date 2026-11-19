import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type {
  JournalCheck,
  JournalProject,
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { DocxFormatSnapshotV1 } from "../../src/lib/docx-format-types";
import { runWordManuscriptTakeover } from "../helpers/word-manuscript-takeover";
import { test, expect } from "../fixtures";
import {
  allActivities,
  activitiesPage,
  cancelIfRunning,
  collectModelReadReceipt,
  CONTROLLED_FORMAT_KINDS,
  finalSavedMutation,
  journalRequest,
  live,
  loadTask,
  MODEL,
  MODEL_EFFORT,
  prepareWordManuscriptFixture,
  PROVIDER,
  readHashes,
  readWorldProject,
  retireAndReadSource,
  runJournalCheck,
  sha256,
  TASK_LIMIT_MINUTES,
  transcript,
  verifyWordManuscriptInitialExport,
  verifyWordManuscriptRepair,
  waitForTask,
  writeJson,
  type Page,
  type WordManuscriptSourceHashes,
} from "../helpers/word-manuscript-live";
import {
  readManuscriptOracle,
  type ControlledManuscript,
} from "../helpers/word-manuscript-oracle";
import {
  createBlankProject,
  openRailTab,
  waitLong,
} from "../helpers";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_WORD_MANUSCRIPT_LIVE === "1";
const relay = process.env.OLEAFLY_DOCX_LIVE_URL;
const run =
  process.env.OLEAFLY_WORD_MANUSCRIPT_RUN
  ?? process.env.OLEAFLY_DOCX_LIVE_RUN
  ?? process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const templatePath =
  process.env.OLEAFLY_NATIVE_TEMPLATE_DOC
  ?? process.env.OLEAFLY_JOURNAL_TEMPLATE;
const englishPath = process.env.OLEAFLY_NATIVE_DOCX_EN;
const chinesePath = process.env.OLEAFLY_NATIVE_DOCX_ZH;
const expectedInputs = {
  template:
    process.env.OLEAFLY_JOURNAL_TEMPLATE_SHA256
    ?? process.env.OLEAFLY_NATIVE_TEMPLATE_DOC_SHA256,
  english: process.env.OLEAFLY_NATIVE_DOCX_EN_SHA256,
  chinese: process.env.OLEAFLY_NATIVE_DOCX_ZH_SHA256,
};

interface TemplateSource {
  worldVersionId: string;
  sourceSha256: string;
  bytes: Uint8Array;
}

interface EditorialMarker {
  text: string;
  paragraphIndex: number;
  originalText: string;
  markedText: string;
}

interface ControlledTarget {
  id: string;
  kind: "paragraph" | "table-cell" | "section";
  location: {
    text?: string;
    paragraphIndex?: number;
    tableIndex?: number;
    sectionIndex?: number;
  };
}

function controlMarker(control: unknown): EditorialMarker {
  const marker = (
    control !== null
    && typeof control === "object"
    && "editorialMarker" in control
  )
    ? (control as { editorialMarker?: Partial<EditorialMarker> }).editorialMarker
    : undefined;
  if (
    !marker
    || typeof marker.text !== "string"
    || typeof marker.paragraphIndex !== "number"
    || typeof marker.originalText !== "string"
    || typeof marker.markedText !== "string"
  ) {
    throw new Error("The controlled manuscript has no editorialMarker receipt.");
  }
  return marker as EditorialMarker;
}

function operationActivities(
  activities: Awaited<ReturnType<typeof allActivities>>["activities"],
) {
  return activities.flatMap(({ activity }) => {
    if (
      activity.event.type !== "runtime"
      || activity.event.event.kind !== "operation"
    ) {
      return [];
    }
    return [{
      activity,
      operation: activity.event.event.operation,
      result: activity.event.event.result,
      operationId: activity.event.event.operationId,
    }];
  });
}

function targetPromptIdentities(control: unknown) {
  const targets = (
    control !== null
    && typeof control === "object"
    && "targets" in control
    && Array.isArray((control as { targets?: unknown }).targets)
  )
    ? (control as { targets: ControlledTarget[] }).targets
    : [];
  const byId = new Map(targets.map((target) => [target.id, target]));
  const paragraphIds = [
    "title",
    "abstract",
    "body-middle",
    "references-tail",
  ] as const;
  const paragraphs = paragraphIds.map((id) => {
    const target = byId.get(id);
    if (
      !target
      || target.kind !== "paragraph"
      || typeof target.location.text !== "string"
    ) {
      throw new Error(`Controlled paragraph target ${id} is missing its text identity.`);
    }
    return `- ${id}: ${JSON.stringify(target.location.text)}`;
  });
  const tableTargets = targets
    .filter((target) => target.kind === "table-cell")
    .sort((left, right) =>
      (left.location.tableIndex ?? -1) - (right.location.tableIndex ?? -1));
  if (
    tableTargets.length !== 3
    || tableTargets.some((target) =>
      target.location.tableIndex === undefined)
  ) {
    throw new Error("Controlled table targets need three explicit table identities.");
  }
  const tables = tableTargets.map((target) => {
    const tableIndex = target.location.tableIndex!;
    return `- table ${tableIndex + 1}: first cell`;
  });
  const section = targets.find(
    (target) => target.kind === "section" && target.location.sectionIndex === 0,
  );
  if (!section) {
    throw new Error("Controlled section target is missing section 1.");
  }
  return [
    ...paragraphs,
    ...tables,
    "- section 1: page size and margins only; preserve its column settings",
  ].join("\n");
}

async function configureProvider(page: Page) {
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      await api.setConfig({
        ...config,
        ai_custom_providers:[
          ...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}),
          {id:${scriptValue(PROVIDER)},name:'Word manuscript live relay',
           baseURL:${scriptValue(relay)},keyOptional:true}
        ],
        ai_provider_models:{
          ...config.ai_provider_models,
          [${scriptValue(PROVIDER)}]:[{
            id:${scriptValue(MODEL)},name:${scriptValue(MODEL)},enabled:true,source:'custom',
            metadata:{
              name:${scriptValue(MODEL)},toolCall:true,reasoning:true,
              reasoningOptions:[{type:'effort',values:[${scriptValue(MODEL_EFFORT)}]}]
            }
          }]
        }
      });
    })`,
  );
}

async function importTemplate(
  page: Page,
  bytes: Uint8Array,
  filename: string,
): Promise<JournalWorld> {
  return page.evaluate<JournalWorld>(
    `window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m =>
      m.importJournalTemplate(new File([
        Uint8Array.from(atob(${scriptValue(Buffer.from(bytes).toString("base64"))}),
          c => c.charCodeAt(0))
      ],${scriptValue(filename)}),{
        journal_id:${scriptValue(`word-manuscript-${randomUUID()}`)},
        journal_name:${scriptValue(`Whole manuscript ${Date.now()}`)},
        article_type:'research_article',stage:'initial_submission',language:'en'
      }))`,
  );
}

async function retainTemplateSource(page: Page, worldVersionId: string) {
  return page.evaluate<TemplateSource>(
    `window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m =>
      m.loadTemplateSource(${scriptValue(worldVersionId)}).then(source => ({
        worldVersionId:source.worldVersionId,
        sourceSha256:source.sourceSha256,
        bytes:Array.from(source.bytes)
      })))`,
  ).then(({ bytes, ...source }) => ({
    ...source,
    bytes: Uint8Array.from(bytes),
  }));
}

async function importManuscript(
  page: Page,
  bytes: Uint8Array,
  filename: string,
  projectName: string,
) {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await panel.getByText("Import DOCX", { exact: true }).click();
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  await expect(dialog).toBeVisible();
  await page.fill(
    '[role="dialog"][data-state="open"] input:not([type="file"])',
    projectName,
  );
  await page.setInputFiles(
    '[role="dialog"][data-state="open"] input[type="file"]',
    [{
      name: filename,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from(bytes),
    }],
  );
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0, {
    timeout: 180_000,
  });
}

async function waitForProject(page: Page, projectName: string) {
  let project: JournalProject | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    project = state.projects.find((item) => item.name === projectName);
    return Boolean(project);
  }, { timeout: 120_000 }).toBe(true);
  return project!;
}

async function selectProject(page: Page, projectId: string) {
  const panel = page.getByTestId("journal-checks-panel");
  const select = panel.locator("select").first();
  await expect(select).toBeEnabled({ timeout: 90_000 });
  await select.selectOption(projectId);
  await expect.poll(() => select.inputValue()).toBe(projectId);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
}

async function clickWorkspaceButton(page: Page, label: string) {
  await page.evaluate(
    `(() => {
      const root=document.querySelector('[data-testid="docx-workspace"]');
      const button=Array.from(root.querySelectorAll('button')).find(item =>
        item.textContent.trim()===${scriptValue(label)}
        || item.getAttribute('aria-label')===${scriptValue(label)}
      );
      if (!button || button.disabled) throw new Error('Unavailable workspace button '+${scriptValue(label)});
      button.click();
    })()`,
  );
}

async function openWorkingCopy(page: Page) {
  await page.getByTestId("journal-checks-panel")
    .getByText("Edit DOCX working copy", { exact: true })
    .click();
  await expect(page.getByTestId("docx-workspace")).toBeVisible({
    timeout: 120_000,
  });
  let current: DocxDocumentRead | undefined;
  await expect.poll(async () => {
    try {
      current = await live<DocxDocumentRead>(page);
      return current.document.dirty;
    } catch {
      return null;
    }
  }, { timeout: 120_000 }).toBe(false);
  return current!;
}

async function closeWorkingCopy(page: Page) {
  if (await page.getByTestId("docx-workspace").count()) {
    await clickWorkspaceButton(page, "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0, {
      timeout: 60_000,
    });
  }
}

async function exportWorkingCopy(page: Page, path: string) {
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(path)})`);
  await clickWorkspaceButton(page, "Download DOCX copy");
  await expect.poll(async () => {
    try {
      return (await readFile(path)).length;
    } catch {
      return 0;
    }
  }, { timeout: 60_000 }).toBeGreaterThan(0);
  return new Uint8Array(await readFile(path));
}

interface TaskExportDialogReceipt {
  taskId: string;
  path: string;
  callbackId: number;
  eventId: number;
  requests: { token: string; operationId?: string }[];
}

function tableSourceIdentity(world: JournalWorld, inventory: DocxFormatSnapshotV1) {
  const table = inventory.objects.find(item => item.kind === "table" && item.part === "/word/document.xml");
  expect(table, "The template needs its first table in document XML order").toBeDefined();
  const cell = inventory.objects.find(item => item.kind === "tc"
    && item.table_context?.table_object_id === table!.object_id
    && item.table_context.row_index === 0 && item.table_context.column_index === 0);
  expect(cell, "The template's first table needs its first cell").toBeDefined();
  const paragraph = inventory.objects.find(item => item.kind === "paragraph"
    && item.part === cell!.part && item.path.length > cell!.path.length
    && cell!.path.every((value, index) => value === item.path[index]));
  expect(paragraph?.text, "The selected template source cell must contain Symbol").toBe("Symbol");
  return {
    world_version_id: world.version_id,
    template_source_sha256: inventory.source_sha256,
    snapshot_source_id: world.template!.snapshot_source_id,
    kind: cell!.kind, part: cell!.part, object_id: cell!.object_id, path: cell!.path,
    table_object_id: table!.object_id, row_index: 0, column_index: 0,
    paragraph_object_id: paragraph!.object_id, text: paragraph!.text,
  };
}

async function clearTaskExportDialogs(page: Page) {
  return page.evaluate<TaskExportDialogReceipt | null>(`(async () => {
    const route = window.__wholeManuscriptTaskExportDialogs;
    if (!route) return null;
    route.active = false;
    delete window.__wholeManuscriptTaskExportDialogs;
    try {
      window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener('research-docx-request', route.eventId);
      await window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', {
        event:'research-docx-request', eventId:route.eventId
      });
    } finally {
      window.__TAURI_INTERNALS__.unregisterCallback(route.callbackId);
      if (window.__e2eFileDialogState?.nextSavePath === route.path) {
        delete window.__e2eFileDialogState.nextSavePath;
      }
    }
    return {taskId:route.taskId, path:route.path, callbackId:route.callbackId,
      eventId:route.eventId, requests:route.requests};
  })()`);
}

async function createLiveTask(
  page: Page,
  appProjectId: string,
  language: "en" | "zh",
  editorialMarker: string,
  controlled: ControlledManuscript,
  world: JournalWorld,
  tableSource: ReturnType<typeof tableSourceIdentity>,
  taskExportPath: string,
) {
  const languageName = language === "en" ? "English" : "Chinese";
  const targetIdentities = targetPromptIdentities(controlled);
  const worldVersionId = world.version_id;
  const prompt = `Work only on the bound live Word working copy for this ${languageName} manuscript.
Call prepare_docx_fonts once before editing and use its actual resolution status.
Read the complete manuscript with read_docx_document. Use limit 20 or less, then pass the returned next_query as the next call's arguments until next_query is null. Finish every text window and atom payload continuation. modelText supplies UTF-16 editing coordinates; displayText expands cached field results. A request does not count as a read; use successful results and retained per-paragraph text.
Read the selected template world ${JSON.stringify(worldVersionId)} with journal_read operation format, format_operation snapshot, detail effective, limit 50, covering both collection objects and collection style_definitions. Read offset 0 metadata first for each collection, then follow next_offset to null. Do not set json_limit initially: pages are already bounded; only when an actual json_fragment is returned, follow its continuation.arguments until continuation is null before advancing the collection. Decode shared refs using that page's snapshot.shared dictionaries; metadata_ref identifies its already-read first page. Effective views omit declared details and do not establish complete support; use full_read for targeted declarations when needed. Before editing, call read_docx_format with kind overview and the current live session revision as expected_revision, then make targeted reads for the supported non-body and format evidence you need.
Read every non-body paragraph with read_docx_format kind paragraphs and its exact part, including footnotes and endnotes even when their paragraphs are empty. Use limit 20 or less, pass the live session revision as expected_revision, continue nextOffset until null, and follow every textContinuation until null.
Apply supported, determinate formatting to exactly these eight selected target identities: four paragraphs, three table cells, and one section. For the four paragraphs, change only font size, ordinary bold and paragraph alignment. Font size includes the corresponding complex-script size; font.bold changes ordinary bold only, so preserve existing complex-script bold. Update paragraph-mark properties only as supported by the same formatting API. For the three cells, change only vertical alignment and direct fill/shading. For the first section, change only page size and margins; preserve columns. Do not change font family, style, spacing or any other property. Match paragraphs by the provided text after reading the live document; the paragraph index is not a live reference:
${targetIdentities}
For all three selected manuscript cells, use this same explicit template source cell for vertical alignment and direct fill/shading: ${JSON.stringify(tableSource)}. This source is the first cell of the first table in XML document order, within a drawing Choice text box; confirm its locator and text through actual system reads. Read its direct tcPr children through the existing format nodes operation so an absent direct shading setting is established by that read, rather than inferred from an omitted compact field. Derive the two settings from that source and apply them to the first cells of manuscript tables 1, 6 and 11. The general checker may retain cannot_determine findings across other template table bands; preserve those findings and use this explicitly selected source for these three targets.
Preserve every other formatting property and all author facts, citations, links, bookmarks, fields, formulas, images, relationships, table structure, and unknown or unsupported differences.
Clear exactly one working-copy editorial note that has no factual basis: ${JSON.stringify(editorialMarker)}
Remove only that editorial marker and restore the note-bearing paragraph's original text. Do not make any other text edit.
Derive every supported value yourself from successful system reads. Do not guess. After the edits, save the resulting revision, run the selected template check, then call export_docx_document and verify its receipt. Clearly report any unsupported or uncovered item. This is a cross-location whole-manuscript closure check for these targets, not a claim that every manuscript or journal rule is compliant. Do not use shell, network, desktop apps, project files, delegation, another task, or another document. Finish within ${TASK_LIMIT_MINUTES} minutes with actual read/edit/save/check/export evidence and remaining gaps.`;
  const task = await page.evaluate<ResearchTask>(
    `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m =>
      m.createResearchTask({
        projectId:${scriptValue(appProjectId)},
        title:${scriptValue(`Whole ${languageName} manuscript live` )},
        prompt:${scriptValue(prompt)},runtimeId:'builtin',agentId:${scriptValue(PROVIDER)},
        modelId:${scriptValue(MODEL)},skillIds:[],dependencyIds:[],
        brief:{
          ...m.defaultBrief(),
          goal:${scriptValue(`Read and repair the complete ${languageName} Word manuscript`)},
          reasoningEffort:${scriptValue(MODEL_EFFORT)},
          permissions:{network:false,commands:'off',desktopApps:false},
          budget:{
            ...m.defaultBrief().budget,
            wallClockMinutes:${TASK_LIMIT_MINUTES},
            runTimeoutMinutes:${TASK_LIMIT_MINUTES}
          }
        }
      }))`,
  );
  const bindingDocument = (await live<DocxDocumentRead>(page)).document;
  const documentTools = page.getByTestId("docx-workspace")
    .getByText("Document tools", { exact: true });
  if (await documentTools.getAttribute("aria-expanded") !== "true") {
    await documentTools.click();
  }
  await expect(documentTools).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[aria-label="Task activity"] select')).toBeVisible();
  await clickWorkspaceButton(page, "Refresh activity");
  await waitLong(
    page,
    `Array.from(document.querySelectorAll('[aria-label="Task activity"] select option'))
      .some(option => option.value === ${scriptValue(task.id)})`,
    20_000,
  );
  await page.selectOption('[aria-label="Task activity"] select', task.id);
  await waitLong(
    page,
    `Array.from(document.querySelectorAll('[aria-label="Task activity"] button'))
      .some(button => button.textContent.trim() === 'Bind current DOCX' && !button.disabled)`,
    20_000,
  );
  await page.evaluate(
    `(() => {
      const button=Array.from(document.querySelectorAll('[aria-label="Task activity"] button'))
        .find(item => item.textContent.trim()==='Bind current DOCX');
      if (!button || button.disabled) throw new Error('Bind current DOCX is unavailable');
      button.click();
    })()`,
  );
  // Clicking starts the async renderer identity request. Execution must wait
  // for the retained binding, while the task still admits its first binding.
  await expect.poll(async () => {
    const receipt = (await activitiesPage(
      page, appProjectId, bindingDocument.workbenchProjectId, 0,
    )).activities.find(({ activity }) =>
      activity.origin.taskId === task.id
      && activity.origin.generation === task.executionGeneration
      && activity.event.type === "runtime"
      && activity.event.event.kind === "bound",
    );
    return receipt?.activity.document;
  }, { timeout: 60_000 }).toEqual({
    sessionId: bindingDocument.sessionId,
    appProjectId: bindingDocument.appProjectId,
    workbenchProjectId: bindingDocument.workbenchProjectId,
    baselineId: bindingDocument.baselineId,
    sourceSha256: bindingDocument.sourceSha256,
    sessionRevision: bindingDocument.sessionRevision,
    savedRevision: bindingDocument.savedRevision,
  });
  await page.evaluate(`(async () => {
    const route = {taskId:${scriptValue(task.id)}, path:${scriptValue(taskExportPath)}, active:true, requests:[]};
    const native = window.__TAURI_INTERNALS__;
    if (typeof native.unregisterCallback !== 'function'
      || typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener !== 'function') {
      throw new Error('The native Tauri event cleanup APIs are unavailable.');
    }
    route.callbackId = native.transformCallback(({payload}) => {
      if (!route.active || payload.operation !== 'export'
        || payload.projectId !== ${scriptValue(appProjectId)}
        || payload.origin?.taskId !== route.taskId) return;
      // The real host awaits native claim/validation before opening the save dialog.
      window.__e2eSetNextSavePath(route.path);
      route.requests.push({token:payload.token, operationId:payload.operationId});
    });
    try {
      route.eventId = await native.invoke('plugin:event|listen', {
        event:'research-docx-request', target:{kind:'Any'}, handler:route.callbackId
      });
      window.__wholeManuscriptTaskExportDialogs = route;
    } catch (error) {
      native.unregisterCallback(route.callbackId);
      throw error;
    }
  })()`);
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m =>
      m.startResearchTask(${scriptValue(task.id)}))`,
  );
  return task;
}

test("real Sol reads and repairs the complete English and Chinese manuscripts", async ({
  tauriPage: page,
}, testInfo) => {
  test.skip(
    !enabled || !relay || !run || !templatePath || !englishPath || !chinesePath,
    "Enable OLEAFLY_WORD_MANUSCRIPT_LIVE with the isolated runner, relay and all three inputs.",
  );
  test.setTimeout(2_700_000);
  await mkdir(run!, { recursive: true });
  const reportPath = resolve(run!, "word-manuscript-live-report.json");
  const normalizedPath = resolve(
    run!,
    "word-manuscript-template-normalized.docx",
  );
  const paths = {
    template: resolve(templatePath!),
    english: resolve(englishPath!),
    chinese: resolve(chinesePath!),
  };
  const report: Record<string, unknown> = {
    outcome: "RUNNING",
    startedAt: new Date().toISOString(),
    mode: "real-model",
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: MODEL_EFFORT,
    taskLimitMinutes: TASK_LIMIT_MINUTES,
    inputs: paths,
    initialHashes: null,
    finalHashes: null,
    normalizedTemplate: null,
    languages: {},
    scope: "Two independent live Sol tasks over controlled managed copies of authorized whole English and Chinese manuscripts. Independent XML verification covers only eight deterministic format targets and one editorial-note removal; findings are retained, not forced to zero. This is not Word/WPS pagination or complete journal-compliance evidence.",
  };
  const writeReport = () => writeJson(reportPath, report);
  let activeTask: ResearchTask | undefined;
  let initialHashes: WordManuscriptSourceHashes | undefined;
  try {
    initialHashes = await readHashes(paths);
    report.initialHashes = initialHashes;
    for (const key of ["template", "english", "chinese"] as const) {
      if (
        expectedInputs[key]
        && expectedInputs[key] !== initialHashes[key]
      ) {
        throw new Error(
          `${key} input hash is ${initialHashes[key]}, runner expected ${expectedInputs[key]}`,
        );
      }
    }
    await writeReport();

    if (await page.getByTestId("docx-workspace").count()) {
      await closeWorkingCopy(page);
    }
    if (
      await page.evaluate<boolean>(
        `Boolean(document.querySelector('[title="Back to library"]'))`,
      )
    ) {
      await page.click('[title="Back to library"]');
    }
    await createBlankProject(page, `Whole manuscript live ${Date.now()}`);
    const appProjectId = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/store/files.ts').then(m =>
        m.useFilesStore.getState().projectId)`,
    );
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    await configureProvider(page);
    await openRailTab(page, "Journal checks");
    await expect.poll(
      () => journalRequest<JournalState>(page, "/api/state").then(() => true, () => false),
      { timeout: 90_000 },
    ).toBe(true);

    const templateBytes = new Uint8Array(await readFile(paths.template));
    const world = await importTemplate(
      page,
      templateBytes,
      basename(paths.template),
    );
    const normalized = await retainTemplateSource(page, world.version_id);
    expect(normalized.worldVersionId).toBe(world.version_id);
    expect(normalized.sourceSha256).toBe(world.template?.source_sha256);
    expect(sha256(normalized.bytes)).toBe(normalized.sourceSha256);
    await writeFile(normalizedPath, normalized.bytes);
    report.normalizedTemplate = {
      path: normalizedPath,
      sourceSha256: normalized.sourceSha256,
    };
    report.world = world;
    const templateInventory = await page.evaluate<DocxFormatSnapshotV1>(
      `window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m =>
        m.docxFormatSnapshot(Uint8Array.from(atob(${scriptValue(Buffer.from(normalized.bytes).toString("base64"))}), c => c.charCodeAt(0))))`,
    );
    expect(templateInventory.source_sha256).toBe(normalized.sourceSha256);
    const tableSource = tableSourceIdentity(world, templateInventory);
    report.tableSourceMapping = tableSource;
    const templateInventoryPath = resolve(run!, "word-manuscript-template-inventory.json");
    await writeJson(templateInventoryPath, templateInventory);
    report.templateInventory = { path: templateInventoryPath,
      objects: templateInventory.objects.length,
      styleDefinitions: templateInventory.style_definitions?.length ?? 0,
      scope: "Pre-task acceptance inventory; not model reading evidence" };
    await writeReport();

    const languages = report.languages as Record<string, Record<string, unknown>>;
    for (const language of ["en", "zh"] as const) {
      const inputPath = language === "en" ? paths.english : paths.chinese;
      const inputBytes = new Uint8Array(await readFile(inputPath));
      const fixture = prepareWordManuscriptFixture(
        inputBytes,
        normalized.bytes,
        {
          seed: language === "en" ? 14_501 : 14_502,
          kinds: CONTROLLED_FORMAT_KINDS,
        },
      );
      const manuscriptOracle = readManuscriptOracle(fixture.damagedBytes);
      const nonBodyParagraphs = manuscriptOracle.semantics.paragraphs
        .filter((paragraph) => !paragraph.part.endsWith("word/document.xml"))
        .map(({ part, index, text: paragraphText }) => ({
          part,
          index,
          text: paragraphText,
        }));
      const marker = controlMarker(fixture.control);
      expect(marker.text).toBe(" OLEAFLY_E2E_REMOVE_MARKER_20261115");
      expect(marker.markedText).toBe(marker.originalText + marker.text);
      expect(sha256(fixture.damagedBytes)).not.toBe(sha256(inputBytes));
      const fixturePath = resolve(
        run!,
        `word-manuscript-${language}-controlled.docx`,
      );
      await writeFile(fixturePath, fixture.damagedBytes);
      const languageReport: Record<string, unknown> = {
        stage: "fixture-ready",
        inputPath,
        inputSha256: sha256(inputBytes),
        fixturePath,
        fixtureSha256: sha256(fixture.damagedBytes),
        editorialMarker: marker.text,
        controls: fixture.control.targets,
        nonBodyParagraphs: nonBodyParagraphs.map(({ part, index, text: paragraphText }) => ({
          part,
          index,
          textLength: paragraphText.length,
        })),
      };
      languages[language] = languageReport;
      await writeReport();

      const projectName =
        `Whole manuscript ${language.toUpperCase()} ${Date.now()}`;
      await importManuscript(
        page,
        fixture.damagedBytes,
        basename(fixturePath),
        projectName,
      );
      let project = await waitForProject(page, projectName);
      await selectProject(page, project.project_id);
      const oldCheck = await runJournalCheck(
        page,
        project.project_id,
        world.version_id,
      );
      expect(oldCheck).toMatchObject({
        project_id: project.project_id,
        baseline_id: project.baseline_id,
        world_version_id: world.version_id,
        validity: "CURRENT",
      });
      languageReport.preCheck = oldCheck;
      await writeReport();

      const before = await openWorkingCopy(page);
      expect(before.document.sourceSha256).toBe(fixture.control.expected.damagedSha256);
      expect(before.document.dirty).toBe(false);
      const initialPath = resolve(
        run!,
        `word-manuscript-${language}-initial-export.docx`,
      );
      const initialExportBytes = await exportWorkingCopy(page, initialPath);
      const initialExport = verifyWordManuscriptInitialExport(
        fixture,
        initialExportBytes,
      );
      languageReport.initialExport = {
        path: initialPath,
        sourceSha256: sha256(initialExportBytes),
        oracle: initialExport,
      };
      expect((await live<DocxDocumentRead>(page)).document)
        .toEqual(before.document);
      await writeReport();

      if (language === "en") {
        report.deterministicTakeover = await runWordManuscriptTakeover(
          page,
          { projectId: appProjectId, outputDirectory: run! },
        );
        await writeReport();
      }
      const modelBefore = await live<DocxDocumentRead>(page);
      expect(modelBefore.document).toMatchObject({
        appProjectId: before.document.appProjectId,
        workbenchProjectId: before.document.workbenchProjectId,
        baselineId: before.document.baselineId,
        sourceSha256: before.document.sourceSha256,
        dirty: false,
      });
      if (language === "en") {
        expect(modelBefore.document.sessionId).not.toBe(before.document.sessionId);
      }
      expect(modelBefore.paragraphs.map(({ text }) => text))
        .toEqual(before.paragraphs.map(({ text }) => text));
      const modelStartPath = resolve(
        run!,
        `word-manuscript-${language}-model-start-export.docx`,
      );
      const modelStartBytes = await exportWorkingCopy(page, modelStartPath);
      languageReport.modelBefore = modelBefore.document;
      languageReport.modelStartExport = {
        path: modelStartPath,
        sourceSha256: sha256(modelStartBytes),
        oracle: verifyWordManuscriptInitialExport(fixture, modelStartBytes),
      };
      expect((await live<DocxDocumentRead>(page)).document)
        .toEqual(modelBefore.document);
      await writeReport();

      const taskExportPath = resolve(
        run!,
        `word-manuscript-${language}-task-export.docx`,
      );
      activeTask = await createLiveTask(
        page,
        appProjectId,
        language,
        marker.text,
        fixture.control,
        world,
        tableSource,
        taskExportPath,
      );
      languageReport.taskCreated = activeTask;
      await writeReport();
      activeTask = await waitForTask(page, appProjectId, activeTask.id);
      languageReport.taskExportDialogs = await clearTaskExportDialogs(page);
      languageReport.task = activeTask;
      const events = await transcript(page, activeTask);
      const activityReceipt = await allActivities(
        page,
        appProjectId,
        modelBefore.document.workbenchProjectId,
        activeTask,
      );
      const transcriptPath = resolve(
        run!,
        `word-manuscript-${language}-transcript.json`,
      );
      const activityPath = resolve(
        run!,
        `word-manuscript-${language}-activity.json`,
      );
      await writeJson(transcriptPath, events);
      await writeJson(activityPath, activityReceipt);
      languageReport.transcriptPath = transcriptPath;
      languageReport.activityPath = activityPath;
      languageReport.activityPages = activityReceipt.pages;
      languageReport.activities = activityReceipt.activities;
      await writeReport();
      expect(
        ["awaiting_review", "completed"],
        activeTask.error ?? `${language} live task failed`,
      ).toContain(activeTask.status);
      expect(activeTask.result?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(activeTask.result?.outputTokens ?? 0).toBeGreaterThan(0);

      const coverage = collectModelReadReceipt(
        events,
        activityReceipt.activities.map(({ activity }) => activity),
        {
          manuscriptRevision: modelBefore.document.sessionRevision,
          manuscriptSourceSha256: modelBefore.document.sourceSha256,
          manuscriptFormatSourceSha256: sha256(modelStartBytes),
          templateWorldVersionId: world.version_id,
          templateSourceSha256: normalized.sourceSha256,
          templateInventory: { ...templateInventory },
          manuscriptParagraphs: modelBefore.paragraphs,
          nonBodyParagraphs,
        },
      );
      languageReport.modelReadCoverage = coverage;
      expect(coverage.format.overviewRead, coverage.gaps.join("\n")).toBe(true);
      expect(coverage.format.nonBody, coverage.gaps.join("\n"))
        .toHaveLength(new Set(nonBodyParagraphs.map(({ part }) => part)).size);
      expect(coverage.format.nonBody.every((part) => part.completeText))
        .toBe(true);
      expect(coverage.gaps, coverage.gaps.join("\n")).toEqual([]);
      expect(coverage.complete, coverage.gaps.join("\n")).toBe(true);

      const names = events.flatMap(({ event }) =>
        event.kind === "tool" && event.phase === "request" && event.name
          ? [event.name]
          : [],
      );
      languageReport.toolTrail = names;
      for (const name of [
        "read_docx_document",
        "journal_read",
        "read_docx_format",
        "prepare_docx_fonts",
        "save_docx_document",
        "check_docx_template",
        "export_docx_document",
      ]) {
        expect(names, `${language} task tool trail`).toContain(name);
      }
      expect(
        names.some((name) =>
          name === "apply_docx_format" || name === "apply_docx_format_batch",
        ),
        `${language} task did not apply a supported format`,
      ).toBe(true);
      expect(names, `${language} task did not clear the editorial note`)
        .toContain("apply_docx_suggestion");

      const after = await live<DocxDocumentRead>(page);
      expect(after.document.dirty).toBe(false);
      expect(after.document.baselineId).not.toBe(modelBefore.document.baselineId);
      languageReport.after = after.document;
      const operations = operationActivities(activityReceipt.activities);
      languageReport.operations = operations;
      const prepareFonts = operations.find(
        (item) => item.operation === "prepare_fonts",
      );
      const exportOperation = [...operations].reverse().find(
        (item) => item.operation === "export",
      );
      const save = [...operations].reverse().find((item) => item.operation === "save");
      const check = [...operations].reverse().find((item) => item.operation === "check");
      expect(prepareFonts?.result).toMatchObject({
        operation: "prepare_fonts",
        ok: true,
      });
      expect(save?.result).toMatchObject({
        operation: "save",
        ok: true,
        document: {
          baselineId: after.document.baselineId,
          sourceSha256: after.document.sourceSha256,
          sessionRevision: after.document.sessionRevision,
        },
      });
      expect(check?.result).toMatchObject({
        operation: "check",
        ok: true,
        result: {
          template: world.version_id,
          check: {
            baseline_id: after.document.baselineId,
            world_version_id: world.version_id,
            source_sha256: after.document.sourceSha256,
          },
        },
      });
      expect(exportOperation?.result).toMatchObject({
        operation: "export",
        ok: true,
      });
      const taskExportBytes = new Uint8Array(await readFile(taskExportPath));
      expect(sha256(taskExportBytes)).toBe(after.document.sourceSha256);
      languageReport.taskExport = {
        path: taskExportPath,
        sourceSha256: sha256(taskExportBytes),
      };
      const savedMutation = finalSavedMutation(
        activityReceipt.activities.map(({ activity }) => activity),
        save!.operationId!,
      );
      expect(savedMutation?.mutation).toBeDefined();
      expect(savedMutation?.checkpoint?.event).toMatchObject({
        type: "operationCheckpoint",
        phase: "saved",
        operationId: savedMutation?.operationId,
        contentSha256: after.document.sourceSha256,
      });
      expect(savedMutation?.checkpoint?.document).toEqual(savedMutation?.mutation.document);
      const mutationCheckpoint = savedMutation?.checkpoint?.event;
      if (mutationCheckpoint?.type !== "operationCheckpoint") {
        throw new Error("The final changed operation has no saved checkpoint");
      }
      expect(mutationCheckpoint.fromDocument).toEqual(savedMutation!.mutation.document);
      const saveOperationIds = new Set(operations.filter(operation => operation.operation === "save")
        .map(operation => operation.operationId));
      const committingSave = activityReceipt.activities.find(({ activity }) =>
        activity.event.type === "operationCheckpoint" && activity.event.phase === "saved"
        && activity.event.requestId === mutationCheckpoint.requestId
        && activity.event.recoveryKey === mutationCheckpoint.recoveryKey
        && saveOperationIds.has(activity.event.operationId));
      expect(committingSave?.activity.event).toMatchObject({
        type: "operationCheckpoint", contentSha256: after.document.sourceSha256,
      });
      const saveCheckpoint = committingSave?.activity.event;
      if (saveCheckpoint?.type !== "operationCheckpoint") {
        throw new Error("The changed operation has no corresponding saved request");
      }
      expect(mutationCheckpoint.requestId).toBeTruthy();
      expect(saveCheckpoint.fromDocument).toEqual(committingSave!.activity.document);
      expect(committingSave!.activity.document).toMatchObject({
        sessionId: mutationCheckpoint.fromDocument.sessionId,
        appProjectId: mutationCheckpoint.fromDocument.appProjectId,
        workbenchProjectId: mutationCheckpoint.fromDocument.workbenchProjectId,
        sessionRevision: mutationCheckpoint.fromDocument.sessionRevision,
        sourceSha256: after.document.sourceSha256,
      });
      const saveIntent = activityReceipt.activities.find(({ activity }) =>
        activity.id === saveCheckpoint.operationId)?.activity;
      expect(saveIntent?.event).toMatchObject({ type: "runtime", event: {
        kind: "operationStarted", operation: "save", request: {
          session_id: mutationCheckpoint.fromDocument.sessionId,
          expected_revision: mutationCheckpoint.fromDocument.sessionRevision,
        },
      } });
      const checkCheckpoint = activityReceipt.activities.find(
        ({ activity }) =>
          activity.event.type === "operationCheckpoint"
          && activity.event.operationId === check?.operationId
          && activity.event.phase === "recovered",
      );
      expect(checkCheckpoint).toBeDefined();
      expect(checkCheckpoint?.activity.event).toMatchObject({
        type: "operationCheckpoint",
        phase: "recovered",
        contentSha256: after.document.sourceSha256,
      });

      const oldAfter = await journalRequest<JournalCheck>(
        page,
        `/api/check?check_id=${encodeURIComponent(oldCheck.check_id)}`,
      );
      expect(oldAfter).toMatchObject({
        check_id: oldCheck.check_id,
        project_id: project.project_id,
        baseline_id: project.baseline_id,
        world_version_id: world.version_id,
        validity: "STALE",
      });
      project = await readWorldProject(page, project.project_id);
      const newCheckId = project.latest_check?.check_id;
      expect(newCheckId).toBeTruthy();
      const newCheck = await journalRequest<JournalCheck>(
        page,
        `/api/check?check_id=${encodeURIComponent(newCheckId!)}`,
      );
      expect(newCheck).toMatchObject({
        project_id: project.project_id,
        baseline_id: after.document.baselineId,
        world_version_id: world.version_id,
        source_sha256: after.document.sourceSha256,
        validity: "CURRENT",
      });
      const savedSource = await retireAndReadSource(
        page,
        project,
        after.document.baselineId,
        resolve(run!, `word-manuscript-${language}-saved.docx`),
      );
      expect(savedSource.source_sha256).toBe(after.document.sourceSha256);
      expect(sha256(savedSource.bytes)).toBe(after.document.sourceSha256);
      languageReport.oldCheck = oldAfter;
      languageReport.newCheck = newCheck;
      languageReport.findingCounts = newCheck.summary;
      languageReport.findingCountPolicy = "retained, not forced to zero";
      languageReport.savedSource = {
        sourceSha256: savedSource.source_sha256,
        path: resolve(run!, `word-manuscript-${language}-saved.docx`),
      };
      await writeReport();

      const repair = verifyWordManuscriptRepair(fixture, savedSource.bytes);
      languageReport.oracleRepair = repair;
      expect(repair.passed).toBe(true);
      await writeReport();

      await closeWorkingCopy(page);
      await selectProject(page, project.project_id);
      const reopened = await openWorkingCopy(page);
      expect(reopened.document).toMatchObject({
        baselineId: after.document.baselineId,
        sourceSha256: after.document.sourceSha256,
        dirty: false,
      });
      languageReport.reopened = reopened.document;
      const baselineExportPath = resolve(
        run!,
        `word-manuscript-${language}-baseline-export.docx`,
      );
      const baselineExportBytes = await exportWorkingCopy(
        page,
        baselineExportPath,
      );
      const baselineExportSha256 = sha256(baselineExportBytes);
      languageReport.baselineExport = {
        path: baselineExportPath,
        sourceSha256: baselineExportSha256,
        expectedSourceSha256: savedSource.source_sha256,
        byteExact: baselineExportSha256 === savedSource.source_sha256,
      };
      expect(
        baselineExportSha256,
        `${language} public export differs from the retained saved baseline`,
      ).toBe(savedSource.source_sha256);
      await writeReport();

      await closeWorkingCopy(page);
      languageReport.stage = "PASSED";
      activeTask = undefined;
      await writeReport();
    }
    report.outcome = "PASSED";
  } catch (error) {
    report.outcome = "FAILED";
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    try {
      await cancelIfRunning(page, activeTask);
      if (activeTask) {
        report.languageIncomplete = {
          task: await loadTask(page, activeTask.projectId, activeTask.id),
        };
      }
    } catch (error) {
      report.cancelError = String(error);
    }
    try {
      const exportDialogs = await clearTaskExportDialogs(page);
      if (exportDialogs) report.taskExportDialogsCleanup = exportDialogs;
    } catch (error) {
      report.outcome = "FAILED";
      report.taskExportDialogsCleanupError = String(error);
    }
    const finalHashes = initialHashes ? await readHashes(paths) : null;
    report.finalHashes = finalHashes;
    if (initialHashes && finalHashes && (
      finalHashes.template !== initialHashes.template
      || finalHashes.english !== initialHashes.english
      || finalHashes.chinese !== initialHashes.chinese
    )) {
      report.outcome = "FAILED";
      report.inputMutation = true;
    }
    report.finishedAt = new Date().toISOString();
    await writeReport();
    await testInfo.attach("word-manuscript-live-report", {
      path: reportPath,
      contentType: "application/json",
    });
  }
  expect(report.inputMutation ?? false, "An author input changed during the run")
    .toBe(false);
  expect(report.finalHashes).toEqual(report.initialHashes);
  expect(report.outcome, String(report.error ?? "")).toBe("PASSED");
});

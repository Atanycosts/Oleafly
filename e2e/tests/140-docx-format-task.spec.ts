import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import type {
  DocxDocumentRead,
  DocxFormatReadResult,
} from "../../packages/ai-tools/src/tools";
import type {
  DocxActivity,
  DocxActivityPage,
  DocxDocumentIdentity,
} from "../../src/lib/docx-task-activity";
import type {
  JournalCheck,
  JournalProject,
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import type { DocxRecoveryListing } from "../../src/lib/docx-recovery";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { GroupSnapshot } from "../../src/lib/task-collaboration";
import { expect, test } from "../fixtures";
import { createBlankProject, openRailTab, waitLong } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_DOCX_TEMPLATE === "1";
const run = process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const PROVIDER = "docx-format-task-fixture";
const MODEL = "gpt/gpt-6.1-sol";
const EAST_ASIA_FONT = "SimHei";
const MANUSCRIPT_EAST_ASIA_FONT = "SimSun";
const LATIN_FONT = "Arial";
const BODY_TEXT = "Synthetic body target 中文";
type Page = TauriPage | BrowserPageAdapter;

type Request = Record<string, unknown>;
type Message = { role: string; content: unknown };
type Operation<T> = {
  operation: "read_format" | "format" | "save" | "check";
  ok: boolean;
  document: DocxDocumentIdentity;
  result: T;
  activity?: DocxActivity;
};
type FormatMutationResult = {
  ok: boolean;
  changed: boolean;
  revision: number;
};
type SaveResult = {
  baselineId: string;
  revision: number;
  sourceSha256: string;
};
type CheckResult = {
  template: string;
  check: Pick<
    JournalCheck,
    "check_id" | "project_id" | "baseline_id" | "world_version_id" | "summary"
  >;
};
type Finding = {
  case_id: string;
  object_id: string;
  property_path: string;
  observed: unknown;
  expected: unknown;
  verdict: string;
};
type FindingsPage = {
  findings: Finding[];
  total: number;
  next_offset: number | null;
  has_more: boolean;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const output = (name: string) => resolve(run!, name);

function syntheticBodyDocx(eastAsia: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${LATIN_FONT}" w:hAnsi="${LATIN_FONT}" w:eastAsia="${eastAsia}"/><w:sz w:val="24"/></w:rPr><w:t>${BODY_TEXT}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`,
    ),
    "word/styles.xml": strToU8(
      '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
    ),
  });
}

function parseToolValue(message: Message): unknown {
  if (message.role !== "tool" || typeof message.content !== "string") return undefined;
  const envelope = JSON.parse(message.content) as {
    content?: { type: string; text: string }[];
  } & Record<string, unknown>;
  return Array.isArray(envelope.content)
    ? JSON.parse(envelope.content.find((entry) => entry.type === "text")?.text ?? "{}")
    : envelope;
}

function findToolObject<T>(
  request: Request,
  predicate: (value: Record<string, unknown>) => boolean,
): T {
  for (const message of [...(request.messages as Message[])].reverse()) {
    const parsed = parseToolValue(message);
    const pending = [parsed];
    while (pending.length) {
      const value = pending.shift();
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      const record = value as Record<string, unknown>;
      if (predicate(record)) return record as T;
      pending.push(...Object.values(record));
    }
  }
  const toolValues = (request.messages as Message[])
    .filter((message) => message.role === "tool")
    .map(parseToolValue);
  throw new Error(`The requested DOCX task tool result is missing: ${JSON.stringify(toolValues)}`);
}

function operation<T>(request: Request, name: Operation<T>["operation"]): Operation<T> {
  return findToolObject<Operation<T>>(
    request,
    (value) => value.operation === name && value.document !== undefined && value.result !== undefined,
  );
}

async function journalRequest<T>(
  page: Page,
  path: string,
  payload?: unknown,
): Promise<T> {
  const payloadArgument = payload === undefined ? "" : `, ${scriptValue(payload)}`;
  return page.evaluate<T>(
    `window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest(${scriptValue(path)}${payloadArgument}))`,
  );
}

async function clickButton(page: Page, root: string, label: string) {
  await page.evaluate(`(() => {
    const surface = document.querySelector(${scriptValue(root)});
    const button = Array.from(surface.querySelectorAll('button')).find(item =>
      item.textContent.trim() === ${scriptValue(label)} || item.getAttribute('aria-label') === ${scriptValue(label)}
    );
    if (!button || button.disabled) throw new Error('Unavailable button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

async function waitForWorld(page: Page, journalId: string): Promise<JournalWorld> {
  let versionId: string | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    versionId = state.worlds.find((item) => item.journal_id === journalId)?.version_id;
    return Boolean(versionId);
  }, { timeout: 120_000 }).toBe(true);
  return journalRequest<JournalWorld>(
    page,
    `/api/world?version_id=${encodeURIComponent(versionId!)}`,
  );
}

async function waitForProject(page: Page, name: string): Promise<JournalProject> {
  let project: JournalProject | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    project = state.projects.find((item) => item.name === name);
    return Boolean(project);
  }, { timeout: 120_000 }).toBe(true);
  return project!;
}

async function importTemplateThroughUi(
  page: Page,
  bytes: Uint8Array,
  journalName: string,
  journalId: string,
) {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Use Word as template", { exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByText("Use Word as template", { exact: true }).click();
  await page.fill('[role="dialog"] input[id$="-name"]', journalName);
  await page.fill('[role="dialog"] input[id$="-journal"]', journalId);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "format-task-template.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(bytes),
  }]);
  await page.click('[role="dialog"] button[type="submit"]');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 120_000 });
}

async function importManuscriptThroughUi(
  page: Page,
  bytes: Uint8Array,
  projectName: string,
) {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByText("Import DOCX", { exact: true }).click();
  await page.fill('[role="dialog"] input:not([type="file"])', projectName);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "format-task-manuscript.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(bytes),
  }]);
  await page.click('[role="dialog"] button[type="submit"]');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 120_000 });
}

async function selectJournalProject(page: Page, projectId: string) {
  const panel = page.getByTestId("journal-checks-panel");
  const select = panel.locator("select").first();
  await expect(select).toBeEnabled({ timeout: 60_000 });
  await select.selectOption(projectId);
  await expect.poll(() => select.inputValue()).toBe(projectId);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
}

async function selectJournalWorld(page: Page, worldVersionId: string) {
  const panel = page.getByTestId("journal-checks-panel");
  const select = page.getByTestId("journal-world-select");
  await expect(select).toBeEnabled({ timeout: 60_000 });
  await expect.poll(() => page.evaluate<string[]>(`Array.from(
    document.querySelector('[data-testid="journal-world-select"]').options,
    option => option.value
  )`), { timeout: 60_000 }).toContain(worldVersionId);
  await select.selectOption(worldVersionId);
  await expect.poll(() => select.inputValue()).toBe(worldVersionId);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
}

async function closeLingeringDocxWorkspace(page: Page) {
  const workspace = page.getByTestId("docx-workspace");
  if (await workspace.count() === 0) return;
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/store/docx-workspace.ts').then(m => m.useDocxWorkspaceStore.getState().restore())`,
  );
  await clickButton(page, '[data-testid="docx-workspace"]', "Close");
  const outcome: { value: "open" | "prompt" | "closed" } = { value: "open" };
  await expect.poll(async () => {
    const discardVisible = await page.evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some(button =>
      button.textContent.trim() === 'Close and discard unsaved changes' && button.getClientRects().length > 0
    )`);
    if (discardVisible) outcome.value = "prompt";
    else if (await workspace.count() === 0) outcome.value = "closed";
    else outcome.value = "open";
    return outcome.value;
  }, { timeout: 30_000 }).not.toBe("open");
  if (outcome.value === "prompt") {
    await clickButton(page, "body", "Close and discard unsaved changes");
  }
  await expect(workspace).toHaveCount(0, { timeout: 60_000 });
}

async function runJournalCheck(
  page: Page,
  projectId: string,
  worldVersionId: string,
): Promise<JournalCheck> {
  const panel = page.getByTestId("journal-checks-panel");
  const previous = (await journalRequest<JournalState>(page, "/api/state"))
    .projects.find((item) => item.project_id === projectId)?.latest_check?.check_id;
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await panel.getByText("Run check", { exact: true }).click();
  let checkId: string | undefined;
  await expect.poll(async () => {
    const current = (await journalRequest<JournalState>(page, "/api/state"))
      .projects.find((item) => item.project_id === projectId)?.latest_check;
    if (
      current?.check_id &&
      current.check_id !== previous &&
      current.validity === "CURRENT" &&
      current.world_version_id === worldVersionId
    ) {
      checkId = current.check_id;
      return true;
    }
    return false;
  }, { timeout: 180_000 }).toBe(true);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
  return journalRequest<JournalCheck>(
    page,
    `/api/check?check_id=${encodeURIComponent(checkId!)}`,
  );
}

async function eastAsiaFindings(
  page: Page,
  check: JournalCheck,
  verdict: "observed_difference" | "observed_match",
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let offset = 0;
  for (;;) {
    const pageResult = await journalRequest<FindingsPage>(page, "/api/docx-query", {
      target: { check_id: check.check_id },
      operation: "findings",
      offset,
      limit: 1_000,
      verdict,
      property_path: "run.fontFamilyEastAsia",
    });
    findings.push(...pageResult.findings);
    if (!pageResult.has_more) return findings;
    expect(pageResult.next_offset).toBe(offset + pageResult.findings.length);
    expect(pageResult.findings.length).toBeGreaterThan(0);
    offset = pageResult.next_offset!;
  }
}

async function taskActivities(
  page: Page,
  projectId: string,
  manuscript: string,
): Promise<DocxActivity[]> {
  const retained: DocxActivity[] = [];
  let cursor = 0;
  for (;;) {
    const batch = await page.evaluate<DocxActivityPage>(`window.__TAURI_INTERNALS__.invoke('research_docx_activities', {
      projectId: ${scriptValue(projectId)},
      workbenchProjectId: ${scriptValue(manuscript)},
      afterCursor: ${cursor},
      limit: 50
    })`);
    retained.push(...batch.activities.map(({ activity }) => activity));
    if (!batch.hasMore) return retained;
    expect(batch.nextCursor).toBeGreaterThan(cursor);
    cursor = batch.nextCursor;
  }
}

async function recoverySnapshots(page: Page, appProjectId: string, manuscript: string) {
  const listing = await page.evaluate<DocxRecoveryListing>(
    `window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`,
  );
  return listing.snapshots.filter((snapshot) =>
    snapshot.appProjectId === appProjectId &&
    snapshot.workbenchProjectId === manuscript
  );
}

async function expectNoRecoverySnapshot(
  page: Page,
  appProjectId: string,
  manuscript: string,
) {
  await expect.poll(async () => (
    await recoverySnapshots(page, appProjectId, manuscript)
  ).length, { timeout: 30_000 }).toBe(0);
}

test("native task completes two format/save/check rounds and reopens cleanly", async ({ tauriPage: page }) => {
  test.skip(!enabled, "Set OLEAFLY_DOCX_TEMPLATE=1 for native DOCX template task acceptance.");
  test.skip(!run, "Set OLEAFLY_DOCX_RECOVERY_RUN to the isolated acceptance output directory.");
  test.setTimeout(900_000);

  const templateBytes = syntheticBodyDocx(EAST_ASIA_FONT);
  const manuscriptBytes = syntheticBodyDocx(MANUSCRIPT_EAST_ASIA_FONT);
  const server = await startMockAiServer();
  try {
    await closeLingeringDocxWorkspace(page);
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) {
      await page.click('[title="Back to library"]');
    }
    await createBlankProject(page, `DOCX format task ${Date.now()}`);
    const appProjectId = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`,
    );
    await openRailTab(page, "Journal checks");

    const journalId = `docx-format-task-${Date.now()}`;
    const journalName = `DOCX format task template ${Date.now()}`;
    await importTemplateThroughUi(page, templateBytes, journalName, journalId);
    const world = await waitForWorld(page, journalId);
    expect(world.template?.source_sha256).toBe(sha256(templateBytes));

    const projectName = `DOCX format task manuscript ${Date.now()}`;
    await importManuscriptThroughUi(page, manuscriptBytes, projectName);
    const manuscriptProject = await waitForProject(page, projectName);
    expect(manuscriptProject.baseline_id).toBeTruthy();
    await selectJournalProject(page, manuscriptProject.project_id);
    await selectJournalWorld(page, world.version_id);
    await expect.poll(() =>
      page.locator('[data-testid="journal-world-select"]').inputValue()
    ).toBe(world.version_id);

    const initialCheck = await runJournalCheck(
      page,
      manuscriptProject.project_id,
      world.version_id,
    );
    expect(initialCheck).toMatchObject({
      project_id: manuscriptProject.project_id,
      baseline_id: manuscriptProject.baseline_id,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    const initialDifference = (await eastAsiaFindings(page, initialCheck, "observed_difference"))
      .find((finding) =>
        finding.observed === MANUSCRIPT_EAST_ASIA_FONT &&
        finding.expected === EAST_ASIA_FONT
      );
    expect(initialDifference, JSON.stringify(initialCheck, null, 2)).toBeTruthy();

    await page.getByTestId("journal-checks-panel")
      .getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 90_000 });
    const liveBefore = await page.evaluate<DocxDocumentRead>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
    );
    expect(liveBefore.paragraphs.some((paragraph) => paragraph.text === BODY_TEXT)).toBe(true);
    expect(liveBefore.document).toMatchObject({
      appProjectId,
      workbenchProjectId: manuscriptProject.project_id,
      baselineId: manuscriptProject.baseline_id,
      sourceSha256: sha256(manuscriptBytes),
      sessionRevision: 0,
      savedRevision: 0,
    });
    const liveExportPath = output("docx-format-task-live-before.docx");
    await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(liveExportPath)})`);
    await clickButton(page, '[data-testid="docx-workspace"]', "Download DOCX copy");
    let liveExportSha256 = "";
    await expect.poll(async () => {
      try {
        liveExportSha256 = sha256(await readFile(liveExportPath));
        return true;
      } catch { return false; }
    }, { timeout: 60_000 }).toBe(true);

    await page.evaluate(`window.__researchTasksSet?.(true)`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      await api.setConfig({
        ...config,
        ai_custom_providers: [
          ...(config.ai_custom_providers ?? []).filter(provider => provider.id !== ${scriptValue(PROVIDER)}),
          {
            id: ${scriptValue(PROVIDER)},
            name: 'Scripted DOCX format task fixture',
            baseURL: ${scriptValue(`${server.url}/v1`)},
            keyOptional: true
          }
        ],
        ai_provider_models: {
          ...config.ai_provider_models,
          [${scriptValue(PROVIDER)}]: [{
            id: ${scriptValue(MODEL)},
            name: ${scriptValue(MODEL)},
            enabled: true,
            source: 'user'
          }]
        }
      });
    })`);

    let firstRead: Operation<DocxFormatReadResult> | undefined;
    let firstFormat: Operation<FormatMutationResult> | undefined;
    let firstSave: Operation<SaveResult> | undefined;
    let firstCheck: Operation<CheckResult> | undefined;
    let secondFormat: Operation<FormatMutationResult> | undefined;
    let secondSave: Operation<SaveResult> | undefined;
    let secondCheck: Operation<CheckResult> | undefined;
    let bodyParagraphRef: string | undefined;
    const steps = [
      {
        name: "discover_tools",
        args: () => ({ query: "docx" }),
      },
      {
        name: "list_docx_documents",
        args: () => ({}),
      },
      {
        name: "read_docx_document",
        args: () => ({ offset: 0, limit: 10 }),
      },
      {
        name: "read_docx_format",
        args: (request: Request) => {
          const read = findToolObject<{
            paragraphs: { paragraphRef: string; text: string }[];
          }>(
            request,
            (value) => Array.isArray(value.paragraphs),
          );
          const paragraph = read.paragraphs.find((item) => item.text === BODY_TEXT);
          if (!paragraph) throw new Error("The synthetic body paragraph is missing.");
          bodyParagraphRef = paragraph.paragraphRef;
          return {
            query: {
              kind: "objects",
              paragraph_ref: paragraph.paragraphRef,
              limit: 50,
            },
          };
        },
      },
      {
        name: "apply_docx_format",
        args: (request: Request) => {
          firstRead = operation<DocxFormatReadResult>(request, "read_format");
          const paragraph = firstRead.result.paragraph;
          if (!paragraph) throw new Error("The format read did not resolve the body paragraph.");
          return {
            paragraph_ref: paragraph.paragraphRef,
            expected_revision: firstRead.result.revision,
            font: { name: LATIN_FONT, nameEastAsia: EAST_ASIA_FONT },
          };
        },
      },
      {
        name: "save_docx_document",
        args: (request: Request) => {
          firstFormat = operation<FormatMutationResult>(request, "format");
          return { expected_revision: firstFormat.document.sessionRevision };
        },
      },
      {
        name: "check_docx_template",
        args: (request: Request) => {
          firstSave = operation<SaveResult>(request, "save");
          return { template: world.version_id };
        },
      },
      {
        name: "apply_docx_format",
        args: () => {
          if (!bodyParagraphRef || !firstSave) {
            throw new Error("The first round did not retain the paragraph and saved revision.");
          }
          return {
            paragraph_ref: bodyParagraphRef,
            expected_revision: firstSave.document.sessionRevision,
            font: { bold: true },
          };
        },
      },
      {
        name: "save_docx_document",
        args: (request: Request) => {
          secondFormat = operation<FormatMutationResult>(request, "format");
          return { expected_revision: secondFormat.document.sessionRevision };
        },
      },
      {
        name: "check_docx_template",
        args: (request: Request) => {
          secondSave = operation<SaveResult>(request, "save");
          return { template: world.version_id };
        },
      },
      {
        name: "docx_task_activity",
        args: (request: Request) => {
          if (!firstSave || !secondSave) {
            throw new Error("Both checks require their saved baselines.");
          }
          firstCheck = findToolObject<Operation<CheckResult>>(
            request,
            (value) =>
              value.operation === "check" &&
              value.document !== undefined &&
              value.result !== undefined &&
              JSON.stringify(value.result).includes(firstSave!.result.baselineId),
          );
          secondCheck = findToolObject<Operation<CheckResult>>(
            request,
            (value) =>
              value.operation === "check" &&
              value.document !== undefined &&
              value.result !== undefined &&
              JSON.stringify(value.result).includes(secondSave!.result.baselineId),
          );
          return { limit: 50 };
        },
      },
    ];
    server.setResponder((request) => {
      const messages = request.messages as Message[];
      if (messages.some((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Assess responsibility-based participation")
      )) return '{"decisions":[]}';
      const step = steps[messages.filter((message) => message.role === "tool").length];
      return step ? { name: step.name, args: step.args(request) } : "DOCX_FORMAT_TASK_COMPLETE";
    });

    const task = await page.evaluate<ResearchTask>(
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.createResearchTask(${scriptValue({
        projectId: appProjectId,
        title: "Native DOCX two-round format task chain",
        prompt: `Work only on the bound live DOCX. Use read_docx_document to select the paragraph whose text is exactly "${BODY_TEXT}". Read its format, apply ${LATIN_FONT} as the Latin font and ${EAST_ASIA_FONT} as the East Asian font at the returned revision, save the exact applied revision, and check the saved baseline against template world ${world.version_id}. Then apply bold to that same paragraph at the revision returned by the first save, save the second exact applied revision, and check the new saved baseline against the same template world. Read the retained DOCX task activity before finishing. Do not finish unless all seven tracked operations succeed.`,
        runtimeId: "builtin",
        agentId: PROVIDER,
        modelId: MODEL,
        skillIds: [],
        dependencyIds: [],
      })}))`,
    );
    const group = await page.evaluate<GroupSnapshot>(
      `window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.createTaskGroup(${scriptValue(appProjectId)}, ${scriptValue(task.id)}, [{
        name: 'DOCX format reviewer',
        responsibility: 'Own two bound DOCX format, save and template recheck rounds; do not delegate or subscribe.',
        runtimeId: 'builtin',
        agentId: ${scriptValue(PROVIDER)},
        modelId: ${scriptValue(MODEL)},
        skillIds: [],
        coordinator: true
      }]))`,
    );

    await clickButton(page, '[aria-label="Task activity"]', "Refresh activity");
    await waitLong(
      page,
      `Array.from(document.querySelectorAll('[aria-label="Task activity"] select option')).some(option => option.value === ${scriptValue(task.id)})`,
      15_000,
    );
    await page.selectOption('[aria-label="Task activity"] select', task.id);
    await waitLong(
      page,
      `Array.from(document.querySelectorAll('[aria-label="Task activity"] button')).some(button => button.textContent.trim() === 'Bind current DOCX' && !button.disabled)`,
      15_000,
    );
    await clickButton(page, '[aria-label="Task activity"]', "Bind current DOCX");
    await expect.poll(async () => (await taskActivities(
      page,
      appProjectId,
      liveBefore.document.workbenchProjectId,
    )).some(({ origin, event }) =>
      origin.taskId === task.id &&
      event.type === "runtime" &&
      event.event.kind === "bound"
    )).toBe(true);

    await page.evaluate(
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(task.id)}))`,
    );
    await waitLong(
      page,
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => ['awaiting_review', 'failed'].includes((await m.listResearchTasks(${scriptValue(appProjectId)})).find(t => t.id === ${scriptValue(task.id)})?.status))`,
      180_000,
    );
    const settled = await page.evaluate<ResearchTask>(
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(appProjectId)})).find(t => t.id === ${scriptValue(task.id)}))`,
    );
    expect(settled.status, settled.error ?? "DOCX format task result").toBe("awaiting_review");
    expect(firstRead).toBeTruthy();
    expect(firstFormat).toBeTruthy();
    expect(firstSave).toBeTruthy();
    expect(firstCheck).toBeTruthy();
    expect(secondFormat).toBeTruthy();
    expect(secondSave).toBeTruthy();
    expect(secondCheck).toBeTruthy();
    for (const receipt of [firstRead, firstFormat, firstSave, firstCheck, secondFormat, secondSave, secondCheck]) {
      expect(receipt!.ok).toBe(true);
    }

    expect(firstRead!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 0,
      savedRevision: 0,
      sourceSha256: sha256(manuscriptBytes),
    });
    expect(firstRead!.result).toMatchObject({
      sourceSha256: liveExportSha256,
      revision: 0,
      paragraph: { paragraphRef: bodyParagraphRef, text: BODY_TEXT },
    });
    expect(firstFormat!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 1,
      savedRevision: 0,
    });
    expect(firstFormat!.document.sessionRevision).toBeGreaterThan(firstFormat!.document.savedRevision);
    expect(firstFormat!.result).toMatchObject({ ok: true, changed: true, revision: 1 });
    expect(firstSave!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 1,
      savedRevision: 1,
    });
    expect(firstSave!.result.baselineId).not.toBe(liveBefore.document.baselineId);
    expect(firstSave!.result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstSave!.result.sourceSha256).not.toBe(sha256(manuscriptBytes));
    expect(firstCheck!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 1,
      savedRevision: 1,
      baselineId: firstSave!.result.baselineId,
    });
    expect(firstCheck!.result).toMatchObject({
      template: world.version_id,
      check: {
        project_id: manuscriptProject.project_id,
        baseline_id: firstSave!.result.baselineId,
        world_version_id: world.version_id,
      },
    });

    expect(secondFormat!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 2,
      savedRevision: 1,
      baselineId: firstSave!.result.baselineId,
    });
    expect(secondFormat!.document.sessionRevision).toBeGreaterThan(secondFormat!.document.savedRevision);
    expect(secondFormat!.result).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(secondSave!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 2,
      savedRevision: 2,
    });
    expect(secondSave!.result.baselineId).not.toBe(firstSave!.result.baselineId);
    expect(secondSave!.result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondSave!.result.sourceSha256).not.toBe(firstSave!.result.sourceSha256);
    expect(secondCheck!.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 2,
      savedRevision: 2,
      baselineId: secondSave!.result.baselineId,
    });
    expect(secondCheck!.result).toMatchObject({
      template: world.version_id,
      check: {
        project_id: manuscriptProject.project_id,
        baseline_id: secondSave!.result.baselineId,
        world_version_id: world.version_id,
      },
    });

    const liveAfter = await page.evaluate<DocxDocumentRead>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
    );
    expect(liveAfter.document).toMatchObject({
      sessionId: liveBefore.document.sessionId,
      sessionRevision: 2,
      savedRevision: 2,
      baselineId: secondSave!.result.baselineId,
      sourceSha256: secondSave!.result.sourceSha256,
      dirty: false,
    });

    const retainedSource = async (baselineId: string) => journalRequest<{
      source_sha256: string;
      content_base64: string;
    }>(
      page,
      `/api/manuscript-source?project_id=${encodeURIComponent(manuscriptProject.project_id)}&baseline_id=${encodeURIComponent(baselineId)}`,
    );
    const firstRetained = await retainedSource(firstSave!.result.baselineId);
    const firstRetainedBytes = Buffer.from(firstRetained.content_base64, "base64");
    expect(firstRetained.source_sha256).toBe(firstSave!.result.sourceSha256);
    expect(sha256(firstRetainedBytes)).toBe(firstSave!.result.sourceSha256);
    const firstXml = strFromU8(unzipSync(firstRetainedBytes)["word/document.xml"]);
    expect(firstXml).toContain(BODY_TEXT);
    const firstRetainedFont = [...firstXml.matchAll(/<w:rFonts\b[^>]*\/>/g)]
      .map((match) => match[0])
      .find((element) => element.includes(`w:eastAsia="${EAST_ASIA_FONT}"`));
    expect(firstRetainedFont, firstXml).toBeTruthy();
    expect(firstRetainedFont).toContain(`w:ascii="${LATIN_FONT}"`);
    expect(firstRetainedFont).toContain(`w:hAnsi="${LATIN_FONT}"`);
    expect(firstXml).not.toMatch(/<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/);

    const secondRetained = await retainedSource(secondSave!.result.baselineId);
    const secondRetainedBytes = Buffer.from(secondRetained.content_base64, "base64");
    expect(secondRetained.source_sha256).toBe(secondSave!.result.sourceSha256);
    expect(sha256(secondRetainedBytes)).toBe(secondSave!.result.sourceSha256);
    const secondXml = strFromU8(unzipSync(secondRetainedBytes)["word/document.xml"]);
    expect(secondXml).toContain(BODY_TEXT);
    const secondRetainedFont = [...secondXml.matchAll(/<w:rFonts\b[^>]*\/>/g)]
      .map((match) => match[0])
      .find((element) => element.includes(`w:eastAsia="${EAST_ASIA_FONT}"`));
    expect(secondRetainedFont, secondXml).toBeTruthy();
    expect(secondRetainedFont).toContain(`w:ascii="${LATIN_FONT}"`);
    expect(secondRetainedFont).toContain(`w:hAnsi="${LATIN_FONT}"`);
    expect(secondXml).toMatch(/<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/);

    const firstTaskCheck = await journalRequest<JournalCheck>(
      page,
      `/api/check?check_id=${encodeURIComponent(firstCheck!.result.check.check_id)}`,
    );
    expect(firstTaskCheck).toMatchObject({
      project_id: manuscriptProject.project_id,
      baseline_id: firstSave!.result.baselineId,
      world_version_id: world.version_id,
      validity: "STALE",
    });
    const firstResolved = (await eastAsiaFindings(page, firstTaskCheck, "observed_match"))
      .find((finding) => finding.case_id === initialDifference!.case_id);
    expect(firstResolved, JSON.stringify(firstTaskCheck, null, 2)).toMatchObject({
      object_id: initialDifference!.object_id,
      property_path: "run.fontFamilyEastAsia",
      observed: EAST_ASIA_FONT,
      expected: EAST_ASIA_FONT,
      verdict: "observed_match",
    });
    const secondTaskCheck = await journalRequest<JournalCheck>(
      page,
      `/api/check?check_id=${encodeURIComponent(secondCheck!.result.check.check_id)}`,
    );
    expect(secondTaskCheck).toMatchObject({
      project_id: manuscriptProject.project_id,
      baseline_id: secondSave!.result.baselineId,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    const secondResolved = (await eastAsiaFindings(page, secondTaskCheck, "observed_match"))
      .find((finding) => finding.case_id === initialDifference!.case_id);
    expect(secondResolved, JSON.stringify(secondTaskCheck, null, 2)).toMatchObject({
      object_id: initialDifference!.object_id,
      property_path: "run.fontFamilyEastAsia",
      observed: EAST_ASIA_FONT,
      expected: EAST_ASIA_FONT,
      verdict: "observed_match",
    });

    await expectNoRecoverySnapshot(
      page,
      appProjectId,
      liveBefore.document.workbenchProjectId,
    );

    let operations: DocxActivity[] = [];
    await expect.poll(async () => {
      const activities = await taskActivities(
        page,
        appProjectId,
        liveBefore.document.workbenchProjectId,
      );
      operations = activities.filter((activity) =>
        activity.origin.taskId === task.id &&
        activity.event.type === "runtime" &&
        ["operationStarted", "operation"].includes(activity.event.event.kind)
      );
      const startedCount = operations.filter((activity) =>
        activity.event.type === "runtime" &&
        activity.event.event.kind === "operationStarted"
      ).length;
      const finishedCount = operations.filter((activity) =>
        activity.event.type === "runtime" &&
        activity.event.event.kind === "operation"
      ).length;
      return `${startedCount}:${finishedCount}`;
    }, { timeout: 30_000 }).toBe("7:7");

    const started = operations.filter((activity) =>
      activity.event.type === "runtime" &&
      activity.event.event.kind === "operationStarted"
    );
    const finished = operations.filter((activity) =>
      activity.event.type === "runtime" &&
      activity.event.event.kind === "operation"
    );
    expect(finished).toHaveLength(7);
    expect(started.map((activity) =>
      activity.event.type === "runtime" &&
      activity.event.event.kind === "operationStarted"
        ? activity.event.event.operation
        : null
    ).sort()).toEqual(["check", "check", "format", "format", "read_format", "save", "save"]);
    expect(finished.map((activity) =>
      activity.event.type === "runtime" &&
      activity.event.event.kind === "operation"
        ? activity.event.event.operation
        : null
    ).sort()).toEqual(["check", "check", "format", "format", "read_format", "save", "save"]);

    const pairs = started.map((start) => {
      if (start.event.type !== "runtime" || start.event.event.kind !== "operationStarted") {
        throw new Error("Expected a retained operation intent.");
      }
      const completed = finished.find((activity) =>
        activity.event.type === "runtime" &&
        activity.event.event.kind === "operation" &&
        activity.event.event.operationId === start.id
      );
      expect(completed, `Missing finished operation for ${start.event.event.operation}`).toBeTruthy();
      expect(completed!.origin).toEqual(start.origin);
      if (completed!.event.type !== "runtime" || completed!.event.event.kind !== "operation") {
        throw new Error("Expected a retained operation result.");
      }
      return { start, completed: completed!, startEvent: start.event.event, completedEvent: completed!.event.event };
    });
    expect(pairs.map(({ startEvent }) => startEvent.operation)).toEqual([
      "read_format", "format", "save", "check", "format", "save", "check",
    ]);

    const [
      firstReadPair,
      firstFormatPair,
      firstSavePair,
      firstCheckPair,
      secondFormatPair,
      secondSavePair,
      secondCheckPair,
    ] = pairs;
    expect(firstReadPair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      query: { kind: "objects", paragraph_ref: bodyParagraphRef, limit: 50 },
    });
    expect(firstReadPair.completedEvent.result).toMatchObject({
      operation: "read_format",
      ok: true,
      document: { sourceSha256: sha256(manuscriptBytes) },
      result: {
        sourceSha256: liveExportSha256,
        revision: 0,
        paragraphRef: bodyParagraphRef,
      },
    });
    expect(firstFormatPair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      paragraph_ref: bodyParagraphRef,
      expected_revision: 0,
      format: { font: { name: LATIN_FONT, nameEastAsia: EAST_ASIA_FONT } },
    });
    expect(firstFormatPair.completedEvent.result).toMatchObject({
      operation: "format",
      ok: true,
      result: { ok: true, changed: true, revision: 1 },
    });
    expect(firstSavePair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      expected_revision: 1,
    });
    expect(firstSavePair.completedEvent.result).toMatchObject({
      operation: "save",
      ok: true,
      result: {
        baselineId: firstSave!.result.baselineId,
        revision: 1,
        sourceSha256: firstSave!.result.sourceSha256,
      },
    });
    expect(firstCheckPair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      template: world.version_id,
    });
    expect(firstCheckPair.completedEvent.result).toMatchObject({
      operation: "check",
      ok: true,
      result: {
        template: world.version_id,
        check: {
          check_id: firstCheck!.result.check.check_id,
          baseline_id: firstSave!.result.baselineId,
          world_version_id: world.version_id,
        },
      },
    });
    expect(secondFormatPair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      paragraph_ref: bodyParagraphRef,
      expected_revision: 1,
      format: { font: { bold: true } },
    });
    expect(secondFormatPair.completedEvent.result).toMatchObject({
      operation: "format",
      ok: true,
      result: { ok: true, changed: true, revision: 2 },
    });
    expect(secondSavePair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      expected_revision: 2,
    });
    expect(secondSavePair.completedEvent.result).toMatchObject({
      operation: "save",
      ok: true,
      result: {
        baselineId: secondSave!.result.baselineId,
        revision: 2,
        sourceSha256: secondSave!.result.sourceSha256,
      },
    });
    expect(secondCheckPair.startEvent.request).toMatchObject({
      session_id: liveBefore.document.sessionId,
      template: world.version_id,
    });
    expect(secondCheckPair.completedEvent.result).toMatchObject({
      operation: "check",
      ok: true,
      result: {
        template: world.version_id,
        check: {
          check_id: secondCheck!.result.check.check_id,
          baseline_id: secondSave!.result.baselineId,
          world_version_id: world.version_id,
        },
      },
    });

    const allActivities = await taskActivities(
      page,
      appProjectId,
      liveBefore.document.workbenchProjectId,
    );
    const checkpoints = allActivities.filter((activity) =>
      activity.origin.taskId === task.id &&
      activity.event.type === "operationCheckpoint"
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      if (checkpoint.event.type !== "operationCheckpoint") {
        throw new Error("Expected a retained operation checkpoint.");
      }
      const checkpointEvent = checkpoint.event;
      const completed = finished.find((activity) =>
        activity.event.type === "runtime" &&
        activity.event.event.kind === "operation" &&
        activity.event.event.operationId === checkpointEvent.operationId
      );
      expect(completed, `Missing operation ${checkpointEvent.operationId} for checkpoint`).toBeTruthy();
      expect(checkpoint.origin).toEqual(completed!.origin);
      expect(checkpoint.document).toEqual(completed!.document);
    }
    const checkpointOperations = new Set(checkpoints.map((activity) =>
      activity.event.type === "operationCheckpoint" ? activity.event.operationId : ""
    ));
    for (const { start, startEvent } of pairs) {
      if (startEvent.operation === "format" || startEvent.operation === "check") {
        expect(checkpointOperations.has(start.id)).toBe(true);
      }
    }

    const expectedOrigin = started[0].origin;
    for (const activity of [...started, ...finished, ...checkpoints]) {
      expect(activity.origin).toEqual(expectedOrigin);
      expect(activity.origin).toMatchObject({
        taskId: task.id,
        generation: settled.executionGeneration,
        groupId: group.group.id,
      });
      expect(activity.origin.memberId).toBeTruthy();
      expect(activity.origin.executionId).toBeTruthy();
      expect(activity.origin.workIds.length).toBeGreaterThan(0);
    }
    const retainedGroup = await page.evaluate<GroupSnapshot>(
      `window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskGroup(${scriptValue(appProjectId)}, ${scriptValue(task.id)}))`,
    );
    const execution = retainedGroup.executions.find((item) =>
      item.id === expectedOrigin.executionId
    );
    expect(execution).toMatchObject({
      memberId: expectedOrigin.memberId,
      agentId: PROVIDER,
      modelId: MODEL,
    });
    for (const workId of expectedOrigin.workIds) {
      expect(retainedGroup.work).toContainEqual(expect.objectContaining({
        id: workId,
        executionId: expectedOrigin.executionId,
        memberId: expectedOrigin.memberId,
      }));
    }

    await clickButton(page, '[data-testid="docx-workspace"]', "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
    await expect(page.getByTestId("docx-recovery-dialog")).toHaveCount(0);
    const normalOpen = page.getByTestId("journal-checks-panel")
      .getByText("Edit DOCX working copy", { exact: true });
    await expect(normalOpen).toBeEnabled({ timeout: 60_000 });
    await normalOpen.click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("docx-recovery-dialog")).toHaveCount(0);

    let reopened: DocxDocumentRead | undefined;
    await expect.poll(async () => {
      try {
        const read = await page.evaluate<DocxDocumentRead>(
          `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
        );
        if (
          read.document.sessionId === liveBefore.document.sessionId ||
          read.document.baselineId !== secondSave!.result.baselineId
        ) return false;
        reopened = read;
        return true;
      } catch {
        return false;
      }
    }, { timeout: 90_000 }).toBe(true);
    expect(reopened).toBeTruthy();
    expect(reopened!.document).toMatchObject({
      appProjectId,
      workbenchProjectId: manuscriptProject.project_id,
      baselineId: secondSave!.result.baselineId,
      sourceSha256: secondSave!.result.sourceSha256,
      sessionRevision: 0,
      savedRevision: 0,
      dirty: false,
    });
    expect(reopened!.document.sessionId).not.toBe(liveBefore.document.sessionId);
    expect(reopened!.paragraphs.some((paragraph) => paragraph.text === BODY_TEXT)).toBe(true);

    await writeFile(output("docx-format-task-report.json"), JSON.stringify({
      outcome: "PASSED",
      modelCalls: "scripted provider; actual native runtime and editor",
      operations: pairs.map(({ start, completed, startEvent }) => ({
        operation: startEvent.operation, intentId: start.id, resultId: completed.id,
        origin: completed.origin, document: completed.document,
      })),
      firstCheck: { checkId: firstTaskCheck.check_id, validity: firstTaskCheck.validity },
      secondCheck: { checkId: secondTaskCheck.check_id, validity: secondTaskCheck.validity },
      checkpoints: checkpoints.length,
      reopened: reopened!.document,
    }, null, 2));
    await writeFile(output("docx-format-task-saved.docx"), secondRetainedBytes);
    await page.screenshot({ path: output("docx-format-task.png") });
  } finally {
    await writeFile(output("docx-format-task-requests.json"), JSON.stringify(
      server.requestBodies().map((body) => JSON.parse(body)), null, 2,
    ));
    await server.close();
  }
});

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import type {
  DocxActivityDocument,
  DocxDocumentRead,
} from "../../packages/ai-tools/src/tools";
import type {
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import { test, expect } from "../fixtures";
import { closeAssistant, createBlankProject, fillTextarea, openRailTab, waitLong } from "../helpers";
import {
  readWordPackageIdentity,
  verifyWordFormatCandidateBytes,
  WORD_FORMAT_CANDIDATE_TIMEOUT_MS,
  WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES,
} from "../helpers/word-format-candidate";
import { scriptValue } from "../script-value";

type Page = TauriPage | BrowserPageAdapter;

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

const PROVIDER = "word-manuscript-live";
const MODEL = process.env.OLEAFLY_WORD_MANUSCRIPT_MODEL ?? "gpt/gpt-6.2-sol";
const MODEL_EFFORT = "max" as const;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function journalRequest<T>(page: Page, path: string, payload?: unknown) {
  const payloadArgument = payload === undefined ? "" : `,${scriptValue(payload)}`;
  return page.evaluate<T>(
    `window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m =>
      m.journalRequest(${scriptValue(path)}${payloadArgument}))`,
  );
}

interface TemplateSource {
  worldVersionId: string;
  sourceSha256: string;
  bytes: Uint8Array;
}

interface InputHashes {
  template: string;
  english: string;
  chinese: string;
}

async function readInputHashes(paths: Record<keyof InputHashes, string>) {
  return {
    template: sha256(await readFile(paths.template)),
    english: sha256(await readFile(paths.english)),
    chinese: sha256(await readFile(paths.chinese)),
  };
}

function writeReport(path: string, report: Record<string, unknown>) {
  return writeFile(path, JSON.stringify(report, null, 2));
}

async function configureProvider(page: Page) {
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      const next = {
        ...config,
        ai_provider:${scriptValue(PROVIDER)},
        ai_model:${scriptValue(MODEL)},
        ai_custom_providers:[
          ...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}),
          {
            id:${scriptValue(PROVIDER)},
            name:'Word manuscript live relay',
            baseURL:${scriptValue(relay)},
            keyOptional:true
          }
        ],
        ai_provider_models:{
          ...config.ai_provider_models,
          [${scriptValue(PROVIDER)}]:[{
            id:${scriptValue(MODEL)},
            name:${scriptValue(MODEL)},
            enabled:true,
            source:'custom',
            metadata:{
              name:${scriptValue(MODEL)},
              toolCall:true,
              reasoning:true,
              reasoningOptions:[{type:'effort',values:[${scriptValue(MODEL_EFFORT)}]}]
            }
          }]
        }
      };
      await api.setConfig(next);
      window.dispatchEvent(new CustomEvent('oleafly:ai-config-changed', { detail: next }));
    })`,
  );
}

async function clickWorkspaceButton(page: Page, label: string) {
  await page.evaluate(
    `(() => {
      const root=document.querySelector('[data-testid="docx-workspace"]');
      if (!root) throw new Error('The Word workspace is unavailable.');
      const button=Array.from(root.querySelectorAll('button')).find(item =>
        item.textContent.trim()===${scriptValue(label)}
        || item.getAttribute('aria-label')===${scriptValue(label)}
      );
      if (!button || button.disabled) throw new Error('Unavailable workspace button '+${scriptValue(label)});
      button.click();
    })()`,
  );
}

async function closeWorkspace(page: Page) {
  if (!await page.getByTestId("docx-workspace").count()) return;
  await clickWorkspaceButton(page, "Close");
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0, {
    timeout: 60_000,
  });
}

async function returnToLibrary(page: Page) {
  const back = page.locator('[title="Back to library"]');
  if (await back.count() && await back.isVisible()) await back.click();
}

async function documentState(
  page: Page,
  sessionId?: string,
): Promise<DocxActivityDocument> {
  const query = sessionId ? { limit: 1, sessionId } : { limit: 1 };
  const read = await page.evaluate<DocxDocumentRead>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
      m.DOCX_AGENT_HOST.readDocument(${scriptValue(query)}))`,
  );
  return read.document;
}

async function waitForDocument(
  page: Page,
  predicate: (document: DocxActivityDocument) => boolean,
  timeout = 180_000,
) {
  let current: DocxActivityDocument | undefined;
  await expect.poll(async () => {
    try {
      current = await documentState(page);
      return predicate(current);
    } catch {
      return false;
    }
  }, { timeout }).toBe(true);
  return current!;
}

async function exportWorkspaceCopy(page: Page, path: string, label = "Download DOCX copy") {
  await expect.poll(() => page.evaluate(
    `(() => {
      const root=document.querySelector('[data-testid="docx-workspace"]');
      return Boolean(root && Array.from(root.querySelectorAll('button')).some(item =>
        item.textContent.trim()===${scriptValue(label)} && !item.disabled && item.getClientRects().length
      ));
    })()`,
  ), { timeout: 120_000 }).toBe(true);
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(path)})`);
  await clickWorkspaceButton(page, label);
  await expect.poll(async () => {
    try {
      return (await readFile(path)).byteLength;
    } catch {
      return 0;
    }
  }, { timeout: 90_000 }).toBeGreaterThan(0);
  return new Uint8Array(await readFile(path));
}

async function waitForCandidate(page: Page) {
  const panel = page.getByTestId("docx-format-candidate");
  let phase: string | null = null;
  let started = false;
  await expect.poll(async () => {
    const state = await page.evaluate<{ phase: string | null; workspace: boolean; error: string | null }>(`(() => ({
      phase: document.querySelector('[data-testid="docx-format-candidate"]')?.getAttribute('data-phase') ?? null,
      workspace: Boolean(document.querySelector('[data-testid="docx-workspace"]')),
      error: document.querySelector('[data-testid="error-boundary"], [data-testid="workspace-word-surface"] [data-testid="surface-error-boundary"]')?.textContent ?? null,
    }))()`);
    if (state.error || (started && !state.phase)) throw new Error(`The Word candidate panel disappeared: ${JSON.stringify(state)}`);
    started ||= state.phase === "running";
    phase = state.phase;
    return phase;
  }, { timeout: WORD_FORMAT_CANDIDATE_TIMEOUT_MS, intervals: [1_000, 2_000] }).toMatch(/^(ready|unchanged|failed)$/);
  if (phase !== "ready") throw new Error(`The Word format candidate ended in ${phase}: ${await panel.innerText()}`);
  return panel;
}

async function typeInWorkingCopy(page: Page, marker: string, before: DocxActivityDocument) {
  const textRun = page.locator('[data-testid="docx-editor-surface"] .layout-run-text[data-start]').first();
  await expect(textRun).toBeVisible({ timeout: 30_000 });
  await textRun.click();
  await page.keyboard.insertText(marker);
  const after = await waitForDocument(page, (current) =>
    current.sessionId === before.sessionId && current.sessionRevision > before.sessionRevision && current.dirty, 30_000);
  const found = await page.evaluate<boolean>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(async m => {
      const read = await m.DOCX_AGENT_HOST.readDocument(${scriptValue({ sessionId: before.sessionId, limit: 10 })});
      return read.paragraphs.some(paragraph => paragraph.text.includes(${scriptValue(marker.trim())}));
    })`,
  );
  expect(found).toBe(true);
  return after;
}

async function importTemplateThroughUi(
  page: Page,
  bytes: Uint8Array,
  filename: string,
  journalName: string,
) {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Use Word as template", { exact: true }))
    .toBeEnabled({ timeout: 120_000 });
  await panel.getByText("Use Word as template", { exact: true }).click();
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  await expect(dialog).toBeVisible();
  await page.setInputFiles(
    '[role="dialog"][data-state="open"] input[type="file"]',
    [{
      name: filename,
      mimeType: "application/msword",
      buffer: Buffer.from(bytes),
    }],
  );
  await page.fill(
    '[role="dialog"][data-state="open"] input[id$="-name"]',
    journalName,
  );
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0, {
    timeout: 240_000,
  });
}

async function waitForWorld(page: Page, journalName: string) {
  let versionId: string | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    versionId = state.worlds.find((item) =>
      item.journal_name === journalName)?.version_id;
    return Boolean(versionId);
  }, { timeout: 180_000 }).toBe(true);
  return journalRequest<JournalWorld>(
    page,
    `/api/world?version_id=${encodeURIComponent(versionId!)}`,
  );
}

async function retainTemplateSource(
  page: Page,
  worldVersionId: string,
): Promise<TemplateSource> {
  const source = await page.evaluate<{
    worldVersionId: string;
    sourceSha256: string;
    bytes: number[];
  }>(
    `window.__oleaflyE2EImport('/src/lib/docx-template-client.ts').then(m =>
      m.loadTemplateSource(${scriptValue(worldVersionId)}).then(source => ({
        worldVersionId:source.worldVersionId,
        sourceSha256:source.sourceSha256,
        bytes:Array.from(source.bytes)
      })))`,
  );
  return {
    ...source,
    bytes: Uint8Array.from(source.bytes),
  };
}

async function createLanguageProject(
  page: Page,
  language: "en" | "zh",
  path: string,
  source: Uint8Array,
) {
  await returnToLibrary(page);
  await createBlankProject(page, `Word manuscript ${language} ${Date.now()}`);
  const appProjectId = await page.evaluate<string>(
    `window.__oleaflyE2EImport('/src/store/files.ts').then(m =>
      m.useFilesStore.getState().projectId)`,
  );
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m =>
      m.saveFileBase64(${scriptValue(appProjectId)},${scriptValue(path)},${scriptValue(Buffer.from(source).toString("base64"))}))`,
  );
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/store/files.ts').then(m =>
      m.useFilesStore.getState().refreshTree())`,
  );
  await openProjectDocx(page, path);
  await expect(page.getByTestId("docx-workspace")).toBeVisible({
    timeout: 180_000,
  });
  const document = await waitForDocument(page, (current) =>
    current.sourceSha256 === sha256(source) && current.dirty === false);
  return { appProjectId, document };
}

async function openProjectDocx(page: Page, filePath: string) {
  await openRailTab(page, "Explorer");
  const folder = dirname(filePath);
  if (folder !== ".") {
    const row = page.locator(`[role="treeitem"][data-path="${folder}"]`);
    await expect(row).toBeVisible();
    if (await row.getAttribute("aria-expanded") === "false") await row.click();
  }
  await page.locator(`[role="treeitem"][data-path="${filePath}"]`).click();
}

async function selectJournalValue(
  page: Page,
  selector: string,
  value: string,
) {
  const select = page.locator(selector);
  await expect(select).toBeVisible({ timeout: 120_000 });
  await expect(select).toBeEnabled({ timeout: 120_000 });
  await expect(select.locator(`option[value="${value}"]`)).toHaveCount(1, {
    timeout: 120_000,
  });
  if (await select.inputValue() !== value) {
    await select.selectOption(value);
  } else {
    await page.evaluate(
      `(() => {
        const select=document.querySelector(${scriptValue(selector)});
        if (!select) throw new Error('Missing select '+${scriptValue(selector)});
        select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`,
    );
  }
  await expect(select).toHaveValue(value);
}

async function bindOpenedDocumentToWorld(
  page: Page,
  workbenchProjectId: string,
  worldVersionId: string,
) {
  await openRailTab(page, "Journal checks");
  const panel = page.getByTestId("journal-checks-panel");
  await selectJournalValue(page, '[data-testid="journal-checks-panel"] select', workbenchProjectId);
  await expect(panel).toHaveAttribute("aria-busy", "false", {
    timeout: 120_000,
  });
  await selectJournalValue(page, '[data-testid="journal-world-select"]', worldVersionId);
  await expect(panel).toHaveAttribute("aria-busy", "false", {
    timeout: 120_000,
  });
  await page.locator('[data-testid="workspace-word-tab"] button').first().click();
  const start = page.getByTestId("docx-start-format-candidate");
  await expect(start).toBeVisible({ timeout: 120_000 });
  await expect(start).toBeEnabled({ timeout: 180_000 });
}

function identity(document: DocxActivityDocument) {
  return {
    appProjectId: document.appProjectId,
    workbenchProjectId: document.workbenchProjectId,
    sessionId: document.sessionId,
    baselineId: document.baselineId,
    sessionRevision: document.sessionRevision,
    sourceSha256: document.sourceSha256,
    dirty: document.dirty,
  };
}

async function prepareInChat(page: Page) {
  await openRailTab(page, "Research Assistant");
  const composer = '[data-testid="research-assistant"] [data-chat-composer] textarea';
  await expect(page.locator(composer)).toBeVisible({ timeout: 90_000 });
  await page.press('[data-testid="ai-effort-selector"]', "Enter");
  await page.getByText("Max", { exact: true }).click();
  await fillTextarea(page, composer, "按这份模板排，不改内容");
  await page.press(composer, "Enter");
  const panel = await waitForCandidate(page);
  await waitLong(page, '!document.querySelector(\'[data-testid="research-assistant"] [data-chat-composer] button[aria-label="Stop"]\')', WORD_FORMAT_CANDIDATE_TIMEOUT_MS);
  await closeAssistant(page);
  return panel;
}

test("real Sol proposes and adopts supported format changes from actual templates and manuscripts", async ({
  tauriPage: page,
}, testInfo) => {
  test.skip(
    !enabled
      || !relay
      || !run
      || !templatePath
      || !englishPath
      || !chinesePath
      || !expectedInputs.template
      || !expectedInputs.english
      || !expectedInputs.chinese,
    "Enable OLEAFLY_WORD_MANUSCRIPT_LIVE with the isolated runner, relay and all three hashed inputs.",
  );
  test.setTimeout(3 * WORD_FORMAT_CANDIDATE_TIMEOUT_MS + 15 * 60_000);
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
    mode: "real-source-format-candidate",
    provider: PROVIDER,
    model: MODEL,
    requestedProviderEffort: {
      uiRequest: "medium",
      availableChoices: [MODEL_EFFORT],
      effective: MODEL_EFFORT,
    },
    candidateTimeoutMinutes: WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES,
    inputs: paths,
    initialHashes: null,
    finalHashes: null,
    normalizedTemplate: null,
    languages: {},
    scope:
      "Word button and ordinary chat run on exact read-only author files and the actual legacy template. Acceptance covers preview, adoption, exact export and reopen bytes, protected-package verification and concurrent editing. It does not establish Word/WPS pagination or complete journal compliance.",
  };
  const write = () => writeReport(reportPath, report);
  const languages = report.languages as Record<string, Record<string, unknown>>;
  let normalizedTemplate: TemplateSource | undefined;
  let world: JournalWorld | undefined;
  let initialHashes: InputHashes | undefined;
  try {
    initialHashes = await readInputHashes(paths);
    report.initialHashes = initialHashes;
    for (const key of ["template", "english", "chinese"] as const) {
      if (initialHashes[key] !== expectedInputs[key]) {
        throw new Error(
          `${key} input hash is ${initialHashes[key]}, runner expected ${expectedInputs[key]}`,
        );
      }
    }
    await write();

    await closeWorkspace(page);
    await returnToLibrary(page);
    await createBlankProject(page, `Word format template ${Date.now()}`);
    await configureProvider(page);
    await openRailTab(page, "Journal checks");
    await expect.poll(
      () => journalRequest<JournalState>(page, "/api/state")
        .then(() => true, () => false),
      { timeout: 120_000 },
    ).toBe(true);

    const templateBytes = new Uint8Array(await readFile(paths.template));
    const journalName = `Word manuscript template ${Date.now()}`;
    await importTemplateThroughUi(
      page,
      templateBytes,
      basename(paths.template),
      journalName,
    );
    world = await waitForWorld(page, journalName);
    expect(world.template?.original_sha256).toBe(initialHashes.template);
    normalizedTemplate = await retainTemplateSource(page, world.version_id);
    expect(normalizedTemplate.worldVersionId).toBe(world.version_id);
    expect(normalizedTemplate.sourceSha256).toBe(world.template?.source_sha256);
    expect(sha256(normalizedTemplate.bytes)).toBe(normalizedTemplate.sourceSha256);
    await writeFile(normalizedPath, normalizedTemplate.bytes);
    report.normalizedTemplate = {
      path: normalizedPath,
      sourceSha256: normalizedTemplate.sourceSha256,
    };
    report.worldVersionId = world.version_id;
    await write();

    for (const language of ["en", "zh"] as const) {
      const inputPath = language === "en" ? paths.english : paths.chinese;
      const source = new Uint8Array(await readFile(inputPath));
      const inputSha256 = sha256(source);
      expect(inputSha256).toBe(
        language === "en" ? initialHashes.english : initialHashes.chinese,
      );
      const languageReport: Record<string, unknown> = {
        stage: "source-ready",
        inputPath,
        inputSha256,
      };
      languages[language] = languageReport;
      await write();

      const filePath = language === "zh" ? `中文稿/${basename(inputPath)}` : basename(inputPath);
      const openedProject = await createLanguageProject(
        page,
        language,
        filePath,
        source,
      );
      const opened = openedProject.document;
      expect(identity(opened)).toMatchObject({
        appProjectId: openedProject.appProjectId,
        sourceSha256: inputSha256,
        dirty: false,
      });
      languageReport.appProjectId = openedProject.appProjectId;
      languageReport.opened = identity(opened);
      languageReport.stage = "opened-clean";
      await write();

      const initialExportPath = resolve(
        run!,
        `word-format-candidate-${language}-initial.docx`,
      );
      const initialExport = await exportWorkspaceCopy(page, initialExportPath);
      const initialExportSha256 = sha256(initialExport);
      expect(initialExportSha256).toBe(opened.sourceSha256);
      expect(await page.evaluate(
        `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
          m.DOCX_AGENT_HOST.readDocument({limit:1})).then(r => r.document)`,
      )).toEqual(opened);
      languageReport.initialExport = {
        path: initialExportPath,
        sha256: initialExportSha256,
        package: readWordPackageIdentity(initialExport),
      };
      await write();

      await bindOpenedDocumentToWorld(
        page,
        opened.workbenchProjectId,
        world!.version_id,
      );
      const beforeCandidate = await documentState(page);
      expect(identity(beforeCandidate)).toEqual(identity(opened));
      languageReport.beforeCandidate = identity(beforeCandidate);
      if (language === "zh" && process.env.OLEAFLY_ACCEPTANCE_DISABLE_RESEARCH_BUDGET_STOP === "1") {
        const budget = await page.evaluate<{ stored: number; enforcement: number | null }>(
          `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
            const id = ${scriptValue(openedProject.appProjectId)};
            await api.budgetSet(id, 0.01);
            return { stored: await api.budgetGet(id), enforcement: await api.budgetGet(id, true) };
          })`,
        );
        expect(budget).toEqual({ stored: 0.01, enforcement: null });
        report.developmentBudget = budget;
      }
      languageReport.stage = "candidate-running";
      await write();

      const panel = language === "zh" ? await prepareInChat(page) : await (async () => {
        await page.getByTestId("docx-start-format-candidate").click();
        return waitForCandidate(page);
      })();
      const changeButtons = panel.getByTestId("docx-format-candidate-change-location");
      await expect.poll(() => changeButtons.count(), {
        timeout: 60_000,
      }).toBeGreaterThan(0);
      const changeCount = await changeButtons.count();
      const confirmedCount = Number(await panel.getAttribute("data-confirmed-count"));
      expect(confirmedCount).toBeGreaterThanOrEqual(changeCount);
      languageReport.candidate = {
        phase: "ready",
        entry: language === "zh" ? "chat" : "toolbar",
        changeCount: confirmedCount,
        changeGroups: changeCount,
        firstChange: await changeButtons.first().innerText(),
        unresolvedGroups: await panel.locator('[data-testid^="docx-finding-group-"]').count(),
      };
      languageReport.stage = "candidate-ready";
      await write();

      await changeButtons.first().click();
      const preview = page.getByTestId("docx-format-candidate-preview");
      await expect(preview).toBeVisible({ timeout: 60_000 });
      await expect(preview).toHaveAttribute("data-docx-history", "readonly");
      const highlighted = preview.locator("[data-docx-anchor-highlight]");
      await expect.poll(() => highlighted.count(), {
        timeout: 30_000,
        intervals: [100, 250],
      }).toBeGreaterThan(0);
      const duringPreview = await documentState(page, beforeCandidate.sessionId);
      expect(identity(duringPreview)).toEqual(identity(beforeCandidate));
      languageReport.preview = {
        readonly: true,
        locatedTargetHighlighted: true,
        activeDocumentUnchanged: true,
        activeDocument: identity(duringPreview),
      };
      await write();

      await page.getByTestId("docx-adopt-format-candidate").click();
      await expect(panel).toHaveAttribute("data-phase", "adopted", {
        timeout: 180_000,
      });
      await expect(page.getByTestId("docx-format-candidate-adopted"))
        .toBeVisible();
      const adopted = await waitForDocument(page, (current) =>
        current.dirty === false
        && current.sessionId !== beforeCandidate.sessionId
        && current.baselineId !== beforeCandidate.baselineId
        && current.sourceSha256 !== beforeCandidate.sourceSha256);
      languageReport.adopted = identity(adopted);
      languageReport.stage = "adopted";
      await write();

      const adoptedExportPath = resolve(
        run!,
        `word-format-candidate-${language}-adopted.docx`,
      );
      const adoptedExport = await exportWorkspaceCopy(page, adoptedExportPath, "Export DOCX");
      const adoptedExportSha256 = sha256(adoptedExport);
      expect(adoptedExportSha256).toBe(adopted.sourceSha256);
      const priorVersionSha256 = await page.evaluate<string>(
        `window.__oleaflyE2EImport('/src/lib/docx-workbench.ts').then(async api => {
          const source = await api.loadDocxSource(${scriptValue(beforeCandidate.workbenchProjectId)}, ${scriptValue(beforeCandidate.baselineId)});
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', source.bytes));
          return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
        })`,
      );
      expect(priorVersionSha256).toBe(initialExportSha256);
      const verification = verifyWordFormatCandidateBytes({
        sourceBytes: initialExport,
        candidateBytes: adoptedExport,
      });
      expect(verification.passed).toBe(true);
      expect(verification.package.actualFormatChange).toBe(true);
      expect(verification.package.protectedXmlPreserved).toBe(true);
      expect(verification.package.pageFlowPreserved).toBe(true);
      expect(verification.package.tableFormattingPreserved).toBe(true);
      languageReport.adoptedExport = {
        path: adoptedExportPath,
        sha256: adoptedExportSha256,
        priorVersionSha256,
        package: readWordPackageIdentity(adoptedExport),
        verification,
      };
      languageReport.stage = "verified";
      await write();

      await closeWorkspace(page);
      await openProjectDocx(page, filePath);
      await expect(page.getByTestId("docx-workspace")).toBeVisible({
        timeout: 180_000,
      });
      const reopened = await waitForDocument(page, (current) =>
        current.dirty === false
        && current.baselineId === adopted.baselineId
        && current.sourceSha256 === adopted.sourceSha256);
      expect(reopened.sessionId).not.toBe(adopted.sessionId);
      const reopenedExportPath = resolve(
        run!,
        `word-format-candidate-${language}-reopened.docx`,
      );
      const reopenedExport = await exportWorkspaceCopy(
        page,
        reopenedExportPath,
      );
      expect(Buffer.from(reopenedExport).equals(Buffer.from(adoptedExport)))
        .toBe(true);
      const retainedSource = await page.evaluate<string>(
        `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m =>
          m.readFileBase64(${scriptValue(openedProject.appProjectId)},${scriptValue(filePath)}))`,
      );
      expect(sha256(Buffer.from(retainedSource, "base64"))).toBe(inputSha256);
      expect(sha256(await readFile(inputPath))).toBe(inputSha256);
      languageReport.reopened = {
        document: identity(reopened),
        exportPath: reopenedExportPath,
        exportSha256: sha256(reopenedExport),
        exactBytes: true,
        projectSourceSha256: inputSha256,
        authorInputSha256: inputSha256,
      };
      languageReport.stage = "complete";
      await write();
      await closeWorkspace(page);
    }

    await test.step("A Word edit during preparation cannot be silently overwritten", async () => {
      const source = new Uint8Array(await readFile(paths.english));
      const { document: before } = await createLanguageProject(page, "en", "concurrent.docx", source);
      await bindOpenedDocumentToWorld(page, before.workbenchProjectId, world!.version_id);
      await page.getByTestId("docx-start-format-candidate").click();
      const panel = page.getByTestId("docx-format-candidate");
      await expect(panel).toHaveAttribute("data-phase", "running", { timeout: 30_000 });
      const afterEdit = await typeInWorkingCopy(page, "OLEAFLY_CONCURRENT_EDIT ", before);
      expect(afterEdit.baselineId).toBe(before.baselineId);
      await expect(panel).toHaveAttribute("data-phase", "conflict", { timeout: WORD_FORMAT_CANDIDATE_TIMEOUT_MS });
      await expect(page.getByTestId("docx-adopt-format-candidate")).toHaveCount(0);
      await expect(panel.getByText("The working copy changed. This candidate is kept separately.", { exact: true })).toBeVisible();
      expect(identity(await documentState(page, before.sessionId))).toEqual(identity(afterEdit));
      const path = resolve(run!, "word-format-candidate-conflict-retained.docx");
      const bytes = await exportWorkspaceCopy(page, path, "Save candidate copy");
      const verification = verifyWordFormatCandidateBytes({ sourceBytes: source, candidateBytes: bytes });
      report.concurrentEdit = {
        before: identity(before), afterEdit: identity(afterEdit), refused: true,
        candidate: { path, sha256: sha256(bytes), verification },
      };
      await write();
    });

    const finalHashes = await readInputHashes(paths);
    expect(finalHashes).toEqual(initialHashes);
    report.finalHashes = finalHashes;
    report.outcome = "PASSED";
    report.finishedAt = new Date().toISOString();
    await write();
    await testInfo.attach("word-manuscript-live-report", {
      path: reportPath,
      contentType: "application/json",
    });
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    try {
      report.finalHashes ??= await readInputHashes(paths);
    } catch (error) {
      report.finalHashesError = String(error);
    }
    if (report.outcome !== "PASSED") report.outcome = "FAILED";
    report.finishedAt ??= new Date().toISOString();
    await write();
  }
});

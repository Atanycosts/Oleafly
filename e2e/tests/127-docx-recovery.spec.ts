import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import type { TauriPage } from "@srsholmes/tauri-playwright";
import type { DocxRecoveryListing, DocxRecoveryMetadata } from "../../src/lib/docx-recovery";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type { DocxRender } from "../../src/lib/docx-render";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { scriptValue } from "../script-value";

const stage = process.env.OLEAFLY_DOCX_RECOVERY_STAGE;
const runDirectory = process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const inputPath = process.env.OLEAFLY_REAL_DOCX;
const inputHash = process.env.OLEAFLY_REAL_DOCX_SHA256;
const PREPARED = "DOCX-RECOVERY-PREPARED ";
const CONTINUED = "DOCX-RECOVERY-CONTINUED ";
const DISCARDED = "DOCX-RECOVERY-DISCARDED ";

interface RecoveryRun {
  appProjectId: string;
  workbenchProjectId: string;
  baselineId: string;
  sourceSha256: string;
  originalSessionId: string;
  preparedText: string;
  recovery: DocxRecoveryMetadata;
  savedBaselineId?: string;
  savedSourceSha256?: string;
  savedText?: string;
  discardRecovery?: DocxRecoveryMetadata;
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const evidencePath = (name: string) => resolve(runDirectory!, name);
const readRun = async () => JSON.parse(await readFile(evidencePath("prepared.json"), "utf8")) as RecoveryRun;
const writeRun = (run: RecoveryRun) => writeFile(evidencePath("prepared.json"), JSON.stringify(run, null, 2));

async function liveDocument(page: TauriPage): Promise<DocxDocumentRead> {
  return page.evaluate(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);
}

async function waitForDocument(page: TauriPage, dirty: boolean): Promise<void> {
  await expect.poll(() => liveDocument(page).then((read) => read.document.dirty, () => null), { timeout: 90_000 }).toBe(dirty);
}

async function selectProject(page: TauriPage, projectId: string): Promise<void> {
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().openProject(${scriptValue(projectId)}))`);
  await expect.poll(() => page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => ({ id: m.useFilesStore.getState().projectId, loading: m.useFilesStore.getState().loading }))`)).toEqual({ id: projectId, loading: false });
}

async function insertAtFirstParagraph(page: TauriPage, text: string): Promise<void> {
  await expect(page.locator("[data-testid=docx-editor-surface] .docx-paragraph-fragment").first()).toBeVisible({ timeout: 90_000 });
  await page.evaluate(`(() => {
    const paragraph = document.querySelector('[data-testid="docx-editor-surface"] .docx-paragraph-fragment');
    paragraph.scrollIntoView({ block: 'center' });
    const rect = paragraph.getBoundingClientRect();
    const clientX = rect.left + 4, clientY = rect.top + Math.min(8, rect.height / 2);
    const target = document.elementFromPoint(clientX, clientY);
    const options = { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', options));
    target.dispatchEvent(new MouseEvent('mousedown', options));
    target.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }));
  })()`);
  await page.keyboard.press("Home");
  await page.keyboard.insertText(text);
  await expect.poll(async () => (await liveDocument(page)).paragraphs.some((paragraph) => paragraph.text.includes(text.trim())), { timeout: 20_000 }).toBe(true);
}

async function checkpoint(page: TauriPage, expectedText: string): Promise<DocxRecoveryMetadata> {
  let found: DocxRecoveryMetadata | undefined;
  await expect.poll(async () => {
    const current = await liveDocument(page);
    const candidates = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
    expect(candidates.failures).toEqual([]);
    for (const candidate of candidates.snapshots.filter((item) => item.appProjectId === current.document.appProjectId && item.baseBaselineId === current.document.baselineId)) {
      const stored = await readFile(resolve(process.env.OLEAFLY_DATA_DIR!, "docx-recovery", `${candidate.recoveryKey}.json`), "utf8");
      const snapshot = JSON.parse(stored);
      const bytes = Buffer.from(snapshot.contentBase64, "base64");
      if (hash(bytes) !== candidate.contentSha256) continue;
      const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
      if (!xml.includes(expectedText.trim())) continue;
      found = candidate;
      return true;
    }
    return false;
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(true);
  return found!;
}

async function openCandidates(page: TauriPage): Promise<void> {
  await page.getByTestId("docx-recovery-open").click();
  await expect(page.getByTestId("docx-recovery-dialog")).toBeVisible();
}

async function clickButton(page: TauriPage, root: string, label: string): Promise<void> {
  await page.evaluate(`(() => {
    const surface = document.querySelector(${scriptValue(root)});
    const button = Array.from(surface.querySelectorAll('button')).find(item => item.textContent.trim() === ${scriptValue(label)});
    if (!button || button.disabled) throw new Error('Button is unavailable: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

async function assertAuthorUnchanged(): Promise<void> {
  expect(hash(await readFile(inputPath!)), "The authorized author input stays byte-for-byte unchanged").toBe(inputHash);
}

test.beforeEach(async () => {
  test.skip(!stage, "Run with node e2e/run-docx-recovery.mjs against an isolated packaged native app.");
  expect(runDirectory).toBeTruthy();
  expect(inputPath).toBeTruthy();
  expect(inputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(process.env.OLEAFLY_DATA_DIR).toBeTruthy();
  expect(process.env.OLEAFLY_E2E_PRODUCTION).toBe("1");
  await assertAuthorUnchanged();
});

test("prepare native DOCX recovery checkpoint before process death", async ({ tauriPage: page }, testInfo) => {
  test.skip(stage !== "prepare");
  test.setTimeout(240_000);
  const authorBytes = await readFile(inputPath!);
  await createBlankProject(page, `DOCX recovery ${basename(inputPath!)} ${Date.now()}`);
  const appProjectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
  await openRailTab(page, "Journal checks");
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await panel.getByText("Import DOCX", { exact: true }).click();
  await page.fill('[role="dialog"] input:not([type="file"])', `Recovery ${basename(inputPath!)}`);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: basename(inputPath!), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: authorBytes }]);
  await page.click('[role="dialog"] button[type="submit"]');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await panel.getByText("Edit DOCX working copy", { exact: true }).click();
  await waitForDocument(page, false);
  const original = await liveDocument(page);
  await insertAtFirstParagraph(page, PREPARED);
  const live = await liveDocument(page);
  expect(live.document.dirty).toBe(true);
  const preparedText = live.paragraphs.find((paragraph) => paragraph.text.includes(PREPARED.trim()))!.text;
  const recovery = await checkpoint(page, PREPARED);
  const run: RecoveryRun = {
    appProjectId, workbenchProjectId: live.document.workbenchProjectId,
    baselineId: live.document.baselineId, sourceSha256: inputHash!,
    originalSessionId: original.document.sessionId, preparedText, recovery,
  };
  expect(recovery.sourceSha256).toBe(inputHash);
  expect(recovery.baseBaselineId).toBe(run.baselineId);
  await writeRun(run);
  await assertAuthorUnchanged();
  await page.screenshot({ path: evidencePath("prepared.png") });
  await testInfo.attach("native-checkpoint", { path: evidencePath("prepared.json"), contentType: "application/json" });
});

test("restore native checkpoint after SIGKILL then save exact baseline and PDF", async ({ tauriPage: page }) => {
  test.skip(stage !== "restore");
  test.setTimeout(360_000);
  const run = await readRun();
  await expect(page.getByTestId("docx-recovery-open")).toBeVisible({ timeout: 30_000 });
  await selectProject(page, run.appProjectId);
  await openCandidates(page);
  const candidate = page.locator(`[data-testid=docx-recovery-candidate][data-recovery-key="${run.recovery.recoveryKey}"]`);
  await expect(candidate).toBeVisible();
  const downloaded = evidencePath("downloaded-recovery.docx");
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(downloaded)})`);
  await candidate.getByTestId("docx-recovery-download").click();
  await expect.poll(async () => readFile(downloaded).then((bytes) => hash(bytes), () => null), { timeout: 10_000 }).toBe(run.recovery.contentSha256);
  await candidate.getByTestId("docx-recovery-restore").click();
  await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 90_000 });
  await waitForDocument(page, true);
  const recovered = await liveDocument(page);
  expect(recovered.document.sessionId).not.toBe(run.originalSessionId);
  expect(recovered.document.baselineId).toBe(run.baselineId);
  expect(recovered.paragraphs.some((paragraph) => paragraph.text === run.preparedText)).toBe(true);
  await expect(page.getByTestId("docx-save-state")).toContainText("Changes not yet saved");
  await writeFile(evidencePath("restored-session.json"), JSON.stringify(recovered, null, 2));
  await insertAtFirstParagraph(page, CONTINUED);
  const continued = await liveDocument(page);
  const savedText = continued.paragraphs.find((paragraph) => paragraph.text.includes(CONTINUED.trim()))!.text;
  expect(savedText).toContain(PREPARED.trim());
  await clickButton(page, '[data-testid="docx-workspace"]', "Save manuscript version");
  await expect.poll(async () => (await liveDocument(page)).document.dirty, { timeout: 90_000 }).toBe(false);
  const saved = await liveDocument(page);
  expect(saved.document.baselineId).not.toBe(run.baselineId);
  expect(saved.document.savedRevision).toBe(saved.document.sessionRevision);
  const source = await page.evaluate<{ source_sha256: string; content_base64: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/manuscript-source?project_id=${encodeURIComponent(run.workbenchProjectId)}&baseline_id=${encodeURIComponent(saved.document.baselineId)}'))`);
  const savedBytes = Buffer.from(source.content_base64, "base64");
  expect(hash(savedBytes)).toBe(source.source_sha256);
  const savedXml = strFromU8(unzipSync(savedBytes)["word/document.xml"]);
  expect(savedXml).toContain(CONTINUED.trim());
  expect(savedXml).toContain(PREPARED.trim());
  await writeFile(evidencePath("saved.docx"), savedBytes);
  await expect.poll(async () => {
    const candidates = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
    return candidates.snapshots.some((item) => item.recoveryKey === run.recovery.recoveryKey);
  }, { timeout: 20_000 }).toBe(false);
  await expect(page.getByTestId("docx-render-state")).toContainText("PDF matches the saved working copy", { timeout: 150_000 });
  const renders = await page.evaluate<DocxRender[]>(`window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(m => m.loadDocxRenders(${scriptValue(run.workbenchProjectId)}, ${scriptValue(saved.document.baselineId)}))`);
  const render = renders.find((item) => item.baseline_id === saved.document.baselineId && item.manifest.source_sha256 === source.source_sha256);
  expect(render, "LibreOffice retained PDF belongs to the exact saved bytes").toBeDefined();
  expect(render!.manifest.render_record.renderer_engine).toBe("LibreOffice");
  const pdf = await page.evaluate<number[]>(`window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(async m => Array.from(await m.loadDocxPdf(${scriptValue(run.workbenchProjectId)}, ${scriptValue(render)})))`);
  expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  expect(hash(Buffer.from(pdf))).toBe(render!.manifest.pdf_sha256);
  expect(render!.manifest.page_count).toBeGreaterThan(0);
  await writeFile(evidencePath("saved.pdf"), Buffer.from(pdf));
  await writeFile(evidencePath("saved-render.json"), JSON.stringify(render, null, 2));
  await clickButton(page, '[data-testid="docx-workspace"]', "Open PDF");
  await expect(page.getByTestId("docx-render-preview").locator("canvas").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("docx-render-preview").locator(".textLayer").first()).toContainText(CONTINUED.trim(), { timeout: 30_000 });
  await page.screenshot({ path: evidencePath("saved-pdf.png") });
  // TauriLocator.getByRole currently drops its parent scope. Close the exact
  // nested surface rather than whichever global Close button appears first.
  await clickButton(page, '[data-testid="docx-render-preview"]', "Close");
  await clickButton(page, '[data-testid="docx-workspace"]', "Close");
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
  await openRailTab(page, "Journal checks");
  await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
  await waitForDocument(page, false);
  await expect.poll(async () => (await liveDocument(page)).paragraphs.some((paragraph) => paragraph.text === savedText), { timeout: 90_000 }).toBe(true);
  expect((await liveDocument(page)).document.dirty).toBe(false);
  await insertAtFirstParagraph(page, DISCARDED);
  run.discardRecovery = await checkpoint(page, DISCARDED);
  run.savedBaselineId = saved.document.baselineId;
  run.savedSourceSha256 = source.source_sha256;
  run.savedText = savedText;
  expect(run.discardRecovery.baseBaselineId).toBe(run.savedBaselineId);
  expect(run.discardRecovery.sourceSha256).toBe(source.source_sha256);
  await writeRun(run);
  await assertAuthorUnchanged();
});

test("discard native recovery requires confirmation and preserves saved baseline", async ({ tauriPage: page }) => {
  test.skip(stage !== "discard");
  test.setTimeout(180_000);
  const run = await readRun();
  expect(run.discardRecovery).toBeDefined();
  await expect(page.getByTestId("docx-recovery-open")).toBeVisible({ timeout: 30_000 });
  await selectProject(page, run.appProjectId);
  await openCandidates(page);
  const candidate = page.locator(`[data-testid=docx-recovery-candidate][data-recovery-key="${run.discardRecovery!.recoveryKey}"]`);
  await expect(candidate).toBeVisible();
  await candidate.getByTestId("docx-recovery-discard").click();
  await expect(page.getByTestId("docx-recovery-confirm-discard")).toBeVisible();
  const before = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
  expect(before.snapshots.some((item) => item.recoveryKey === run.discardRecovery!.recoveryKey)).toBe(true);
  await page.getByTestId("docx-recovery-confirm-discard").click();
  await expect.poll(() => page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`).then((items) => items.snapshots.some((item) => item.recoveryKey === run.discardRecovery!.recoveryKey))).toBe(false);
  const current = await page.evaluate<{ baseline_id: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async m => { await m.connectJournalWorkbench(); return (await m.journalRequest('/api/state')).projects.find(p => p.project_id === ${scriptValue(run.workbenchProjectId)}); })`);
  expect(current.baseline_id).toBe(run.savedBaselineId);
  const source = await page.evaluate<{ source_sha256: string; content_base64: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/manuscript-source?project_id=${encodeURIComponent(run.workbenchProjectId)}&baseline_id=${encodeURIComponent(run.savedBaselineId!)}'))`);
  expect(source.source_sha256).toBe(run.savedSourceSha256);
  expect(strFromU8(unzipSync(Buffer.from(source.content_base64, "base64"))["word/document.xml"])).not.toContain(DISCARDED.trim());
  await assertAuthorUnchanged();
  await page.screenshot({ path: evidencePath("discarded.png") });
  await writeFile(evidencePath("discarded.json"), JSON.stringify({ recoveryKey: run.discardRecovery!.recoveryKey, baselineId: current.baseline_id, sourceSha256: source.source_sha256, authorSha256: inputHash, confirmed: true }, null, 2));
});

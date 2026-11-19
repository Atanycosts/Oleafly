import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type { ResearchWorkspace } from "../../src/lib/research-workspace";
import { expect, test } from "../fixtures";
import { createBlankProject, openRailTab, openSettings } from "../helpers";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";

type Page = TauriPage | BrowserPageAdapter;
const enabled = process.env.OLEAFLY_DOCX_TEMPLATE === "1";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function document(page: Page): Promise<DocxDocumentRead> {
  let result: DocxDocumentRead | null = null;
  await expect.poll(async () => {
    try {
      result = await page.evaluate<DocxDocumentRead>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);
      return result.paragraphs.length > 0;
    } catch { return false; }
  }, { timeout: 120_000 }).toBe(true);
  return result!;
}

async function closeWord(page: Page) {
  await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="docx-workspace"]');
    const close = Array.from(root.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Close' || button.textContent.trim() === 'Close');
    if (!close || close.disabled) throw new Error('Word close is unavailable');
    close.click();
  })()`);
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
}

test("Word file tree opens, saves and reopens the same managed manuscript", async ({ tauriPage }) => {
  test.skip(!enabled, "Run with the isolated Word template runner.");
  test.setTimeout(360_000);
  const evidence = process.env.OLEAFLY_DOCX_RECOVERY_RUN!;
  const sources = [
    { language: "en", path: resolve(process.env.OLEAFLY_NATIVE_DOCX_EN!) },
    { language: "zh", path: resolve(process.env.OLEAFLY_NATIVE_DOCX_ZH!) },
  ];
  const page = tauriPage;
  await createBlankProject(page, `Word file entry ${Date.now()}`);
  const projectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
  const reports: unknown[] = [];
  await openRailTab(page, "Journal checks");
  const journal = page.getByTestId("journal-checks-panel");
  await expect(journal.getByText("Use Word as template", { exact: true })).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByTestId("journal-workspace")).toContainText("Choose a manuscript and journal template");
  expect(await page.evaluate(`document.querySelector('[data-testid="journal-world-select"]').value`)).toBe("");
  await webviewScreenshot(page, resolve(evidence, "journal-first-use.png"));
  await journal.getByText("Use Word as template", { exact: true }).click();
  const template = await readFile(resolve(process.env.OLEAFLY_JOURNAL_TEMPLATE!));
  await page.setInputFiles('[role="dialog"][data-state="open"] input[type="file"]', [{ name: "IJAM template.doc", mimeType: "application/msword", buffer: template }]);
  expect(await page.evaluate(`document.querySelector('[role="dialog"][data-state="open"] input[id$="-name"]').value`)).toBe("IJAM template");
  expect(await page.evaluate(`document.querySelector('[data-testid="journal-id-input"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="journal-submission-context"]').open`)).toBe(false);
  await webviewScreenshot(page, resolve(evidence, "journal-template-entry.png"));
  await page.evaluate(`Array.from(document.querySelectorAll('[role="dialog"][data-state="open"] button')).find(button => button.textContent.trim() === 'Close').click()`);
  await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0);
  for (const source of sources) {
    const original = await readFile(source.path);
    const path = `${source.language}-manuscript.docx`;
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(${scriptValue(projectId)}, ${scriptValue(path)}, ${scriptValue(original.toString("base64"))}))`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`);
    await openRailTab(page, "Explorer");
    await page.locator(`[role="treeitem"][data-path="${path}"]`).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(`document.querySelector('[data-toolbar-item="compile"]') === null && document.querySelector('[data-testid="toolbar-views"]') === null`)).toBe(true);
    const opened = await document(page);
    expect(opened.document.sourceSha256).toBe(digest(original));
    expect(opened.document.dirty).toBe(false);
    if (source.language === "zh") {
      await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-state"]')?.getAttribute('data-resolving')`), { timeout: 90_000 }).toBe("false");
      await openSettings(page, "downloads");
      const fontRow = page.locator('[data-e2e-font-pack="microsoft-simsun"]');
      const fontAction = fontRow.locator("button");
      await expect(fontRow).toBeVisible();
      const wasInstalled = await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.listFontComponents()).then(packs => packs.find(pack => pack.id === 'microsoft-simsun').installed)`);
      if (wasInstalled) {
        await expect(fontAction).toHaveText("Remove");
        await fontAction.click();
        await expect(fontAction).toHaveText("Download", { timeout: 120_000 });
        await expect(fontAction).toBeEnabled({ timeout: 120_000 });
      }
      await expect(fontAction).toHaveText("Download");
      await fontAction.click();
      await expect(fontAction).toHaveText("Remove", { timeout: 120_000 });
      await expect(fontAction).toBeEnabled({ timeout: 120_000 });
      expect(await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.listFontComponents()).then(packs => packs.find(pack => pack.id === 'microsoft-simsun').installed)`)).toBe(true);
      await webviewScreenshot(page, resolve(evidence, "shared-font-settings.png"));
      await page.getByTestId("settings-close").click();
      await page.evaluate(`window.__oleaflyE2EImport('/src/store/docx-workspace.ts').then(m => m.useDocxWorkspaceStore.getState().restore())`);
      await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-state"]')?.getAttribute('data-resolving')`), { timeout: 90_000 }).toBe("false");
      const refreshed = await document(page);
      expect(refreshed.document.sessionId).toBe(opened.document.sessionId);
      expect(refreshed.document.sessionRevision).toBe(opened.document.sessionRevision);
      expect(refreshed.document.dirty).toBe(false);
      reports.push({ sharedFont: "SimSun", wasInstalled, sha256: "e72e26043ece0a899366f93e3fd48ca0aa9f285f9e81e3573f076813bb96d0ff", session: refreshed.document });
    }
    const target = opened.paragraphs.find(item => item.text.trim());
    expect(target).toBeTruthy();
    const change = await page.evaluate<{ ok: boolean; changed: boolean; document: DocxDocumentRead["document"] }>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.createDocxAgentTools().apply_docx_format.execute(${scriptValue({
      paragraph_ref: target!.paragraphRef, expected_revision: opened.document.sessionRevision, font: { size: 17.5 },
    })}))`);
    expect(change).toMatchObject({ ok: true, changed: true, document: { dirty: true } });
    // The visible editor, checks and right-hand Agent share the main workspace.
    await openRailTab(page, "Journal checks");
    await expect(page.getByTestId("journal-workspace")).toBeVisible({ timeout: 60_000 });
    const duringChecks = await document(page);
    expect(duringChecks.document.sessionId).toBe(opened.document.sessionId);
    expect(duringChecks.document.dirty).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-testid="journal-sidebar-content"]').textContent.includes('JSON')`)).toBe(false);
    expect(await page.evaluate(`document.querySelector('[data-testid="journal-sidebar-content"]').querySelector('[data-testid="journal-template-facts"]') === null`)).toBe(true);
    await page.evaluate(`document.querySelector('[data-testid="workspace-word-tab"] button').click()`);
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    await page.locator('[role="treeitem"][data-path="main.tex"]').count().then(async count => {
      if (!count) await openRailTab(page, "Explorer");
    });
    await page.locator('[role="treeitem"][data-path="main.tex"]').click();
    await expect(page.getByTestId("docx-workspace")).not.toBeVisible();
    await page.evaluate(`document.querySelector('[data-testid="workspace-word-tab"] button').click()`);
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    expect((await document(page)).document.sessionId).toBe(opened.document.sessionId);
    expect((await document(page)).document.dirty).toBe(true);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setAssistantOpen(true))`);
    await webviewScreenshot(page, resolve(evidence, `word-central-${source.language}.png`));
    const saved = await page.evaluate<{ baselineId: string; sourceSha256: string; document: DocxDocumentRead["document"] }>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.createDocxAgentTools().save_docx_document.execute(${scriptValue({ expected_revision: change.document.sessionRevision })}))`);
    expect(saved.document.dirty).toBe(false);
    expect(saved.baselineId).not.toBe(opened.document.baselineId);
    expect(saved.sourceSha256).not.toBe(digest(original));
    await closeWord(page);
    // Re-mount the file view as a normal user switching away and back in the tree.
    await page.locator('[role="treeitem"][data-path="main.tex"]').click();
    await page.locator(`[role="treeitem"][data-path="${path}"]`).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const reopened = await document(page);
    expect(reopened.document.workbenchProjectId).toBe(opened.document.workbenchProjectId);
    expect(reopened.document.baselineId).toBe(saved.baselineId);
    expect(reopened.document.sourceSha256).toBe(saved.sourceSha256);
    expect(reopened.document.dirty).toBe(false);
    expect(reopened.document.sessionId).not.toBe(opened.document.sessionId);
    const reopenedTarget = reopened.paragraphs.find(item => item.text === target!.text);
    const format = await page.evaluate<{ paragraph: { font: { size: number } } }>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.createDocxAgentTools().read_docx_format.execute(${scriptValue({ query: { kind: "objects", paragraph_ref: reopenedTarget!.paragraphRef, limit: 10 } })}))`);
    expect(format.paragraph.font.size).toBe(17.5);
    const sourceBytes = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileBase64(${scriptValue(projectId)}, ${scriptValue(path)}))`);
    expect(digest(Buffer.from(sourceBytes, "base64"))).toBe(digest(original));
    expect(digest(await readFile(source.path))).toBe(digest(original));
    await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-state"]')?.getAttribute('data-resolving')`), { timeout: 90_000 }).toBe("false");
    expect(await page.evaluate(`document.querySelector('[data-testid="docx-font-details"]') === null && document.querySelector('[data-testid="docx-version-details"]') === null`)).toBe(true);
    expect(await page.evaluate(`(() => { const word = document.querySelector('[data-testid="docx-workspace"]'); return !!word.closest('[data-testid="workspace-center"]') && !word.closest('[role="dialog"]'); })()`)).toBe(true);
    await webviewScreenshot(page, resolve(evidence, `word-file-${source.language}.png`));
    if (source.language === "en") {
      const pdfButton = '[data-testid="docx-workspace"] button';
      await expect.poll(() => page.evaluate(`Array.from(document.querySelectorAll(${scriptValue(pdfButton)})).some(button => button.textContent.trim() === 'Open PDF' && !button.disabled)`), { timeout: 120_000 }).toBe(true);
      await page.evaluate(`Array.from(document.querySelectorAll(${scriptValue(pdfButton)})).find(button => button.textContent.trim() === 'Open PDF').click()`);
      await expect(page.getByTestId("docx-render-preview")).toBeVisible({ timeout: 120_000 });
      await expect.poll(() => page.evaluate(`(() => { const canvas = document.querySelector('[data-testid="docx-render-preview"] canvas'); return !!canvas && canvas.width > 0 && canvas.height > 0; })()`), { timeout: 120_000 }).toBe(true);
      expect(await page.evaluate(`document.querySelector('[data-testid="docx-render-preview"]').closest('[role="dialog"]') === null`)).toBe(true);
      await webviewScreenshot(page, resolve(evidence, "word-central-pdf.png"));
      await page.evaluate(`Array.from(document.querySelectorAll(${scriptValue(pdfButton)})).find(button => button.textContent.trim() === 'Back to document').click()`);
      await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
      expect((await document(page)).document).toMatchObject({ sessionId: reopened.document.sessionId, sessionRevision: reopened.document.sessionRevision, dirty: false });
    }
    reports.push({ language: source.language, path, opened: opened.document, saved, reopened: reopened.document, fontSize: format.paragraph.font.size, authorSha256: digest(original) });
    await closeWord(page);
  }
  const workspace = await page.evaluate<ResearchWorkspace>(`window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m => m.getResearchWorkspace(${scriptValue(projectId)}))`);
  expect(workspace.wordDocuments).toHaveLength(2);
  expect(new Set(workspace.wordDocuments!.map(item => item.workbenchProjectId)).size).toBe(2);
  const englishId = workspace.wordDocuments!.find(item => item.path === "en-manuscript.docx")!.workbenchProjectId;
  const chineseId = workspace.wordDocuments!.find(item => item.path === "zh-manuscript.docx")!.workbenchProjectId;
  const retainedCount = await page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/state')).then(s => s.projects.length)`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().renameEntry('en-manuscript.docx', 'renamed.docx'))`);
  await page.locator('[role="treeitem"][data-path="renamed.docx"]').click();
  await expect(page.getByTestId("word-source-choice")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("word-source-choice").getByText("Continue en-manuscript", { exact: true }).click();
  const renamed = await document(page);
  expect(renamed.document.workbenchProjectId).toBe(englishId);
  const renamedWorkspace = await page.evaluate<ResearchWorkspace>(`window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m => m.getResearchWorkspace(${scriptValue(projectId)}))`);
  expect(renamedWorkspace.wordDocuments!.find(item => item.path === "renamed.docx")!.workbenchProjectId).toBe(englishId);
  await closeWord(page);
  // Replace only the isolated project copy, then choose the exact existing Chinese manuscript.
  const replacement = await readFile(sources[1].path);
  await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(${scriptValue(projectId)}, 'renamed.docx', ${scriptValue(replacement.toString("base64"))}))`);
  await page.locator('[role="treeitem"][data-path="main.tex"]').click();
  await page.locator('[role="treeitem"][data-path="renamed.docx"]').click();
  await expect(page.getByTestId("word-source-choice")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("word-source-choice")).toContainText("The source file has changed outside Oleafly");
  await page.getByTestId("word-source-choice").getByText("Continue zh-manuscript", { exact: true }).click();
  const replaced = await document(page);
  expect(replaced.document.workbenchProjectId).toBe(chineseId);
  const finalWorkspace = await page.evaluate<ResearchWorkspace>(`window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m => m.getResearchWorkspace(${scriptValue(projectId)}))`);
  expect(finalWorkspace.wordDocuments!.find(item => item.path === "renamed.docx")!.workbenchProjectId).toBe(chineseId);
  const finalCount = await page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/state')).then(s => s.projects.length)`);
  expect(finalCount).toBe(retainedCount);
  await closeWord(page);
  reports.push({ rename: renamed.document, replacement: replaced.document, retainedCount, finalCount, finalWorkspace });
  await writeFile(resolve(evidence, "word-file-entry-report.json"), JSON.stringify({ outcome: "PASSED", projectId, workspace, documents: reports }, null, 2));
});

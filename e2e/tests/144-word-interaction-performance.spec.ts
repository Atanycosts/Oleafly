import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";

const enabled = process.env.OLEAFLY_WORD_INTERACTION_PERFORMANCE === "1";
const input = process.env.OLEAFLY_REAL_DOCX;
const expectedHash = process.env.OLEAFLY_REAL_DOCX_SHA256;
const fixed = process.env.OLEAFLY_WORD_PERFORMANCE_EXPECT_FIXED === "1";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Timing = { syncMs: number; paintMs: number };

test("long Word opens, edits and switches versions without losing its working session", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Opt-in local real-manuscript performance acceptance.");
  test.setTimeout(360_000);
  expect(input).toBeTruthy();
  const bytes = await readFile(input!);
  expect(digest(bytes)).toBe(expectedHash);
  const report: Record<string, unknown> = { inputSha256: digest(bytes), inputBytes: bytes.length, fixed,
    scope: "Packaged macOS WebView, real manuscript copied into isolated managed storage; injected editor input through its contenteditable. Paint latency includes two animation frames. This is not an OS keyboard or Word/WPS comparison." };
  await createBlankProject(page, `Word interaction ${Date.now()}`);
  const projectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(${scriptValue(projectId)}, 'long-manuscript.docx', ${scriptValue(bytes.toString("base64"))}))`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`);
  await openRailTab(page, "Explorer");
  await page.evaluate(`Promise.all([
    window.__oleaflyE2EImport('/src/store/agent-workspace.ts'),
    window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts')
  ]).then(([views, host]) => {
    window.__wordPerf = { views: views.useAgentWorkspaceStore, host, calls: [], frames: [], running: true };
    const fetch = window.fetch;
    window.fetch = async function(resource, ...args) {
      const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
      const command = url.pathname.replace(/^\\//, '');
      const at = performance.now();
      try { return await fetch.call(this, resource, ...args); }
      finally { if (url.protocol === 'ipc:' || url.hostname === 'ipc.localhost') window.__wordPerf.calls.push({ command, at, durationMs: performance.now() - at }); }
    };
    let previous = performance.now();
    requestAnimationFrame(function frame(now) {
      window.__wordPerf.frames.push({ at: now, gapMs: now - previous });
      if (!window.__wordPerf.firstPaperAt && document.querySelector('[data-testid="docx-editor-surface"] .docx-paragraph-fragment')) window.__wordPerf.firstPaperAt = now;
      previous = now;
      if (window.__wordPerf.running) requestAnimationFrame(frame);
    });
    window.__wordPerf.openAt = performance.now();
  })`);
  await page.locator('[role="treeitem"][data-path="long-manuscript.docx"]').click();
  await expect.poll(() => page.evaluate<boolean>(`(() => {
    const paragraphs = document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment');
    const font = document.querySelector('[data-testid="docx-font-state"]');
    return paragraphs.length > 0 && font?.getAttribute('data-resolving') === 'false'
      && window.__wordPerf.host.getDocxWorkspaceContext().writable.length === 1;
  })()`), { timeout: 120_000, intervals: [50, 100, 200] }).toBe(true);
  report.open = await page.evaluate(`(() => {
    const perf = window.__wordPerf;
    perf.readyAt = performance.now();
    return { readyMs: perf.readyAt - perf.openAt,
      firstPaperMs: perf.firstPaperAt - perf.openAt,
      paragraphsMounted: document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment').length,
      historyMounted: !!document.querySelector('[data-testid="docx-original-surface"]'),
      font: document.querySelector('[data-testid="docx-font-state"]')?.getAttribute('data-measurer'),
      session: perf.host.getDocxWorkspaceContext().writable[0] };
  })()`);
  expect((report.open as { historyMounted: boolean }).historyMounted).toBe(false);
  const document = await page.evaluate<{ document: { sessionId: string }; paragraphs: { text: string }[] }>(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument()`);
  report.paragraphCount = document.paragraphs.length;
  expect(document.paragraphs.length).toBeGreaterThan(400);
  report.beforeEdit = await page.evaluate(`({ calls: window.__wordPerf.calls, frames: window.__wordPerf.frames })`);
  const nativeCalls = (report.beforeEdit as { calls: { command: string }[] }).calls;
  if (fixed) {
    expect(nativeCalls.some(item => item.command === "journal_word_open")).toBe(true);
    expect(nativeCalls.filter(item => ["journal_docx_renderer", "journal_docx_render", "journal_docx_pdf"].includes(item.command))).toEqual([]);
  }

  // Real hit-testing enters the engine's editable surface; no direct model mutation.
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
  const edits: Timing[] = [];
  const marker = "PERF-7F91A2 ";
  expect(document.paragraphs.some(item => item.text.includes(marker))).toBe(false);
  for (const character of marker) {
    edits.push(await page.evaluate<Timing>(`new Promise(resolve => {
      const start = performance.now();
      const inserted = document.execCommand('insertText', false, ${scriptValue(character)});
      if (!inserted) throw new Error('The Word contenteditable refused input.');
      const syncMs = performance.now() - start;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ syncMs, paintMs: performance.now() - start })));
    })`));
  }
  report.edits = edits;
  const after = await page.evaluate<{ document: { sessionId: string; sessionRevision: number; dirty: boolean }; paragraphs: { text: string }[] }>(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument()`);
  expect(after.document.sessionId).toBe(document.document.sessionId);
  expect(after.document.dirty).toBe(true);
  expect(after.paragraphs.some(item => item.text.includes(marker))).toBe(true);

  const selections: Timing[] = [];
  for (let index = 0; index < 12; index++) {
    selections.push(await page.evaluate<Timing>(`new Promise(resolve => {
      const start = performance.now();
      const node = document.activeElement;
      node.dispatchEvent(new KeyboardEvent('keydown', { key: ${scriptValue("ArrowLeft")}, bubbles: true, cancelable: true }));
      const syncMs = performance.now() - start;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ syncMs, paintMs: performance.now() - start })));
    })`));
  }
  report.selections = selections;

  const scrolls: Timing[] = [];
  for (let index = 0; index < 8; index++) {
    scrolls.push(await page.evaluate<Timing>(`new Promise(resolve => {
      const start = performance.now();
      const paragraph = document.querySelector('[data-testid="docx-editor-surface"] .docx-paragraph-fragment');
      let scroller = paragraph.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (!scroller) throw new Error('Missing Word scroller');
      scroller.scrollTop += ${index < 4 ? 550 : -550};
      const syncMs = performance.now() - start;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ syncMs, paintMs: performance.now() - start })));
    })`));
  }
  report.scrolls = scrolls;

  const rect = await page.evaluate(`document.querySelector('[data-testid="word-surface"] [data-word-surface-layer="current"]').getBoundingClientRect().toJSON()`);
  const workingScroll = await page.evaluate<number>(`(() => {
    const paragraph = document.querySelector('[data-testid="docx-editor-surface"] .docx-paragraph-fragment');
    let scroller = paragraph.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    window.__wordPerf.scroller = scroller;
    return scroller.scrollTop;
  })()`);
  await page.evaluate(`document.querySelector('[data-testid="docx-workspace"] [aria-label="Display"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`);
  await expect.poll(() => page.evaluate<boolean>(`Array.from(document.querySelectorAll('[role="option"]')).some(item => item.textContent.trim() === 'Stack versions')`)).toBe(true);
  await page.evaluate(`Array.from(document.querySelectorAll('[role="option"]')).find(item => item.textContent.trim() === 'Stack versions').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await expect(page.getByTestId("docx-original-surface")).toHaveCount(1);
  if (fixed) {
    await expect.poll(() => page.evaluate<boolean>(`!document.querySelector('[data-testid="word-surface-paper-edge"]').getAnimations().some(animation => animation.playState === 'running')`)).toBe(true);
    const geometry = await page.evaluate(`(() => {
      const root = document.querySelector('[data-testid="word-surface"]');
      const edge = root.querySelector('[data-testid="word-surface-paper-edge"]').getBoundingClientRect();
      const back = root.querySelector('[data-testid="word-surface-version-spine"] [aria-pressed="false"]').getBoundingClientRect();
      const front = root.querySelector('[data-testid="word-surface-version-spine"] [aria-pressed="true"]').getBoundingClientRect();
      const actual = root.querySelector('[data-word-surface-layer="current"] .docx-page').getBoundingClientRect();
      return { exposedDepth: front.top - back.top, paperWidth: actual.width, shellWidth: edge.width, spineHeight: root.querySelector('[data-testid="word-surface-version-spine"]').getBoundingClientRect().height,
        rect: root.querySelector('[data-word-surface-layer="current"]').getBoundingClientRect().toJSON(), visibleLayers: root.querySelectorAll('[data-word-surface-layer]:not([hidden])').length };
    })()`);
    expect(geometry).toMatchObject({ exposedDepth: 28, spineHeight: 64, rect, visibleLayers: 1 });
    expect((geometry as { shellWidth: number }).shellWidth).toBe((geometry as { paperWidth: number }).paperWidth);
    report.geometry = geometry;
  }
  const switches = [];
  for (let index = 0; index < 6; index++) {
    const original = index % 2 === 0;
    switches.push(await page.evaluate(`new Promise(resolve => {
      const started = performance.now();
      const root = document.querySelector('[data-testid="word-surface"]');
      Array.from(root.querySelectorAll('button')).find(button => button.textContent.trim() === ${scriptValue(original ? "Version before this session" : "Working copy")}).click();
      const next = () => {
        const surface = root.querySelector(${scriptValue(original ? '[data-testid="docx-original-surface"]' : '[data-testid="docx-editor-surface"]')});
        if (surface?.getClientRects().length && surface.querySelector('.docx-paragraph-fragment')) {
          requestAnimationFrame(() => resolve({ original: ${original}, paintMs: performance.now() - started }));
        } else requestAnimationFrame(next);
      };
      next();
    })`));
  }
  report.switches = switches;
  if (fixed) {
    // A half-second main-thread stall is directly noticeable during each keystroke.
    expect(Math.max(...edits.map(item => item.paintMs))).toBeLessThan(500);
    expect(Math.max(...selections.map(item => item.paintMs))).toBeLessThan(500);
  }
  expect(await page.evaluate<number>(`window.__wordPerf.scroller.scrollTop`)).toBe(workingScroll);
  const retained = await page.evaluate<typeof after>(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument()`);
  expect(retained.document).toEqual(after.document);
  expect(retained.paragraphs).toEqual(after.paragraphs);
  await webviewScreenshot(page, testInfo.outputPath("long-word-stack.png"));
  await page.evaluate(`document.querySelector('[data-testid="word-formatting-toolbar"] [aria-label="Undo (Mod+Z)"]').click()`);
  await expect.poll(() => page.evaluate(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument().then(value => value.paragraphs.some(item => item.text.includes(${scriptValue(marker)})))`)).toBe(false);

  // Save a real changed baseline, then close and reopen from the original project file.
  // The file remains unchanged while reopening must choose the latest retained draft.
  await page.evaluate(`document.querySelector('[data-testid="word-formatting-toolbar"] [aria-label="Redo (Mod+Shift+Z)"]').click()`);
  await expect.poll(() => page.evaluate(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument().then(value => value.paragraphs.some(item => item.text.includes(${scriptValue(marker)})))`)).toBe(true);
  expect(await page.evaluate<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="docx-workspace"] button')).find(item => item.textContent.trim() === 'Save version');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)).toBe(true);
  await expect.poll(() => page.evaluate<boolean>(`window.__wordPerf.host.getDocxWorkspaceContext().writable[0]?.dirty === false`), { timeout: 60_000 }).toBe(true);
  const saved = await page.evaluate<{ baselineId: string; workbenchProjectId: string }>(`window.__wordPerf.host.getDocxWorkspaceContext().writable[0]`);
  await page.locator('[data-testid="docx-workspace"] button[aria-label="Close"]').click();
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
  await page.evaluate(`(() => {
    const perf = window.__wordPerf;
    perf.firstPaperAt = null;
    perf.openAt = performance.now();
  })()`);
  await page.locator('[role="treeitem"][data-path="long-manuscript.docx"]').click();
  await expect.poll(() => page.evaluate<boolean>(`(() => {
    const font = document.querySelector('[data-testid="docx-font-state"]');
    return !!document.querySelector('[data-testid="docx-editor-surface"] .docx-paragraph-fragment')
      && font?.getAttribute('data-resolving') === 'false'
      && window.__wordPerf.host.getDocxWorkspaceContext().writable.length === 1;
  })()`), { timeout: 120_000, intervals: [50, 100, 200] }).toBe(true);
  report.reopen = await page.evaluate(`({ readyMs: performance.now() - window.__wordPerf.openAt,
    firstPaperMs: window.__wordPerf.firstPaperAt - window.__wordPerf.openAt,
    session: window.__wordPerf.host.getDocxWorkspaceContext().writable[0] })`);
  const reopened = await page.evaluate<typeof after>(`window.__wordPerf.host.DOCX_AGENT_HOST.readDocument()`);
  expect(reopened.document).toMatchObject({ baselineId: saved.baselineId, workbenchProjectId: saved.workbenchProjectId, dirty: false });
  expect(reopened.paragraphs.some(item => item.text.includes(marker))).toBe(true);
  report.final = await page.evaluate(`(() => {
    const perf = window.__wordPerf;
    perf.running = false;
    return { calls: perf.calls, frames: perf.frames, session: perf.host.getDocxWorkspaceContext().writable[0] };
  })()`);
  if (fixed) expect((report.final as { calls: { command: string }[] }).calls.filter(item =>
    ["journal_docx_renderer", "journal_docx_render", "journal_docx_pdf"].includes(item.command))).toEqual([]);
  const projectSource = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileBase64(${scriptValue(projectId)}, 'long-manuscript.docx'))`);
  expect(digest(Buffer.from(projectSource, "base64"))).toBe(expectedHash);
  expect(digest(await readFile(input!))).toBe(expectedHash);
  await writeFile(testInfo.outputPath("word-interaction.json"), JSON.stringify(report, null, 2));
  const summary = (values: Timing[]) => {
    const sorted = values.map(item => item.paintMs).sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxSyncMs: Math.max(...values.map(item => item.syncMs)) };
  };
  console.log(JSON.stringify({ open: report.open, reopen: report.reopen, paragraphs: report.paragraphCount, edits: summary(edits), selections: summary(selections), scrolls: summary(scrolls), switches }, null, 2));
});

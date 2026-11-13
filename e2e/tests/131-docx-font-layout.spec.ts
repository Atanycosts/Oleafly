import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_DOCX_FONT_LAYOUT === "1";
type Page = TauriPage | BrowserPageAdapter;
const input = process.env.OLEAFLY_REAL_DOCX;
const inputHash = process.env.OLEAFLY_REAL_DOCX_SHA256;
const run = process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const output = (name: string) => resolve(run!, name);
const live = (page: Page) => page.evaluate<DocxDocumentRead>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);

interface FontRequest { family: string; weight: number; style: "normal" | "italic" }
interface FontFace {
  requested: FontRequest; family: string; postscriptName: string;
  weight: number; style: string; faceIndex: number; sha256: string;
  computedSha256: string; bytes: number; signature: string;
}
interface FontResult { faces: FontFace[]; missing: FontRequest[] }

const state = (page: Page) => page.evaluate<{
  measurer: string | null; resolving: string | null; producer: string | null;
  missing: string | null; aliases: string | null; alerts: string[]; registeredFonts: { family: string; status: string }[];
  admittedFonts: { sha256: string | null; family: string; status: string; registered: boolean }[];
  runs: { text: string | null; family: string }[];
}>(`(() => {
  const state = document.querySelector('[data-testid="docx-font-state"]');
  return { measurer: state?.getAttribute('data-measurer') ?? null,
    resolving: state?.getAttribute('data-resolving') ?? null,
    producer: state?.getAttribute('data-producer') ?? null,
    missing: document.querySelector('[data-testid="docx-font-missing"]')?.textContent ?? null,
    aliases: document.querySelector('[data-testid="docx-font-aliases"]')?.textContent ?? null,
    alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(item => item.textContent),
    registeredFonts: Array.from(document.fonts).map(font => ({ family: font.family, status: font.status })),
    admittedFonts: (window.__docxFontEvidence ?? []).map(record => ({ sha256: record.sha256,
      family: record.face.family, status: record.face.status, registered: document.fonts.has(record.face) })),
    runs: Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] .layout-run-text')).slice(0, 250).map(run => ({
      text: run.textContent, family: getComputedStyle(run).fontFamily })) };
})()`);

async function click(page: Page, label: string) {
  await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="docx-workspace"] button')).find(item => item.textContent.trim() === ${scriptValue(label)});
    if (!button || button.disabled) throw new Error('Unavailable button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

// Opt-in local fonts and manuscripts; no model calls or renderer equivalence claim.
test("native DOCX uses byte-backed local fonts and preserves source formatting", async ({ tauriPage: page }) => {
  test.skip(!enabled, "Run with OLEAFLY_DOCX_FONT_LAYOUT=1 and the isolated DOCX runner.");
  test.setTimeout(300_000);
  expect(run).toBeTruthy();
  expect(inputHash).toMatch(/^[a-f0-9]{64}$/);
  const source = await readFile(input!);
  expect(hash(source)).toBe(inputHash);
  const requested: FontRequest[] = ["Times New Roman"].flatMap(family => [
    { family, weight: 400, style: "normal" as const },
    { family, weight: 700, style: "normal" as const },
  ]);
  const resolved = await page.evaluate<FontResult>(`window.__TAURI_INTERNALS__.invoke('resolve_system_font_faces', { requests: ${scriptValue(requested)} }).then(async result => ({
    missing: result.missing,
    faces: await Promise.all(result.faces.map(async ({ contentBase64, ...face }) => {
      const bytes = Uint8Array.from(atob(contentBase64), c => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { ...face, computedSha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join(''),
        bytes: bytes.length, signature: String.fromCharCode(...bytes.slice(0, 4)) };
    }))
  }))`);
  expect(resolved.missing).toEqual([]);
  expect(resolved.faces).toHaveLength(requested.length);
  for (const face of resolved.faces) {
    expect(face.computedSha256).toBe(face.sha256);
    expect(face.family).toBe(face.requested.family);
    expect(face.faceIndex).toBe(0);
    expect(face.postscriptName.length).toBeGreaterThan(0);
    expect(face.bytes).toBeGreaterThan(1_000);
    expect(face.signature).not.toBe("ttcf");
  }
  await writeFile(output("native-fonts.json"), JSON.stringify(resolved.faces, null, 2));
  const missingRequest = { family: "Oleafly Unavailable Journal Font 2026", weight: 400, style: "normal" };
  expect(await page.evaluate(`window.__TAURI_INTERNALS__.invoke('resolve_system_font_faces', { requests: [${scriptValue(missingRequest)}] }).then(result => ({ faces: result.faces.length, missing: result.missing }))`)).toEqual({ faces: 0, missing: [missingRequest] });

  await createBlankProject(page, `DOCX fonts ${basename(input!)} ${Date.now()}`);
  // Observe the actual bytes passed by Core's admitted-source registration. The
  // native constructor and loading behavior remain unchanged; no product API is added.
  await page.evaluate(`(() => {
    const Constructor = window.FontFace;
    window.__docxFontEvidence = [];
    window.FontFace = new Proxy(Constructor, { construct(target, args) {
      const face = Reflect.construct(target, args);
      const source = args[1];
      if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        const record = { face, sha256: null };
        window.__docxFontEvidence.push(record);
        const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        crypto.subtle.digest('SHA-256', bytes).then(hash => {
          record.sha256 = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        });
      }
      return face;
    }});
  })()`);
  await openRailTab(page, "Journal checks");
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await panel.getByText("Import DOCX", { exact: true }).click();
  await page.fill('[role="dialog"] input:not([type="file"])', `Typography ${basename(input!)}`);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: basename(input!), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: source }]);
  await page.click('[role="dialog"] button[type="submit"]');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await panel.getByText("Edit DOCX working copy", { exact: true }).click();
  await expect.poll(() => live(page).then(read => read.document.dirty, () => null), { timeout: 90_000 }).toBe(false);
  await expect.poll(() => state(page).then(value => ({ measurer: value.measurer, resolving: value.resolving })), { timeout: 90_000 }).toEqual({ measurer: "shaped", resolving: "false" });
  const fonts = await state(page);
  expect(fonts.producer).toBeTruthy();
  expect(fonts.registeredFonts.some(face => face.status === "loaded")).toBe(true);
  expect(fonts.missing).toMatch(/宋体|SimSun/);
  expect(fonts.aliases ?? "").not.toMatch(/Noto|Liberation|Carlito/);
  const actualFamilies = new Set(["Times New Roman"]);
  await expect.poll(async () => {
    const captured = await state(page);
    return resolved.faces.filter(face => actualFamilies.has(face.family)).every(face => captured.admittedFonts.some(
      loaded => loaded.sha256 === face.sha256 && loaded.status === "loaded" && loaded.registered,
    ));
  }, { timeout: 30_000 }).toBe(true);
  const rendered = await state(page);
  const familiesUsed = new Set(["Times New Roman"]);
  for (const family of familiesUsed) {
    const hashes = new Set(resolved.faces.filter(face => face.family === family).map(face => face.sha256));
    const aliases = rendered.admittedFonts.filter(face => hashes.has(face.sha256 ?? "")).map(face => face.family);
    expect(rendered.runs.some(run => aliases.some(alias => run.family.includes(alias))), `${family} is used by an actual text run`).toBe(true);
  }
  const paragraphs = await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment')).slice(0, 15).map(item => ({ text: item.textContent, box: item.getBoundingClientRect().toJSON() }))`);
  await writeFile(output("editor-font-state.json"), JSON.stringify({ ...await state(page), paragraphs }, null, 2));
  await page.screenshot({ path: output("opened.png") });
  const exported = output("no-change.docx");
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(exported)})`);
  await click(page, "Download DOCX copy");
  await expect.poll(() => readFile(exported).then(bytes => bytes.length, () => 0), { timeout: 30_000 }).toBeGreaterThan(0);
  const comparison = JSON.parse(execFileSync(resolve("services/research-workbench/.venv/bin/python"), [resolve("e2e/tests/docx-real-package.py"), input!, exported], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  await writeFile(output("package-comparison.json"), JSON.stringify(comparison, null, 2));
  expect(comparison.missingParts).toEqual([]);
  expect(comparison.addedParts).toEqual([]);
  expect(comparison.changedMedia).toEqual([]);
  expect(comparison.changedRelationships).toEqual([]);
  expect(comparison.lostOrModifiedProtectedNodes).toEqual({});
  expect(comparison.paragraphTextChanges).toEqual([]);
  expect(comparison.paragraphCount.after).toBe(comparison.paragraphCount.before);
  // Font origins and measurement must not alter the authored font/style/frame settings.
  const format = execFileSync(resolve("services/research-workbench/.venv/bin/python"), ["-c", `
import sys,zipfile,xml.etree.ElementTree as E
def semantic(node):
 return (node.tag,sorted(node.attrib.items()),node.text if node.text and node.text.strip() else None,[semantic(child) for child in node])
with zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2]) as exported:
 for name in ['word/styles.xml','word/fontTable.xml']:
  if name in source.namelist(): assert semantic(E.fromstring(source.read(name)))==semantic(E.fromstring(exported.read(name))),name
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 before=E.fromstring(source.read('word/document.xml'));after=E.fromstring(exported.read('word/document.xml'))
 for kind in ['sectPr','framePr','rFonts']:
  assert [semantic(n) for n in before.findall('.//w:'+kind,ns)]==[semantic(n) for n in after.findall('.//w:'+kind,ns)],kind
print('authored styles, font table, section, frame and font properties retained')
`, input!, exported], { encoding: "utf8" });
  await writeFile(output("format-comparison.txt"), format);
  await click(page, "Close");
  await panel.getByText("Edit DOCX working copy", { exact: true }).click();
  await expect.poll(() => state(page).then(value => ({ measurer: value.measurer, resolving: value.resolving })), { timeout: 90_000 }).toEqual({ measurer: "shaped", resolving: "false" });
  expect((await live(page)).document.dirty).toBe(false);
  expect((await state(page)).missing).toMatch(/宋体|SimSun/);
  expect(hash(await readFile(input!))).toBe(inputHash);
  await verifyJournalFontDownload(page);
  await writeFile(output("result.json"), JSON.stringify({ outcome: "EXACT_FONT_SOURCES_AND_ROUNDTRIP_PASSED", inputHash, format: format.trim(), scope: "macOS native font IPC, actual editor shaping with exact TNR, truthful missing fonts, no family substitution, unchanged DOCX export and reopen; missing Chinese fonts prevent full font coverage" }, null, 2));
});

async function verifyJournalFontDownload(page: Page) {
  const before = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('resolve_system_font_faces', { requests: [{ family: 'PT Serif', weight: 400, style: 'normal' }] }).then(result => result.faces.length)`);
  expect(before, "isolated cache starts without a standalone PT Serif face").toBe(0);
  await click(page, "Close");
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
  const fontWorld = await page.evaluate<{ version_id: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/worlds', {
    journal_id: 'font-acquisition-probe', journal_name: 'Font acquisition acceptance', article_type: 'research_article', stage: 'initial_submission', language: 'en',
    sources: [{ name: 'controlled-font-guide.txt', kind: 'guide_text', content_base64: btoa('Body text must use PT Serif font.') }]
  }))`);
  await openRailTab(page, "Journal checks");
  const panel = page.getByTestId("journal-checks-panel");
  const fixture = zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="PT Serif" w:hAnsi="PT Serif"/><w:sz w:val="24"/></w:rPr><w:t>Controlled exact journal font acquisition and refresh.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>'),
  });
  await panel.getByText("Import DOCX", { exact: true }).click();
  await page.fill('[role="dialog"] input:not([type="file"])', "Controlled font acquisition");
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: "exact-font-fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(fixture) }]);
  await page.click('[role="dialog"] button[type="submit"]');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await page.click('[aria-label="Refresh journal checks"]');
  await expect.poll(() => page.evaluate(`Array.from(document.querySelectorAll('[data-testid="journal-checks-panel"] select option')).some(option => option.value === ${scriptValue(fontWorld.version_id)})`)).toBe(true);
  await page.selectOption('[data-testid="journal-world-select"]', fontWorld.version_id);
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="journal-checks-panel"]')?.getAttribute('aria-busy')`)).toBe("false");
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="journal-world-select"]')?.value`)).toBe(fontWorld.version_id);
  await panel.getByText("Edit DOCX working copy", { exact: true }).click();
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-world"]')?.textContent ?? null`)).toContain(fontWorld.version_id);
  await writeFile(output("font-acquisition-context.json"), JSON.stringify(await page.evaluate(`window.__oleaflyE2EImport('/src/store/docx-workspace.ts').then(m => {
    const request = m.useDocxWorkspaceStore.getState().request;
    return { project: request?.project, world: request?.world, text: document.querySelector('[data-testid="docx-fonts-panel"]')?.textContent };
  })`), null, 2));
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-acquisition"]')?.getAttribute('data-state') ?? null`), { timeout: 120_000 }).toBe("available");
  const available = await page.evaluate<{ faces: { family: string; sha256: string; weight: number; style: string }[]; missing: FontRequest[] }>(`window.__TAURI_INTERNALS__.invoke('resolve_system_font_faces', { requests: [{ family: 'PT Serif', weight: 400, style: 'normal' }] }).then(result => ({ faces: result.faces.map(({contentBase64,...face}) => face), missing: result.missing }))`);
  expect(available.missing).toEqual([]);
  expect(available.faces[0]).toMatchObject({ family: "PT Serif", weight: 400, style: "normal" });
  expect(available.faces[0].sha256).toBe("a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a");
  await writeFile(output("font-acquisition-font-state.json"), JSON.stringify(await state(page), null, 2));
  await expect.poll(async () => {
    const current = await state(page);
    await writeFile(output("font-acquisition-font-state.json"), JSON.stringify(current, null, 2));
    const admitted = current.admittedFonts.find(face => face.sha256 === available.faces[0].sha256 && face.status === "loaded" && face.registered);
    const textRuns = current.runs.filter(run => run.text?.trim());
    return !!admitted && textRuns.map(run => run.text).join("").includes("Controlled exact journal font") && textRuns.every(run => run.family.startsWith(admitted.family));
  }, { timeout: 30_000 }).toBe(true);
  const packs = await page.evaluate<{ id: string; installed: boolean; families: string[] }[]>(`window.__TAURI_INTERNALS__.invoke('list_font_components')`);
  expect(packs.find(pack => pack.id === "ptserif")).toMatchObject({ installed: true, families: ["PT Serif"] });
  await expect.poll(() => live(page).then(value => value.document.dirty, () => null)).toBe(false);
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
  await page.keyboard.insertText("FONT REFRESH PROBE ");
  await expect.poll(() => live(page).then(value => value.paragraphs.some(item => item.text.includes("FONT REFRESH PROBE")))).toBe(true);
  const snapshot = await live(page);
  expect(snapshot.document.dirty).toBe(true);
  await click(page, "Minimize");
  const nextWorld = await page.evaluate<{ version_id: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/worlds', {
    journal_id: 'font-context-probe', journal_name: 'Updated font context acceptance', article_type: 'research_article', stage: 'initial_submission', language: 'en',
    sources: [{ name: 'controlled-font-guide.txt', kind: 'guide_text', content_base64: btoa('Body text must use PT Serif font.') }]
  }))`);
  await page.click('[aria-label="Refresh journal checks"]');
  await expect.poll(() => page.evaluate(`Array.from(document.querySelectorAll('[data-testid="journal-world-select"] option')).some(option => option.value === ${scriptValue(nextWorld.version_id)})`)).toBe(true);
  await page.selectOption('[data-testid="journal-world-select"]', nextWorld.version_id);
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="journal-checks-panel"]')?.getAttribute('aria-busy')`)).toBe("false");
  await panel.getByText("Edit DOCX working copy", { exact: true }).click();
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-world"]')?.textContent ?? null`)).toContain(nextWorld.version_id);
  expect((await live(page)).document.sessionId).toBe(snapshot.document.sessionId);
  await page.getByTestId("docx-font-refresh").click();
  await expect.poll(() => page.evaluate(`document.querySelector('[data-testid="docx-font-state"]')?.getAttribute('data-resolving')`)).toBe("false");
  const after = await live(page);
  expect(after.document.sessionId).toBe(snapshot.document.sessionId);
  expect(after.document.sessionRevision).toBe(snapshot.document.sessionRevision);
  expect(after.document.dirty).toBe(true);
  expect(after.paragraphs.map(item => item.text)).toEqual(snapshot.paragraphs.map(item => item.text));
  expect(hash(fixture)).toBe(after.document.sourceSha256);
  await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] button')).find(item => (item.getAttribute('aria-label') ?? '').startsWith('Undo'));
    if (!button || button.disabled) throw new Error('Undo is unavailable after font refresh');
    button.click();
  })()`);
  await expect.poll(() => live(page).then(value => value.paragraphs.some(item => item.text.includes("FONT REFRESH PROBE")))).toBe(false);
  await writeFile(output("font-acquisition.json"), JSON.stringify({ outcome: "EXACT_JOURNAL_FONT_DOWNLOADED", family: "PT Serif", faces: available.faces, refreshRetainsSession: true, worldSwitchRetainsSession: true, scope: "controlled journal guide through retained world and native catalog download; does not modify manuscript font declarations or prove journal compliance" }, null, 2));
}

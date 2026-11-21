import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { chromium, expect, test, webkit, type Page, type TestInfo } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { docxDoiUrl } from "../../src/lib/docx-citation-doi";
import type { MaterialAnchor, MaterialReference } from "../../src/lib/material-surface";
import type { TaskAnnotation } from "../../src/lib/task-collaboration";

const original = "Target paragraph for a streamed suggestion.";
const other = "Human paragraph stays independent.";
const citationInstruction = 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":1,"itemData":{"title":"Embedded study","DOI":"https://doi.org/10.1234/embedded%23result"}}]}';
const columnDoi = "10.1234/column";
const conflictingDoi = "10.1234/conflict";
const conflictingSourceMessage = "The draft has conflicting source records or DOI details.";
const workbenchModule = resolve("services/research-workbench");
const workbenchPython = process.env.OLEAFLY_WORKBENCH_PYTHON ??
  resolve(workbenchModule, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");

async function launchDocxTestBrowser() {
  if (process.env.OLEAFLY_DOCX_TEST_BROWSER === "webkit") return webkit.launch();
  return chromium.launch({ channel: "chrome" });
}

function fixture(multilineCitation = false): Uint8Array {
  const formulas = '<w:p><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath><w:r><w:t xml:space="preserve"> and </w:t></w:r><m:oMath><m:r><m:t>z+2</m:t></m:r></m:oMath></w:p>';
  const fieldParagraph = `<w:p><w:r><w:t xml:space="preserve">Cited study </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${citationInstruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>[1]</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:fldSimple w:instr="REF RetainedTable"><w:r><w:t>Table 1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> or </w:t></w:r><w:fldSimple w:instr="REF MissingTable"><w:r><w:t>Table 2</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:fldSimple w:instr="CITATION NativeStudy"><w:r><w:t>[2]</w:t></w:r></w:fldSimple></w:p>`;
  const wrappedField = multilineCitation ? `<w:p><w:fldSimple w:instr="CITATION NativeStudy"><w:r><w:t>Source first line</w:t><w:br/><w:t>Source second line</w:t></w:r></w:fldSimple></w:p>` : "";
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSources" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>'),
    "customXml/item1.xml": strToU8('<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"><b:Source><b:Tag>NativeStudy</b:Tag><b:SourceType>JournalArticle</b:SourceType><b:Title>Native Word study</b:Title></b:Source></b:Sources>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>${original}</w:t></w:r></w:p><w:p><w:r><w:t>${other}</w:t></w:r></w:p><w:p><w:r><w:t>Protected field </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>${formulas}<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:bookmarkStart w:id="1" w:name="RetainedTable"/><w:r><w:t>Retained table cell.</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p></w:tc></w:tr></w:tbl>${fieldParagraph}${wrappedField}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`.replaceAll("<w:r>", '<w:r><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/></w:rPr>')),
  });
}

async function startWorkbench(root: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const child = spawn(workbenchPython, ["-I", "-m", "research_file_workbench.workbench.launcher", "--library-root", root]);
  const url = await new Promise<string>((accept, reject) => {
    let output = "";
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    child.stdout.on("data", (data) => { output += data; if (output.includes("\n")) accept(output.trim()); });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Workbench exited ${code}: ${errors}`)));
  });
  return { child, url };
}

async function installBrowserBridge(
  page: Page,
  request: (path: string, payload?: any) => Promise<any>,
  renderer: string | null,
  requestBytes?: (path: string) => Promise<Uint8Array>,
) {
  await page.exposeFunction("docxWorkbenchRequest", request);
  await page.exposeFunction("docxWorkbenchBytes", requestBytes ?? (() => { throw new Error("PDF bytes were not requested by this acceptance."); }));
  await page.exposeFunction("docxRenderer", () => renderer);
  await page.exposeFunction("docxSystemFontFaces", async (requests: { family: string; weight: number; style: string }[]) => {
    const faces = await Promise.all(requests.filter((face) => face.family === "Liberation Serif").map(async (requested) => {
      const variant = requested.weight === 700 ? requested.style === "italic" ? "BoldItalic" : "Bold" : requested.style === "italic" ? "Italic" : "Regular";
      const bytes = await readFile(resolve(`node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-${variant}.ttf`));
      return { requested, family: "Liberation Serif", postscriptName: `LiberationSerif-${variant}`,
        weight: requested.weight, style: requested.style, faceIndex: 0,
        sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") };
    }));
    return { faces, missing: requests.filter((face) => face.family !== "Liberation Serif") };
  });
  await page.addInitScript(() => {
    const recoveryDigest = crypto.subtle.digest.bind(crypto.subtle);
    let callback = 0;
    const recoveries = new Map<string, any>();
    const control = { finish: null as (() => void) | null, canceled: 0, prefix: "Suggested paragraph", selection: " is complete." };
    Object.assign(window, {
      __docxTest: control,
      __TAURI_INTERNALS__: {
        transformCallback: () => ++callback,
        unregisterCallback: () => {},
        invoke: async (command: string, args: any = {}) => {
          if (command === "journal_workbench_request") return (window as any).docxWorkbenchRequest(args.path, args.payload ?? undefined);
          if (command === "crossref_search_journal_titles") return (window as any).docxCitationSearch("title", args.title);
          if (command === "crossref_work") return (window as any).docxCitationSearch("doi", args.doi);
          if (command === "journal_docx_renderer") return (window as any).docxRenderer();
          if (command === "journal_docx_render") return (window as any).docxWorkbenchRequest("/api/render-baseline", {
            project_id: args.projectId, baseline_id: args.baselineId,
            libreoffice_executable: args.executable,
            reason: "Refresh the PDF preview of this saved DOCX working-copy version.",
          });
          if (command === "journal_docx_pdf") return Array.from(await (window as any).docxWorkbenchBytes(
            `/api/render?project_id=${encodeURIComponent(args.projectId)}&baseline_id=${encodeURIComponent(args.baselineId)}&bundle_id=${encodeURIComponent(args.bundleId)}&role=pdf&page_number=none`,
          ));
          if (command === "docx_recovery_save") {
            const input = args.request;
            const bytes = Uint8Array.from(atob(input.contentBase64), (char) => char.charCodeAt(0));
            const digest = new Uint8Array(await recoveryDigest("SHA-256", bytes));
            const contentSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
            const metadata = { appProjectId: input.appProjectId, workbenchProjectId: input.workbenchProjectId,
              baseBaselineId: input.baseBaselineId, sourceSha256: input.sourceSha256,
              recoveryKey: input.recoveryKey, revision: input.revision, updatedAt: input.updatedAt,
              contentSha256, taskState: input.taskState };
            recoveries.set(input.recoveryKey, { ...metadata, bytesBase64: input.contentBase64 });
            return metadata;
          }
          if (command === "docx_recovery_commit") {
            const saved = recoveries.get(args.request.recoveryKey);
            if (!saved || saved.contentSha256 !== args.request.contentSha256 || !saved.taskState.pendingSave) throw new Error("Unknown DOCX recovery commit.");
            const pending = saved.taskState.pendingSave;
            const result = await (window as any).docxWorkbenchRequest("/api/baseline", {
              project_id: pending.projectId, expected_baseline_id: pending.expectedBaselineId,
              filename: pending.filename, content_base64: saved.bytesBase64,
              reason: pending.reason, request_id: pending.requestId,
            });
            if (result.status !== "APPLIED") throw new Error(`DOCX baseline was not applied: ${result.status}`);
            return { baselineId: result.result_baseline_id, sourceSha256: saved.contentSha256, revision: saved.revision };
          }
          if (command === "docx_recovery_read") return recoveries.get(args.request.recoveryKey) ?? null;
          if (command === "docx_recovery_list") return { snapshots: [], failures: [] };
          if (command === "docx_recovery_clear") {
            const saved = recoveries.get(args.request.recoveryKey);
            if (saved && saved.contentSha256 !== args.request.contentSha256) return false;
            recoveries.delete(args.request.recoveryKey);
            return true;
          }
          if (command === "resolve_system_font_faces") return (window as any).docxSystemFontFaces(args.requests);
          if (command === "research_task_list") return [];
          if (command === "research_object_annotations") return { annotations: [], deliveries: [], requirements: [], handlings: [], distillations: [] };
          if (command === "research_docx_activities") return { activities: [], nextCursor: 0, hasMore: false };
          if (command === "agent_cancel") { control.canceled++; control.finish?.(); return; }
          if (command === "agent_stream") {
            args.onEvent.onmessage({ kind: "textDelta", text: control.prefix });
            await new Promise<void>((finish) => { control.finish = finish; });
            args.onEvent.onmessage({ kind: "textDelta", text: control.selection });
            args.onEvent.onmessage({ kind: "runEnd" });
            control.finish = null;
            return;
          }
          if (command.startsWith("plugin:")) return 1;
          throw new Error(`Unexpected DOCX browser acceptance IPC: ${command}`);
        },
      },
    });
  });
}

const readLive = (page: Page, query: Record<string, unknown> = {}) =>
  page.evaluate((query) => (window as any).__docxTools.read_docx_document.execute(query), query);

async function delayFeedbackCapture(page: Page) {
  await page.evaluate(() => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = crypto.subtle.digest;
    const probe = { captured: false, release: async () => { release(); await held; } };
    crypto.subtle.digest = async (algorithm, data) => {
      crypto.subtle.digest = original;
      const digest = await original.call(crypto.subtle, algorithm, data);
      probe.captured = true;
      await held;
      return digest;
    };
    Object.assign(window, { __docxFeedbackCapture: probe });
  });
}

async function beginSuggestion(page: Page, paragraphRef: string) {
  await page.evaluate((paragraphRef) => {
    (window as any).__docxPending = (window as any).__docxTools.suggest_docx_change.execute({
      paragraph_ref: paragraphRef, instruction: "Improve this sentence.",
    });
  }, paragraphRef);
}

// Actual React editor and Workbench HTTP. Tauri IPC and token generation are scripted.
test("DOCX live working copy preserves intervention, undo and exact saved checks", async ({}, testInfo) => {
  const renderer = process.env.OLEAFLY_LIBREOFFICE ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  test.skip(!existsSync(renderer), `LibreOffice is not installed at ${renderer}`);
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  const workbenchErrors: string[] = [];
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        const message = `${path}: ${result.error}`;
        workbenchErrors.push(message);
        throw new Error(message);
      }
      return result;
    }
    async function requestBytes(path: string) {
      const response = await fetch(new URL(path, service.url), {
        headers: { "X-RFW-Token": session.token },
      });
      if (!response.ok) {
        const message = `${path}: ${(await response.json()).error}`;
        workbenchErrors.push(message);
        throw new Error(message);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    const guideWorld = await request("/api/worlds", { journal_id: "docx-test", journal_name: "DOCX test journal", article_type: "research_article", stage: "initial_submission", language: "en", sources: [{ name: "guide.txt", kind: "guide_text", content_base64: Buffer.from("All manuscript pages must use A4 paper.").toString("base64") }] });
    const world = await request("/api/world-component", {
      version_id: guideWorld.version_id,
      name: "requirements.json",
      content_base64: Buffer.from(JSON.stringify({
        schema_version: "journal-rule-component-1.0.0", component_id: "page-size", component_version: "1.0.0",
        applicability: { journal_ids: ["docx-test"], article_types: ["research_article"], stages: ["initial_submission"], languages: ["en"], basis: "Explicit A4 requirements confirmed against the retained guide." },
        sources: [{ source_id: "a4", title: "Page-size guidance", locator: "line:1", quote: "All manuscript pages must use A4 paper." }],
        rules: [
          { property: "page_width_twips", expected: 11906, unit: "twips", source_refs: ["a4"] },
          { property: "page_height_twips", expected: 16838, unit: "twips", source_refs: ["a4"] },
        ],
      })).toString("base64"),
      decisions: [
        { property: "page_width_twips", expected: 11906, reason: "Operator confirmed A4 width from the guide." },
        { property: "page_height_twips", expected: 16838, reason: "Operator confirmed A4 height from the guide." },
      ],
    });
    const project = await request("/api/projects", { name: "Synthetic DOCX working copy", filename: "working-copy.docx", content_base64: Buffer.from(fixture(true)).toString("base64") });
    await request("/api/bind", { project_id: project.project_id, world_version_id: world.version_id, expected_binding_id: null });
    const initialCheck = await request("/api/check", { project_id: project.project_id });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors: string[] = [];
    const failedAssets: string[] = [];
    const harfBuzzResponses: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400 && /docx-editor|harfbuzz|\.ttf|\.woff/.test(response.url())) failedAssets.push(response.url()); });
    page.on("response", (response) => {
      if (response.ok() && new URL(response.url()).pathname.endsWith("/harfbuzz.wasm")) {
        harfBuzzResponses.push(response.headers()["content-type"]);
      }
    });
    await installBrowserBridge(page, request, renderer, requestBytes);
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    try { await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 15000 }); }
    catch (cause) {
      await testInfo.attach("docx-startup-errors", { body: JSON.stringify({ errors, consoleErrors, failedAssets }), contentType: "application/json" });
      throw cause;
    }
    await expect.poll(async () => (await readLive(page)).paragraphs?.length).toBe(7);
    const liveDocument = await readLive(page);
    expect(liveDocument).toMatchObject({ document: { appProjectId: "docx-harness", dirty: false } });
    const originalSession = liveDocument.document.sessionId;
    const tools = page.getByTestId("docx-document-tools");
    const paper = page.getByTestId("docx-editor-surface").locator(".docx-page").first();
    const paperBefore = await paper.boundingBox();
    const viewport = page.getByTestId("docx-editor-surface").locator(".docx-editor__scroll-container");
    const scrollBefore = await viewport.evaluate((element) => element.scrollTop);
    const citation = paper.locator('[data-field-atom="field"]').filter({ hasText: "[1]" });
    const viewCitation = page.getByRole("button", { name: "View citation", exact: true });
    const clickField = async (field: typeof citation) => {
      await expect(field).toBeVisible();
      await field.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = await field.boundingBox();
      if (!box) throw new Error("Field has no painted bounds");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await clickField(citation);
    await expect(viewCitation).toBeVisible();
    await viewCitation.click();
    const sources = page.getByRole("dialog", { name: "View citation" });
    const sourceButton = sources.getByRole("link", { name: /Embedded study/ });
    await expect(sourceButton).toBeVisible();
    expect(await page.evaluate(() => (window as any).__docxOpenedSource)).toBeUndefined();
    await page.evaluate(() => {
      window.open = (url) => {
        (window as any).__docxOpenedSource = String(url);
        return null;
      };
    });
    await sourceButton.click();
    await expect.poll(() => page.evaluate(() => (window as any).__docxOpenedSource)).toBe("https://doi.org/10.1234/embedded%23result");
    expect(await paper.boundingBox()).toEqual(paperBefore);
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Escape");
    await expect(sources).toHaveCount(0);
    await page.keyboard.press("Shift+F10");
    await expect(viewCitation).toBeFocused();
    await page.keyboard.press("Escape");

    await test.step("A drag that ends on the citation is not a citation click", async () => {
      await citation.scrollIntoViewIfNeeded();
      const box = (await citation.boundingBox())!;
      const layout = { paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) };
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.move(point.x - 45, point.y, { steps: 6 });
      await page.mouse.move(point.x, point.y, { steps: 6 });
      await page.mouse.up({ clickCount: 1 });
      await expect(viewCitation).toHaveCount(0);
      expect({ paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) }).toEqual(layout);
      expect((await readLive(page)).document.dirty).toBe(false);
    });

    await test.step("Copy and context actions respect a text selection that includes a citation", async () => {
      await paper.locator(".docx-line").filter({ hasText: "Cited study" }).first()
        .click({ position: { x: 4, y: 7 }, timeout: 5000 });
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      const quote = await page.evaluate(() => document.getSelection()?.toString());
      expect(quote).toContain("Cited study");
      const context = page.getByTestId("docx-context-tools");
      await expect(context).toHaveCount(0);
      expect(await citation.evaluate((field) => document.getSelection()?.getRangeAt(0).intersectsNode(field))).toBe(true);
      const copied = await page.evaluate(() => {
        const transfer = new DataTransfer();
        document.activeElement?.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: transfer }));
        return transfer.getData("text/plain");
      });
      expect(copied).toContain("Cited study [1]");
      await expect(context).toHaveCount(0);
      const copy = context.getByRole("button", { name: "Copy", exact: true });
      await page.keyboard.press("Shift+F10");
      await expect(copy).toBeFocused();
      await expect(viewCitation).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(context.getByRole("button", { name: "Annotate selection", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(copy).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(context).toHaveCount(0);
      await expect(viewport.locator(":focus")).toHaveCount(0);
      await paper.locator(".docx-line").filter({ hasText: "Cited study" }).first()
        .click({ position: { x: 4, y: 7 }, timeout: 5000 });
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await page.keyboard.press("Shift+F10");
      await expect(copy).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(context).toHaveCount(0);
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(quote);
      const box = await citation.boundingBox();
      if (!box) throw new Error("The selected citation has no painted bounds.");
      const layout = { paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) };
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await expect(copy).toBeVisible({ timeout: 3000 });
      await expect(viewCitation).toHaveCount(0);
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(quote);
      const menuCopy = page.evaluate(() => new Promise<string>((resolve) => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => { Reflect.deleteProperty(navigator, "clipboard"); resolve(text); } },
        });
      }));
      await copy.click({ timeout: 3000 });
      expect(await menuCopy).toBe(copied);
      await expect(context).toHaveCount(0);
      expect({ paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) }).toEqual(layout);
      await expect.poll(async () => (await readLive(page)).document.dirty).toBe(false);
    });
    await clickField(paper.locator('[data-field-atom="field"]').filter({ hasText: "[2]" }));
    await page.keyboard.press("Shift+F10");
    await expect(viewCitation).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sources.getByText("Native Word study", { exact: true })).toBeVisible();
    await expect(sources.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sources).toHaveCount(0);
    await expect(viewport.locator('.docx-pages:focus')).toHaveCount(1);
    const reference = page.getByRole("button", { name: "Go to reference", exact: true });
    const citationParagraph = paper.locator(".docx-paragraph-fragment").filter({ hasText: "Cited study" });
    await clickField(citationParagraph.locator('[data-field-atom="field"][data-start="23"]').first());
    await expect(reference).toHaveCount(0);
    await clickField(citationParagraph.locator('[data-field-atom="field"][data-start="18"]').first());
    await reference.click({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => {
      const selection = document.getSelection();
      return selection?.anchorNode?.parentElement?.closest(".docx-paragraph-fragment")?.textContent;
    })).toBe("Retained table cell.");
    const equation = paper.locator("[data-docx-equation]").first();
    const equationPanel = page.getByRole("dialog", { name: "Edit LaTeX", exact: true });
    const latex = equationPanel.getByRole("textbox", { name: "LaTeX source", exact: true });
    const macros = equationPanel.getByRole("textbox", { name: "Macros", exact: true });
    const adopt = equationPanel.getByRole("checkbox", { name: "Adopt current math source" });
    const equationAction = page.getByRole("button", { name: "Edit LaTeX", exact: true });
    await test.step("Double-clicking a formula leaves the editor's selection alone", async () => {
      await equation.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      const box = (await equation.boundingBox())!;
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await expect(equationAction).toHaveCount(0);
      expect(await page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(false);
    });
    const openEquation = async (collapseNativeSelection = false) => {
      await clickField(equation);
      if (collapseNativeSelection) {
        await expect(equationAction).toBeVisible();
        await page.evaluate(() => {
          document.getSelection()?.collapseToEnd();
          document.dispatchEvent(new Event("selectionchange"));
        });
      }
      await equationAction.click({ timeout: 5000 });
      try { await expect(latex).toBeFocused(); }
      catch (error) {
        await testInfo.attach("equation diagnostics", { body: JSON.stringify({ errors, consoleErrors }), contentType: "application/json" });
        throw error;
      }
    };
    await test.step("Showing a formula action does not minimize feedback until the editor opens", async () => {
      const feedback = page.getByRole("button", { name: "Fixture feedback", exact: true });
      await feedback.click();
      await expect(feedback).toHaveAttribute("aria-pressed", "true");
      await equation.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await expect(equation).toBeInViewport({ ratio: 1 });
      const readGeometry = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
        scroll: await viewport.evaluate((element) => element.scrollTop) });
      const before = await readGeometry();
      await equation.click({ timeout: 5000 });
      await expect(equationAction).toBeVisible();
      await expect(feedback).toHaveAttribute("aria-pressed", "true");
      expect(await readGeometry()).toEqual(before);
      await equationAction.click();
      await expect(latex).toBeFocused();
      await expect(feedback).toHaveAttribute("aria-pressed", "false");
      expect(await readGeometry()).toEqual(before);
      await feedback.press("Enter");
      await expect(equationPanel).toHaveCount(0);
      await expect(feedback).toBeFocused();
      await feedback.click();
      expect(await readGeometry()).toEqual(before);
    });
    await test.step("Dragging from a formula into text does not open object actions", async () => {
      const from = (await equation.boundingBox())!;
      const formulaLine = paper.locator(".docx-line").filter({ has: page.getByRole("math", { name: "x+1", exact: true }) });
      const to = (await formulaLine.getByText("and", { exact: true }).boundingBox())!;
      const y = from.y + from.height / 2;
      await page.mouse.move(from.x + from.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width - 1, y, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByTestId("docx-context-tools")).toHaveCount(0);
      expect(await page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(false);
    });
    await test.step("A late feedback capture does not take over an open formula editor", async () => {
      await delayFeedbackCapture(page);
      const annotate = page.getByRole("button", { name: "Annotate whole material" });
      await annotate.click();
      await expect.poll(() => page.evaluate(() => (window as any).__docxFeedbackCapture.captured)).toBe(true);
      await openEquation();
      await page.evaluate(() => (window as any).__docxFeedbackCapture.release());
      await expect(annotate).toBeEnabled();
      const documentId = await page.evaluate(async (path) => {
        const { useMaterialAnnotationsStore } = await import(path) as typeof import("../../src/store/material-annotations");
        return useMaterialAnnotationsStore.getState().document?.documentId ?? null;
      }, "/src/store/material-annotations.ts");
      expect(documentId).toBeNull();
      await expect(latex).toBeFocused();
      await page.keyboard.press("Escape");
    });
    await test.step("Escape exits the formula panel while source preview loads", async () => {
      await openEquation();
      await latex.fill("x^2");
      const preview = equationPanel.getByRole("button", { name: "Preview source", exact: true });
      const mathjax = /\/[^?]*mathjax-full(?:[_/][^?]*)/u;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let routed: Promise<void> | undefined;
      await page.route(mathjax, (route) => {
        routed = held.then(() => route.continue());
        return routed;
      }, { times: 1 });
      try {
        const geometry = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
          scroll: await viewport.evaluate((element) => element.scrollTop) });
        const before = await geometry();
        const loading = page.waitForRequest(mathjax);
        await preview.focus();
        await page.keyboard.press("Enter");
        await loading;
        await expect(preview).toBeDisabled();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.keyboard.press("Escape");
        await expect(equationPanel).toHaveCount(0, { timeout: 1500 });
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        expect(await geometry()).toEqual(before);
        expect((await readLive(page)).document.sessionRevision).toBe(liveDocument.document.sessionRevision);
      } finally {
        release();
        await routed;
      }
    });
    await test.step("Keep a LaTeX draft when leaving its popup and switching work surfaces", async () => {
      await openEquation(true);
      await latex.fill("y^2");
      await macros.fill("\\newcommand{\\vect}{\\mathbf}");
      await adopt.check();
      await page.keyboard.press("Escape");
      await expect(equationPanel).toHaveCount(0);
      await openEquation();
      await expect(latex).toHaveValue("y^2");
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await page.getByRole("button", { name: "Word", exact: true }).click();
      await expect(equationPanel).toHaveCount(0);
      await openEquation();
      await expect(latex).toHaveValue("y^2");
      await expect(macros).toHaveValue("\\newcommand{\\vect}{\\mathbf}");
      await expect(adopt).toBeChecked();
      await page.keyboard.press("Escape");
      expect((await readLive(page)).document).toMatchObject({ sessionRevision: liveDocument.document.sessionRevision, dirty: false });
    });
    const convertedEquation = {
      kind: "binary", text: null, fileName: "equation.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", files: [],
      dataBase64: Buffer.from(zipSync({ "word/document.xml": strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><m:oMath><m:sSup><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p></w:body></w:document>',
      ) })).toString("base64"),
    };
    const delayNextEquationConversion = () => page.evaluate(async ({ hostPath, converted }) => {
      const { DOCX_AGENT_HOST } = await import(hostPath) as typeof import("../../src/lib/docx-agent-host");
      const host = window as unknown as {
        __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
      };
      let release = () => {};
      const conversion = new Promise<void>((resolve) => { release = resolve; });
      const probe: { request?: unknown; release(): void; outcome?: Promise<string>;
        result?: Awaited<ReturnType<typeof DOCX_AGENT_HOST.writeEquation>> } = { release };
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command !== "convert_ad_hoc") return invoke(command, args);
        host.__TAURI_INTERNALS__.invoke = invoke;
        probe.request = (args as { request: unknown }).request;
        await conversion;
        return converted;
      };
      const write = DOCX_AGENT_HOST.writeEquation;
      DOCX_AGENT_HOST.writeEquation = (...args) => {
        DOCX_AGENT_HOST.writeEquation = write;
        const pending = write(...args);
        probe.outcome = pending.then((result) => { probe.result = result; return "completed"; }, (error: Error) => error.message);
        return pending;
      };
      Object.assign(window, { __docxEquationTest: probe });
    }, { hostPath: "/src/lib/docx-agent-host.ts", converted: convertedEquation });
    await test.step("Document tools keeps focus and the LaTeX draft when a replacement is cancelled", async () => {
      const before = await readLive(page);
      await delayNextEquationConversion();
      await openEquation();
      const replace = equationPanel.getByRole("button", { name: "Replace equation", exact: true });
      await expect(replace).toBeEnabled();
      await replace.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toMatchObject({
        source: "latex", target: "docx", text: expect.stringContaining("y^2"),
      });
      await expect(equationPanel.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await tools.press("Enter");
      await expect(tools).toHaveAttribute("aria-expanded", "true");
      await expect(equationPanel).toHaveCount(0);
      await expect(tools).toBeFocused();
      const outcome = await page.evaluate(() => {
        const probe = (window as any).__docxEquationTest;
        probe.release();
        return probe.outcome;
      });
      expect(outcome).toContain("cancelled before mutation");
      await expect(tools).toBeFocused();
      expect(await readLive(page)).toEqual(before);
      await tools.click();
      await expect(tools).toHaveAttribute("aria-expanded", "false");
      await expect(equationPanel).toHaveCount(0);
      await openEquation();
      await expect(latex).toHaveValue("y^2");
      await expect(macros).toHaveValue("\\newcommand{\\vect}{\\mathbf}");
      await expect(adopt).toBeChecked();
      await page.keyboard.press("Escape");
    });
    await test.step("Cancel a replacement that finishes before the offscreen popup can close", async () => {
      const before = await readLive(page);
      await delayNextEquationConversion();
      await openEquation();
      await equationPanel.getByRole("button", { name: "Replace equation", exact: true }).press("Enter");
      await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toBeTruthy();
      const scrolled = await equation.evaluate((formula) => {
        const scroller = formula.closest<HTMLElement>(".docx-editor__scroll-container")!;
        scroller.scrollTop = scroller.scrollHeight;
        const bounds = scroller.getBoundingClientRect();
        const anchor = formula.getBoundingClientRect();
        const probe = (window as any).__docxEquationTest;
        probe.release();
        return { offscreen: anchor.bottom <= bounds.top, top: scroller.scrollTop };
      });
      expect(scrolled.offscreen).toBe(true);
      const outcome = await page.evaluate(() => (window as any).__docxEquationTest.outcome);
      expect(outcome).toContain("cancelled before mutation");
      await expect(equationPanel).toHaveCount(0);
      await expect(viewport).toBeFocused();
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrolled.top);
      expect(await readLive(page)).toEqual(before);
      await openEquation();
      await expect(latex).toHaveValue("y^2");
      await expect(macros).toHaveValue("\\newcommand{\\vect}{\\mathbf}");
      await expect(adopt).toBeChecked();
      await page.keyboard.press("Escape");
    });
    const documentParagraphs = page.getByTestId("docx-editor-surface").locator(".docx-paragraph-fragment");
    await test.step("Reject a late equation conversion after a separate Agent edit", async () => {
      const before = await readLive(page);
      const formulas = paper.locator("[data-docx-equation]");
      const originalFormulas = await formulas.allTextContents();
      await delayNextEquationConversion();
      await openEquation();
      const replace = equationPanel.getByRole("button", { name: "Replace equation", exact: true });
      await replace.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toBeTruthy();

      const newText = "Agent edit while the equation converts.";
      const edit = await page.evaluate(async ({ paragraphRef, text }) => {
        const docx = (window as any).__docxTools;
        const target = await docx.capture_docx_target.execute({ paragraph_ref: paragraphRef });
        return docx.apply_docx_suggestion.execute({ target_id: target.targetId, expected_revision: target.revision, text });
      }, { paragraphRef: before.paragraphs[1].paragraphRef, text: newText });
      expect(edit).toMatchObject({ ok: true, changed: true });
      await expect(equationPanel).toBeVisible();
      const afterEdit = await readLive(page);
      expect(afterEdit.document.sessionRevision).toBe(before.document.sessionRevision + 1);
      expect(afterEdit.paragraphs[1].text).toBe(newText);

      const result = await page.evaluate(async () => {
        const probe = (window as any).__docxEquationTest;
        probe.release();
        await probe.outcome;
        return probe.result;
      });
      expect(result).toMatchObject({ ok: false, changed: false, code: "stale-target", revision: afterEdit.document.sessionRevision });
      await expect(equationPanel.getByTestId("docx-equation-result")).toContainText("The equation revision changed");
      await expect(equationPanel.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      expect(await readLive(page)).toEqual(afterEdit);
      expect(await formulas.allTextContents()).toEqual(originalFormulas);

      await page.keyboard.press("Escape");
      await expect(equationPanel).toHaveCount(0);
      await page.getByRole("button", { name: /^Undo/ }).click();
      await expect.poll(async () => (await readLive(page)).paragraphs[1].text).toBe(other);
      expect(await formulas.allTextContents()).toEqual(originalFormulas);
    });
    await test.step("Do not offer an unsent equation draft after a manuscript edit", async () => {
      await documentParagraphs.nth(1).click({ position: { x: 4, y: 8 } });
      await page.keyboard.press("Home");
      await page.keyboard.insertText("TEMP ");
      await expect.poll(async () => (await readLive(page)).paragraphs[1].text).toBe(`TEMP ${other}`);
      await page.getByRole("button", { name: /^Undo/ }).click();
      await expect.poll(async () => (await readLive(page)).paragraphs[1].text).toBe(other);
      await openEquation();
      await expect(latex).toHaveValue("");
      await expect(macros).toHaveValue("");
      await expect(adopt).not.toBeChecked();
      await page.keyboard.press("Escape");
    });
    await test.step("Moving the caret with the keyboard dismisses the formula action", async () => {
      await clickField(equation);
      await expect(equationAction).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await expect(equationAction).toHaveCount(0);
    });
    await viewport.evaluate((element, top) => { element.scrollTop = top; }, scrollBefore);
    await beginSuggestion(page, liveDocument.paragraphs[0].paragraphRef);
    const inline = page.getByTestId("docx-inline-suggestion");
    const reviewEntry = inline.getByRole("button", { name: "Review suggestion", exact: true });
    const review = page.getByTestId("docx-suggestion");
    await expect(reviewEntry).toBeVisible();
    await expect(review).toBeHidden();
    await expect(inline).not.toContainText("Suggested paragraph");
    await test.step("Keep selection actions operable when the review entry cannot fit beside them", async () => {
      const paragraph = paper.getByText(original, { exact: true });
      const layout = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
        scroll: await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]) });
      const startingLayout = await layout();
      await viewport.evaluate((element) => {
        element.style.maxWidth = "260px";
        element.style.maxHeight = "52px";
      });
      try {
        await expect.poll(async () => (await viewport.boundingBox())?.width).toBe(260);
        await paragraph.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await expect(reviewEntry).toBeVisible();
        await paragraph.click({ position: { x: 2, y: 4 }, timeout: 5000 });
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        const before = await layout();
        await page.keyboard.press("Shift+F10");
        const copy = page.getByTestId("docx-context-tools").getByRole("button", { name: "Copy", exact: true });
        const annotateSelection = page.getByTestId("docx-context-tools").getByRole("button", { name: "Annotate selection", exact: true });
        await expect(copy).toBeFocused();
        await expect(reviewEntry).toBeHidden();
        await copy.click({ trial: true, timeout: 1500 });
        await page.keyboard.press("Tab");
        await expect(annotateSelection).toBeFocused();
        await annotateSelection.click({ trial: true, timeout: 1500 });
        await expect(review).toBeHidden();
        expect(await layout()).toEqual(before);
        await viewport.evaluate((element) => { element.style.maxHeight = "144px"; });
        await expect(reviewEntry).toBeVisible();
        await reviewEntry.click({ trial: true, timeout: 1500 });
        await annotateSelection.click({ trial: true, timeout: 1500 });
        await expect(annotateSelection).toBeFocused();
        await viewport.evaluate((element) => { element.style.maxHeight = "52px"; });
        await expect(reviewEntry).toBeHidden();
        await expect(annotateSelection).toBeFocused();
        expect(await layout()).toEqual(before);
        await page.keyboard.press("Escape");
        await expect(reviewEntry).toBeVisible();
        await reviewEntry.click({ trial: true, timeout: 1500 });
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        expect(await layout()).toEqual(before);

        await viewport.evaluate((element) => { element.style.maxHeight = "144px"; });
        await paragraph.click({ button: "right", position: { x: 32, y: 4 } });
        await expect(copy).toBeVisible();
        await reviewEntry.focus();
        await expect(reviewEntry).toBeFocused();
        await expect(copy).toBeVisible();
        await viewport.evaluate((element) => { element.style.maxHeight = "52px"; });
        await expect.poll(() => inline.evaluate((entry) => ({
          stripOpen: !!entry.ownerDocument.querySelector('[data-testid="docx-context-tools"]'),
          reviewFocused: entry.contains(entry.ownerDocument.activeElement),
        }))).toEqual({ stripOpen: false, reviewFocused: true });
        await expect(reviewEntry).toBeFocused();
        expect(await layout()).toEqual(before);
      } finally {
        await viewport.evaluate((element) => {
          element.style.maxWidth = "";
          element.style.maxHeight = "";
        });
        await expect.poll(async () => (await paper.boundingBox())?.width).toBe(startingLayout.paper?.width);
        await viewport.evaluate((element, [left, top]) => { element.scrollTo(left, top); }, startingLayout.scroll);
      }
      expect(await layout()).toEqual(startingLayout);
    });
    await test.step("A citation action does not replace a pending review entry", async () => {
      await citation.scrollIntoViewIfNeeded();
      await expect(reviewEntry).toBeVisible();
      const before = { paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
        scroll: await viewport.evaluate((element) => element.scrollTop) };
      await clickField(citation);
      await expect(viewCitation).toBeVisible();
      await reviewEntry.click({ trial: true });
      await expect(review).toBeHidden();
      await viewCitation.click();
      await expect(sources).toBeVisible();
      await expect(reviewEntry).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
      await expect(reviewEntry).toBeVisible();
      expect({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
        scroll: await viewport.evaluate((element) => element.scrollTop) }).toEqual(before);
    });
    await test.step("Keep the streaming review anchored when Agent navigation highlights another paragraph", async () => {
      const reviewHighlight = viewport.locator(".oleafly-docx-target");
      await expect(reviewHighlight).toBeVisible();
      const before = await inline.boundingBox();
      await page.evaluate(async (target) => {
        const hostPath = "/src/lib/docx-agent-host.ts";
        const { revealDocxWorkspaceTarget } = await import(hostPath) as typeof import("../../src/lib/docx-agent-host");
        await revealDocxWorkspaceTarget(target);
      }, { projectId: "docx-harness", sessionId: originalSession, paragraphRef: liveDocument.paragraphs[1].paragraphRef });
      const navigationHighlight = viewport.locator("[data-docx-anchor-highlight]");
      await expect(navigationHighlight).toBeVisible();
      await expect(reviewHighlight).toBeVisible();
      await expect(inline).toBeVisible({ timeout: 2_000 });
      expect(await inline.boundingBox()).toEqual(before);
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    });
    await test.step("Open and close the compact review from a narrow, short viewport without moving the paper", async () => {
      await viewport.evaluate((element) => {
        element.style.maxWidth = "440px";
        element.style.maxHeight = "72px";
      });
      try {
        await expect.poll(async () => (await paper.boundingBox())?.width ?? Infinity).toBeLessThan(440);
        await documentParagraphs.first().evaluate((paragraph) => {
          paragraph.scrollIntoView({ block: "center", behavior: "instant" });
        });
        await expect(reviewEntry).toBeVisible();
        await expect(inline.getByRole("button")).toHaveCount(1);
        await expect(inline).not.toContainText(original);
        const viewBox = (await viewport.boundingBox())!;
        await expect.poll(async () => {
          const cardBox = await inline.boundingBox();
          return cardBox ? Math.min(Math.abs(cardBox.y - viewBox.y - 4),
            Math.abs(viewBox.y + viewBox.height - cardBox.y - cardBox.height - 4)) : Infinity;
        }).toBeLessThan(2);
        const entryBox = (await reviewEntry.boundingBox())!;
        expect(entryBox.height).toBeLessThan(32);
        expect(entryBox.x).toBeGreaterThanOrEqual(viewBox.x);
        expect(entryBox.x + entryBox.width).toBeLessThanOrEqual(viewBox.x + viewBox.width);
        expect(entryBox.y).toBeGreaterThan(viewBox.y);
        expect(entryBox.y + entryBox.height).toBeLessThan(viewBox.y + viewBox.height);
        await documentParagraphs.first().locator(".docx-line").first().click({ position: { x: 4, y: 7 } });
        await page.keyboard.press("Home");
        await page.keyboard.press("Shift+End");
        const scroll = await viewport.evaluate((element) => element.scrollTop);
        const paperBox = await paper.boundingBox();
        await page.keyboard.press("Shift+F10");
        const copy = page.getByTestId("docx-context-tools").getByRole("button", { name: "Copy", exact: true });
        await expect(copy).toBeFocused();
        await reviewEntry.click({ trial: true, timeout: 1500 });
        await copy.click({ trial: true, timeout: 1500 });
        expect(await paper.boundingBox()).toEqual(paperBox);
        expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll);
        await page.keyboard.press("Escape");
        await reviewEntry.press("Enter");
        await expect(review.getByRole("heading", { name: "Generating suggestion" })).toBeFocused();
        await expect(review.getByTestId("docx-proposed")).toHaveText("Suggested paragraph");
        await expect(review.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await expect(viewport.locator(".oleafly-docx-target")).toBeVisible();
        expect(await paper.boundingBox()).toEqual(paperBox);
        await page.keyboard.press("Escape");
        await expect(tools).toBeFocused();
        await expect(review).toBeHidden();
        await expect(reviewEntry).toBeVisible();
        expect(await paper.boundingBox()).toEqual(paperBox);
        expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll);
      } finally {
        await viewport.evaluate((element) => {
          element.style.maxWidth = "";
          element.style.maxHeight = "";
        });
        await expect.poll(async () => (await paper.boundingBox())?.width).toBe(paperBefore?.width);
        await viewport.evaluate((element, top) => { element.scrollTop = top; }, scrollBefore);
        await expect.poll(() => paper.boundingBox()).toEqual(paperBefore);
      }
    });
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    expect(await paper.boundingBox()).toEqual(paperBefore);
    await documentParagraphs.nth(1).click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.insertText("USER ");
    await expect.poll(async () => (await readLive(page)).paragraphs[1].text).toBe(`USER ${other}`);
    await page.keyboard.press("Shift+End");
    await expect(page.getByTestId("docx-context-tools")).toHaveCount(0);
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("docx-context-tools").getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(reviewEntry).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reviewEntry).toBeVisible();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeHidden();
    await page.getByRole("button", { name: "Word", exact: true }).press("Enter");
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    expect((await readLive(page)).document.sessionId).toBe(originalSession);
    expect((await readLive(page)).paragraphs[1].text).toBe(`USER ${other}`);
    await expect(reviewEntry).toHaveAttribute("title", "Generating suggestion");
    await testInfo.attach("editor-dom", { body: await page.getByTestId("docx-editor-surface").innerHTML(), contentType: "text/html" });
    await test.step("Keep keyboard focus in review when generation replaces the Stop button", async () => {
      const paperBox = await paper.boundingBox();
      const scroll = await viewport.evaluate((element) => element.scrollTop);
      await reviewEntry.press("Enter");
      await page.keyboard.press("Tab");
      await expect(review.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
      await page.evaluate(() => (window as any).__docxTest.finish());
      await expect(review.getByRole("heading", { name: "Ready to review" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(tools).toBeFocused();
      await expect(review).toBeHidden();
      expect(await paper.boundingBox()).toEqual(paperBox);
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll);
      await page.getByRole("button", { name: "Word", exact: true }).focus();
    });
    await expect(reviewEntry).toHaveAttribute("title", "Ready to review");
    const agentText = "Agent updated this paragraph after the user's edit.";
    await test.step("A separate Agent edit leaves the pending review and paper in place", async () => {
      const reviewBox = await inline.boundingBox();
      const paperBox = await paper.boundingBox();
      const scroll = await viewport.evaluate((element) => element.scrollTop);
      await expect(page.getByRole("button", { name: "Word", exact: true })).toBeFocused();
      const applied = await page.evaluate(async (text) => {
        const live = await (window as any).__docxTools.read_docx_document.execute({});
        const target = await (window as any).__docxTools.capture_docx_target.execute({ paragraph_ref: live.paragraphs[1].paragraphRef });
        return (window as any).__docxTools.apply_docx_suggestion.execute({ target_id: target.targetId, expected_revision: target.revision, text });
      }, agentText);
      expect(applied).toMatchObject({ ok: true, changed: true });
      expect((await readLive(page)).paragraphs[1].text).toBe(agentText);
      await expect(reviewEntry).toHaveAttribute("title", "Ready to review");
      await expect(tools).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("button", { name: "Word", exact: true })).toBeFocused();
      expect(await inline.boundingBox()).toEqual(reviewBox);
      expect(await paper.boundingBox()).toEqual(paperBox);
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll);
    });
    const workingBeforeSourceView = await readLive(page);
    await page.getByRole("combobox", { name: "Display", exact: true }).click();
    await page.getByRole("option", { name: "Version before this session" }).click();
    await test.step("View a known source in the read-only original without changing the working copy", async () => {
      const originalSurface = page.getByTestId("docx-original-surface");
      await expect(originalSurface).toBeVisible();
      const originalPaper = originalSurface.locator(".docx-page").first();
      const originalCitation = originalPaper.locator('[data-field-atom="field"]').filter({ hasText: "[2]" });
      const line = originalCitation.locator("xpath=ancestor::*[contains(@class, 'docx-line')][1]");
      await line.click({ trial: true, timeout: 5000 });
      const originalViewport = originalSurface.locator(".docx-editor__scroll-container");
      const layout = { paper: await originalPaper.boundingBox(), scroll: await originalViewport.evaluate((element) => element.scrollTop) };
      const expectSourceView = async () => {
        await expect(sources.getByText("Native Word study", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toHaveCount(0);
        expect({ paper: await originalPaper.boundingBox(), scroll: await originalViewport.evaluate((element) => element.scrollTop) }).toEqual(layout);
      };
      const box = (await originalCitation.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(viewCitation).toBeVisible();
      await viewCitation.click();
      await expectSourceView();
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
      await page.keyboard.press("Shift+F10");
      await expect(viewCitation).toBeFocused();
      await page.keyboard.press("Enter");
      await expectSourceView();
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
    });
    await tools.click();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Go to paragraph", exact: true }).click();
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
    expect((await readLive(page)).document).toMatchObject({
      sessionId: workingBeforeSourceView.document.sessionId,
      sessionRevision: workingBeforeSourceView.document.sessionRevision,
    });
    await expect(page.getByTestId("docx-original-surface").getByTestId("docx-context-tools")).toHaveCount(0);
    const generated = await page.evaluate(() => (window as any).__docxPending);
    expect(generated).toMatchObject({ proposed: "Suggested paragraph is complete." });
    await reviewEntry.press("Enter");
    await expect(review.getByRole("heading", { name: "Ready to review" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toBe("Suggested paragraph is complete.");
    await expect(review.getByRole("heading", { name: "Applied to this working copy" })).toBeFocused();
    await expect(viewport.locator(".oleafly-docx-target")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tools).toBeFocused();
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toBe(original);
    expect((await readLive(page)).paragraphs[1].text).toBe(agentText);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toBe("Suggested paragraph is complete.");
    expect((await readLive(page)).paragraphs[1].text).toBe(agentText);
    await test.step("Restore focus without moving the paper when a focused review entry is withdrawn", async () => {
      const live = await readLive(page);
      const paragraphRef = live.paragraphs[0].paragraphRef;
      await beginSuggestion(page, paragraphRef);
      await expect(reviewEntry).toHaveAttribute("title", "Generating suggestion");
      await reviewEntry.focus();
      await expect(reviewEntry).toBeFocused();
      const scroll = await viewport.evaluate((element) => element.scrollTop);
      const paperBox = await paper.boundingBox();
      const edit = await page.evaluate(async ({ paragraphRef, revision }) =>
        (window as any).__docxTools.replace_docx_text_range.execute({
          paragraph_ref: paragraphRef, expected_revision: revision,
          range: { start: 0, end: "Suggested".length }, expected_text: "Suggested", replacement: "LOCAL Suggested",
        }), { paragraphRef, revision: live.document.sessionRevision });
      expect(edit).toMatchObject({ ok: true, changed: true });
      await expect(reviewEntry).toHaveCount(0);
      await expect(tools).toBeFocused();
      await expect(tools).toHaveAttribute("aria-expanded", "false");
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll);
      expect(await paper.boundingBox()).toEqual(paperBox);
      expect((await readLive(page)).paragraphs[0].text).toBe("LOCAL Suggested paragraph is complete.");
    });
    await tools.click();
    await expect(page.getByTestId("docx-suggestion")).toContainText("Needs a fresh read");
    await tools.click();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__docxTest.canceled)).toBe(1);
    expect(await page.evaluate(() => (window as any).__docxPending)).toHaveProperty("error");
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved");
    await page.getByRole("button", { name: "Check journal format", exact: true }).click();
    await expect(page.getByText("Journal workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Word", exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    await expect(page.getByTestId("docx-check-validity")).toHaveText("Check saved: Current");
    await page.getByRole("button", { name: "Open PDF", exact: true }).click();
    const preview = page.getByTestId("docx-render-preview");
    const viewer = preview.getByTestId("pdf-renderer");
    try {
      await expect(viewer).toHaveAttribute("data-pdf-state", "ready", { timeout: 30_000 });
      await expect(viewer.locator("canvas.pdf-canvas").first()).toBeVisible();
      await expect(preview.getByText("PDF matches the saved working copy", { exact: true })).toBeVisible();
    } catch (cause) {
      await testInfo.attach("docx-preview-errors", { body: JSON.stringify({ workbenchErrors, errors, consoleErrors }), contentType: "application/json" });
      throw cause;
    }
    await page.getByRole("button", { name: "Back to document", exact: true }).click();
    const state = await request("/api/state");
    const current = state.projects[0];
    expect(current.baseline_id).not.toBe(project.baseline_id);
    expect(current.latest_check.baseline_id).toBe(current.baseline_id);
    expect(current.latest_check.summary.compliant).toBe(2);
    const renders = await request(`/api/derived-renders?project_id=${project.project_id}&baseline_id=${current.baseline_id}`);
    expect(renders.derived_renders).toHaveLength(1);
    expect(renders.derived_renders[0]).toMatchObject({ baseline_id: current.baseline_id });
    expect(renders.derived_renders[0].manifest.page_count).toBeGreaterThan(0);
    const renderedPdf = await requestBytes(`/api/render?project_id=${project.project_id}&baseline_id=${current.baseline_id}&bundle_id=${renders.derived_renders[0].bundle_id}&role=pdf&page_number=none`);
    expect(new TextDecoder().decode(renderedPdf.slice(0, 5))).toBe("%PDF-");
    const historical = await request(`/api/check?check_id=${initialCheck.check_id}`);
    expect(historical.validity).toBe("STALE");
    const saved = await request(`/api/manuscript-source?project_id=${project.project_id}&baseline_id=${current.baseline_id}`);
    const savedParts = unzipSync(Buffer.from(saved.content_base64, "base64"));
    const xml = new TextDecoder().decode(savedParts["word/document.xml"]);
    expect(xml).toContain("Suggested paragraph is complete.");
    expect(xml).toContain("Agent updated this paragraph after the user");
    expect(xml).toContain("LOCAL Suggested paragraph is complete.");
    expect(xml).toContain("fldSimple");
    expect(xml).toContain("oMath");
    expect(xml).toContain("Retained table cell.");
    expect(xml.replaceAll("&quot;", '"')).toContain(citationInstruction);
    expect(xml).toContain("CITATION NativeStudy");
    expect(new TextDecoder().decode(savedParts["customXml/item1.xml"])).toContain("Native Word study");
    await page.screenshot({ path: testInfo.outputPath("docx-workspace.png") });
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect.poll(async () => (await readLive(page)).document?.baselineId).toBe(current.baseline_id);
    const reopened = await readLive(page);
    expect(reopened.document.sessionId).not.toBe(originalSession);
    expect(reopened.paragraphs[0].text).toBe("LOCAL Suggested paragraph is complete.");
    expect(reopened.paragraphs[1].text).toBe("Agent updated this paragraph after the user's edit.");
    await clickField(citation);
    await viewCitation.click({ timeout: 5000 });
    await expect(sources.getByRole("link", { name: /Embedded study/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await test.step("Keep the same citation available when its first line scrolls out", async () => {
      const first = paper.locator('[data-field-atom="field"]').filter({ hasText: /^first\s*$/ });
      const second = paper.locator('[data-field-atom="field"]').filter({ hasText: /^second\s*$/ });
      await clickField(first);
      await viewCitation.click();
      const source = sources.getByText("Native Word study", { exact: true });
      await expect(source).toBeVisible();
      const modelRange = (field: typeof first) => field.evaluate((element) => [element.dataset.paragraphId, element.dataset.start, element.dataset.end]);
      expect(await modelRange(first)).toEqual(await modelRange(second));
      const clip = await viewport.boundingBox();
      const ending = await first.boundingBox();
      if (!clip || !ending) throw new Error("The split citation has no painted bounds.");
      await viewport.evaluate((element, delta) => { element.scrollTop += Math.ceil(delta); }, ending.y + ending.height - clip.y);
      await expect(first).not.toBeInViewport();
      await expect(second).toBeInViewport();
      expect(await first.count()).toBe(1);
      await expect(source).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
      const layout = { paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) };
      await page.keyboard.press("Shift+F10");
      await expect(viewCitation).toBeFocused({ timeout: 3000 });
      await page.keyboard.press("Enter");
      await expect(source).toBeVisible();
      expect({ paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) }).toEqual(layout);
      await page.keyboard.press("Escape");
      await expect(sources).toHaveCount(0);
    });
    expect(failedAssets).toEqual([]);
    expect(harfBuzzResponses).toContain("application/wasm");
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-resolving", "false");
    await test.step("Cancel a document tools equation write when switching to Source", async () => {
      const before = await readLive(page);
      await tools.click();
      await expect(tools).toHaveAttribute("aria-expanded", "true");
      await documentParagraphs.nth(1).click({ position: { x: 4, y: 8 } });
      await page.keyboard.press("Home");
      const toolsEquation = page.getByTestId("docx-equation-panel");
      const toolsLatex = toolsEquation.getByRole("textbox", { name: "LaTeX source", exact: true });
      const toolsMacros = toolsEquation.getByRole("textbox", { name: "Macros", exact: true });
      const toolsInsert = toolsEquation.getByRole("button", { name: "Insert equation", exact: true });
      const macro = "\\newcommand{\\vect}{\\mathbf}";
      await toolsLatex.fill("y^2");
      await toolsMacros.fill(macro);
      await expect(toolsInsert).toBeEnabled();
      const startConversion = async () => {
        await delayNextEquationConversion();
        await toolsInsert.click();
        await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toMatchObject({
          source: "latex", target: "docx", text: expect.stringContaining("y^2"),
        });
      };
      const finishConversion = () => page.evaluate(() => {
        const probe = (window as any).__docxEquationTest;
        probe.release();
        return probe.outcome;
      });
      await startConversion();
      const sourceTab = page.getByRole("button", { name: "Source", exact: true });
      await sourceTab.press("Enter");
      await expect(page.getByTestId("docx-workspace")).toBeHidden();
      await expect(sourceTab).toBeFocused();
      const cancellation = await finishConversion();
      await expect(sourceTab).toBeFocused();
      expect(await readLive(page)).toEqual(before);
      expect(cancellation).toContain("cancelled before mutation");

      await page.getByRole("button", { name: "Word", exact: true }).click();
      await expect(page.getByTestId("docx-workspace")).toBeVisible();
      await expect(tools).toHaveAttribute("aria-expanded", "true");
      await expect(toolsLatex).toHaveValue("y^2");
      await expect(toolsMacros).toHaveValue(macro);
      await expect(toolsInsert).toBeEnabled();

      await startConversion();
      expect(await finishConversion()).toBe("completed");
      await expect(toolsEquation.getByTestId("docx-equation-result")).toHaveText("Result");
      expect((await readLive(page)).document).toMatchObject({ sessionRevision: before.document.sessionRevision + 1, dirty: true });
      await tools.click();
      await page.getByRole("button", { name: /^Undo/ }).click();
      expect((await readLive(page)).paragraphs.map((paragraph: { text: string }) => paragraph.text))
        .toEqual(before.paragraphs.map((paragraph: { text: string }) => paragraph.text));
    });
    await test.step("Document tools edits the selected formula and cancels if the user returns to text", async () => {
      const equationTools = page.getByRole("complementary", { name: "Document tools" }).getByTestId("docx-equation-panel");
      const target = equationTools.getByRole("combobox", { name: "Equation", exact: true });
      const replace = equationTools.getByRole("button", { name: "Replace equation", exact: true });
      await clickField(paper.locator("[data-docx-equation]").nth(1));
      await expect(equationAction).toBeVisible();
      await tools.click();
      await expect(replace).toBeVisible();
      await expect(target.locator("option:checked")).toHaveText(/^Equations 2/);
      await documentParagraphs.first().click({ position: { x: 4, y: 8 } });
      await expect(equationTools.getByRole("button", { name: "Insert equation", exact: true })).toBeVisible();
      await expect(replace).toHaveCount(0);
      await tools.click();

      const formulas = paper.locator("[data-docx-equation]");
      const originalFormulas = await formulas.allTextContents();
      const openSecondInTools = async () => {
        await clickField(formulas.nth(1));
        await expect(equationAction).toBeVisible();
        await tools.click();
      };
      const startConversion = async () => {
        await equationTools.getByRole("textbox", { name: "LaTeX source", exact: true }).fill("y^2");
        await equationTools.getByRole("checkbox", { name: "Adopt current math source" }).check();
        await expect(replace).toBeEnabled();
        await delayNextEquationConversion();
        await replace.click({ timeout: 5000 });
        await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toBeTruthy();
      };
      const finishConversion = () => page.evaluate(() => {
        const probe = (window as any).__docxEquationTest;
        probe.release();
        return probe.outcome;
      });
      const before = await readLive(page);
      await openSecondInTools();
      await startConversion();
      await documentParagraphs.first().click({ position: { x: 4, y: 8 } });
      expect(await finishConversion()).toContain("cancelled before mutation");
      expect(await readLive(page)).toEqual(before);
      await expect.poll(() => formulas.allTextContents()).toEqual(originalFormulas);
      await expect(viewport.locator(".docx-pages")).toBeFocused();

      await tools.click();
      await openSecondInTools();
      await equationTools.getByRole("button", { name: "Refresh equation", exact: true }).click({ timeout: 5000 });
      await test.step("Keyboard submission keeps Document tools pending and cancels without changing the paper", async () => {
        const beforeSubmit = await readLive(page);
        const layout = { paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) };
        await equationTools.getByRole("textbox", { name: "LaTeX source", exact: true }).fill("y^2");
        await equationTools.getByRole("checkbox", { name: "Adopt current math source" }).check();
        await expect(replace).toBeEnabled();
        await delayNextEquationConversion();
        await replace.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => (window as any).__docxEquationTest.request)).toBeTruthy();
        await expect(equationTools.getByRole("heading", { name: "Equations", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(equationTools).toBeHidden();
        await expect(tools).toBeFocused();
        expect(await finishConversion()).toContain("cancelled before mutation");
        await expect(tools).toBeFocused();
        expect(await readLive(page)).toEqual(beforeSubmit);
        expect(await formulas.allTextContents()).toEqual(originalFormulas);
        expect({ paper: await paper.boundingBox(), scroll: await viewport.evaluate((element) => element.scrollTop) }).toEqual(layout);
        await tools.click();
        await expect(equationTools).toBeVisible();
        await expect(replace).toBeVisible();
      });
      await startConversion();
      expect(await finishConversion()).toBe("completed");
      await expect.poll(async () => (await formulas.allTextContents()).map((value) => value.normalize("NFKC")))
        .toEqual([originalFormulas[0].normalize("NFKC"), "y2"]);
      await tools.click();
      await page.getByRole("button", { name: /^Undo/ }).click();
      await expect.poll(() => formulas.allTextContents()).toEqual(originalFormulas);
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("DOCX reopening feedback keeps its draft and focus during a new capture", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-feedback-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    await request("/api/projects", {
      name: "Synthetic feedback reentry", filename: "feedback.docx", content_base64: Buffer.from(fixture()).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    await installBrowserBridge(page, request, null);
    const savedFeedback: { body: string; documentId: string; revision: string; sha256: string; anchor: MaterialAnchor }[] = [];
    await page.exposeFunction("saveFeedbackFixture", (input: { document: MaterialReference; bytes: number[]; body: string; anchor: MaterialAnchor }): TaskAnnotation => {
      const { document, body } = input;
      const sha256 = createHash("sha256").update(Buffer.from(input.bytes)).digest("hex");
      savedFeedback.push({ body, documentId: document.documentId, revision: document.revision, sha256, anchor: input.anchor });
      return { id: `feedback-${savedFeedback.length}`, body,
        target: { projectId: document.projectId, objectId: document.documentId, objectRevision: document.revision,
          objectKind: "material", path: null, taskId: null },
        author: { kind: "user", id: "fixture" }, parentId: null, mentions: [], explicitRequest: false,
        status: "open", createdAt: 0, updatedAt: 0, handledAt: null, handledBy: null };
    });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html?workspace-center`);
    await page.evaluate(() => {
      const host = window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
        saveFeedbackFixture(args: unknown): Promise<unknown> };
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = (command, args) => command === "material_annotation_save"
        ? host.saveFeedbackFixture(args) : invoke(command, args);
    });

    const workspace = page.getByTestId("workspace-center");
    const surface = workspace.getByTestId("docx-editor-surface");
    const annotate = workspace.getByRole("button", { name: "Annotate whole material", exact: true });
    const feedback = workspace.getByRole("button", { name: "Open material feedback", exact: true });
    const draft = workspace.getByTestId("material-annotations").getByRole("textbox");
    const paper = surface.locator(".docx-page").first();
    const viewport = surface.locator(".docx-editor__scroll-container");
    const readLayout = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]) });
    const feedbackCapture = () => page.evaluate(async (path) => {
      const { useMaterialAnnotationsStore } = await import(path) as typeof import("../../src/store/material-annotations");
      const document = useMaterialAnnotationsStore.getState().document;
      return document && { documentId: document.documentId, revision: document.revision };
    }, "/src/store/material-annotations.ts");
    const feedbackRevision = async () => (await feedbackCapture())?.revision;

    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
    await annotate.click();
    const wordDraft = "Keep this unsent feedback on the earlier revision.";
    await draft.fill(wordDraft);
    const wordCapture = (await feedbackCapture())!;
    const previousRevision = wordCapture.revision;
    expect(previousRevision).toMatch(/^[a-f0-9]{64}$/u);
    await workspace.getByRole("button", { name: "Minimize feedback", exact: true }).click();
    await expect(draft).toBeHidden();

    await paper.getByText(original, { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.insertText("Later revision. ");
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toBe(`Later revision. ${original}`);
    await delayFeedbackCapture(page);
    await annotate.click();
    await expect.poll(() => page.evaluate(() => (window as any).__docxFeedbackCapture.captured)).toBe(true);
    await expect(annotate).toBeDisabled();
    const before = await readLayout();
    await feedback.press("Enter");
    await expect(feedback).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => (window as any).__docxFeedbackCapture.release());
    await expect(annotate).toBeEnabled();
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue("Keep this unsent feedback on the earlier revision.");
    expect(await feedbackRevision()).toBe(previousRevision);
    await expect(feedback).toBeFocused();
    expect(await readLayout()).toEqual(before);

    await workspace.getByRole("button", { name: "Minimize feedback", exact: true }).click();
    await paper.getByText(original, { exact: false }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Shift+F10");
    const annotateSelection = workspace.getByRole("button", { name: "Annotate selection", exact: true });
    await expect(annotateSelection).toBeVisible();
    await delayFeedbackCapture(page);
    await annotateSelection.click();
    await expect.poll(() => page.evaluate(() => (window as any).__docxFeedbackCapture.captured)).toBe(true);
    await paper.getByText(other, { exact: true }).click();
    const moved = await readLayout();
    await page.evaluate(async () => {
      await (window as any).__docxFeedbackCapture.release();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(draft).toBeHidden();
    await expect(viewport.locator(".docx-pages")).toBeFocused();
    expect(await feedbackRevision()).toBe(previousRevision);
    expect(await readLayout()).toEqual(moved);

    await test.step("Scrolling an annotation target offscreen leaves the earlier draft alone", async () => {
      const line = paper.locator(".docx-line").filter({ hasText: original });
      await line.click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await page.keyboard.press("Shift+F10");
      await delayFeedbackCapture(page);
      await annotateSelection.click();
      await expect.poll(() => page.evaluate(() => (window as any).__docxFeedbackCapture.captured)).toBe(true);
      await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(line).not.toBeInViewport();
      const scrolled = await readLayout();
      await page.evaluate(async () => {
        await (window as any).__docxFeedbackCapture.release();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await expect(draft).toBeHidden();
      await expect(viewport.locator(".docx-pages")).toBeFocused();
      expect(await feedbackRevision()).toBe(previousRevision);
      expect(await readLayout()).toEqual(scrolled);
    });

    await test.step("Working-copy feedback does not move to the original version", async () => {
      await feedback.click();
      await expect(draft).toHaveValue("Keep this unsent feedback on the earlier revision.");
      const display = workspace.getByRole("combobox", { name: "Display", exact: true });
      await display.click();
      await page.getByRole("option", { name: "Version before this session", exact: true }).click();
      await expect(workspace.getByTestId("docx-original-surface")).toBeVisible();
      await expect(draft).toBeHidden();
      await expect(feedback).toHaveCount(0);
      await display.click();
      await page.getByRole("option", { name: "Working copy", exact: true }).click();
      await expect(draft).toBeVisible();
      await expect(draft).toHaveValue("Keep this unsent feedback on the earlier revision.");
      expect(await feedbackRevision()).toBe(previousRevision);
      await workspace.getByRole("button", { name: "Minimize feedback", exact: true }).click();
    });

    await test.step("A retained material's feedback does not hide a Word suggestion", async () => {
      await paper.getByText(original, { exact: false }).scrollIntoViewIfNeeded();
      const before = await readLive(page);
      await beginSuggestion(page, before.paragraphs[0].paragraphRef);
      const review = workspace.getByRole("button", { name: "Review suggestion", exact: true });
      await expect(review).toBeVisible();
      const layout = await readLayout();
      await page.evaluate(async ({ materialPath, viewerPath }) => {
        const { createMaterialDocument } = await import(materialPath) as typeof import("../../src/lib/material-surface");
        const { useMaterialViewerStore } = await import(viewerPath) as typeof import("../../src/store/material-viewer");
        const notes = "Supporting notes for the manuscript.";
        const material = await createMaterialDocument({ projectId: "docx-harness", documentId: "notes", path: "notes.md",
          title: "Supporting notes", kind: "markdown" }, { text: notes });
        useMaterialViewerStore.getState().open({ ...material, load: async () => notes });
      }, { materialPath: "/src/lib/material-surface.ts", viewerPath: "/src/store/material-viewer.ts" });
      const retained = workspace.locator('[data-testid="workspace-material-surface"]');
      await retained.getByRole("button", { name: "Annotate whole material", exact: true }).click();
      const notesDraft = "Keep this draft with the supporting notes.";
      await expect(draft).toHaveValue("");
      await draft.fill(notesDraft);
      const notesCapture = (await feedbackCapture())!;
      await page.evaluate(async (path) => {
        const { useDocxWorkspaceStore } = await import(path) as typeof import("../../src/store/docx-workspace");
        useDocxWorkspaceStore.getState().restore();
      }, "/src/store/docx-workspace.ts");
      await expect(draft).toBeHidden();
      await expect(feedback).toHaveAttribute("aria-expanded", "false");
      await expect.poll(readLayout).toEqual(layout);
      await review.click({ trial: true });
      expect((await readLive(page)).document.sessionRevision).toBe(before.document.sessionRevision);
      await feedback.click();
      await expect(draft).toHaveValue(wordDraft);
      const save = workspace.getByRole("button", { name: "Save annotation", exact: true });
      await save.click();
      await expect(draft).toHaveValue("");
      await workspace.getByRole("button", { name: "Close feedback", exact: true }).click();

      await page.evaluate(async (path) => {
        const { useMaterialViewerStore } = await import(path) as typeof import("../../src/store/material-viewer");
        useMaterialViewerStore.getState().restore();
      }, "/src/store/material-viewer.ts");
      await expect(draft).toBeVisible();
      await expect(draft).toHaveValue(notesDraft);
      await save.click();
      await expect(draft).toHaveValue("");
      expect(savedFeedback).toEqual([
        { ...wordCapture, body: wordDraft, sha256: wordCapture.revision, anchor: { kind: "whole" } },
        { ...notesCapture, body: notesDraft, sha256: notesCapture.revision, anchor: { kind: "whole" } },
      ]);
      await page.evaluate(() => (window as any).__docxTest.finish());
      await page.evaluate(() => (window as any).__docxPending);
    });

    const openSelection = async (text: string, modelStart?: number, modelLength = 1) => {
      await paper.getByText(text, { exact: false }).click({ timeout: 5000 });
      await page.keyboard.press("Home");
      if (modelStart === undefined) await page.keyboard.press("Shift+End");
      else {
        for (let offset = 0; offset < modelStart; offset += 1) await page.keyboard.press("ArrowRight");
        for (let offset = 0; offset < modelLength; offset += 1) await page.keyboard.press("Shift+ArrowRight");
      }
      await page.keyboard.press("Shift+F10");
      await page.keyboard.press("Tab");
      await expect(annotateSelection).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(draft).toBeFocused();
    };

    await test.step("Separate paragraph drafts keep their captured targets", async () => {
      await page.getByRole("button", { name: "Synthetic feedback reentry", exact: true }).click({ timeout: 5000 });
      const firstText = `Later revision. ${original}`;
      await openSelection(firstText);
      const firstBody = "Only the suggestion paragraph needs this note.";
      await draft.fill(firstBody);
      const firstCapture = (await feedbackCapture())!;
      await openSelection(other);
      await expect(draft).toHaveValue("");
      const secondBody = "This note belongs to the human paragraph.";
      await draft.fill(secondBody);
      const secondCapture = (await feedbackCapture())!;

      await openSelection(firstText);
      await expect(draft).toHaveValue(firstBody);
      const save = workspace.getByRole("button", { name: "Save annotation", exact: true });
      await save.click();
      await expect(draft).toHaveValue("");
      await openSelection(other);
      await expect(draft).toHaveValue(secondBody);
      await save.click();
      await expect(draft).toHaveValue("");
      const [firstSave, secondSave] = savedFeedback.slice(-2);
      const { paragraphs } = await readLive(page) as { paragraphs: { text: string; paraId: string }[] };
      const firstId = paragraphs.find(({ text }) => text === firstText)?.paraId;
      const secondId = paragraphs.find(({ text }) => text === other)?.paraId;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      expect(firstId).not.toBe(secondId);
      expect(firstSave).toEqual({ ...firstCapture, body: firstBody, sha256: firstCapture.revision,
        anchor: { kind: "object", id: firstId, label: firstText, range: { from: 0, to: firstText.length } } });
      expect(secondSave).toEqual({ ...secondCapture, body: secondBody, sha256: secondCapture.revision,
        anchor: { kind: "object", id: secondId, label: other, range: { from: 0, to: other.length } } });

      const earlierBody = "Feedback on the wording before the edit.";
      await draft.fill(earlierBody);
      await workspace.getByRole("button", { name: "Minimize feedback", exact: true }).press("Enter");
      await expect(feedback).toBeFocused();
      await paper.getByText(other, { exact: true }).click();
      await page.keyboard.press("Home");
      await page.keyboard.insertText("Revised. ");
      const updatedText = `Revised. ${other}`;
      await openSelection(updatedText);
      await expect(draft).toHaveValue("");
      expect(await feedbackRevision()).not.toBe(secondCapture.revision);
      const target = workspace.getByRole("combobox", { name: "Feedback target", exact: true });
      const earlier = target.getByRole("option", { name: /^Earlier version .* · Human paragraph stays independent\.$/u });
      const layout = await readLayout();
      await target.focus();
      await target.selectOption(await earlier.getAttribute("value") as string);
      await expect(draft).toHaveValue(earlierBody);
      await expect(target).toBeFocused();
      const feedbackPanel = workspace.getByTestId("material-annotations");
      await expect(feedbackPanel.getByText("manuscript.docx · Earlier version", { exact: true })).toBeVisible();
      await expect(feedbackPanel.getByRole("button", { name: "manuscript.docx · Earlier version", exact: true })).toHaveCount(0);
      expect(await readLayout()).toEqual(layout);
      expect(await feedbackRevision()).toBe(secondCapture.revision);
      await save.click();
      await expect(draft).toHaveValue("");
      expect(savedFeedback.at(-1)).toEqual({ ...secondSave, body: earlierBody });
      await expect(paper.getByText(updatedText, { exact: true })).toBeVisible();
    });

    await test.step("Identical text at different ranges keeps separate drafts", async () => {
      const firstText = `Later revision. ${original}`;
      const firstA = firstText.indexOf("a");
      const secondA = firstText.indexOf("a", firstA + 1);
      expect(firstA).toBeGreaterThanOrEqual(0);
      expect(secondA).toBeGreaterThan(firstA);
      const firstBody = "The first occurrence has its own draft.";
      const secondBody = "The second occurrence keeps a different draft.";
      const save = workspace.getByRole("button", { name: "Save annotation", exact: true });

      await openSelection(firstText, firstA);
      await draft.fill(firstBody);
      await openSelection(firstText, secondA);
      await expect(draft).toHaveValue("");
      await draft.fill(secondBody);
      await openSelection(firstText, firstA);
      await expect(draft).toHaveValue(firstBody);
      await save.click();
      await expect(draft).toHaveValue("");
      await openSelection(firstText, secondA);
      await expect(draft).toHaveValue(secondBody);
      await save.click();
      await expect(draft).toHaveValue("");

      const paragraphId = (await readLive(page)).paragraphs[0].paraId;
      const [firstSave, secondSave] = savedFeedback.slice(-2);
      expect(firstSave.anchor).toEqual({ kind: "object", id: paragraphId, label: "a",
        range: { from: firstA, to: firstA + 1 } });
      expect(secondSave.anchor).toEqual({ kind: "object", id: paragraphId, label: "a",
        range: { from: secondA, to: secondA + 1 } });
    });
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("DOCX review shortcut yields expanded feedback without losing its draft", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-review-feedback-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    const request = async (path: string, payload?: unknown) => {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    };
    await request("/api/projects", {
      name: "Synthetic review and feedback", filename: "review.docx",
      content_base64: Buffer.from(fixture()).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await installBrowserBridge(page, request, null);
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html?workspace-center`);

    const workspace = page.getByTestId("workspace-center");
    const surface = workspace.getByTestId("docx-editor-surface");
    const paper = surface.locator(".docx-page").first();
    const viewport = surface.locator(".docx-editor__scroll-container");
    const pages = viewport.locator(".docx-pages");
    const tools = workspace.getByTestId("docx-document-tools");
    const review = workspace.getByTestId("docx-suggestion");
    const reviewEntry = workspace.getByRole("button", { name: "Review suggestion", exact: true });
    const annotate = workspace.getByRole("button", { name: "Annotate whole material", exact: true });
    const feedback = workspace.getByRole("button", { name: "Open material feedback", exact: true });
    const draft = workspace.getByTestId("material-annotations").getByRole("textbox");
    const readLayout = async () => ({
      paper: await paper.boundingBox(),
      viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop]),
    });

    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
    const live = await readLive(page);
    const target = live.paragraphs.find((paragraph: { text: string }) => paragraph.text === other);
    expect(target).toBeDefined();
    await beginSuggestion(page, target.paragraphRef);
    await expect(reviewEntry).toBeVisible();
    await page.evaluate(() => (window as any).__docxTest.finish());
    await expect(reviewEntry).toHaveAttribute("title", "Ready to review");

    await annotate.click();
    const wordDraft = "Keep this feedback draft when the review opens.";
    await expect(draft).toBeVisible();
    await draft.fill(wordDraft);
    await expect(reviewEntry).toBeHidden();

    const sessionId = live.document.sessionId as string;
    const readModelSelection = () => page.evaluate(async ({ path, sessionId }) => {
      const module = await import(path) as typeof import("../../src/components/research/DocxWorkspaceDialog");
      return module.e2eDocxSelection(sessionId);
    }, { path: "/src/components/research/DocxWorkspaceDialog.tsx", sessionId });
    await paper.getByText(original, { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(pages).toBeFocused();
    const selection = await readModelSelection();
    expect(selection).toMatchObject({ anchor: { offset: 1 }, head: { offset: 1 } });
    expect(selection!.anchor.paragraphId).toBe(selection!.head.paragraphId);
    await expect(feedback).toHaveAttribute("aria-expanded", "true");
    const before = await readLayout();

    await page.keyboard.press("F6");
    await expect(tools).toHaveAttribute("aria-expanded", "true");
    await expect(review.getByRole("heading", { name: "Ready to review" })).toBeFocused();
    await expect(feedback).toHaveAttribute("aria-expanded", "false");
    await expect(draft).toBeHidden();
    expect(await readModelSelection()).toEqual(selection);
    expect(await readLayout()).toEqual(before);

    await page.keyboard.press("Escape");
    await expect(tools).toHaveAttribute("aria-expanded", "false");
    await expect(review).toBeHidden();
    await expect(pages).toBeFocused();
    expect(await readModelSelection()).toEqual(selection);
    expect(await readLayout()).toEqual(before);

    await feedback.click();
    await expect(feedback).toHaveAttribute("aria-expanded", "true");
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue(wordDraft);
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("DOCX late whole-material feedback yields to a new paper caret", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-late-feedback-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    await request("/api/projects", {
      name: "Late whole-material feedback", filename: "feedback.docx",
      content_base64: Buffer.from(fixture()).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    await installBrowserBridge(page, request, null);
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html?workspace-center`);

    const workspace = page.getByTestId("workspace-center");
    const surface = workspace.getByTestId("docx-editor-surface");
    const paper = surface.locator(".docx-page").first();
    const viewport = surface.locator(".docx-editor__scroll-container");
    const annotate = workspace.getByRole("button", { name: "Annotate whole material", exact: true });
    const feedback = workspace.getByTestId("workspace-material-feedback");
    const draft = workspace.getByTestId("material-annotations").getByRole("textbox");
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");

    const sessionId = (await readLive(page)).document.sessionId as string;
    const readModelSelection = () => page.evaluate(async ({ path, sessionId }) => {
      const module = await import(path) as typeof import("../../src/components/research/DocxWorkspaceDialog");
      return module.e2eDocxSelection(sessionId);
    }, { path: "/src/components/research/DocxWorkspaceDialog.tsx", sessionId });

    await paper.getByText(other, { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await delayFeedbackCapture(page);
    await annotate.click();
    await expect.poll(() => page.evaluate(() => (window as any).__docxFeedbackCapture.captured)).toBe(true);
    await expect(annotate).toBeDisabled();

    await paper.getByText(other, { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const caret = await readModelSelection();
    expect(caret).not.toBeNull();
    await expect(viewport.locator(".docx-pages")).toBeFocused();

    await page.evaluate(async () => {
      await (window as any).__docxFeedbackCapture.release();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(annotate).toBeEnabled();
    await expect(feedback).toBeHidden();
    await expect(draft).toHaveCount(0);
    await expect(viewport.locator(".docx-pages")).toBeFocused();
    expect(await readModelSelection()).toEqual(caret);

    await annotate.click();
    await expect(feedback).toBeVisible();
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue("");
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

async function checkSelectionActionsAcrossBreak(split: "column" | "page") {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-selection-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    const request = async (path: string, payload?: unknown) => {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    };
    const parts = unzipSync(fixture());
    const first = "Selected text before the break.";
    const second = "Selected text after the break.";
    const xml = new TextDecoder().decode(parts["word/document.xml"])
      .replace(`<w:t>${original}</w:t>`, `<w:t>${first}</w:t><w:br w:type="${split}"/><w:t>${second}</w:t>`);
    parts["word/document.xml"] = strToU8(split === "column"
      ? xml.replace("</w:sectPr>", '<w:cols w:num="2" w:space="720"/></w:sectPr>')
      : xml.replace('w:h="16838"', 'w:h="6000"'));
    await request("/api/projects", {
      name: "Synthetic split paragraph", filename: "split.docx", content_base64: Buffer.from(zipSync(parts)).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
    await installBrowserBridge(page, request, null);
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-resolving", "false");
    const surface = page.getByTestId("docx-editor-surface");
    const papers = surface.locator(".docx-page");
    const viewport = surface.locator(".docx-editor__scroll-container");
    const before = papers.first().getByText(first, { exact: true });
    const after = papers.nth(split === "column" ? 0 : 1).getByText(second, { exact: true });
    await expect(before).toBeInViewport({ ratio: 1 });
    await expect(after).toBeInViewport({ ratio: 1 });
    const beforeBox = (await before.boundingBox())!;
    const afterBox = (await after.boundingBox())!;
    if (split === "column") expect(afterBox.x - beforeBox.x).toBeGreaterThan(100);
    const readGeometry = async () => ({ paper: await papers.first().boundingBox(), viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => element.scrollTop) });
    const geometry = await readGeometry();
    const copy = page.getByRole("button", { name: "Copy", exact: true });
    const selectedText = () => page.evaluate(() => document.getSelection()?.toString());
    const start = { x: beforeBox.x + 1, y: beforeBox.y + beforeBox.height / 2 };
    const end = { x: afterBox.x + afterBox.width - 1, y: afterBox.y + afterBox.height / 2 };
    const drag = async (from: typeof start, to: typeof end) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    };
    const expectActionNear = async (box: typeof beforeBox) => {
      const action = (await copy.boundingBox())!;
      expect(Math.abs(action.x - box.x)).toBeLessThan(24);
      expect(Math.min(Math.abs(action.y - box.y - box.height), Math.abs(box.y - action.y - action.height))).toBeLessThan(24);
    };
    await drag(start, end);
    const quote = await selectedText();
    expect(quote).toContain(first);
    expect(quote).toContain(second);
    await expect(copy).toHaveCount(0);

    await page.mouse.click(beforeBox.x + 40, start.y, { button: "right" });
    await expect(copy).toBeVisible();
    await expectActionNear(beforeBox);
    await page.keyboard.press("Escape");
    expect(await selectedText()).toBe(quote);

    await page.keyboard.press("Shift+F10");
    await expect(copy).toBeFocused();
    await expectActionNear(afterBox);
    await page.keyboard.press("Escape");
    await expect(copy).toHaveCount(0);
    await expect(viewport.locator(".docx-pages:focus")).toHaveCount(1);
    expect(await selectedText()).toBe(quote);

    await drag(end, start);
    expect(await selectedText()).toBe(quote);
    await expect(copy).toHaveCount(0);
    await page.mouse.click(afterBox.x + 40, end.y, { button: "right" });
    await expect(copy).toBeVisible();
    await expectActionNear(afterBox);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+F10");
    await expect(copy).toBeFocused();
    await expectActionNear(beforeBox);
    await page.keyboard.press("Escape");
    await expect(copy).toHaveCount(0);
    expect(await selectedText()).toBe(quote);
    expect(await readGeometry()).toEqual(geometry);
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
}

for (const split of ["column", "page"] as const) {
  test(`selection actions stay with the invoked line across a ${split} break`, async () => {
    await checkSelectionActionsAcrossBreak(split);
  });
}

test("opt-in citation picker preserves one Crossref source across columns, save and download", async ({}, testInfo) => {
  test.skip(process.env.OLEAFLY_DOCX_CITATION_ACCEPTANCE !== "1", "Run Vite with VITE_DOCX_CITATION_PREVIEW=1 and opt in.");
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-citation-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    const parts = unzipSync(fixture());
    const decoder = new TextDecoder();
    const authorDoi = "10.1234/native-study";
    const oversizedTitle = `Long article title: ${"A".repeat(255)}`;
    const bibliographySource = (tag: string, title: string) =>
      `<b:Source><b:Tag>${tag}</b:Tag><b:SourceType>JournalArticle</b:SourceType><b:Title>${title}</b:Title><b:URL>https://doi.org/${conflictingDoi}</b:URL></b:Source>`;
    parts["customXml/item1.xml"] = strToU8(decoder.decode(parts["customXml/item1.xml"])
      .replace("<b:Title>Native Word study</b:Title>", `<b:Title>Native Word study</b:Title><b:URL>https://doi.org/${authorDoi}</b:URL>`)
      .replace("</b:Sources>",
      `${bibliographySource("ConflictingA", "Conflicting source A")}${bibliographySource("ConflictingB", "Conflicting source B")}</b:Sources>`));
    const spanningBibliography = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
      '<w:p><w:r><w:t>Existing bibliography entry.</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const leftText = "Left column citation body.";
    const twoColumns = decoder.decode(parts["word/document.xml"])
      .replace('<w:fldChar w:fldCharType="begin"/>',
        '<w:fldChar w:fldCharType="begin" w:fldLock="1"><w:fldData>cGF5bG9hZA==</w:fldData></w:fldChar>')
      .replace(`</w:t></w:r></w:p><w:p><w:r><w:rPr>`, `</w:t><w:br w:type="column"/></w:r></w:p><w:p><w:r><w:rPr>`)
      .replace("<w:body>", `<w:body><w:p><w:r><w:t>${leftText}</w:t></w:r></w:p>`)
      .replace("<w:sectPr>", `<w:p><w:r><w:t>Second citation body.</w:t></w:r></w:p>${spanningBibliography}<w:sectPr>`)
      .replace("</w:sectPr>", '<w:cols w:num="2" w:space="720"/></w:sectPr>');
    parts["word/document.xml"] = strToU8(twoColumns);
    const originalBytes = zipSync(parts);
    const project = await request("/api/projects", {
      name: "Synthetic two-column citation", filename: "citations.docx", content_base64: Buffer.from(originalBytes).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, acceptDownloads: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installBrowserBridge(page, request, null);
    let releaseSearch = () => {};
    let requests = 0;
    await page.exposeFunction("docxCitationSearch", async (kind: "title" | "doi", query: string) => {
      const requestNumber = ++requests;
      const articles = (kind === "title" && query === "Column article") || (kind === "doi" && query === columnDoi) ? [{ DOI: columnDoi, title: ["Column article"],
        type: "journal-article", author: [{ family: "Ng", given: "Li" }],
        "container-title": ["Journal of Layout"], issued: { "date-parts": [[2025]] } }] :
        kind === "doi" && query === conflictingDoi ? [{ DOI: conflictingDoi, title: ["Conflicting article"],
          type: "journal-article", author: [{ family: "Du", given: "Wei" }],
          "container-title": ["Journal of Conflict"], issued: { "date-parts": [[2024]] } }] :
          kind === "title" && query === "Long article title" ? [{ DOI: "10.1234/long-title", title: [oversizedTitle],
            type: "journal-article", author: [{ family: "Lin" }],
            "container-title": ["Journal of Layout"], issued: { "date-parts": [[2025]] } }] : null;
      if (!articles) throw new Error(`Unexpected ${kind} query: ${query}`);
      if (requestNumber <= 3) await new Promise<void>((done) => { releaseSearch = done; });
      return kind === "doi" ? articles[0] : JSON.stringify({ message: { items: articles } });
    });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    await expect.poll(async () => (await readLive(page)).paragraphs?.length).toBe(11);
    const surface = page.getByTestId("docx-editor-surface");
    const paper = surface.locator(".docx-page").first();
    const viewport = surface.locator(".docx-editor__scroll-container");
    const left = surface.locator(".docx-paragraph-fragment").filter({ hasText: leftText }).locator(".docx-line").first();
    const right = surface.locator(".docx-line").filter({ hasText: other });
    const secondBody = surface.locator(".docx-line").filter({ hasText: "Second citation body." });
    const picker = page.getByRole("dialog", { name: "Insert citation" });
    const crossref = picker.getByRole("button", { name: "Search Crossref" });
    const closePicker = picker.getByRole("button", { name: "Close", exact: true });
    const readLayout = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => element.scrollTop) });
    const bibliographyLine = surface.locator(".docx-line").filter({ hasText: "Existing bibliography entry." });
    await bibliographyLine.click({ position: { x: 12, y: 7 } });
    await expect(viewport.locator(".docx-pages:focus")).toHaveCount(1);
    expect(await bibliographyLine.evaluate((line) => line.contains(document.getSelection()?.anchorNode ?? null))).toBe(true);
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toHaveCount(0);
    expect((await readLive(page)).document.dirty).toBe(false);
    const capture = async (line = right, column: "left" | "right" = "right") => {
      await line.click({ position: { x: 4, y: 7 }, timeout: 5000 });
      await page.keyboard.press("Home");
      const caret = await surface.locator("[data-docx-caret]").boundingBox();
      const leftBox = await left.boundingBox();
      if (!caret || !leftBox) throw new Error("The two-column fixture has no painted caret or first column.");
      if (column === "left") expect(Math.abs(caret.x - leftBox.x)).toBeLessThan(10);
      else expect(caret.x - leftBox.x).toBeGreaterThan(100);
      const layout = await readLayout();
      await page.keyboard.press("Shift+F10");
      const button = page.getByRole("button", { name: "Insert citation", exact: true });
      await expect(button).toBeFocused();
      const bar = await button.boundingBox();
      expect(Math.abs((bar?.x ?? 0) - caret.x)).toBeLessThan(28);
      await page.keyboard.press("Enter");
      await expect(picker.getByRole("searchbox")).toBeFocused();
      expect(await readLayout()).toEqual(layout);
    };
    await capture();
    const searchLayout = await readLayout();
    await expect(picker.getByRole("button", { name: "Native Word study" })).toBeVisible();
    const searchBox = picker.getByRole("searchbox");
    const localTrialSource = picker.getByRole("button", { name: "Column article", exact: true });
    await searchBox.fill("Column article");
    await page.keyboard.press("Tab");
    await expect(crossref).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests).toBe(1);
    await expect(searchBox).toBeFocused();
    await closePicker.click();
    await expect(picker).toHaveCount(0);
    await expect(viewport.locator('.docx-pages:focus')).toHaveCount(1);
    expect(await readLayout()).toEqual(searchLayout);
    releaseSearch();
    await capture();
    await searchBox.fill("Column article");
    await searchBox.press("Enter");
    await expect.poll(() => requests).toBe(2);
    await expect(searchBox).toBeFocused();
    await left.click({ position: { x: 4, y: 7 } });
    await expect(picker).toHaveCount(0);
    releaseSearch();
    await expect(picker).toHaveCount(0);
    expect((await readLive(page)).document.dirty).toBe(false);
    await test.step("A search started before switching to Source does not return to the reopened picker", async () => {
      await capture();
      const before = (await readLive(page)).document;
      await page.evaluate(() => {
        const bridge = (window as any).__TAURI_INTERNALS__;
        const invoke = bridge.invoke;
        bridge.invoke = (command: string, args?: unknown) => {
          const pending = invoke(command, args);
          if (command === "crossref_search_journal_titles") {
            bridge.invoke = invoke;
            Object.assign(window, { __docxPendingCitationSearch: pending });
          }
          return pending;
        };
      });
      await searchBox.fill("Column article");
      await crossref.click();
      await expect.poll(() => requests).toBe(3);
      await page.getByRole("button", { name: "Source", exact: true }).press("Enter");
      await expect(page.getByText("Source workspace", { exact: true })).toBeVisible();
      await expect(picker).toHaveCount(0);
      await page.getByRole("button", { name: "Word", exact: true }).press("Enter");
      await expect(picker).toHaveCount(0);
      await capture();
      releaseSearch();
      await page.evaluate(async () => {
        await (window as any).__docxPendingCitationSearch;
      });
      await expect(searchBox).toBeFocused();
      await expect(searchBox).toHaveValue("");
      await expect(picker.getByRole("region", { name: "Crossref", exact: true })).toHaveCount(0);
      expect((await readLive(page)).document).toMatchObject({ sessionId: before.sessionId,
        sessionRevision: before.sessionRevision, dirty: false });
      await page.keyboard.press("Escape");
    });
    await capture();
    await expect(picker.getByRole("button", { name: "Conflicting source A", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Conflicting source B", exact: true })).toBeVisible();
    const conflictStart = (await readLive(page)).document;
    const conflictFieldCount = await paper.locator('[data-field-atom="field"]').count();
    await picker.getByRole("searchbox").fill(conflictingDoi);
    await crossref.click();
    const conflictResult = picker.getByRole("button").filter({ hasText: "Conflicting article" }).filter({ hasText: "Journal of Conflict" });
    await expect(conflictResult).toHaveCount(1);
    await conflictResult.click();
    expect((await readLive(page)).document.dirty).toBe(false);
    const pickerHandle = await picker.elementHandle();
    const conflictLayout = await readLayout();
    await expect(picker.getByRole("alert")).toBeVisible();
    await expect(picker.getByRole("alert")).toHaveText(conflictingSourceMessage);
    await expect(picker.getByRole("button", { name: "Insert citation", exact: true })).toBeDisabled();
    expect(await picker.evaluate((element, originalPicker) => element === originalPicker, pickerHandle)).toBe(true);
    await pickerHandle.dispose();
    expect((await readLive(page)).document).toMatchObject({
      sessionId: conflictStart.sessionId,
      sessionRevision: conflictStart.sessionRevision,
      savedRevision: conflictStart.savedRevision,
      dirty: false,
    });
    expect(await paper.locator('[data-field-atom="field"]').count()).toBe(conflictFieldCount);
    expect(await readLayout()).toEqual(conflictLayout);
    await picker.getByRole("searchbox").fill("Long article title");
    await crossref.click();
    await picker.getByRole("button", { name: /Long article title/ }).click();
    await expect(picker.getByRole("alert")).toHaveText("This source's metadata doesn't fit Word's bibliography format.");
    await expect(picker.getByRole("button", { name: "Insert citation", exact: true })).toBeDisabled();
    expect((await readLive(page)).document).toMatchObject({ sessionRevision: conflictStart.sessionRevision, dirty: false });
    expect(await paper.locator('[data-field-atom="field"]').count()).toBe(conflictFieldCount);
    expect(await readLayout()).toEqual(conflictLayout);
    await page.keyboard.press("Escape");
    await capture(left, "left");
    await picker.getByRole("searchbox").fill(columnDoi);
    await crossref.click();
    const columnResult = picker.getByRole("button").filter({ hasText: "Column article" }).filter({ hasText: "Journal of Layout" });
    await expect(columnResult).toHaveCount(1);
    await expect(columnResult).toHaveAccessibleDescription(`Journal of Layout · 2025 · ${columnDoi}`);
    const unselected = await columnResult.evaluate((element) => getComputedStyle(element).backgroundColor);
    await columnResult.click();
    await expect(columnResult).toHaveAttribute("aria-pressed", "true");
    const confirmInsert = picker.getByRole("button", { name: "Insert citation", exact: true });
    await expect(confirmInsert).toHaveAccessibleDescription("Add document source");
    await page.mouse.move(0, 0);
    await expect.poll(() => columnResult.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(unselected);
    expect((await readLive(page)).document.dirty).toBe(false);
    await confirmInsert.click();
    const columnFields = surface.locator('[data-field-atom="field"]').filter({ hasText: "⟦Column" });
    try { await expect(columnFields).toHaveCount(1); }
    catch (cause) {
      const painted = await surface.locator('[data-field-atom]').evaluateAll((fields) => fields.map((field) => ({ text: field.textContent, start: (field as HTMLElement).dataset.start, end: (field as HTMLElement).dataset.end })));
      await testInfo.attach("citation write errors", { body: JSON.stringify({ errors, painted, document: await readLive(page) }), contentType: "application/json" });
      throw cause;
    }
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toContain(leftText);
    await expect.poll(async () => (await readLive(page)).paragraphs[0].text).toContain("Column article");
    const firstInsertion = (await readLive(page)).document;
    await capture(secondBody);
    await picker.getByRole("searchbox").fill(`https://doi.org/${columnDoi.toUpperCase()}`);
    await crossref.click();
    const reusedResult = picker.getByRole("button").filter({ hasText: "Column article" }).filter({ hasText: "Journal of Layout" });
    await expect(picker.getByRole("region", { name: "In this document" }).getByRole("button", { name: "Column article" })).toBeVisible();
    await expect(picker.getByRole("region", { name: "Crossref" }).getByRole("button", { name: "Column article" })).toBeVisible();
    await expect(reusedResult).toHaveCount(1);
    await reusedResult.click();
    await expect(confirmInsert).toHaveAccessibleDescription("Reuse: Column article");
    expect((await readLive(page)).document.sessionRevision).toBe(firstInsertion.sessionRevision);
    await picker.getByRole("button", { name: "Insert citation", exact: true }).click();
    await expect(columnFields).toHaveCount(2);
    expect(new Set(await columnFields.evaluateAll((fields) => fields.map((field) => field.getAttribute("data-paragraph-id")))).size).toBe(2);
    await expect.poll(async () => (await readLive(page)).document.dirty).toBe(true);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(columnFields).toHaveCount(1);
    await expect(columnFields.first()).toBeVisible();
    await capture(secondBody);
    await searchBox.fill(columnDoi);
    await expect(localTrialSource).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(columnFields).toHaveCount(0);
    await capture(secondBody);
    await searchBox.fill(columnDoi);
    await expect(localTrialSource).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(columnFields).toHaveCount(1);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(columnFields).toHaveCount(2);
    const [leftCitation, rightCitation] = await columnFields.evaluateAll((fields) =>
      fields.map((field) => field.getBoundingClientRect().x));
    expect(rightCitation - leftCitation).toBeGreaterThan(100);
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved");
    const baseline = (await readLive(page)).document.baselineId;
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect.poll(async () => (await readLive(page)).document?.baselineId).toBe(baseline);
    await expect(columnFields).toHaveCount(2);
    for (const field of await columnFields.all()) {
      await field.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = (await field.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole("button", { name: "View citation", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "View citation" }).getByRole("link", { name: /Column article/ })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const originalPath = resolve(root, "original.docx");
    const exportPath = testInfo.outputPath("oleafly-export.docx");
    await writeFile(originalPath, originalBytes);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download DOCX copy", exact: true }).click();
    const downloaded = await downloading;
    await downloaded.saveAs(exportPath);
    const exportEvidence = JSON.parse(execFileSync(workbenchPython, ["-B", resolve("e2e/tests/docx-real-package.py"),
      "--citation-export", originalPath, exportPath, columnDoi,
    ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(workbenchModule, "src") } }));
    expect(exportEvidence).toMatchObject({ ok: true, issues: [], doi: columnDoi,
      sha256: { original: createHash("sha256").update(originalBytes).digest("hex") } });
    expect((await readLive(page)).document).toMatchObject({ baselineId: baseline, dirty: false });
    const exportedParts = unzipSync(await readFile(exportPath));
    const searchCount = requests;
    await capture(surface.locator(".docx-line").filter({ hasText: "Protected field" }));
    const localLayout = await readLayout();
    const searchbox = picker.getByRole("searchbox");
    const authorSource = picker.getByRole("button", { name: "Native Word study", exact: true });
    await searchbox.fill(`https://doi.org/${authorDoi}-different`);
    await expect(authorSource).toHaveCount(0);
    await searchbox.fill(`https://doi.org/${authorDoi.toUpperCase()}`);
    await expect(authorSource).toBeVisible({ timeout: 3000 });
    expect(requests).toBe(searchCount);
    const confirm = picker.getByRole("button", { name: "Insert citation", exact: true });
    await expect(confirm).toBeDisabled();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(closePicker).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(authorSource).toBeFocused();
    await page.keyboard.press("Enter");
    expect(requests).toBe(searchCount);
    expect(await readLayout()).toEqual(localLayout);
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    const nativeFields = surface.locator('[data-field-atom="field"]').filter({ hasText: "⟦Native" });
    await expect(nativeFields).toHaveCount(1);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(nativeFields).toHaveCount(0);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(nativeFields).toHaveCount(1);
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved");
    const finalBaseline = (await readLive(page)).document.baselineId;
    const finalSource = await request(`/api/manuscript-source?project_id=${project.project_id}&baseline_id=${finalBaseline}`);
    const finalParts = unzipSync(Buffer.from(finalSource.content_base64, "base64"));
    expect(finalParts["customXml/item1.xml"]).toEqual(exportedParts["customXml/item1.xml"]);
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect.poll(async () => (await readLive(page)).document?.baselineId).toBe(finalBaseline);
    await expect(columnFields).toHaveCount(2);
    await expect(nativeFields).toHaveCount(1);
    await test.step("Keep the citation picker keyboard-accessible in a compact right column", async () => {
      await viewport.evaluate((element) => {
        element.style.maxWidth = "440px";
        element.style.maxHeight = "192px";
      });
      await expect.poll(async () => (await paper.boundingBox())?.width ?? Infinity).toBeLessThan(440);
      const compactLine = surface.locator(".docx-line").filter({ hasText: "Second citation body." });
      await compactLine.scrollIntoViewIfNeeded();
      const frame = (await viewport.boundingBox())!;
      const line = (await compactLine.boundingBox())!;
      await viewport.evaluate((element, delta) => { element.scrollTop += delta; },
        line.y + line.height / 2 - (frame.y + frame.height / 2));
      await compactLine.click({ position: { x: line.width - 4, y: 7 } });
      await page.keyboard.press("End");
      const layout = await readLayout();
      const caret = (await surface.locator("[data-docx-caret]").boundingBox())!;
      expect(caret.x).toBeGreaterThan((await left.boundingBox())!.x + 100);
      expect(Math.max(caret.y - frame.y, frame.y + frame.height - (caret.y + caret.height))).toBeLessThan(104);
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(searchbox).toBeFocused();
      await searchbox.fill(authorDoi);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(closePicker).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(authorSource).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(confirm).toHaveAccessibleDescription("Reuse: Native Word study");
      await page.keyboard.press("Tab");
      await expect(confirm).toBeFocused();
      const panel = (await picker.boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(frame.x);
      expect(panel.y).toBeGreaterThanOrEqual(frame.y);
      expect(panel.x + panel.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(panel.y + panel.height).toBeLessThanOrEqual(frame.y + frame.height);
      const confirmBounds = (await confirm.boundingBox())!;
      expect(confirmBounds.y).toBeGreaterThanOrEqual(panel.y);
      expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(panel.y + panel.height);
      const closeBounds = (await closePicker.boundingBox())!;
      expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(closeBounds.y).toBeGreaterThanOrEqual(panel.y);
      expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(panel.y + panel.height);
      await closePicker.click();
      await expect(picker).toHaveCount(0);
      await expect(viewport.locator(".docx-pages:focus")).toHaveCount(1);
      expect(await readLayout()).toEqual(layout);
      expect((await readLive(page)).document.dirty).toBe(false);
    });
    await test.step("Read and choose a source when the view is too short for the whole picker", async () => {
      await viewport.evaluate((element) => { element.style.maxHeight = "72px"; });
      try {
        await secondBody.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        const line = (await secondBody.boundingBox())!;
        await secondBody.click({ position: { x: line.width - 4, y: 7 } });
        await page.keyboard.press("End");
        const layout = await readLayout();
        const before = (await readLive(page)).document;
        await page.keyboard.press("Shift+F10");
        await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(searchbox).toBeFocused();
        await searchbox.fill(authorDoi);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect(closePicker).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(authorSource).toBeFocused();
        await expect(authorSource).toBeInViewport({ ratio: 0.8, timeout: 2000 });
        await authorSource.click({ timeout: 2000 });
        await expect(authorSource).toHaveAttribute("aria-pressed", "true");
        await expect(authorSource).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(confirm).toBeFocused();
        await expect(confirm).toBeInViewport({ ratio: 0.9, timeout: 2000 });
        expect(await readLayout()).toEqual(layout);
        await page.keyboard.press("Escape");
        await expect(picker).toHaveCount(0);
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        expect(await readLayout()).toEqual(layout);
        expect((await readLive(page)).document).toMatchObject({ sessionRevision: before.sessionRevision, dirty: false });
      } finally {
        await viewport.evaluate((element) => { element.style.maxHeight = "192px"; });
      }
    });
    await test.step("Closing an offscreen citation picker preserves scroll and focus ownership", async () => {
      const documentTools = page.getByTestId("docx-document-tools");
      const before = (await readLive(page)).document;
      for (const moveFocus of [false, true]) {
        await secondBody.click({ position: { x: 4, y: 7 } });
        await page.keyboard.press("End");
        await page.keyboard.press("Shift+F10");
        await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(searchbox).toBeFocused();
        if (moveFocus) {
          await documentTools.focus();
          await expect(documentTools).toBeFocused();
          await expect(picker).toBeVisible();
        }
        const beforeScroll = (await readLayout()).scroll;
        const scroll = await viewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        expect(scroll).toBeGreaterThan(beforeScroll);
        await expect(picker).toHaveCount(0);
        await expect(moveFocus ? documentTools : viewport).toBeFocused();
        expect((await readLayout()).scroll).toBe(scroll);
      }
      expect((await readLive(page)).document).toMatchObject({ sessionRevision: before.sessionRevision, dirty: false });
    });
    await test.step("Confirmation cannot write after the insertion point has scrolled out of view", async () => {
      await secondBody.click({ position: { x: 4, y: 7 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await searchbox.fill(authorDoi);
      await authorSource.click();
      await expect(confirm).toBeEnabled();
      await confirm.focus();
      const before = (await readLive(page)).document;
      const scroll = await confirm.evaluate((button, text) => {
        const scroller = button.closest("section")!.querySelector<HTMLElement>(".docx-editor__scroll-container")!;
        const line = Array.from(scroller.querySelectorAll(".docx-line")).find((node) => node.textContent?.includes(text))!;
        scroller.scrollTop = scroller.scrollHeight;
        const offscreen = line.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top;
        (button as HTMLButtonElement).click();
        return { offscreen, top: scroller.scrollTop };
      }, "Second citation body.");
      expect(scroll.offscreen).toBe(true);
      expect((await readLive(page)).document).toMatchObject({ sessionRevision: before.sessionRevision, dirty: false });
      await expect(picker).toHaveCount(0);
      await expect(viewport).toBeFocused();
      expect((await readLayout()).scroll).toBe(scroll.top);
    });
    await test.step("A background edit closes the stale picker without losing keyboard focus", async () => {
      await secondBody.click({ position: { x: 4, y: 7 } });
      await page.keyboard.press("End");
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(searchbox).toBeFocused();
      const fieldCount = await surface.locator('[data-field-atom="field"]').count();
      await searchbox.fill(authorDoi);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(closePicker).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(authorSource).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(confirm).toBeFocused();
      const layout = await readLayout();
      const agentEdit = await page.evaluate(async ({ original, replacement }) => {
        const tools = (window as any).__docxTools;
        const live = await tools.read_docx_document.execute({});
        const paragraph = live.paragraphs.find((item: { text: string }) => item.text === original);
        const target = await tools.capture_docx_target.execute({ paragraph_ref: paragraph.paragraphRef });
        return tools.apply_docx_suggestion.execute({ target_id: target.targetId, expected_revision: target.revision, text: replacement });
      }, { original: other, replacement: "Background edit in a separate paragraph." });
      expect(agentEdit).toMatchObject({ ok: true, changed: true });
      await expect(picker).toHaveCount(0);
      await expect(viewport.locator(".docx-pages")).toBeFocused();
      expect(await readLayout()).toEqual(layout);
      expect(await surface.locator('[data-field-atom="field"]').count()).toBe(fieldCount);
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

const embeddedImages = [
  { name: "Red figure", width: 24, height: 12, rgba: [220, 30, 40, 255],
    png: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAMCAIAAAD3UuoiAAAAF0lEQVR4nGO4I6dBFcQwatCoQaMG4UMAIC1GUIlIYPIAAAAASUVORK5CYII=" },
  { name: "Blue figure", width: 15, height: 20, rgba: [30, 90, 220, 255],
    png: "iVBORw0KGgoAAAANSUhEUgAAAA8AAAAUCAIAAADdpfBFAAAAGElEQVR4nGOQi7pDPGIYVT2qelQ1HVQDAEAVjoDgldkvAAAAAElFTkSuQmCC" },
];

function embeddedImageFixture(): Uint8Array {
  const parts = unzipSync(fixture());
  const decoder = new TextDecoder();
  const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const drawing = (image: typeof embeddedImages[number], index: number) => {
    const id = index + 2;
    const size = `cx="${image.width * 38100}" cy="${image.height * 38100}"`;
    const floating = index === 1;
    const placement = floating ? "anchor" : "inline";
    const positioning = floating
      ? ' distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>914400</wp:posOffset></wp:positionV>'
      : '>';
    parts[`word/media/figure-${id}.png`] = Buffer.from(image.png, "base64");
    return `<w:r><w:drawing><wp:${placement}${positioning}<wp:extent ${size}/>${floating ? '<wp:wrapNone/>' : ''}<wp:docPr id="${id}" name="${image.name}" descr="${image.name}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${image.name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:${placement}></w:drawing></w:r>`;
  };
  const [red, blue] = embeddedImages.map(drawing);
  parts["[Content_Types].xml"] = strToU8(decoder.decode(parts["[Content_Types].xml"])
    .replace("<Override", '<Default Extension="png" ContentType="image/png"/><Override'));
  parts["word/_rels/document.xml.rels"] = strToU8(decoder.decode(parts["word/_rels/document.xml.rels"])
    .replace("</Relationships>", `${embeddedImages.map((_, index) => `<Relationship Id="rId${index + 2}" Type="${relationships}/image" Target="media/figure-${index + 2}.png"/>`).join("")}</Relationships>`));
  parts["word/document.xml"] = strToU8(decoder.decode(parts["word/document.xml"])
    .replace("<w:body>", `<w:body><w:p>${red}<w:r><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/></w:rPr><w:t xml:space="preserve"> Words between the figures </w:t></w:r>${blue}</w:p>`)
    .replace("<w:document ", `<w:document xmlns:r="${relationships}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" `)
    .replace("<w:sectPr>", '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Second page for scrolling.</w:t></w:r></w:p><w:sectPr>'));
  return zipSync(parts);
}

test("embedded image preview opens only the targeted figure in the existing context tools", async () => {
  test.setTimeout(60_000);
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-image-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    await request("/api/projects", {
      name: "Synthetic embedded image preview", filename: "figures.docx", content_base64: Buffer.from(embeddedImageFixture()).toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
    await installBrowserBridge(page, request, null);
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);

    const surface = page.getByTestId("docx-editor-surface");
    const paper = surface.locator(".docx-page").first();
    const viewport = surface.locator(".docx-editor__scroll-container");
    const tools = page.getByTestId("docx-context-tools");
    const viewImage = page.getByRole("button", { name: "View image", exact: true });
    const dialog = page.getByRole("dialog", { name: "View image", exact: true });
    const readLayout = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => [element.scrollLeft, element.scrollTop, element.scrollWidth, element.scrollHeight]) });
    const assertQuiet = async () => {
      await expect(viewImage).toBeHidden();
      await expect(dialog).toBeHidden();
    };
    const paintedImage = (name: string) => paper.getByRole("img", { name, exact: true });
    const imageBounds = async (name: string) => {
      const image = paintedImage(name);
      await expect(image).toBeInViewport({ ratio: 1 });
      const box = await image.boundingBox();
      if (!box) throw new Error(`${name} has no painted bounds.`);
      return box;
    };

    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
    await imageBounds(embeddedImages[0].name);
    await imageBounds(embeddedImages[1].name);
    await viewport.evaluate((element) => { element.scrollTop = 48; });
    await expect.poll(async () => (await readLive(page)).document?.dirty).toBe(false);
    const clean = (await readLive(page)).document;
    const assertClean = async (action: string) => {
      const { dirty, sessionRevision, savedRevision } = (await readLive(page)).document;
      expect({ dirty, sessionRevision, savedRevision }, action).toEqual({
        dirty: false, sessionRevision: clean.sessionRevision, savedRevision: clean.savedRevision,
      });
    };
    const layout = await readLayout();
    expect(layout.scroll[1]).toBeGreaterThan(0);
    await assertQuiet();

    const selectImage = async (image: typeof embeddedImages[number], expectedLayout = layout) => {
      const box = await imageBounds(image.name);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(tools.getByRole("button", { name: "View image", exact: true })).toBeVisible();
      await expect(viewImage).toHaveCount(1);
      await expect(dialog).toBeHidden();
      expect(await readLayout()).toEqual(expectedLayout);
      await assertClean(`After clicking ${image.name}`);
      const bar = await tools.boundingBox();
      expect(bar?.x).toBeCloseTo(box.x, 0);
    };
    const openImage = async (image: typeof embeddedImages[number], open: () => Promise<void>, expectedLayout = layout) => {
      await selectImage(image, expectedLayout);
      const toolbar = await tools.elementHandle();
      await open();
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element, originalToolbar) => element === originalToolbar, toolbar)).toBe(true);
      await toolbar.dispose();
      const preview = dialog.locator("img");
      await expect(preview).toHaveCount(1);
      await expect(preview).toBeVisible();
      await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(image.width);
      const content = await preview.evaluate((element: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(element, 0, 0, 1, 1);
        return { height: element.naturalHeight, rgba: Array.from(context.getImageData(0, 0, 1, 1).data) };
      });
      expect(content).toEqual({ height: image.height, rgba: image.rgba });
      expect(await readLayout()).toEqual(expectedLayout);
      await assertClean(`After opening ${image.name}`);
    };

    await test.step("Open the inline image from its start caret without clicking the image", async () => {
      const text = paper.getByText("Words between the figures", { exact: true });
      await text.click();
      await page.keyboard.press("Home");
      const image = await imageBounds(embeddedImages[0].name);
      const caret = surface.locator("[data-docx-caret]");
      await expect(caret).toBeVisible();
      expect((await caret.boundingBox())!.x).toBeCloseTo(image.x, 0);
      await expect(surface.locator(".docx-image-selection-overlay")).toHaveCount(0);
      await assertQuiet();
      const body = (await readLive(page)).paragraphs.map((paragraph: { text: string }) => paragraph.text);

      await page.keyboard.press("Shift+F10");
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("img", { name: embeddedImages[0].name, exact: true })).toBeVisible();
      await expect(dialog.locator("img")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await assertQuiet();
      await text.click();
      expect(await readLayout()).toEqual(layout);
      expect((await readLive(page)).paragraphs.map((paragraph: { text: string }) => paragraph.text)).toEqual(body);
      await assertClean("After opening and dismissing the preview by keyboard");
    });

    await openImage(embeddedImages[0], async () => {
      await page.keyboard.press("Shift+F10");
      await expect(viewImage).toBeFocused();
      await page.keyboard.press("Enter");
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await readLayout()).toEqual(layout);
    await paper.getByText("Words between the figures", { exact: true }).click();
    await assertQuiet();
    await assertClean("After clicking next to the red figure");

    await paper.locator(".docx-line").filter({ hasText: original }).click({ position: { x: 4, y: 7 } });
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(original);
    await assertQuiet();
    expect(await readLayout()).toEqual(layout);
    await assertClean("After selecting text");

    await test.step("Keep the action beside the floating picture, not its anchor paragraph", async () => {
      const host = await paper.getByText("Words between the figures", { exact: true }).boundingBox();
      const picture = await imageBounds(embeddedImages[1].name);
      expect(picture.y).toBeGreaterThan(host!.y + host!.height + 40);
      const body = (await readLive(page)).paragraphs.map((paragraph: { text: string }) => paragraph.text);
      await openImage(embeddedImages[1], async () => {
        await page.keyboard.press("Shift+F10");
        await page.keyboard.press("Enter");
      });
      expect((await readLive(page)).paragraphs.map((paragraph: { text: string }) => paragraph.text)).toEqual(body);
      const panel = (await dialog.boundingBox())!;
      expect(Math.min(Math.abs(panel.y - (picture.y + picture.height)), Math.abs(panel.y + panel.height - picture.y)))
        .toBeLessThan(8);
      await page.keyboard.press("Escape");
      await assertQuiet();
      await openImage(embeddedImages[1], () => viewImage.click());
    });
    await viewport.hover({ position: { x: 20, y: 300 } });
    await page.mouse.wheel(0, 1150);
    await expect(paintedImage(embeddedImages[1].name)).not.toBeInViewport();
    await assertQuiet();
    await expect(viewport).toBeFocused();
    await expect(paintedImage(embeddedImages[1].name)).not.toBeInViewport();
    await viewport.evaluate((element, top) => { element.scrollTop = top; }, layout.scroll[1]);
    await imageBounds(embeddedImages[1].name);
    await assertQuiet();
    expect(await readLayout()).toEqual(layout);
    await assertClean("After scrolling the preview offscreen and back");
    await paper.getByText("Words between the figures", { exact: true }).click();
    await assertQuiet();
    await selectImage(embeddedImages[1]);
    await page.keyboard.press("Shift+F10");
    await expect(viewImage, "Shift+F10 focuses the selected blue figure's action").toBeFocused();
    await page.keyboard.press("Escape");
    await assertQuiet();

    await test.step("Keep the opened image preview usable in a short, narrow paper viewport", async () => {
      const image = embeddedImages[0];
      await viewport.evaluate((element) => {
        element.style.maxWidth = "440px";
        element.style.maxHeight = "192px";
      });
      await expect.poll(async () => (await paper.boundingBox())?.width ?? Infinity).toBeLessThan(440);
      const frame = (await viewport.boundingBox())!;
      const drawing = (await paintedImage(image.name).boundingBox())!;
      await viewport.evaluate((element, delta) => { element.scrollTop += delta; },
        drawing.y + drawing.height / 2 - (frame.y + frame.height / 2));

      const compactLayout = await readLayout();
      const bounds = compactLayout.viewport!;
      const anchor = await imageBounds(image.name);
      expect(bounds.width).toBeLessThan(576);
      expect(Math.max(anchor.y - bounds.y, bounds.y + bounds.height - (anchor.y + anchor.height)),
        "The painted image is visible without 104px of room on either side").toBeLessThan(104);
      await assertQuiet();

      await openImage(image, () => viewImage.click(), compactLayout);
      const panel = (await dialog.boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(bounds.x);
      expect(panel.y).toBeGreaterThanOrEqual(bounds.y);
      expect(panel.x + panel.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(panel.y + panel.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      const closePreview = dialog.getByRole("button", { name: "Close", exact: true });
      await expect(closePreview).toBeFocused();
      await closePreview.click({ trial: true });

      await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(paintedImage(image.name)).not.toBeInViewport();
      await assertQuiet();
      await viewport.evaluate((element, top) => { element.scrollTop = top; }, compactLayout.scroll[1]);
      await imageBounds(image.name);
      await assertQuiet();
      expect(await readLayout()).toEqual(compactLayout);
      await assertClean("After scrolling the docked preview offscreen and back");
    });
    await test.step("Dragging the selected floating picture can be undone by keyboard without moving the viewport", async () => {
      await viewport.evaluate((element) => {
        element.style.removeProperty("max-width");
        element.style.removeProperty("max-height");
      });
      await expect.poll(async () => (await paper.boundingBox())?.width).toBe(layout.paper!.width);
      await viewport.evaluate((element, top) => {
        element.scrollTop = top;
      }, layout.scroll[1]);
      await expect.poll(readLayout).toEqual(layout);
      const image = embeddedImages[1];
      await selectImage(image);
      const before = await imageBounds(image.name);
      const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
      const drag = async (dx: number, dy: number) => {
        const current = await imageBounds(image.name);
        const start = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
        await page.mouse.up();
      };
      await drag(32, 16);
      await assertQuiet();
      await expect.poll(async () => (await readLive(page)).document.dirty).toBe(true);
      const afterFirstDrag = await imageBounds(image.name);
      expect(afterFirstDrag.x).toBeCloseTo(before.x + 32, 0);
      expect(await readLayout()).toEqual(layout);
      await drag(16, 8);
      expect((await imageBounds(image.name)).x).toBeCloseTo(before.x + 48, 0);
      expect(await readLayout()).toEqual(layout);
      await viewport.hover({ position: { x: 20, y: 300 } });
      await page.mouse.wheel(0, 120);
      await expect.poll(async () => (await readLayout()).scroll[1]).toBeGreaterThan(layout.scroll[1]);
      await page.mouse.wheel(0, -120);
      await expect.poll(readLayout).toEqual(layout);
      await page.keyboard.press(undoKey);
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await imageBounds(image.name)).toEqual(afterFirstDrag);
      expect(await readLayout()).toEqual(layout);
      await page.keyboard.press(undoKey);
      expect(await imageBounds(image.name)).toEqual(before);
      expect(await readLayout()).toEqual(layout);
      await assertQuiet();
    });
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

interface RealParagraph {
  paraId: string | null;
  text: string;
  safe: boolean;
  categories: string[];
}

interface PackageInventory {
  sha256: string;
  bytes: number;
  parts: Record<string, string>;
  paragraphs: RealParagraph[];
}

interface PackageComparison {
  missingParts: string[];
  changedMedia: string[];
  changedRelationships: string[];
  lostOrModifiedProtectedNodes: Record<string, Record<string, number>>;
  paragraphCount: { before: number; after: number };
  paragraphTextChanges: Array<{ index: number; paraId: string; before: string; after: string }>;
}

const packageEvidence = <T,>(source: string, output?: string): T => JSON.parse(
  execFileSync(workbenchPython, [
    resolve("e2e/tests/docx-real-package.py"), source, ...(output ? [output] : []),
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
);

test("embedded chart exports its own workbook without changing the draft", async () => {
  test.setTimeout(45_000);
  const native = await readFile(resolve("services/research-workbench/tests/fixtures/docx/native/s1-native-complex-objects/s1-native-complex-objects.docx"));
  const expected = unzipSync(native)["word/embeddings/Workbook1.xlsx"];
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-chart-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    await request("/api/projects", { name: "WPS native chart", filename: "chart.docx", content_base64: native.toString("base64") });
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, acceptDownloads: true });
    await installBrowserBridge(page, request, null);
    const writes: Uint8Array[] = [];
    await page.exposeFunction("writeChartExport", (base64: string) => { writes.push(Buffer.from(base64, "base64")); });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    await page.evaluate(() => {
      const host = window as unknown as {
        __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> };
        writeChartExport(base64: string): Promise<void>;
      };
      const chartSaves = { picks: 0, returned: 0, writes: 0, finish: (_path: string | null) => {} };
      Object.assign(window, { chartSaves });
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "pick_save_path") {
          const path = await new Promise<string | null>((resolve) => { chartSaves.finish = resolve; chartSaves.picks++; });
          requestAnimationFrame(() => { chartSaves.returned++; });
          return path;
        }
        if (command === "write_bytes_file") {
          chartSaves.writes++;
          return host.writeChartExport((args as { dataBase64: string }).dataBase64);
        }
        return invoke(command, args);
      };
    });
    const surface = page.getByTestId("docx-editor-surface");
    const chart = surface.getByRole("img", { name: "RFW-FX-EO-CHART-001", exact: true });
    const paper = chart.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' docx-page ')][1]");
    const viewport = surface.locator(".docx-editor__scroll-container");
    const action = page.getByRole("button", { name: "Export embedded workbook", exact: true });
    const bodyText = paper.getByText("RFW-FX-EO-CHART-ANCHOR-001", { exact: true });
    await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-resolving", "false");
    await expect.poll(async () => (await readLive(page)).document?.dirty).toBe(false);
    await expect(chart).toBeInViewport();
    await expect(action).toHaveCount(0);
    const view = async () => ({ paper: await paper.boundingBox(), viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((node) => [node.scrollLeft, node.scrollTop]), revision: (await readLive(page)).document.sessionRevision });
    const before = await view();
    const bounds = await chart.boundingBox();
    if (!bounds) throw new Error("The native chart has no painted bounds.");
    await test.step("Report a refused copy without dropping the chart from the selection", async () => {
      await bodyText.click({ position: { x: 3, y: 6 } });
      await page.keyboard.press("Home");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+ArrowUp" : "Control+Shift+Home");
      const contents = await chart.evaluate((element) => {
        const selection = document.getSelection();
        return { text: selection?.toString(), includesChart: selection?.getRangeAt(0).intersectsNode(element) };
      });
      expect(contents.text).toContain("RFW Native Complex Object Probe");
      expect(contents.includesChart).toBe(true);
      await expect(page.getByTestId("docx-context-tools")).toHaveCount(0);
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeFocused();
      const layout = await view();
      await page.keyboard.press("Enter");
      const error = await page.evaluate(async () => {
        const toastPath = "/src/store/toast.ts";
        const { useToastStore } = await import(toastPath) as typeof import("../../src/store/toast");
        return useToastStore.getState().toasts.find((toast) => toast.kind === "error")?.message;
      });
      expect(error).toBe("This selection couldn't be copied.");
      await expect(page.getByTestId("docx-context-tools")).toHaveCount(0);
      await expect(viewport.locator(".docx-pages")).toBeFocused();
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(contents.text);
      expect(await view()).toEqual(layout);
    });
    const selectChart = async () => {
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(action).toBeVisible();
    };
    await selectChart();
    await expect(page.getByRole("button", { name: "View image", exact: true })).toHaveCount(0);
    await page.keyboard.press("Shift+F10");
    await expect(action).toBeFocused();
    expect(await view()).toEqual(before);
    const downloading = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("chart-workbook.xlsx");
    expect(await readFile(await download.path())).toEqual(Buffer.from(expected));
    await expect(action).toHaveCount(0);
    expect(await view()).toEqual(before);
    expect((await readLive(page)).document.dirty).toBe(false);

    const waitForSave = (picks: number) => page.waitForFunction((count) => (window as any).chartSaves.picks === count, picks);
    const destination = "/unused/chart-workbook.xlsx";
    const finishSave = (path: string | null = destination) => page.evaluate((path) => (window as any).chartSaves.finish(path), path);
    const waitForSaveReturn = (returned: number) => page.waitForFunction((count) => (window as any).chartSaves.returned === count, returned);
    await page.evaluate(() => { Object.assign(window, { isTauri: true }); });
    await bodyText.click();
    await selectChart();
    await action.press("Enter");
    await waitForSave(1);
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as any).chartSaves.picks)).toBe(1);
    await finishSave(null);
    await waitForSaveReturn(1);
    await expect(action).toBeFocused();
    expect(writes).toHaveLength(0);

    await page.keyboard.press("Enter");
    await waitForSave(2);
    await finishSave();
    await expect.poll(() => writes).toEqual([Buffer.from(expected)]);
    await expect(action).toHaveCount(0);
    expect(await view()).toEqual(before);

    await bodyText.click();
    await selectChart();
    await action.click();
    await waitForSave(3);
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await finishSave();
    await waitForSaveReturn(3);
    expect(writes).toEqual([Buffer.from(expected)]);
    await page.getByRole("button", { name: "Word", exact: true }).click();
    await expect(action).toHaveCount(0);
    expect(await view()).toEqual(before);

    await bodyText.click();
    await selectChart();
    await page.keyboard.press("Shift+F10");
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    await waitForSave(4);
    const scroll = await chart.evaluate((element, path) => {
      const scroller = element.closest<HTMLElement>(".docx-editor__scroll-container")!;
      scroller.scrollTop = scroller.scrollHeight;
      const offscreen = element.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top;
      (window as any).chartSaves.finish(path);
      return { offscreen, top: scroller.scrollTop };
    }, destination);
    expect(scroll.offscreen).toBe(true);
    await waitForSaveReturn(4);
    expect(await page.evaluate(() => (window as any).chartSaves.writes)).toBe(1);
    await expect(action).toHaveCount(0);
    await expect(viewport).toBeFocused();
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scroll.top);
    expect((await readLive(page)).document).toMatchObject({ sessionRevision: before.revision, dirty: false });
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
});

function refreshedCitationFixture(doi: string) {
  const parts = unzipSync(fixture());
  const decoder = new TextDecoder();
  const title = "Journal article carried through re-import";
  parts["customXml/item1.xml"] = strToU8(decoder.decode(parts["customXml/item1.xml"])
    .replace("</b:Source>", "<b:Guid>{434223C3-438A-41D5-8F8C-CF983208E7A7}</b:Guid></b:Source>")
    .replace("</b:Sources>", `<b:Source><b:Tag>Retagged</b:Tag><b:Title>${title}</b:Title><b:URL>https://doi.org/${doi}</b:URL></b:Source></b:Sources>`));
  const fieldStart = (instructions: string[]) => '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    instructions.map((code) => `<w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r>`).join("") +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const fieldEnd = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const trialCitation = (paraId: string) => `<w:p w14:paraId="${paraId}"><w:r><w:t xml:space="preserve">Cited study </w:t></w:r>` +
    '<w:fldSimple w:instr="CITATION NativeStudy"><w:r><w:t>(Ng, 2024)</w:t></w:r></w:fldSimple>' +
    fieldStart([" CITA", "TION Retagged \\l 1033 "]) + '<w:r><w:t>(Ng, 2024)</w:t></w:r>' + fieldEnd + '</w:p>';
  const bibliography = `<w:p>${fieldStart([" BIBLIOGRAPHY "])}<w:r><w:t>Native Word study.</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Ng (2024). ${title}.</w:t></w:r>${fieldEnd}</w:p>`;
  parts["word/document.xml"] = strToU8(decoder.decode(parts["word/document.xml"])
    .replace("<w:document ", '<w:document xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ')
    .replace("<w:body><w:p>", '<w:body><w:p w14:paraId="14300001">')
    .replace("<w:sectPr>", `${trialCitation("14300002")}${trialCitation("14300003")}${bibliography}<w:sectPr>`)
    .replace("</w:sectPr>", '<w:cols w:num="2" w:space="720"/></w:sectPr>'));
  return zipSync(parts);
}

async function verifyCitationReimport(inputPath: string, doi: string, testInfo: TestInfo) {
  const input = await readFile(inputPath);
  const inputHash = createHash("sha256").update(input).digest("hex");
  function checkPackage(mode: string, ...args: string[]) {
    return JSON.parse(execFileSync(workbenchPython, ["-B", "e2e/tests/docx-real-package.py", mode, ...args], {
      encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(workbenchModule, "src") },
    }));
  }
  const targets: { ok: boolean; doi: string; sha256: string; citations: { paraId: string; instruction: string }[]; editParaId: string } =
    checkPackage("--citation-reimport-targets", inputPath, doi);
  expect(targets).toMatchObject({ ok: true, sha256: inputHash });
  expect(targets.citations).toHaveLength(2);
  const root = testInfo.outputPath("workbench");
  await mkdir(root, { recursive: true });
  const service = await startWorkbench(root);
  const browser = await launchDocxTestBrowser();
  try {
    const { token } = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    const project = await request("/api/projects", {
      name: "Citation re-import regression", filename: "reimport-input.docx", content_base64: input.toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, acceptDownloads: true });
    page.setDefaultTimeout(8000);
    await installBrowserBridge(page, request, null);
    await page.addInitScript(() => {
      const opened: string[] = [];
      Object.assign(window, { __docxOpenedSources: opened });
      window.open = (url) => { opened.push(String(url)); return window; };
    });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    await expect.poll(async () => (await readLive(page)).document?.baselineId, { timeout: 60_000 }).toBe(project.baseline_id);
    const surface = page.getByTestId("docx-editor-surface");
    const contextual = page.getByTestId("docx-context-tools");
    type Paragraph = { paraId?: string; text: string; modelTextTruncated?: boolean; atoms: {
      kind: string; payload?: { code?: string }; modelRange: { start: number; end: number };
    }[] };
    const ids = [targets.editParaId, ...targets.citations.map(({ paraId }) => paraId)];
    async function readTargets() {
      const found = new Map<string, Paragraph>();
      let query: Record<string, unknown> | null = { limit: 50 };
      while (query && found.size < ids.length) {
        const result = await readLive(page, query);
        expect(result.error).toBeUndefined();
        for (const paragraph of result.paragraphs as Paragraph[]) {
          const id = paragraph.paraId?.toUpperCase();
          if (id && ids.includes(id) && !found.has(id)) found.set(id, paragraph);
        }
        query = result.next_query;
      }
      expect([...found.keys()].sort()).toEqual([...ids].sort());
      return found;
    }
    const reveal = (id: string) => page.evaluate((paraId) => (window as any).__docxRevealParagraph(paraId), id);
    const assertSources = async (paragraphs: Map<string, Paragraph>) => {
      const opened = () => page.evaluate(() => (window as any).__docxOpenedSources as string[]);
      const expected = await opened();
      for (const { paraId, instruction } of targets.citations) {
        const paragraph = paragraphs.get(paraId)!;
        const fields = paragraph.atoms.filter((atom) => atom.kind === "field" && atom.payload?.code?.trim() === instruction.trim());
        expect(fields, `Expected one matching field in ${paraId}`).toHaveLength(1);
        const { start, end } = fields[0].modelRange;
        const nodeId = await reveal(paraId);
        const field = surface.locator(`[data-field-atom="field"][data-paragraph-id="${nodeId}"][data-start="${start}"][data-end="${end}"]`).first();
        await field.scrollIntoViewIfNeeded();
        const box = await field.boundingBox();
        if (!box) throw new Error(`No painted citation in ${paraId}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await contextual.getByRole("button", { name: "View citation", exact: true }).click();
        const sources = contextual.getByRole("listitem");
        await expect(sources).toHaveCount(1);
        await sources.getByRole("link").click();
        expected.push(docxDoiUrl(targets.doi));
        await expect.poll(opened).toEqual(expected);
        await page.keyboard.press("Escape");
        await expect(contextual).toHaveCount(0);
      }
    };
    const paragraphs = await readTargets();
    await assertSources(paragraphs);
    const body = paragraphs.get(targets.editParaId)!;
    expect(body.modelTextTruncated).not.toBe(true);
    expect(body.atoms).toHaveLength(0);
    const editNode = await reveal(targets.editParaId);
    await surface.locator(`.docx-line[data-paragraph-id="${editNode}"]`).first().click({ position: { x: 4, y: 7 } });
    await page.keyboard.press("Home");
    const prefix = "LOCAL ";
    const expected = prefix + body.text;
    await page.keyboard.insertText(prefix);
    const bodyText = async () => (await readTargets()).get(targets.editParaId)!.text;
    await expect.poll(bodyText).toBe(expected);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect.poll(bodyText).toBe(body.text);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect.poll(bodyText).toBe(expected);
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved");
    const saved = (await readLive(page)).document;
    expect(saved.baselineId).not.toBe(project.baseline_id);
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect.poll(async () => (await readLive(page)).document?.baselineId).toBe(saved.baselineId);
    const reopened = await readTargets();
    expect(reopened.get(targets.editParaId)?.text).toBe(expected);
    await assertSources(reopened);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download DOCX copy", exact: true }).click();
    const exported = testInfo.outputPath("reimport-edited.docx");
    await (await downloading).saveAs(exported);
    const [exportedBody] = packageEvidence<PackageInventory>(exported).paragraphs.filter((paragraph) =>
      paragraph.paraId?.toUpperCase() === targets.editParaId);
    expect(exportedBody?.text === expected, "Downloaded copy must include the edit at its original paragraph ID").toBe(true);
    const evidence = checkPackage("--citation-reimport", inputPath, exported, doi, targets.editParaId, prefix);
    expect(evidence).toMatchObject({ ok: true, issues: [], doi: targets.doi, sha256: { word: inputHash } });
    expect(createHash("sha256").update(await readFile(inputPath)).digest("hex")).toBe(inputHash);
    await testInfo.attach("citation-reimport", { body: JSON.stringify(evidence), contentType: "application/json" });
  } finally {
    await browser.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
}

test("re-imported DOCX keeps refreshed citations and bibliography through an edit and re-export", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const doi = "10.1234/refreshed";
  const inputPath = testInfo.outputPath("refreshed-fixture.docx");
  await writeFile(inputPath, refreshedCitationFixture(doi));
  await verifyCitationReimport(inputPath, doi, testInfo);
});

test("re-imported DOCX from an authorized Word save remains editable and preserves citations", async ({}, testInfo) => {
  const input = process.env.OLEAFLY_WORD_REIMPORT_DOCX;
  const doi = process.env.OLEAFLY_WORD_REIMPORT_DOI;
  test.skip(!input && !doi, "Supply an authorized Word save and the trial DOI.");
  if (!input || !doi) throw new Error("Set both OLEAFLY_WORD_REIMPORT_DOCX and OLEAFLY_WORD_REIMPORT_DOI.");
  test.setTimeout(180_000);
  await verifyCitationReimport(await realpath(input), doi, testInfo);
});

test("published DOCX keeps default editing and review on target", async ({}, testInfo) => {
  test.skip(!process.env.OLEAFLY_PUBLISHED_DOCX || process.env.OLEAFLY_DOCX_CITATION_ACCEPTANCE === "1",
    "Supply the Zenodo 8227226 DOCX and start Vite with citation preview disabled.");
  test.setTimeout(180_000);
  await exercisePublishedDocx(process.env.OLEAFLY_PUBLISHED_DOCX!, testInfo, false);
});

test("opt-in published DOCX keeps two-column editing, review and citations on target", async ({}, testInfo) => {
  const input = process.env.OLEAFLY_PUBLISHED_DOCX;
  test.skip(!input || process.env.OLEAFLY_DOCX_CITATION_ACCEPTANCE !== "1", "Supply the Zenodo 8227226 DOCX and enable citation preview.");
  test.setTimeout(180_000);
  await exercisePublishedDocx(input!, testInfo, true);
});

async function exercisePublishedDocx(input: string, testInfo: TestInfo, citationPreview: boolean) {
  const sourcePath = await realpath(input);
  const source = await readFile(sourcePath);
  const sha = "31b5cbc408c359dc31224b081505264bad689f4601eef3a05969668f85c9d47b";
  expect(createHash("sha256").update(source).digest("hex")).toBe(sha);
  const doi = "10.1038/nature14539";
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-published-")));
  const service = await startWorkbench(resolve(root, "library"));
  let browser: Awaited<ReturnType<typeof launchDocxTestBrowser>> | undefined;
  try {
    browser = await launchDocxTestBrowser();
    const { token } = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${result.error}`);
      return result;
    }
    const project = await request("/api/projects", {
      name: "Zenodo 8227226 interaction acceptance", filename: "8227226.docx", content_base64: source.toString("base64"),
    });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installBrowserBridge(page, request, null);
    const lookups: string[] = [];
    await page.exposeFunction("docxCitationSearch", async (kind: string, query: string) => {
      expect(citationPreview).toBe(true);
      expect([kind, query]).toEqual(["doi", doi]);
      lookups.push(query);
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Crossref lookup failed: HTTP ${response.status}`);
      return (await response.json()).message;
    });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    await expect.poll(async () => (await readLive(page)).document?.baselineId, { timeout: 75_000 }).toBe(project.baseline_id);

    const leftId = "0E8ABDCF";
    const humanId = "4AD876D5";
    const rightId = "3907DF96";
    type LiveParagraph = { paraId: string; paragraphRef: string; text: string; atoms: { kind: string; payload?: { code?: string } }[] };
    async function readTargets(ids: string[]) {
      const matches = new Map<string, LiveParagraph>();
      let result = await readLive(page, { limit: 50 });
      for (;;) {
        expect(result.error).toBeUndefined();
        for (const paragraph of result.paragraphs as LiveParagraph[]) {
          if (ids.includes(paragraph.paraId)) matches.set(paragraph.paraId, paragraph);
        }
        if (!result.next_query || matches.size === ids.length) break;
        result = await readLive(page, result.next_query);
      }
      expect([...matches.keys()].sort()).toEqual([...ids].sort());
      return ids.map((id) => matches.get(id)!);
    }
    const [left, human, right] = await readTargets([leftId, humanId, rightId]);
    const surface = page.getByTestId("docx-editor-surface");
    const viewport = surface.locator(".docx-editor__scroll-container");
    const line = (paragraph: LiveParagraph) => surface.locator(".docx-line").filter({ hasText: paragraph.text.slice(0, 32) }).first();
    const caretAtStart = async (paragraph: LiveParagraph) => {
      await line(paragraph).click({ position: { x: 4, y: 7 } });
      await page.keyboard.press("Home");
    };
    const focusTrialParagraph = async ({ paraId }: LiveParagraph) => {
      const nodeId = await page.evaluate((id) => (window as any).__docxRevealParagraph(id) as string, paraId);
      await viewport.locator(`.docx-line[data-paragraph-id="${nodeId}"]`).first().click({ position: { x: 4, y: 7 } });
      await page.keyboard.press("Home");
    };
    const geometry = async () => ({ papers: await surface.locator(".docx-page").evaluateAll((pages) => pages.map((page) => page.getBoundingClientRect().toJSON())),
      viewport: await viewport.boundingBox(),
      scroll: await viewport.evaluate((element) => element.scrollTop) });
    const bodySelection = () => page.evaluate(() => {
      const selection = document.getSelection();
      if (!selection) return null;
      const paragraph = (node: Node | null) => node?.parentElement?.closest(".docx-paragraph-fragment")
        ?.getAttribute("data-paragraph-id") ?? null;
      return {
        anchor: paragraph(selection.anchorNode),
        anchorOffset: selection.anchorOffset,
        focus: paragraph(selection.focusNode),
        focusOffset: selection.focusOffset,
        collapsed: selection.isCollapsed,
        text: selection.toString(),
      };
    });
    const context = page.getByTestId("docx-context-tools");
    const field = surface.locator('[data-field-atom="field"]').filter({ hasText: /\[\s*1\s*\]/ }).first();
    const tools = page.getByTestId("docx-document-tools");
    async function saveAndReopen() {
      const ids = [leftId, humanId, rightId];
      const before = (await readTargets(ids)).map(({ text }) => text);
      await page.getByRole("button", { name: "Save version", exact: true }).click();
      await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved");
      const baseline = (await readLive(page)).document.baselineId;
      expect(baseline).not.toBe(project.baseline_id);
      await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
      await expect.poll(async () => (await readLive(page)).document?.baselineId).toBe(baseline);
      expect((await readTargets(ids)).map(({ text }) => text)).toEqual(before);
    }
    async function downloadCopy(filename: string) {
      const exportPath = testInfo.outputPath(filename);
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download DOCX copy", exact: true }).click();
      await (await downloading).saveAs(exportPath);
      return exportPath;
    }
    await test.step("Select and copy a real cited line without opening its object actions", async () => {
      const { sessionId } = (await readLive(page)).document;
      const reveal = (paragraph: LiveParagraph) => page.evaluate(async ({ sessionId, paragraphRef }) => {
        const hostPath = "/src/lib/docx-agent-host.ts";
        const { revealDocxWorkspaceTarget } = await import(hostPath) as typeof import("../../src/lib/docx-agent-host");
        await revealDocxWorkspaceTarget({ projectId: "docx-harness", sessionId, paragraphRef });
      }, { sessionId, paragraphRef: paragraph.paragraphRef });
      await reveal(right);
      await expect(line(right)).toBeVisible();
      await field.scrollIntoViewIfNeeded({ timeout: 5000 });
      await field.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      const box = (await field.boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width + 80, y, { steps: 10 });
      await page.mouse.up();
      await expect(context).toHaveCount(0);
      const copied = await page.evaluate(() => {
        const transfer = new DataTransfer();
        document.activeElement?.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: transfer }));
        return transfer.getData("text/plain");
      });
      expect(copied).toContain("[1]");
      expect(copied.trim().length).toBeGreaterThan(3);
      await expect(context).toHaveCount(0);
      const citationBox = (await field.boundingBox())!;
      const before = await geometry();
      await page.mouse.click(citationBox.x + citationBox.width / 2, citationBox.y + citationBox.height / 2);
      await page.getByRole("button", { name: "View citation", exact: true }).click();
      const sources = page.getByRole("dialog", { name: "View citation" });
      await expect(sources.getByRole("link", { name: /Multi Disease Prediction Model/ })).toBeVisible();
      await page.keyboard.press("Escape");
      expect(await geometry()).toEqual(before);
      expect((await readLive(page)).document.dirty).toBe(false);
    });

    if (!citationPreview) await test.step("Keep the full selection and copied text across a real page break", async () => {
      const papers = viewport.locator(".docx-page");
      const bodyLines = ".docx-page-content .docx-line[data-paragraph-id]";
      const previous = papers.nth(1).locator(bodyLines).filter({ hasText: /\p{L}{3}/u }).last();
      const next = papers.nth(2).locator(bodyLines).filter({ hasText: /\p{L}{3}/u }).first();
      await previous.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await expect(previous).toBeInViewport({ ratio: 1 });
      await expect(next).toBeInViewport({ ratio: 1 });
      const before = await geometry();
      const start = (await previous.boundingBox())!;
      const end = (await next.boundingBox())!;
      const previousText = (await previous.innerText()).trim();
      const nextText = (await next.innerText()).trim();
      await page.mouse.move(start.x + 1, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 16 });
      await page.mouse.up();
      const quote = await page.evaluate(() => document.getSelection()?.toString());
      expect(quote).toContain(previousText);
      expect(quote).toContain(nextText);
      await expect(context).toHaveCount(0);
      const copied = await page.evaluate(() => {
        const transfer = new DataTransfer();
        document.activeElement?.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: transfer }));
        return transfer.getData("text/plain");
      });
      expect(copied).toContain(previousText);
      expect(copied).toContain(nextText);
      await expect(context).toHaveCount(0);

      await page.keyboard.press("Shift+F10");
      const copy = context.getByRole("button", { name: "Copy", exact: true });
      await expect(copy).toBeFocused();
      const strip = (await copy.boundingBox())!;
      expect(Math.min(Math.abs(strip.y - end.y - end.height), Math.abs(end.y - strip.y - strip.height))).toBeLessThan(24);
      await page.keyboard.press("Escape");
      await expect(context).toHaveCount(0);
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(quote);
      expect(await geometry()).toEqual(before);
    });

    if (!citationPreview) await test.step("Leave F6 to the browser when no review is pending", async () => {
      await caretAtStart(human);
      const before = { geometry: await geometry(), document: await readLive(page) };
      await page.evaluate(() => {
        document.addEventListener("keydown", (event) => {
          if (event.key !== "F6") return;
          const record = {
            inBody: !!(event.target as Element | null)?.closest(".docx-pages"),
            defaultPrevented: false,
            settled: false,
          };
          Object.assign(window, { __docxF6Default: record });
          queueMicrotask(() => {
            record.defaultPrevented = event.defaultPrevented;
            record.settled = true;
          });
        }, { capture: true, once: true });
      });
      await expect(viewport.locator(".docx-pages")).toBeFocused();
      await page.keyboard.press("F6");
      await expect.poll(() => page.evaluate(() => (window as any).__docxF6Default?.settled)).toBe(true);
      expect(await page.evaluate(() => (window as any).__docxF6Default.defaultPrevented)).toBe(false);
      expect(await page.evaluate(() => (window as any).__docxF6Default.inBody)).toBe(true);
      await expect(tools).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("docx-inline-suggestion")).toHaveCount(0);
      await expect(page.getByTestId("docx-suggestion")).toHaveCount(0);
      expect(await geometry()).toEqual(before.geometry);
      expect(await readLive(page)).toEqual(before.document);
    });

    await test.step("Review the left paragraph after editing another paragraph", async () => {
      await caretAtStart(left);
      const before = await geometry();
      await beginSuggestion(page, left.paragraphRef);
      const entry = page.getByRole("button", { name: "Review suggestion", exact: true });
      const review = page.getByTestId("docx-suggestion");
      await expect(entry).toBeVisible();
      await expect(tools).toHaveAttribute("aria-expanded", "false");
      expect(await geometry()).toEqual(before);
      await caretAtStart(human);
      await page.keyboard.insertText("LOCAL ");
      await expect.poll(async () => (await readTargets([humanId]))[0].text).toBe(`LOCAL ${human.text}`);
      if (!citationPreview) {
        await page.keyboard.press("Shift+Home");
        const selection = await bodySelection();
        expect(selection).toMatchObject({ collapsed: false, text: "LOCAL " });
        const streaming = { geometry: await geometry(), document: await readLive(page) };
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        await page.keyboard.press("F6");
        await expect(tools).toHaveAttribute("aria-expanded", "true");
        await expect(review.getByRole("heading", { name: "Generating suggestion" })).toBeFocused();
        expect(await bodySelection()).toEqual(selection);
        expect(await geometry()).toEqual(streaming.geometry);
        expect(await readLive(page)).toEqual(streaming.document);
        await page.keyboard.press("Escape");
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(review).toBeHidden();
        expect(await bodySelection()).toEqual(selection);
        expect(await geometry()).toEqual(streaming.geometry);
        expect(await readLive(page)).toEqual(streaming.document);
      }

      const beforeReady = await geometry();
      await page.evaluate(() => (window as any).__docxTest.finish());
      await expect(entry).toHaveAttribute("title", "Ready to review");
      await expect(viewport.locator(".docx-pages")).toBeFocused();
      expect(await geometry()).toEqual(beforeReady);
      const heading = review.getByRole("heading", { name: "Ready to review" });
      if (!citationPreview) {
        const ready = { geometry: await geometry(), document: await readLive(page), selection: await bodySelection() };
        await page.keyboard.press("F6");
        await expect(tools).toHaveAttribute("aria-expanded", "true");
        await expect(heading).toBeFocused();
        expect(await bodySelection()).toEqual(ready.selection);
        expect(await geometry()).toEqual(ready.geometry);
        expect(await readLive(page)).toEqual(ready.document);
        await page.keyboard.press("Escape");
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(review).toBeHidden();
        expect(await bodySelection()).toEqual(ready.selection);
        expect(await geometry()).toEqual(ready.geometry);
        expect(await readLive(page)).toEqual(ready.document);
      }
      const firstPaper = surface.locator(".docx-page").first();
      if (!citationPreview) {
        await viewport.evaluate((element) => {
          element.style.maxWidth = "440px";
          element.style.maxHeight = "192px";
        });
        await expect.poll(async () => (await viewport.boundingBox())!.width).toBeLessThanOrEqual(440);
        await expect.poll(async () => (await firstPaper.boundingBox())!.width).toBeLessThanOrEqual(440);
        await line(left).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await expect(entry).toBeVisible();
        const compact = await geometry();
        await entry.press("Enter");
        await expect(heading).toBeFocused();
        expect(await geometry()).toEqual(compact);
        await page.keyboard.press("Escape");
        await expect(tools).toBeFocused();
        await expect(review).toBeHidden();
        expect(await geometry()).toEqual(compact);
        await viewport.evaluate((element) => {
          element.style.maxWidth = "";
          element.style.maxHeight = "";
        });
        await expect.poll(async () => (await viewport.boundingBox())?.width).toBe(before.viewport?.width);
        await expect.poll(async () => (await firstPaper.boundingBox())?.width).toBe(before.papers[0].width);
      }
      let editingPosition: Awaited<ReturnType<typeof bodySelection>> | undefined;
      if (citationPreview) {
        await entry.press("Enter");
      } else {
        await focusTrialParagraph(human);
        editingPosition = await bodySelection();
        expect(editingPosition).toMatchObject({ collapsed: true });
        await page.keyboard.press("F6");
      }
      await expect(heading).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(review.getByRole("heading", { name: "Applied to this working copy" })).toBeFocused();
      const appliedGeometry = await geometry();
      await page.keyboard.press("Escape");
      if (editingPosition) {
        await expect(viewport.locator(".docx-pages")).toBeFocused();
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        expect(await bodySelection()).toEqual(editingPosition);
        expect(await geometry()).toEqual(appliedGeometry);
      }
      await page.getByRole("button", { name: /^Undo/ }).click();
      expect((await readTargets([leftId, humanId])).map(({ text }) => text)).toEqual([left.text, `LOCAL ${human.text}`]);
      await page.getByRole("button", { name: /^Redo/ }).click();
      expect((await readTargets([leftId, humanId])).map(({ text }) => text)).toEqual(["Suggested paragraph is complete.", `LOCAL ${human.text}`]);
    });

    if (!citationPreview) {
      await test.step("Default build keeps an ordinary caret quiet and reopens both edits", async () => {
        await caretAtStart(human);
        await expect(surface.locator("[data-docx-caret]").first()).toBeVisible();
        const before = await geometry();
        await page.keyboard.press("Shift+F10");
        await expect(context).toHaveCount(0);
        expect(await geometry()).toEqual(before);
        await saveAndReopen();
        expect(lookups).toEqual([]);
        const exportPath = await downloadCopy("8227226-default-export.docx");
        const evidence = packageEvidence<PackageInventory>(exportPath);
        expect(evidence.paragraphs.find((paragraph) => paragraph.paraId === leftId)?.text)
          .toBe("Suggested paragraph is complete.");
        expect(evidence.paragraphs.find((paragraph) => paragraph.paraId === humanId)?.text)
          .toBe(`LOCAL ${human.text}`);
        const fields = JSON.parse(execFileSync(workbenchPython, ["-B", resolve("e2e/tests/docx-real-package.py"),
          "--word-export", sourcePath, exportPath, `${leftId},${humanId}`,
        ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(workbenchModule, "src") } }));
        expect(fields).toMatchObject({ ok: true, issues: [], sha256: { original: sha, oleafly: evidence.sha256 } });
      });
      await test.step("Reject from the keyboard and continue at the same caret", async () => {
        const [reviewed, edited] = await readTargets([leftId, humanId]);
        await beginSuggestion(page, reviewed.paragraphRef);
        await focusTrialParagraph(edited);
        await page.evaluate(() => (window as any).__docxTest.finish());
        const before = { geometry: await geometry(), document: await readLive(page), selection: await bodySelection() };
        const pages = viewport.locator(".docx-pages");
        await expect(pages).toBeFocused();
        await page.keyboard.press("F6");
        const review = page.getByTestId("docx-suggestion");
        await expect(review.getByRole("heading", { name: "Ready to review" })).toBeFocused();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect(review.getByRole("button", { name: "Reject", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(review).toHaveCount(0);
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(pages).toBeFocused();
        expect(await bodySelection()).toEqual(before.selection);
        expect(await geometry()).toEqual(before.geometry);
        expect(await readLive(page)).toEqual(before.document);
      });
      await test.step("A failed task receipt leaves the paper and focus in place", async () => {
        const [reviewed, edited] = await readTargets([leftId, humanId]);
        const pages = viewport.locator(".docx-pages");
        const failure = "The task receipt could not be recorded.";
        const failureNotice = page.getByText(`Error: ${failure}`, { exact: true });
        await page.evaluate(async ({ paragraphRef, projectId, failure }) => {
          const modulePath = "/src/lib/docx-agent-host.ts";
          const { captureTaskDocxTarget, presentTaskDocxProposal } = await import(modulePath) as typeof import("../../src/lib/docx-agent-host");
          const host = window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> } };
          const invoke = host.__TAURI_INTERNALS__.invoke;
          const probe = { calls: [] as unknown[], fail: () => {} };
          Object.assign(window, { __docxReceiptProbe: probe });
          host.__TAURI_INTERNALS__.invoke = async (command, args) => {
            if (command !== "research_docx_activity_settle") return invoke(command, args);
            probe.calls.push(args);
            if (probe.calls.length === 1) await new Promise<never>((_, reject) => { probe.fail = () => reject(new Error(failure)); });
            return {};
          };
          const scope = { projectId: "docx-harness", workbenchProjectId: projectId };
          const { document, target } = captureTaskDocxTarget(scope, undefined, paragraphRef);
          presentTaskDocxProposal(scope, { id: "late-receipt-proposal", document, proposalId: null, createdAt: 1,
            origin: { taskId: "receipt-test", generation: 1, groupId: null, memberId: null, executionId: null, workIds: [] },
            event: { type: "runtime", event: { kind: "proposed", target, proposed: "Do not apply this withdrawn rewrite." } } });
        }, { paragraphRef: reviewed.paragraphRef, projectId: project.project_id, failure });
        await focusTrialParagraph(reviewed);
        await page.keyboard.insertText("KEEP ");
        await expect.poll(() => page.evaluate(() => (window as any).__docxReceiptProbe.calls.length)).toBe(1);
        await focusTrialParagraph(edited);
        const beforeFailure = await geometry();
        await page.evaluate(() => (window as any).__docxReceiptProbe.fail());
        await expect(failureNotice).toBeAttached();
        expect(await geometry()).toEqual(beforeFailure);
        await expect(pages).toBeFocused();
        await expect(tools).toHaveAttribute("aria-expanded", "false");

        await tools.click();
        await expect(failureNotice).toBeVisible();
        const retry = page.getByRole("button", { name: "Retry recording results", exact: true });
        await retry.focus();
        await page.keyboard.press("Enter");
        await expect(failureNotice).toHaveCount(0);
        await expect(tools).toBeFocused();
        expect(await geometry()).toEqual(beforeFailure);
        const calls = await page.evaluate(() => (window as any).__docxReceiptProbe.calls);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
        expect((await readTargets([leftId, humanId])).map(({ text }) => text)).toEqual([`KEEP ${reviewed.text}`, edited.text]);
      });
    }
    if (citationPreview) await test.step("Insert in both columns, check shared source undo, save and export", async () => {
      const [edited, , rightColumn] = await readTargets([leftId, humanId, rightId]);
      const picker = page.getByRole("dialog", { name: "Insert citation" });
      const search = picker.getByRole("searchbox");
      const article = picker.getByRole("button", { name: /Deep learning/ });
      const confirm = picker.getByRole("button", { name: "Insert citation", exact: true });
      const openPicker = async (paragraph: LiveParagraph) => {
        await caretAtStart(paragraph);
        await page.keyboard.press("Shift+F10");
        await expect(context.getByRole("button", { name: "Insert citation", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(search).toBeFocused();
      };
      const insert = async (paragraph: LiveParagraph, query: string, description: string) => {
        await openPicker(paragraph);
        await search.fill(query);
        await picker.getByRole("button", { name: "Search Crossref" }).click();
        await article.click();
        await expect(confirm).toHaveAccessibleDescription(description);
        await confirm.click();
        await expect(picker).toHaveCount(0);
      };
      const leftBox = (await line(edited).boundingBox())!;
      const rightBox = (await line(rightColumn).boundingBox())!;
      expect(rightBox.x - leftBox.x).toBeGreaterThan(100);
      const paperNumber = (paragraph: LiveParagraph) => line(paragraph).evaluate((element) => element.closest(".docx-page")?.getAttribute("data-page-index"));
      expect(await paperNumber(edited)).toBe(await paperNumber(rightColumn));
      await insert(edited, doi, "Add document source");
      await insert(rightColumn, `https://doi.org/${doi}`, "Reuse: Deep learning");
      expect(lookups).toEqual([doi, doi]);
      const citationCodes = async () => (await readTargets([leftId, rightId]))
        .map(({ atoms }) => atoms.filter(({ kind }) => kind === "field")
          .map(({ payload }) => payload?.code?.trim()).filter((code) => code?.startsWith("CITATION Oleafly")));
      const codes = await citationCodes();
      expect(codes.map((paragraph) => paragraph.length)).toEqual([1, 1]);
      expect(codes[0]).toEqual(codes[1]);
      const undo = page.getByRole("button", { name: /^Undo/ });
      const redo = page.getByRole("button", { name: /^Redo/ });
      for (const remaining of [1, 0]) {
        await undo.click();
        expect(await citationCodes()).toEqual([remaining ? codes[0] : [], []]);
        await openPicker(rightColumn);
        await search.fill(doi);
        await expect(article).toHaveCount(remaining);
        await page.keyboard.press("Escape");
      }
      await redo.click();
      expect(await citationCodes()).toEqual([codes[0], []]);
      await redo.click();
      expect(await citationCodes()).toEqual(codes);
      await saveAndReopen();
      expect(await citationCodes()).toEqual(codes);
      const exportPath = await downloadCopy("8227226-oleafly-export.docx");
      const evidence = JSON.parse(execFileSync(workbenchPython, ["-B", resolve("e2e/tests/docx-real-package.py"),
        "--citation-export", sourcePath, exportPath, doi, `${leftId},${humanId},${rightId}`,
      ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(workbenchModule, "src") } }));
      expect(evidence).toMatchObject({ ok: true, issues: [], doi, sha256: { original: sha } });
    });
    expect(createHash("sha256").update(await readFile(sourcePath)).digest("hex")).toBe(sha);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    service.child.stdin.end();
    await new Promise<void>((done) => service.child.once("exit", () => done()));
    await rm(root, { recursive: true, force: true });
  }
}

test("opt-in real DOCX round trip retains objects and refuses unsafe paragraph edits", async ({}, testInfo) => {
  const input = process.env.OLEAFLY_REAL_DOCX;
  test.skip(!input, "Set OLEAFLY_REAL_DOCX to an authorized read-only author input.");
  test.setTimeout(360_000);
  const sourcePath = await realpath(input!);
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  if (process.env.OLEAFLY_REAL_DOCX_SHA256) expect(sourceSha256).toBe(process.env.OLEAFLY_REAL_DOCX_SHA256);
  const evidenceParent = resolve(process.env.OLEAFLY_REAL_DOCX_OUTPUT ?? ".private/upstream-reuse/docx-live-implementation-20261111/real-editor");
  await mkdir(evidenceParent, { recursive: true });
  const root = await mkdtemp(resolve(evidenceParent, "run-"));
  const inventory = packageEvidence<PackageInventory>(sourcePath);
  await writeFile(resolve(root, "input-inventory.json"), JSON.stringify(inventory, null, 2));
  const report: Record<string, unknown> = {
    sourcePath, sourceSha256, sourceBytes: source.length,
    browserUrl: process.env.OLEAFLY_BROWSER_TEST_URL, evidence: root,
    level: "real React/EigenPal and Workbench, scripted Tauri IPC and token provider",
    pdf: "not run; independent rendering is outside this editor acceptance",
    stages: [],
  };
  const stages = report.stages as Array<Record<string, unknown>>;
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await launchDocxTestBrowser();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResources: Array<{ url: string; status: number }> = [];
  const requests: Array<Record<string, unknown>> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) failedResources.push({ url: response.url(), status: response.status() }); });
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: Record<string, unknown>) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (payload) {
        const { content_base64, ...identity } = payload;
        requests.push({ path, ...identity, ...(typeof content_base64 === "string" ? {
          content_sha256: createHash("sha256").update(Buffer.from(content_base64, "base64")).digest("hex"),
        } : {}), status: response.status, result });
      }
      if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
      return result;
    }
    const project = await request("/api/projects", {
      name: `Read-only author input acceptance: ${basename(sourcePath)}`,
      filename: basename(sourcePath), content_base64: source.toString("base64"),
    });
    report.project = project;
    await installBrowserBridge(page, request, null);
    const url = `${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`;
    await page.goto(url);
    await expect(page.locator(".docx-paragraph-fragment").first()).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: resolve(root, "opened.png") });
    const read = () => page.evaluate(async () => (window as any).__docxTools.read_docx_document.execute({}));
    const initial = await read();
    await writeFile(resolve(root, "initial-session.json"), JSON.stringify(initial, null, 2));
    stages.push({ stage: "rendered", state: initial.document, sessionRead: initial.error, paragraphs: initial.paragraphs?.length ?? 0 });
    expect.soft(initial.document, "A rendered author document must register its live session before the first edit").toBeDefined();

    // The UI disables Save while pristine. Download invokes the actual editor.save().
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download DOCX copy", exact: true }).click();
    const exported = await download;
    const noChangePath = resolve(root, "no-change.docx");
    await exported.saveAs(noChangePath);
    const noChange = await readFile(noChangePath);
    const noChangeComparison = packageEvidence<PackageComparison>(sourcePath, noChangePath);
    await writeFile(resolve(root, "no-change-comparison.json"), JSON.stringify(noChangeComparison, null, 2));
    report.noChange = noChangeComparison;
    const assertPreserved = (label: string, comparison: PackageComparison) => {
      expect.soft(comparison.missingParts, `${label}: no missing package parts`).toEqual([]);
      expect.soft(comparison.changedMedia, `${label}: exact media bytes remain`).toEqual([]);
      expect.soft(comparison.changedRelationships, `${label}: relationship semantics remain`).toEqual([]);
      expect.soft(comparison.lostOrModifiedProtectedNodes, `${label}: protected authored objects remain`).toEqual({});
      expect.soft(comparison.paragraphCount.after, `${label}: paragraph count remains`).toBe(comparison.paragraphCount.before);
    };
    assertPreserved("no-change", noChangeComparison);
    expect.soft(noChangeComparison.paragraphTextChanges, "No-change export must retain every paragraph's text").toEqual([]);
    const retained = await request("/api/baseline", {
      project_id: project.project_id, expected_baseline_id: project.baseline_id,
      filename: basename(sourcePath), content_base64: noChange.toString("base64"),
      reason: "Controlled no-change export from the real EigenPal React editor; no author path is modified.",
      request_id: `docx-real-${randomUUID()}`,
    });
    expect(retained.status).toBe("APPLIED");
    const retainedSource = await request(`/api/manuscript-source?project_id=${project.project_id}&baseline_id=${retained.result_baseline_id}`);
    expect(Buffer.from(retainedSource.content_base64, "base64").equals(noChange)).toBe(true);
    stages.push({ stage: "no-change-export-retained", baseline: retained.result_baseline_id, sha256: retainedSource.source_sha256 });
    await page.reload();
    await expect(page.locator(".docx-paragraph-fragment").first()).toBeVisible({ timeout: 90_000 });
    // Preserve the failed read as evidence, then exercise the ordinary human input
    // path. A real mutation wakes the current large-document SessionBridge bug.
    const afterReload = await read();
    if (!afterReload.document) {
      const bootstrap = inventory.paragraphs.find((p) => p.safe)!;
      report.activationDefect = { initial, afterReload, workaround: "human keyboard edit followed by toolbar undo" };
      const fragment = page.locator(".docx-paragraph-fragment").filter({ hasText: bootstrap.text.slice(0, 35) }).first();
      await fragment.click({ position: { x: 4, y: 8 } });
      await page.keyboard.press("Home");
      await page.keyboard.insertText("REAL-DOCX-BOOTSTRAP ");
      await expect.poll(async () => (await read()).document?.baselineId, { timeout: 15_000 }).toBe(retained.result_baseline_id);
      await page.getByRole("button", { name: /^Undo/ }).click();
      stages.push({ stage: "session-activation-workaround", method: "human edit and undo", initialMissing: true });
    }
    await expect.poll(async () => (await read()).document?.baselineId, { timeout: 90_000 }).toBe(retained.result_baseline_id);

    let live = await read();
    const candidate = inventory.paragraphs.find((p) => p.safe && live.paragraphs.some((q: RealParagraph) => q.paraId === p.paraId && q.text === p.text));
    expect(candidate, "Author document has a uniform-format plain paragraph exposed by the real session").toBeDefined();
    const plain = live.paragraphs.find((p: RealParagraph) => p.paraId === candidate!.paraId);
    report.plainTarget = plain;
    const apply = (paragraphRef: string, text: string) => page.evaluate(async ({ paragraphRef, text }) => {
      const tools = (window as any).__docxTools;
      const target = await tools.capture_docx_target.execute({ paragraph_ref: paragraphRef });
      return tools.apply_docx_suggestion.execute({ target_id: target.targetId, expected_revision: target.revision, text });
    }, { paragraphRef, text });
    const marked = `REAL-DOCX-ACCEPTANCE ${plain.text}`;
    const applied = await apply(plain.paragraphRef, marked);
    stages.push({ stage: "plain-edit", result: applied });
    expect(applied).toMatchObject({ ok: true, changed: true });
    expect(applied.document.sessionRevision).toBe(live.document.sessionRevision + 1);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect.poll(async () => (await read()).paragraphs.find((p: RealParagraph) => p.paraId === candidate!.paraId)?.text).toBe(plain.text);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect.poll(async () => (await read()).paragraphs.find((p: RealParagraph) => p.paraId === candidate!.paraId)?.text).toBe(marked);
    stages.push({ stage: "undo-redo", passed: true });

    await page.evaluate((selection) => {
      Object.assign((window as any).__docxTest, { prefix: "REAL-DOCX-AGENT ", selection });
    }, marked);
    await beginSuggestion(page, plain.paragraphRef);
    const tools = page.getByTestId("docx-document-tools");
    await tools.click();
    await expect(page.getByTestId("docx-proposed")).toHaveText("REAL-DOCX-AGENT");
    await tools.click();
    const fragments = page.locator(".docx-paragraph-fragment").filter({ hasText: "REAL-DOCX-ACCEPTANCE" });
    await fragments.first().click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.insertText("REAL-DOCX-HUMAN ");
    await tools.click();
    await expect(page.getByTestId("docx-suggestion")).toContainText("Needs a fresh read");
    await tools.click();
    expect(await page.evaluate(() => (window as any).__docxTest.canceled)).toBe(1);
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    live = await read();
    const humanText = live.paragraphs.find((p: RealParagraph) => p.paraId === candidate!.paraId)?.text;
    expect(humanText).toContain("REAL-DOCX-HUMAN");
    expect(humanText).toContain("REAL-DOCX-ACCEPTANCE");
    stages.push({ stage: "human-target-intervention", text: humanText, canceled: true });

    const protectedResults: Array<Record<string, unknown>> = [];
    for (const category of ["mixed", "field", "formula", "image", "revision", "comment"]) {
      const originalTarget = inventory.paragraphs.find((p) => p.categories.includes(category) && live.paragraphs.some((q: RealParagraph) => q.paraId === p.paraId));
      if (!originalTarget) { protectedResults.push({ category, status: "not-present-or-not-exposed" }); continue; }
      const paragraph = live.paragraphs.find((p: RealParagraph) => p.paraId === originalTarget.paraId);
      const before = await read();
      const result = await apply(paragraph.paragraphRef, `UNSAFE-REPLACEMENT ${paragraph.text}`);
      protectedResults.push({ category, paraId: paragraph.paraId, result });
      expect.soft(result, `${category} paragraph must explicitly refuse a whole-paragraph replacement`).toMatchObject({ ok: false, changed: false });
      expect.soft(["unsupported-target", "stale-target"]).toContain(result.code);
      expect.soft((await read()).document.sessionRevision).toBe(before.document.sessionRevision);
    }
    report.protectedResults = protectedResults;
    stages.push({ stage: "protected-targets", results: protectedResults });
    const afterRefusals = await request("/api/state");
    expect(afterRefusals.projects[0].baseline_id).toBe(retained.result_baseline_id);

    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect.poll(async () => (await read()).document?.dirty, { timeout: 60_000 }).toBe(false);
    const savedState = await request("/api/state");
    const savedBaseline = savedState.projects[0].baseline_id;
    expect(savedBaseline).not.toBe(retained.result_baseline_id);
    const saved = await request(`/api/manuscript-source?project_id=${project.project_id}&baseline_id=${savedBaseline}`);
    const savedPath = resolve(root, "edited.docx");
    await writeFile(savedPath, Buffer.from(saved.content_base64, "base64"));
    const editedComparison = packageEvidence<PackageComparison>(sourcePath, savedPath);
    await writeFile(resolve(root, "edited-comparison.json"), JSON.stringify(editedComparison, null, 2));
    report.edited = editedComparison;
    assertPreserved("edited", editedComparison);
    expect.soft(editedComparison.paragraphTextChanges.map(({ before, after }) => ({ before, after })), "Only the authorized plain paragraph changes").toEqual([{ before: plain.text, after: humanText }]);
    stages.push({ stage: "edited-export-retained", baseline: savedBaseline, sha256: saved.source_sha256 });
    await page.screenshot({ path: resolve(root, "edited.png") });
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect.poll(async () => (await read()).document?.baselineId, { timeout: 90_000 }).toBe(savedBaseline);
    await expect(page.locator(".docx-paragraph-fragment").filter({ hasText: "REAL-DOCX-HUMAN REAL-DOCX-ACCEPTANCE" }).first()).toBeVisible({ timeout: 90_000 });
    const reopenedBeforeIntervention = await read();
    if (!reopenedBeforeIntervention.document) {
      report.reopenActivationDefect = reopenedBeforeIntervention;
      const fragment = page.locator(".docx-paragraph-fragment").filter({ hasText: "REAL-DOCX-HUMAN REAL-DOCX-ACCEPTANCE" }).first();
      await fragment.click({ position: { x: 4, y: 8 } });
      await page.keyboard.press("Home");
      await page.keyboard.insertText("REOPEN-PROBE ");
      await expect.poll(async () => (await read()).document?.baselineId, { timeout: 15_000 }).toBe(savedBaseline);
      await page.getByRole("button", { name: /^Undo/ }).click();
    }
    const reopened = await read();
    expect(reopened.paragraphs.find((p: RealParagraph) => p.paraId === candidate!.paraId)?.text).toBe(humanText);
    await writeFile(resolve(root, "reopened-session.json"), JSON.stringify(reopened, null, 2));
    await page.screenshot({ path: resolve(root, "reopened.png") });
    stages.push({ stage: "reopened", state: reopened.document, markerRetained: true });

    expect.soft(errors).toEqual([]);
    report.completed = true;
  } catch (cause) {
    report.failure = String(cause);
    report.failureState = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 12_000), html: document.querySelector("[data-testid=docx-editor-surface]")?.innerHTML.slice(0, 4_000) })).catch(() => null);
    await page.screenshot({ path: resolve(root, "failure.png") }).catch(() => {});
    throw cause;
  } finally {
    report.authorHashAfter = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    report.authorUnchanged = report.authorHashAfter === sourceSha256;
    report.pageErrors = errors;
    report.consoleErrors = consoleErrors;
    report.failedResources = failedResources;
    report.assertionFailures = testInfo.errors.map((error) => error.message);
    report.outcome = report.failure || testInfo.errors.length ? "FAILED" : "PASSED";
    report.requests = requests;
    await writeFile(resolve(root, "result.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("real-docx-result", { path: resolve(root, "result.json"), contentType: "application/json" });
    await browser.close();
    const exited = new Promise<void>((done) => service.child.once("exit", () => done()));
    service.child.stdin.end();
    await exited;
    expect(report.authorHashAfter, "Read-only author input hash must remain unchanged").toBe(sourceSha256);
  }
});

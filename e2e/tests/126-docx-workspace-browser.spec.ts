import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";

const original = "Target paragraph for a streamed suggestion.";
const other = "Human paragraph stays independent.";

function fixture(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>${original}</w:t></w:r></w:p><w:p><w:r><w:t>${other}</w:t></w:r></w:p><w:p><w:r><w:t>Protected field </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p><w:p><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Retained table cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`),
  });
}

async function startWorkbench(root: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const module = resolve("services/research-workbench");
  const child = spawn(resolve(module, ".venv/bin/python"), ["-m", "research_file_workbench.workbench.launcher", "--library-root", root], { cwd: module, env: { ...process.env, PYTHONPATH: "src" } });
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

// Actual React editor and Workbench HTTP. Tauri IPC and token generation are scripted.
test("DOCX live working copy preserves intervention, undo and exact saved checks", async ({}, testInfo) => {
  const renderer = process.env.OLEAFLY_LIBREOFFICE ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  test.skip(!existsSync(renderer), `LibreOffice is not installed at ${renderer}`);
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "oleafly-docx-")));
  const service = await startWorkbench(resolve(root, "library"));
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request(path: string, payload?: unknown) {
      const response = await fetch(new URL(path, service.url), {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-RFW-Token": session.token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }
    async function requestBytes(path: string) {
      const response = await fetch(new URL(path, service.url), {
        headers: { "X-RFW-Token": session.token },
      });
      if (!response.ok) throw new Error((await response.json()).error);
      return new Uint8Array(await response.arrayBuffer());
    }
    const world = await request("/api/worlds", { journal_id: "docx-test", journal_name: "DOCX test journal", article_type: "research_article", stage: "initial_submission", language: "en", sources: [{ name: "guide.txt", kind: "guide_text", content_base64: Buffer.from("All manuscript pages must use A4 paper.").toString("base64") }] });
    const project = await request("/api/projects", { name: "Synthetic DOCX working copy", filename: "working-copy.docx", content_base64: Buffer.from(fixture()).toString("base64") });
    await request("/api/bind", { project_id: project.project_id, world_version_id: world.version_id, expected_binding_id: null });
    const initialCheck = await request("/api/check", { project_id: project.project_id });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors: string[] = [];
    const failedAssets: string[] = [];
    const loadedAssets: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400 && /docx-editor|harfbuzz|\.ttf|\.woff/.test(response.url())) failedAssets.push(response.url()); });
    page.on("response", (response) => { if (response.ok() && /\.wasm|\.ttf|\.otf/.test(response.url())) loadedAssets.push(response.url()); });
    await page.exposeFunction("docxWorkbenchRequest", request);
    await page.exposeFunction("docxWorkbenchBytes", requestBytes);
    await page.exposeFunction("docxRenderer", () => renderer);
    await page.addInitScript(() => {
      let callback = 0;
      const control = { finish: null as (() => void) | null, canceled: 0 };
      Object.assign(window, {
        __docxTest: control,
        __TAURI_INTERNALS__: {
          transformCallback: () => ++callback,
          unregisterCallback: () => {},
          invoke: async (command: string, args: any = {}) => {
            if (command === "journal_workbench_request") return (window as any).docxWorkbenchRequest(args.path, args.payload ?? undefined);
            if (command === "journal_docx_renderer") return await (window as any).docxRenderer();
            if (command === "journal_docx_render") {
              return (window as any).docxWorkbenchRequest("/api/render-baseline", {
                project_id: args.projectId,
                baseline_id: args.baselineId,
                libreoffice_executable: args.executable,
                reason: "Refresh the PDF preview of this saved DOCX working-copy version.",
              });
            }
            if (command === "journal_docx_pdf") {
              const result = await (window as any).docxWorkbenchBytes(
                `/api/render?project_id=${encodeURIComponent(args.projectId)}&baseline_id=${encodeURIComponent(args.baselineId)}&bundle_id=${encodeURIComponent(args.bundleId)}&role=pdf&page_number=none`,
              );
              return Array.from(result);
            }
            if (command === "agent_cancel") { control.canceled++; control.finish?.(); return; }
            if (command === "agent_stream") {
              args.onEvent.onmessage({ kind: "textDelta", text: "Suggested paragraph" });
              await new Promise<void>((finish) => { control.finish = finish; });
              args.onEvent.onmessage({ kind: "textDelta", text: " is complete." });
              args.onEvent.onmessage({ kind: "runEnd" });
              control.finish = null;
              return;
            }
            if (command.startsWith("plugin:")) return 1;
            return null;
          },
        },
      });
    });
    await page.goto(`${process.env.OLEAFLY_BROWSER_TEST_URL ?? "http://127.0.0.1:1420"}/e2e/docx-workspace-harness.html`);
    try { await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 15000 }); }
    catch (cause) {
      await testInfo.attach("docx-startup-errors", { body: JSON.stringify({ errors, consoleErrors, failedAssets }), contentType: "application/json" });
      throw cause;
    }
    const liveDocument = await page.evaluate(async () => {
      return (window as any).__docxTools.read_docx_document.execute({});
    });
    expect(liveDocument).toMatchObject({ document: { appProjectId: "docx-harness", dirty: false } });
    const target = page.getByRole("combobox", { name: "Target paragraph", exact: true });
    await expect(target.locator("option")).toHaveCount(6);
    await target.selectOption({ label: `1. ${original}` });
    await page.getByRole("textbox", { name: "Describe the change to this paragraph" }).fill("Improve this sentence.");
    await page.getByRole("button", { name: "Generate suggestion", exact: true }).click();
    await expect(page.getByTestId("docx-proposed")).toHaveText("Suggested paragraph");
    await expect(page.getByTestId("docx-inline-suggestion")).toBeVisible();
    const documentParagraphs = page.locator(".docx-paragraph-fragment");
    await documentParagraphs.nth(1).click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.insertText("USER ");
    await expect(target).toContainText(`USER ${other}`);
    await page.getByRole("button", { name: "Minimize", exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeHidden();
    await page.getByRole("button", { name: "Resume DOCX working copy", exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    await expect(target).toContainText(`USER ${other}`);
    await expect(page.getByTestId("docx-suggestion")).toContainText("Generating suggestion");
    await testInfo.attach("editor-dom", { body: await page.getByTestId("docx-editor-surface").innerHTML(), contentType: "text/html" });
    await page.evaluate(() => (window as any).__docxTest.finish());
    await expect(page.getByTestId("docx-inline-suggestion").getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    await page.getByTestId("docx-inline-suggestion").getByRole("button", { name: "Accept", exact: true }).click();
    await expect(target).toContainText("Suggested paragraph is complete.");
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(target).toContainText(original);
    await expect(target).toContainText(`USER ${other}`);
    await page.getByRole("button", { name: /^Redo/ }).click();
    await expect(target).toContainText("Suggested paragraph is complete.");
    await target.selectOption({ label: "1. Suggested paragraph is complete." });
    await page.getByRole("button", { name: "Generate suggestion", exact: true }).click();
    await expect(page.getByTestId("docx-proposed")).toHaveText("Suggested paragraph");
    await documentParagraphs.first().click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.insertText("LOCAL ");
    await expect(target).toContainText("LOCAL Suggested paragraph is complete.");
    await expect(page.getByTestId("docx-suggestion")).toContainText("Needs a fresh read");
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__docxTest.canceled)).toBe(1);
    const appliedByAgent = await page.evaluate(async () => {
      const read = await (window as any).__docxTools.read_docx_document.execute({});
      const paragraph = read.paragraphs.find((item: { text: string }) => item.text.includes("USER "));
      const target = await (window as any).__docxTools.capture_docx_target.execute({ paragraph_ref: paragraph.paragraphRef });
      return (window as any).__docxTools.apply_docx_suggestion.execute({
        target_id: target.targetId,
        expected_revision: target.revision,
        text: "Agent updated this paragraph after the user's edit.",
      });
    });
    expect(appliedByAgent).toMatchObject({ ok: true, changed: true });
    await expect(target).toContainText("Agent updated this paragraph after the user's edit.");
    await page.getByRole("button", { name: "Save manuscript version", exact: true }).click();
    await expect(page.getByTestId("docx-save-state")).toContainText("Retained DOCX version loaded or saved");
    await page.getByRole("button", { name: "Bind selected journal and check saved version", exact: true }).click();
    await expect(page.getByText(/Check saved: CURRENT/)).toBeVisible();
    await expect(page.getByTestId("docx-render-state")).toContainText("PDF matches the saved working copy");
    await page.getByRole("button", { name: "Open PDF", exact: true }).click();
    await expect(page.locator("[data-testid=docx-render-preview] [data-pdf-state=ready]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-testid=docx-render-preview] .pdf-canvas").first()).toBeVisible();
    await page.getByTestId("docx-render-preview").getByRole("button", { name: "Close", exact: true }).click();
    const state = await request("/api/state");
    const current = state.projects[0];
    expect(current.baseline_id).not.toBe(project.baseline_id);
    expect(current.latest_check.baseline_id).toBe(current.baseline_id);
    const renders = await request(`/api/derived-renders?project_id=${project.project_id}&baseline_id=${current.baseline_id}`);
    expect(renders.derived_renders).toHaveLength(1);
    expect(renders.derived_renders[0].manifest.page_count).toBeGreaterThan(0);
    const renderedPdf = await requestBytes(`/api/render?project_id=${project.project_id}&baseline_id=${current.baseline_id}&bundle_id=${renders.derived_renders[0].bundle_id}&role=pdf&page_number=none`);
    expect(new TextDecoder().decode(renderedPdf.slice(0, 5))).toBe("%PDF-");
    const historical = await request(`/api/check?check_id=${initialCheck.check_id}`);
    expect(historical.validity).toBe("STALE");
    const saved = await request(`/api/manuscript-source?project_id=${project.project_id}&baseline_id=${current.baseline_id}`);
    const xml = new TextDecoder().decode(unzipSync(Buffer.from(saved.content_base64, "base64"))["word/document.xml"]);
    expect(xml).toContain("Suggested paragraph is complete.");
    expect(xml).toContain("Agent updated this paragraph after the user");
    expect(xml).toContain("LOCAL Suggested paragraph is complete.");
    expect(xml).toContain("fldSimple");
    expect(xml).toContain("oMath");
    expect(xml).toContain("Retained table cell.");
    await page.screenshot({ path: testInfo.outputPath("docx-workspace.png") });
    await page.getByTestId("docx-workspace").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Reopen working copy", exact: true }).click();
    await expect(page.getByText(`Retained baseline: ${current.baseline_id}`, { exact: true })).toBeVisible();
    await expect(target).toContainText("LOCAL Suggested paragraph is complete.");
    await expect(target).toContainText("Agent updated this paragraph after the user's edit.");
    expect(failedAssets).toEqual([]);
    expect(loadedAssets.some((url) => url.includes(".wasm"))).toBe(true);
    expect(loadedAssets.some((url) => /\.ttf|\.otf/.test(url))).toBe(true);
    expect(errors).toEqual([]);
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
  execFileSync(resolve("services/research-workbench/.venv/bin/python"), [
    resolve("e2e/tests/docx-real-package.py"), source, ...(output ? [output] : []),
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
);

// Explicit local input only. Real React/EigenPal + real Workbench; scripted IPC/provider.
// No renderer is selected: a PDF conversion is independent evidence, not object fidelity.
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
  const browser = await chromium.launch({ channel: "chrome" });
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
    await page.exposeFunction("docxWorkbenchRequest", request);
    await page.addInitScript(() => {
      let callback = 0;
      const control = { finish: null as (() => void) | null, canceled: 0, prefix: "REAL-DOCX-AGENT ", selection: "" };
      Object.assign(window, {
        __docxTest: control,
        __TAURI_INTERNALS__: {
          transformCallback: () => ++callback,
          unregisterCallback: () => {},
          invoke: async (command: string, args: any = {}) => {
            if (command === "journal_workbench_request") return (window as any).docxWorkbenchRequest(args.path, args.payload ?? undefined);
            if (command === "journal_docx_renderer") return null;
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
            throw new Error(`Unexpected real-DOCX test IPC: ${command}`);
          },
        },
      });
    });
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

    const target = page.getByRole("combobox", { name: "Target paragraph", exact: true });
    await target.selectOption(plain.paragraphRef);
    await page.getByRole("textbox", { name: "Describe the change to this paragraph" }).fill("Keep the paragraph and add the acceptance marker.");
    await page.evaluate((selection) => { (window as any).__docxTest.selection = selection; }, marked);
    await page.getByRole("button", { name: "Generate suggestion", exact: true }).click();
    await expect(page.getByTestId("docx-proposed")).toHaveText("REAL-DOCX-AGENT");
    const fragments = page.locator(".docx-paragraph-fragment").filter({ hasText: "REAL-DOCX-ACCEPTANCE" });
    await fragments.first().click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.insertText("REAL-DOCX-HUMAN ");
    await expect(page.getByTestId("docx-suggestion")).toContainText("Needs a fresh read");
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

    await page.getByRole("button", { name: "Save manuscript version", exact: true }).click();
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
    await expect(page.getByText(`Retained baseline: ${savedBaseline}`, { exact: true })).toBeVisible({ timeout: 90_000 });
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

import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
import type { ResearchTask, TaskCompiledArtifact } from "../../src/lib/research-tasks";
import type { PaperText } from "../../src/lib/research-literature";
import { test, expect } from "../fixtures";
import { createBlankProject, fillTextarea, openRailTab, setEditorContent, waitLong } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

type Message = { role: string; content: unknown };
const MODEL = "gpt/gpt-6.1-sol";
const PROVIDER = "shared-paper-fixture";
const ORIGINAL = "\\documentclass{article}\n\\begin{document}\nValidation is an independent test.\n\\end{document}\n";
const REVISED = "\\documentclass{article}\n\\begin{document}\nValidation selects the model; test data stay held out. A change from 92 to 91 is a decrease.\n\\end{document}\n";

function toolResult<T>(request: Record<string, unknown>, field: string): T {
  for (const message of [...request.messages as Message[]].reverse()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const value = JSON.parse(message.content) as Record<string, unknown>;
    if (field in value) return value as T;
  }
  throw new Error(`No tool result with ${field}.`);
}

async function sourcePdf(): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, marker] of ["VALIDATION_SOURCE_FIRST", "HELDOUT_SOURCE_SECOND"].entries()) {
    const page = document.addPage([612, 792]);
    page.drawText(`${marker}\nValidation selects the model; test data stay held out.\nA change from 92 to 91 is a decrease.`, { x: 36, y: 750, font, size: 10, lineHeight: 14 });
    for (let row = 0; row < 38; row++) page.drawText(`Source page ${index + 1}, evidence line ${row + 1}: keep the measured comparison.`, { x: 36, y: 680 - row * 14, font, size: 9 });
  }
  return Buffer.from(await document.save()).toString("base64");
}

// Scripted provider calls test native application integration, not model reasoning.
test("ordinary chat reads retained paper windows, revises, compiles and reopens the exact PDF", async ({ tauriPage: page }, testInfo) => {
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Shared paper chat ${Date.now()}`);
    await setEditorContent(page, ORIGINAL);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().saveAllDirty())`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setViewMode('split'))`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const pdf = await sourcePdf();
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      const next = { ...config, ai_provider: ${scriptValue(PROVIDER)}, ai_model: ${scriptValue(MODEL)}, ai_custom_providers: [...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}), { id: ${scriptValue(PROVIDER)}, name: 'Scripted paper reader fixture', baseURL: ${scriptValue(`${server.url}/v1`)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(PROVIDER)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'user' }] } };
      await api.setConfig(next);
      window.dispatchEvent(new CustomEvent('oleafly:ai-config-changed', { detail: next }));
      await api.approvalsModeSet(${scriptValue(projectId)}, 'full-access');
      await api.writeProjectBytes(${scriptValue(projectId)}, 'source.pdf', ${scriptValue(pdf)});
    })`);
    await page.evaluate(`window.__researchTasksSet?.(false)`);
    let first: PaperText | undefined;
    server.setToolSequence([
      { name: "read_paper", args: { path: "source.pdf", max_chars: 1000 } },
      { name: "read_paper", args: (request) => {
        first = toolResult<PaperText>(request, "nextOffset");
        return { reference: first.pdfReference, offset: first.nextOffset!, max_chars: 48000 };
      } },
      { name: "read_file", args: { path: "main.tex" } },
      { name: "write_file", args: { path: "main.tex", content: REVISED } },
      { name: "compile", args: {} },
      { name: "get_pdf_text", args: {} },
    ], "SHARED_PAPER_CHAT_COMPLETE");
    await openRailTab(page, "Research Assistant");
    await fillTextarea(page, 'textarea[placeholder*="Ask AI"]', "Read source.pdf, correct the validation/test statement, compile, and read the resulting PDF.");
    await page.press('textarea[placeholder*="Ask AI"]', "Enter");
    await waitLong(page, `document.body.innerText.includes('SHARED_PAPER_CHAT_COMPLETE') && !document.querySelector('[aria-label="Stop"]')`, 150_000);
    expect(first?.source.offset).toBe(0);
    expect(first?.nextOffset).toBeGreaterThan(0);
    expect(first?.text).toContain("VALIDATION_SOURCE_FIRST");
    const requests = server.requestBodies().map((body) => JSON.parse(body) as Record<string, unknown>);
    const final = requests.at(-1)!;
    const windows = (final.messages as Message[]).filter((message) => message.role === "tool" && typeof message.content === "string")
      .map((message) => JSON.parse(message.content as string) as Partial<PaperText> & { text?: string; success?: boolean });
    expect(windows.some((value) => value.text?.includes("HELDOUT_SOURCE_SECOND"))).toBe(true);
    expect(windows.some((value) => value.success === true)).toBe(true);
    expect(toolResult<{ text: string }>(final, "numPages").text).toContain("test data stay held out");
    const native = await page.evaluate<{ source: string; pdf: string; files: string[] }>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => ({ source: await api.readFileContent(${scriptValue(projectId)}, 'main.tex'), pdf: btoa(String.fromCharCode(...new Uint8Array(await api.readProjectBytes(${scriptValue(projectId)}, 'source.pdf')))), files: (await api.listFiles(${scriptValue(projectId)})).map(f => f.path) }))`);
    expect(native.source).toBe(REVISED);
    expect(native.pdf).toBe(pdf);
    expect(native.files.some((path) => path.startsWith("sources/") || path.includes("papers/file_"))).toBe(false);
    expect(first?.pdfReference.projectId).toBe(projectId);
    await waitLong(page, `!!document.querySelector('[data-pdf-scroll-root] canvas')`, 30_000);
    const manuscriptText = () => page.evaluate<string>(`window.__oleaflyE2EImport('/src/components/pdf/pdfController.ts').then(async m => (await m.pdfPageText(1))?.map(run => run.str).join(' ') ?? '')`);
    expect(await manuscriptText()).toContain("test data stay held out");
    await page.evaluate(`document.querySelector('[data-tool-name="read_paper"] > button[aria-expanded="false"]')?.click()`);
    await page.getByText("Open retained PDF", { exact: true }).click();
    const preview = page.locator('[data-testid="retained-paper-preview"]');
    await expect(preview).toContainText(first!.pdfReference.pdfSha256);
    await expect(preview.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    expect(await manuscriptText()).toContain("test data stay held out");
    await page.screenshot({ path: testInfo.outputPath("retained-paper-preview.png") });
    await page.press("body", "Escape");
    await expect(preview).toHaveCount(0);
    expect(await manuscriptText()).toContain("test data stay held out");
    const mismatch = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/research-literature.ts').then(async m => { try { await m.readRetainedPaperPdf(${scriptValue({ ...first!.pdfReference, pdfSha256: "0".repeat(64) })}); return 'unexpected success'; } catch (error) { return String(error); } })`);
    expect(mismatch).toContain("no longer matches");
  } finally { await server.close(); }
});

test("single task and task group share the paper reader and retain compiled results without applying to the author project", async ({ tauriPage: page }) => {
  test.setTimeout(300_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Shared paper tasks ${Date.now()}`);
    await setEditorContent(page, ORIGINAL);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().saveAllDirty())`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const pdf = await sourcePdf();
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      await api.setConfig({ ...config, ai_custom_providers: [...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}), { id: ${scriptValue(PROVIDER)}, name: 'Scripted paper reader fixture', baseURL: ${scriptValue(`${server.url}/v1`)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(PROVIDER)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'user' }] } });
      await api.writeProjectBytes(${scriptValue(projectId)}, 'source.pdf', ${scriptValue(pdf)});
    })`);
    const references: TaskCompiledArtifact[] = [];
    for (const group of [false, true]) {
      server.resetRequests();
      const steps = [
        { name: "read_paper", args: { path: "source.pdf", max_chars: 48000 } },
        { name: "read_file", args: { path: "main.tex" } },
        { name: "write_file", args: { path: "main.tex", content: REVISED } },
        { name: "compile", args: {} },
        { name: "discover_tools", args: { query: "task_pdf_text" } },
        { name: "task_pdf_text", args: (request: Record<string, unknown>) => {
          const { artifact } = toolResult<{ artifact: TaskCompiledArtifact }>(request, "artifact");
          references.push(artifact);
          return { reference: artifact };
        } },
      ];
      server.setResponder((request) => {
        const messages = request.messages as Message[];
        if (messages.some(message => message.role === "system" && typeof message.content === "string" && message.content.includes("Assess responsibility-based participation"))) return '{"decisions":[]}';
        const step = steps[messages.filter(message => message.role === "tool").length];
        return step ? { name: step.name, args: typeof step.args === "function" ? step.args(request) : step.args } : "SHARED_PAPER_TASK_COMPLETE";
      });
      const task = await page.evaluate<ResearchTask>(`(async () => {
        const m = await window.__oleaflyE2EImport('/src/lib/research-tasks.ts');
        const task = await m.createResearchTask(${scriptValue({ projectId, title: group ? "Group source review" : "Single source review", prompt: "Read source.pdf, correct main.tex in the task copy, compile and read the resulting PDF.", runtimeId: "builtin", agentId: PROVIDER, modelId: MODEL, skillIds: [], dependencyIds: [] })});
        ${group ? `const c = await window.__oleaflyE2EImport('/src/lib/task-collaboration.ts'); await c.createTaskGroup(${scriptValue(projectId)}, task.id, [{ name: 'Source reviewer', responsibility: 'Read source evidence, revise the isolated draft, compile and verify the result.', runtimeId: 'builtin', agentId: ${scriptValue(PROVIDER)}, modelId: ${scriptValue(MODEL)}, skillIds: [], coordinator: true }]);` : ""}
        return m.startResearchTask(task.id);
      })()`);
      await waitLong(page, `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => ['awaiting_review', 'failed'].includes((await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)})?.status))`, 150_000);
      const settled = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
      expect(settled.status, settled.error ?? "task status").toBe("awaiting_review");
      const request = server.requestBodies().map(body => JSON.parse(body) as Record<string, unknown>).reverse().find(body => (body.messages as Message[]).some(message => message.role === "tool" && typeof message.content === "string" && "pageCount" in JSON.parse(message.content)))!;
      const paper = toolResult<PaperText>(request, "key");
      expect(paper.text).toContain("HELDOUT_SOURCE_SECOND");
      expect(paper.source.snapshotRetained).toBe(true);
      expect(toolResult<{ text: string }>(request, "pageCount").text).toContain("test data stay held out");
      expect(references.at(-1)?.taskId).toBe(task.id);
      expect(await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(api => api.readFileContent(${scriptValue(projectId)}, 'main.tex'))`)).toBe(ORIGINAL);
    }
    expect(references).toHaveLength(2);
    expect(references[0].taskId).not.toBe(references[1].taskId);
  } finally { await server.close(); }
});

test("live Sol reads source evidence, revises the draft and verifies the compiled PDF", async ({ tauriPage: page }, testInfo) => {
  test.skip(!process.env.OLEAFLY_SHARED_PAPER_LIVE_URL, "Set OLEAFLY_SHARED_PAPER_LIVE_URL for the bounded live-provider probe.");
  test.setTimeout(300_000);
  if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
  await createBlankProject(page, `Live shared paper ${Date.now()}`);
  await setEditorContent(page, ORIGINAL.replace("Validation is an independent test.", "Validation is an independent test. The change from 92 to 91 improves accuracy."));
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().saveAllDirty())`);
  const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
  const pdf = await sourcePdf();
  const provider = "shared-paper-live";
  await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
    const config = await api.getConfig();
    const next = { ...config, ai_provider: ${scriptValue(provider)}, ai_model: ${scriptValue(MODEL)}, ai_custom_providers: [...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(provider)}), { id: ${scriptValue(provider)}, name: 'Shared paper live probe', baseURL: ${scriptValue(process.env.OLEAFLY_SHARED_PAPER_LIVE_URL)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(provider)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'custom', metadata: { name: ${scriptValue(MODEL)}, toolCall: true, reasoning: true, reasoningOptions: [{ type: 'effort', values: ['high'] }] } }] } };
    await api.setConfig(next);
    window.dispatchEvent(new CustomEvent('oleafly:ai-config-changed', { detail: next }));
    await api.approvalsModeSet(${scriptValue(projectId)}, 'full-access');
    await api.writeProjectBytes(${scriptValue(projectId)}, 'source.pdf', ${scriptValue(pdf)});
  })`);
  await page.evaluate(`window.__researchTasksSet?.(false)`);
  await openRailTab(page, "Research Assistant");
  await page.press('[data-testid="ai-effort-selector"]', "Enter");
  await page.getByText("High", { exact: true }).click();
  await fillTextarea(page, 'textarea[placeholder*="Ask AI"]', "This is a teaching fixture. Read source.pdf using read_paper, then read main.tex. Correct the validation/test conflation and the direction of the 92 to 91 accuracy comparison in main.tex, preserving both measured numbers. Compile with the compile tool, then use get_pdf_text to check the new PDF. Finish by reporting the pages you read and the two corrections. Work in this project only. Do not delegate, use shell commands, or search the network.");
  await page.press('textarea[placeholder*="Ask AI"]', "Enter");
  await waitLong(page, `!!document.querySelector('[aria-label="Stop"]')`, 30_000);
  await waitLong(page, `!document.querySelector('[aria-label="Stop"]')`, 240_000);
  const result = await page.evaluate<{ source: string; sourcePdf: string; chat: { effort?: string; messages: Array<{ role: string; failed?: boolean; toolCalls?: Array<{ name: string; status: string; output?: string }> }>; usage?: { inputTokens: number; outputTokens: number } } }>(`(async () => {
    const api = await window.__oleaflyE2EImport('/src/lib/tauri.ts');
    const chats = (await window.__oleaflyE2EImport('/src/store/chats.ts')).useChatsStore.getState();
    const chat = chats.byId(chats.activeId);
    return { source: await api.readFileContent(${scriptValue(projectId)}, 'main.tex'), sourcePdf: btoa(String.fromCharCode(...new Uint8Array(await api.readProjectBytes(${scriptValue(projectId)}, 'source.pdf')))), chat: { ...chat, messages: chats.liveOrSaved(chats.activeId) ?? chat.messages } };
  })()`);
  writeFileSync(testInfo.outputPath("live-paper-reading.json"), JSON.stringify({ projectId, provider, model: MODEL, effort: "high", ...result }, null, 2));
  expect(result.chat.effort).toBe("high");
  expect(result.chat.messages.at(-1)?.failed).not.toBe(true);
  const calls = result.chat.messages.flatMap(message => message.toolCalls ?? []);
  const paper = calls.find(call => call.name === "read_paper" && call.status === "done");
  expect(paper).toBeDefined();
  expect(JSON.parse(paper!.output!).text).toContain("Validation selects the model");
  expect(calls.some(call => call.name === "compile" && JSON.parse(call.output ?? "{}").success === true)).toBe(true);
  const compiled = calls.find(call => call.name === "get_pdf_text" && call.status === "done");
  expect(compiled).toBeDefined();
  const compiledText = JSON.parse(compiled!.output!).text as string;
  expect(compiledText).toMatch(/92[\s\S]*91/);
  expect(compiledText).toMatch(/decreas|declin|drop|lower/i);
  expect(result.source).not.toContain("Validation is an independent test");
  expect(result.source).not.toContain("improves accuracy");
  expect(result.sourcePdf).toBe(pdf);
  expect(result.chat.usage?.inputTokens).toBeGreaterThan(0);
});

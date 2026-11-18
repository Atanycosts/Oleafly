import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
import type { ResearchTask, TaskCompiledArtifact } from "../../src/lib/research-tasks";
import type { PaperText } from "../../src/lib/research-literature";
import { test, expect } from "../fixtures";
import {
  createBlankProject,
  fillTextarea,
  openRailTab,
  setEditorContent,
  waitForCompileIdle,
  waitLong,
} from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";

type ToolCall = { id?: string; function?: { name?: string } };
type Message = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
type CompileToolResult = { value: Record<string, unknown> | null; excerpt: string };
const MODEL = "gpt/gpt-6.1-sol";
const PROVIDER = "shared-paper-fixture";
const COMPILE_ARTIFACT_MISSING = "SHARED_PAPER_COMPILE_ARTIFACT_MISSING";
const ORIGINAL = "\\documentclass{article}\n\\begin{document}\nValidation is an independent test.\n\\end{document}\n";
const REVISED = "\\documentclass{article}\n\\begin{document}\nValidation selects the model; test data stay held out. A change from 92 to 91 is a decrease.\n\\end{document}\n";

function compileToolResult(request: Record<string, unknown>): CompileToolResult | null {
  const messages = request.messages as Message[];
  const compileCallIds = new Set(messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls
        .filter((call) => call.function?.name === "compile" || call.function?.name === "task_compile")
        .map((call) => call.id)
        .filter((id): id is string => typeof id === "string")
      : [],
  ));
  const message = [...messages].reverse().find((candidate) =>
    candidate.role === "tool"
    && typeof candidate.tool_call_id === "string"
    && compileCallIds.has(candidate.tool_call_id)
    && typeof candidate.content === "string",
  );
  if (!message || typeof message.content !== "string") return null;
  try {
    const value = JSON.parse(message.content) as Record<string, unknown>;
    const excerpt = JSON.stringify(value, null, 2).slice(0, 12_000);
    return { value, excerpt };
  } catch {
    return { value: null, excerpt: message.content.slice(0, 12_000) };
  }
}

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
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/compile.ts').then(m => m.useCompileStore.getState().setAutoCompile(false))`);
    await waitForCompileIdle(page, 90_000);
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
    const completeMarker = `SHARED_PAPER_CHAT_COMPLETE_${projectId}`;
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
    ], completeMarker);
    await openRailTab(page, "Research Assistant");
    await fillTextarea(page, 'textarea[placeholder*="Ask AI"]', "Read source.pdf, correct the validation/test statement, compile, and read the resulting PDF.");
    await page.press('textarea[placeholder*="Ask AI"]', "Enter");
    await waitLong(page, `document.body.innerText.includes(${scriptValue(completeMarker)}) && !document.querySelector('[aria-label="Stop"]')`, 150_000);
    expect(first?.source.offset).toBe(0);
    expect(first?.nextOffset).toBeGreaterThan(0);
    expect(first?.text).toContain("VALIDATION_SOURCE_FIRST");
    const requests = server.requestBodies().map((body) => JSON.parse(body) as Record<string, unknown>);
    const final = requests.at(-1)!;
    const toolResultByName = (request: Record<string, unknown>, name: string) => {
      const messages = request.messages as Message[];
      const callIds = new Set(messages.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.tool_calls)
          ? message.tool_calls.filter((call) => call.function?.name === name).map((call) => call.id).filter((id): id is string => typeof id === "string")
          : [],
      ));
      const message = [...messages].reverse().find((candidate) => candidate.role === "tool" && typeof candidate.tool_call_id === "string" && callIds.has(candidate.tool_call_id) && typeof candidate.content === "string");
      return message && typeof message.content === "string" ? JSON.parse(message.content) as Record<string, unknown> : null;
    };
    const windows = (final.messages as Message[]).filter((message) => message.role === "tool" && typeof message.content === "string")
      .map((message) => JSON.parse(message.content as string) as Partial<PaperText> & { text?: string; success?: boolean });
    expect(windows.some((value) => value.text?.includes("HELDOUT_SOURCE_SECOND"))).toBe(true);
    expect(toolResultByName(final, "compile")).toMatchObject({ success: true, has_pdf: true });
    const pdfText = toolResultByName(final, "get_pdf_text");
    expect(pdfText, "The final provider request must contain the exact get_pdf_text result.").not.toBeNull();
    expect(pdfText).not.toHaveProperty("error");
    expect(pdfText).toHaveProperty("numPages");
    expect(pdfText?.text).toContain("test data stay held out");
    const native = await page.evaluate<{ source: string; pdf: string; files: string[] }>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => ({ source: await api.readFileContent(${scriptValue(projectId)}, 'main.tex'), pdf: btoa(String.fromCharCode(...new Uint8Array(await api.readProjectBytes(${scriptValue(projectId)}, 'source.pdf')))), files: (await api.listFiles(${scriptValue(projectId)})).map(f => f.path) }))`);
    expect(native.source).toBe(REVISED);
    expect(native.pdf).toBe(pdf);
    expect(native.files.some((path) => path.startsWith("sources/") || path.includes("papers/file_"))).toBe(false);
    expect(first?.pdfReference.projectId).toBe(projectId);
    await waitLong(page, `!!document.querySelector('[data-pdf-scroll-root] canvas')`, 30_000);
    const manuscriptText = () => page.evaluate<string>(`window.__oleaflyE2EImport('/src/components/pdf/pdfController.ts').then(async m => (await m.pdfPageText(1))?.map(run => run.str).join(' ') ?? '')`);
    expect(await manuscriptText()).toContain("test data stay held out");
    const reference = first!.pdfReference;
    expect(await page.evaluate<boolean>(`(() => {
      const card = document.querySelector('[data-tool-name="read_paper"]');
      const header = card?.querySelector('button[aria-expanded]');
      if (!header) return false;
      if (header.getAttribute("aria-expanded") === "false") header.click();
      return true;
    })()`)).toBe(true);
    await waitLong(page, `!![...document.querySelectorAll('[data-tool-name="read_paper"] button')].find(button => button.textContent.trim() === 'Open retained PDF')`, 10_000);
    expect(await page.evaluate<boolean>(`(() => {
      const card = document.querySelector('[data-tool-name="read_paper"]');
      const button = [...(card?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Open retained PDF');
      button?.click();
      return !!button;
    })()`)).toBe(true);
    const viewer = page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 30_000 });
    await expect(viewer).toContainText(reference.path.split("/").at(-1)!);
    await expect.poll(() => page.evaluate<{ kind: string; revision: string; documentId: string } | null>(
      `window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m => {
        const request = m.useMaterialViewerStore.getState().request;
        return request ? { kind: request.kind, revision: request.revision, documentId: request.documentId } : null;
      })`,
    )).toEqual({ kind: "pdf", revision: reference.pdfSha256, documentId: `paper:${reference.path}` });
    await expect.poll(() => page.evaluate<boolean>(`(() => {
      const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
      return !!viewer
        && !!viewer.querySelector('[data-pdf-scroll-root] canvas[width][height]')
        && !viewer.closest('[role="dialog"], [role="alertdialog"]');
    })()`), { timeout: 45_000 }).toBe(true);
    await waitLong(page, `!![...document.querySelectorAll('[data-testid="workspace-material-surface"] .textLayer span')].find(node => node.textContent.includes('VALIDATION_SOURCE_FIRST'))`, 30_000);
    await webviewScreenshot(page, testInfo.outputPath("retained-paper-material-viewer.png"));
    await viewer.getByRole("button", { name: "Close material", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    expect(await manuscriptText()).toContain("test data stay held out");
    const mismatch = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/research-literature.ts').then(async m => { try { await m.readRetainedPaperPdf(${scriptValue({ ...first!.pdfReference, pdfSha256: "0".repeat(64) })}); return 'unexpected success'; } catch (error) { return String(error); } })`);
    expect(mismatch).toContain("no longer matches");
  } finally { await server.close(); }
});

test("single task and task group share the paper reader and retain compiled results without applying to the author project", async ({ tauriPage: page }, testInfo) => {
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
          const artifact = compileToolResult(request)?.value?.artifact as TaskCompiledArtifact | undefined;
          return artifact ? { reference: artifact } : { error: COMPILE_ARTIFACT_MISSING };
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
      const taskRequests = server.requestBodies().map(body => JSON.parse(body) as Record<string, unknown>);
      const compile = taskRequests
        .map((request) => compileToolResult(request))
        .filter((result): result is CompileToolResult => result !== null)
        .at(-1);
      if (compile) {
        await testInfo.attach(`shared-paper-compile-result-${group ? "group" : "single"}`, {
          body: compile.excerpt,
          contentType: "text/plain",
        });
      }
      expect(settled.status, [settled.error ?? "task status", compile?.excerpt].filter(Boolean).join("\n\n")).toBe("awaiting_review");
      const artifact = compile?.value?.artifact as TaskCompiledArtifact | undefined;
      expect(artifact?.taskId, `Compile tool result did not expose a task artifact.\n\n${compile?.excerpt ?? "No matching compile tool response."}`).toBe(task.id);
      references.push(artifact!);
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

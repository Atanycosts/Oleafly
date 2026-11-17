import type { ResearchTask, TaskCompiledArtifact } from "../../src/lib/research-tasks";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

type Message = { role: string; content: unknown; tool_call_id?: string };
type CompileFailure = {
  error: string;
  compileToolCallId: string | null;
  compileToolResponse: unknown;
};

function compileReference(request: Record<string, unknown>): TaskCompiledArtifact | undefined {
  for (const message of request.messages as Message[]) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const result = JSON.parse(message.content) as { artifact?: TaskCompiledArtifact };
      if (result.artifact) return result.artifact;
    } catch {
      // A failed compile can return plain text; compileFailure() preserves it.
    }
  }
  return undefined;
}

function compileFailure(request: Record<string, unknown>): CompileFailure {
  const toolMessages = (request.messages as Message[]).filter(message => message.role === "tool" && typeof message.content === "string");
  const compileMessage = toolMessages[2];
  let response: unknown = compileMessage?.content ?? null;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      // Preserve a non-JSON compile response verbatim in the diagnostic.
    }
  }
  return {
    error: "The native compile tool returned no retained PDF reference.",
    compileToolCallId: compileMessage?.tool_call_id ?? null,
    compileToolResponse: response,
  };
}

// Scripted model sequencing verifies application delivery, not visual reasoning quality.
test("native task retains read source through edits and delivers compiled PDF pages", async ({ tauriPage: page }, testInfo) => {
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  let usedReference: TaskCompiledArtifact | undefined;
  let compileDiagnostic: CompileFailure | undefined;
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Task page images ${Date.now()}`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llava") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const original = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'main.tex'))`);
    const archivedSource = original.replace("\\end{document}", "\\par ARCHIVED_SOURCE_SENTINEL\n\\end{document}");
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.writeFileContent(${scriptValue(projectId)}, 'main.tex', ${scriptValue(archivedSource)}))`);
    const revised = archivedSource.replace("ARCHIVED_SOURCE_SENTINEL", "RetainedPageImageEvidence");
    server.setToolSequence([
      { name: "read_file", args: { path: "main.tex" } },
      { name: "write_file", args: { path: "main.tex", content: revised } },
      { name: "compile", args: {} },
      { name: "discover_tools", args: { query: "task_pdf_pages" } },
      { name: "task_pdf_pages", args: (request) => {
        usedReference = compileReference(request);
        if (!usedReference) {
          compileDiagnostic = compileFailure(request);
          return { reference: null, pages: [1], scale: 1 };
        }
        return { reference: usedReference, pages: [1], scale: 1 };
      } },
    ], "The retained page image was received; capture alone is not a visual review.");
    const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => { const task = await m.createResearchTask(${scriptValue({ projectId, title: "Retained PDF image delivery", prompt: "Revise and compile this task copy, then request its retained first PDF page image.", runtimeId: "builtin", agentId: "ollama", modelId: "llava", skillIds: [], dependencyIds: [] })}); return m.startResearchTask(task.id); })`);
    await expect.poll(async () => {
      const current = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
      return compileDiagnostic ? JSON.stringify(compileDiagnostic, null, 2) : current.status;
    }, { timeout: 180_000, intervals: [500] }).toBe("awaiting_review");
    expect(usedReference?.taskId).toBe(task.id);
    const requests = server.requestBodies().map(body => JSON.parse(body) as { messages: Message[] });
    const nextRequest = requests.find(request => request.messages.some(message => message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "image_url")));
    expect(nextRequest).toBeDefined();
    const image = nextRequest!.messages.filter(message => message.role === "user").flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === "image_url");
    expect(image.image_url.url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(image.image_url.url.length).toBeGreaterThan(1000);
    const pageCall = nextRequest!.messages.find(message => message.role === "tool" && typeof message.content === "string" && message.content.includes('"pages":[1]'));
    expect(pageCall).toBeDefined();
    expect(JSON.parse(pageCall!.content as string).artifact).toEqual(usedReference);
    expect(await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'main.tex'))`)).toBe(archivedSource);

    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m => { await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)}); m.useResearchTasksStore.getState().receiveTask(${scriptValue(task)}); m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, 'activity'); })`);
    const detail = page.locator('[data-testid="research-task-detail"]');
    await expect(detail).toBeVisible();
    await detail.getByText("Observation records and source locators").click();
    await detail.getByText("Read recorded source range", { exact: true }).click();
    const retainedSource = detail.locator('[data-testid="task-observations"] ol pre');
    await expect(retainedSource).toContainText("\\par ARCHIVED_SOURCE_SENTINEL");
    await expect(retainedSource).not.toContainText("\\par RetainedPageImageEvidence");
  } finally {
    if (compileDiagnostic) {
      await testInfo.attach("119-task-compile-failure", {
        body: JSON.stringify(compileDiagnostic, null, 2),
        contentType: "application/json",
      });
    }
    await server.close();
  }
});

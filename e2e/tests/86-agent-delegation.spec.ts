import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchTask, TaskCompiledArtifact } from "../../src/lib/research-tasks";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("native system flow retains a delegated task PDF before apply", async ({ tauriPage: page }) => {
  test.setTimeout(540_000);
  const server = await startMockAiServer();
  try {
    await createBlankProject(page, `A0 native PDF ${Date.now()}`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const original = await page.evaluate<string>(`window.__e2eImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'main.tex'))`);
    const buffer = original.replace("\\end{document}", "\\par DelegatedBufferAlpha\n\\end{document}");
    const revised = buffer.replace("DelegatedBufferAlpha", "TaskCompiledBravo");
    const selection = { from: buffer.indexOf("DelegatedBufferAlpha"), to: buffer.indexOf("DelegatedBufferAlpha") + "DelegatedBufferAlpha".length, text: "DelegatedBufferAlpha" };
    const delegation = { projectId, mainDocument: "main.tex", path: "main.tex", selection, sourceContent: buffer, sourceSha256: sha(buffer), diskSha256: sha(original.replace(/\r\n?/g, "\n")), editorDocVersion: 7, runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2" };
    server.setToolSequence([{ name: "write_file", args: { path: "main.tex", content: revised } }, { name: "compile", args: {} }], "Native PDF ready for review");
    const task = await page.evaluate<ResearchTask>(`window.__e2eImport('/src/lib/research-tasks.ts').then(m => m.createDelegatedResearchTask(${scriptValue({ projectId, title: "A0 delegated PDF", prompt: "Revise the delegated selection and compile the task copy.", runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [], dependencyIds: [] })}, ${scriptValue(delegation)}))`);
    await page.evaluate(`window.__e2eImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(task.id)}))`);
    let completed: ResearchTask | undefined;
    await expect.poll(async () => {
      completed = await page.evaluate<ResearchTask>(`window.__e2eImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
      return completed?.status;
    }, { timeout: 240_000, intervals: [1000] }).toBe("awaiting_review");
    expect(readFileSync(join(completed!.isolation!.executionRoot, "main.tex"), "utf8")).toBe(revised);
    const captured = JSON.parse(readFileSync(join(completed!.isolation!.executionRoot, completed!.recordDir, "delegation.json"), "utf8"));
    expect(captured.sourceContent).toBe(buffer);
    expect(captured.selection).toEqual(selection);
    expect(captured.diskSha256).toBe(delegation.diskSha256);
    const artifacts = await page.evaluate<TaskCompiledArtifact[]>(`window.__e2eImport('/src/lib/research-tasks.ts').then(m => m.listTaskCompiledPdfs(${scriptValue(task.id)}, ${completed!.executionGeneration}))`);
    expect(artifacts.length).toBeGreaterThan(0);
    const reference = artifacts[0];
    const facts = await page.evaluate<{ text: string; png: boolean }>(`(async () => { const m = await window.__e2eImport('/src/lib/research-tasks.ts'); const bytes = new Uint8Array(await m.readTaskCompiledPdf(${scriptValue(task.id)}, ${completed!.executionGeneration}, ${scriptValue(reference)})); const text = await (await window.__e2eImport('/src/lib/pdf-text.ts')).extractPdfText(bytes); const png = await (await window.__e2eImport('/src/lib/pdf-image.ts')).pdfPageToPng(bytes); return {text: text.pages.join('\\n'), png: png.startsWith('data:image/png')}; })()`);
    expect(facts.text).toContain("TaskCompiledBravo");
    expect(facts.png).toBe(true);
    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__e2eImport('/src/store/research-tasks.ts').then(async m => { await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)}); m.useResearchTasksStore.getState().receiveTask(${scriptValue(completed)}); m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, 'output'); })`);
    await expect(page.locator('section[aria-label="Task compiled PDFs"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('section[aria-label="Task compiled PDFs"] button').first().click();
    await expect(page.locator('section[aria-label="Task compiled PDFs"] .pdf-canvas')).toBeVisible({ timeout: 45_000 });
    expect(await page.evaluate(`window.__e2eImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'main.tex'))`)).toBe(original);
    const toolResults = server.requestBodies().flatMap(body => (JSON.parse(body).messages ?? []).filter((message: {role?: string}) => message.role === "tool"));
    expect(toolResults.some((message: {content?: unknown}) => JSON.stringify(message.content).includes("pdfSha256"))).toBe(true);
    await page.locator('[data-testid="research-task-detail"]').press("Escape");
    await page.click('[title="Back to library"]');
    await createBlankProject(page, `A0 unrelated ${Date.now()}`);
    const retained = await page.evaluate<{text: string; hash: string}>(`(async () => { const m = await window.__e2eImport('/src/lib/research-tasks.ts'); const bytes = new Uint8Array(await m.readTaskCompiledPdf(${scriptValue(task.id)}, ${completed!.executionGeneration}, ${scriptValue(reference)})); const text = await (await window.__e2eImport('/src/lib/pdf-text.ts')).extractPdfText(bytes); const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join(''); return {text: text.pages.join('\\n'), hash}; })()`);
    expect(retained.text).toContain("TaskCompiledBravo");
    expect(retained.hash).toBe(reference.pdfSha256);
    const rerunContent = revised.replace("TaskCompiledBravo", "TaskCompiledCharlie");
    server.setToolSequence([{ name: "write_file", args: { path: "main.tex", content: rerunContent } }, { name: "compile", args: {} }], "Second compiled result");
    const second = await page.evaluate<ResearchTask>(`window.__e2eImport('/src/lib/research-tasks.ts').then(m => m.createDelegatedResearchTask(${scriptValue({ projectId, title: "A0 subsequent PDF", prompt: "Revise and compile the task copy.", runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [], dependencyIds: [] })}, ${scriptValue(delegation)}))`);
    await page.evaluate(`window.__e2eImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(second.id)}))`);
    await expect.poll(async () => {
      const current = await page.evaluate<ResearchTask>(`window.__e2eImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(second.id)}))`);
      return current.status;
    }, { timeout: 240_000, intervals: [1000] }).toBe("awaiting_review");
    const oldText = await page.evaluate<string>(`(async () => { const m = await window.__e2eImport('/src/lib/research-tasks.ts'); const bytes = new Uint8Array(await m.readTaskCompiledPdf(${scriptValue(task.id)}, ${completed!.executionGeneration}, ${scriptValue(reference)})); return (await (await window.__e2eImport('/src/lib/pdf-text.ts')).extractPdfText(bytes)).pages.join('\\n'); })()`);
    expect(oldText).toContain("TaskCompiledBravo");
    expect(oldText).not.toContain("TaskCompiledCharlie");
    expect(await page.evaluate(`window.__e2eImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'main.tex'))`)).toBe(original);
  } finally { await server.close(); }
});

test("the native editor selection menu delegates its captured target", async ({ tauriPage: page }) => {
  const { selectWord } = await import("../helpers");
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `A0 selection menu ${Date.now()}`);
    await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2")`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    server.setReply("Selection retained for review");
    await selectWord(page, "Write");
    await page.getByText("Ask AI", { exact: true }).click();
    await page.fill('[aria-label="Describe the change…"]', "Review this frozen selection");
    await page.getByText("Delegate task", { exact: true }).click();
    let task: ResearchTask | undefined;
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask>(`window.__e2eImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.title.includes('Review this frozen selection')))`);
      return task?.status;
    }, { timeout: 60_000, intervals: [1000] }).toBe("awaiting_review");
    const captured = JSON.parse(readFileSync(join(task!.isolation!.executionRoot, task!.recordDir, "delegation.json"), "utf8"));
    expect(captured.projectId).toBe(projectId);
    expect(captured.path).toBe("main.tex");
    expect(captured.selection.text).toBe("Write");
    expect(captured.sourceSha256).toBe(sha(captured.sourceContent));
  } finally { await server.close(); }
});

import type { ResearchTask } from "../../src/lib/research-tasks";
import type { AnnotationContext, GroupSnapshot } from "../../src/lib/task-collaboration";
import { test, expect } from "../fixtures";
import { createBlankProject, fillTextarea, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

// Scripted model output verifies native application delivery and persistence, not model reasoning.
test("native annotations retain feedback and deliver an explicit historical follow-up", async ({ tauriPage: page }) => {
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `A1 annotations ${Date.now()}`);
    await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2")`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    server.setReply("Scripted original task response");
    const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => { const task = await m.createResearchTask(${scriptValue({ projectId, title: "A1 retained feedback", prompt: "Return one brief response without modifying files.", runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [], dependencyIds: [] })}); return m.startResearchTask(task.id); })`);
    let finished: ResearchTask = task;
    await expect.poll(async () => {
      finished = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
      return finished.status;
    }, { timeout: 90_000, intervals: [500] }).toBe("awaiting_review");
    const generation = finished.executionGeneration;
    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m => { await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)}); m.useResearchTasksStore.getState().receiveTask(${scriptValue(finished)}); m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, 'annotations'); })`);
    const panel = page.locator('[data-testid="task-annotations"]');
    await expect(panel).toBeVisible();
    const feedback = "Keep this original wording as feedback only: α claim stays provisional.";
    await fillTextarea(page, '[data-testid="task-annotations"] textarea', feedback);
    await panel.getByRole("button", { name: "Save annotation", exact: true }).click();
    const feedbackRow = panel.locator('[data-testid="task-annotation"]').filter({ hasText: feedback });
    await expect(feedbackRow).toContainText("Feedback");
    const stored = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskAnnotations(${scriptValue(projectId)}, ${scriptValue(task.id)}))`);
    const saved = stored.annotations.find(annotation => annotation.body === feedback);
    expect(saved?.explicitRequest).toBe(false);
    expect(stored.deliveries.some(delivery => delivery.annotationId === saved?.id)).toBe(false);
    expect(await page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}).executionGeneration)`)).toBe(generation);
    server.setReply("Scripted follow-up delivery acknowledged");
    await feedbackRow.getByRole("button", { name: "Reply", exact: true }).click();
    const followUp = "Revisit that original generation and check the provisional claim.";
    await fillTextarea(page, '[data-testid="task-annotations"] textarea', followUp);
    await panel.getByRole("checkbox", { name: "Request follow-up handling" }).check();
    await panel.getByRole("button", { name: "Save annotation", exact: true }).click();
    let receipts: AnnotationContext = stored;
    await expect.poll(async () => {
      receipts = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskAnnotations(${scriptValue(projectId)}, ${scriptValue(task.id)}))`);
      const request = receipts.annotations.find(annotation => annotation.body === followUp);
      return receipts.deliveries.find(delivery => delivery.annotationId === request?.id)?.deliveredGeneration ?? 0;
    }, { timeout: 90_000, intervals: [500] }).toBeGreaterThan(generation);
    const request = receipts.annotations.find(annotation => annotation.body === followUp);
    expect(request?.parentId).toBe(saved?.id);
    expect(request?.target.objectRevision).toBe(`generation:${generation}`);
    expect(await page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}).executionGeneration)`)).toBeGreaterThan(generation);
    await panel.getByRole("button", { name: "Refresh annotations" }).click();
    await expect(panel.locator('[data-testid="task-annotation"]').filter({ hasText: followUp })).toContainText("Delivered to generation");
  } finally { await server.close(); }
});

test("native task group routes addressed work into member execution and a reply", async ({ tauriPage: page }) => {
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[data-testid="research-task-detail"]')`)) await page.locator('[data-testid="research-task-detail"]').press("Escape");
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `A1 group ${Date.now()}`);
    await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2")`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.createResearchTask(${scriptValue({ projectId, title: "A1 member delivery", prompt: "Coordinate a bounded review.", runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [], dependencyIds: [] })}))`);
    const members = [ { name: "Coordinator", responsibility: "Coordinate review", coordinator: true }, { name: "Reviewer", responsibility: "Check requested evidence", coordinator: false } ].map(member => ({ ...member, runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [] }));
    const group = await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.createTaskGroup(${scriptValue(projectId)}, ${scriptValue(task.id)}, ${scriptValue(members)}))`);
    const reviewer = group.members.find(member => member.name === "Reviewer");
    if (!reviewer) throw new Error("Native group did not retain its reviewer");
    server.setReply("Scripted member review returned");
    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m => { await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)}); m.useResearchTasksStore.getState().receiveTask(${scriptValue(task)}); m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, 'group'); })`);
    const panel = page.locator('section[aria-label="Task group"]');
    await expect(panel).toBeVisible();
    await panel.getByRole("checkbox", { name: "@Reviewer", exact: true }).check();
    await fillTextarea(page, 'section[aria-label="Task group"] textarea[aria-label="Message"]', "Review this bounded claim and return your finding.");
    await panel.getByRole("checkbox", { name: "Request work", exact: true }).check();
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    let result: GroupSnapshot = group;
    await expect.poll(async () => {
      result = await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskGroup(${scriptValue(projectId)}, ${scriptValue(task.id)}))`);
      return result.work.some(work => work.memberId === reviewer.id && work.status === "completed" && work.resultMessageId !== null);
    }, { timeout: 90_000, intervals: [500] }).toBe(true);
    const work = result.work.find(item => item.memberId === reviewer.id && item.status === "completed" && item.resultMessageId);
    if (!work) throw new Error("Native member work has no returned message");
    expect(result.executions.some(execution => execution.id === work.executionId && execution.memberId === reviewer.id && execution.modelId === "llama3.2")).toBe(true);
    expect(result.messages.find(message => message.id === work.resultMessageId)?.author.id).toBe(reviewer.id);
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(panel.locator(`[id="group-message-${work.resultMessageId}"]`)).toContainText("Scripted member review returned");
    await expect(panel.locator(`a[href="#group-message-${work.resultMessageId}"]`)).toBeVisible();
    expect(server.requestBodies().length).toBeGreaterThan(0);
  } finally { await server.close(); }
});

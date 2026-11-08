import type { AnnotationContext, AnnotationTarget } from "../../src/lib/task-collaboration";
import { test, expect } from "../fixtures";
import { createBlankProject, fillTextarea, openRailTab, waitLong } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

// Scripted replies verify native chat feedback delivery, not model reasoning quality.
test("ordinary chat retains message feedback and sends only explicit follow-up requests", async ({ tauriPage: page }) => {
  test.setTimeout(180_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) await page.press("body", "Escape");
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Chat annotations ${Date.now()}`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    await openRailTab(page, "Research Assistant");
    server.setReply("ANNOTATION ORIGINAL ASSISTANT MARKER");
    await fillTextarea(page, 'textarea[placeholder*="Ask AI"]', "Reply with one short marker for annotation.");
    await page.press('textarea[placeholder*="Ask AI"]', "Enter");
    await waitLong(page, `document.body.innerText.includes('ANNOTATION ORIGINAL ASSISTANT MARKER') && !document.querySelector('[aria-label="Stop"]')`, 60_000);
    await page.getByText("Annotate", { exact: true }).last().click();
    const panel = page.locator('[data-testid="task-annotations"]');
    await expect(panel).toBeVisible();
    const baseline = server.requestCount();
    const feedback = "Feedback only: preserve this cautious wording unchanged.";
    await fillTextarea(page, '[data-testid="task-annotations"] textarea', feedback);
    await panel.getByRole("button", { name: "Save annotation", exact: true }).click();
    await expect(panel.locator('[data-testid="task-annotation"]').filter({ hasText: feedback })).toBeVisible();
    expect(server.requestCount()).toBe(baseline);
    const threadId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/chats.ts').then(m => { const s=m.useChatsStore.getState(); return s.chats.find(c=>c.id===s.activeId)?.threadId ?? ''; })`);
    expect(threadId).not.toBe("");
    const target: AnnotationTarget = { projectId, taskId: null, objectKind: "thread", objectId: threadId, objectRevision: null, path: null };
    const stored = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadObjectAnnotations(${scriptValue(target)}))`);
    const originalAnnotation = stored.annotations.find(annotation => annotation.body === feedback);
    expect(originalAnnotation?.target.objectId).toBe(threadId);
    expect(originalAnnotation?.target.objectRevision).toMatch(/^(message:|turn:)/);
    expect(originalAnnotation?.explicitRequest).toBe(false);
    const request = "Explicit follow-up: reconsider the retained original assistant wording and report the limitation.";
    server.setReply("ANNOTATION FOLLOWUP RECEIVED");
    await fillTextarea(page, '[data-testid="task-annotations"] textarea', request);
    await panel.getByRole("checkbox", { name: "Request follow-up handling", exact: true }).check();
    await panel.getByRole("button", { name: "Save annotation", exact: true }).click();
    await expect.poll(() => server.requestCount(), { timeout: 60_000 }).toBeGreaterThan(baseline);
    const nextRequests = server.requestBodies().slice(baseline).map(body => JSON.parse(body) as { messages: unknown[] });
    expect(nextRequests.some(body => JSON.stringify(body.messages).includes(request) && JSON.stringify(body.messages).includes(threadId))).toBe(true);
    const history = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadObjectAnnotations(${scriptValue(target)}))`);
    const explicit = history.annotations.find(annotation => annotation.body === request);
    expect(explicit?.explicitRequest).toBe(true);
    expect(explicit?.target).toEqual(originalAnnotation?.target);
    expect(history.annotations.some(annotation => annotation.id === originalAnnotation?.id && annotation.body === feedback)).toBe(true);
  } finally { await server.close(); }
});

import type { ResearchTask } from "../../src/lib/research-tasks";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

type Message = { role?: string; content?: unknown };

// Scripted calls exercise the packaged helper path, not model reasoning quality.
test("packaged task retains helper source and includes its reported usage", async ({ tauriPage: page }) => {
  test.setTimeout(180_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Helper source ${Date.now()}`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const source = "\\documentclass{article}\n\\begin{document}\nHELPER_SOURCE_SENTINEL\n\\end{document}\n";
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.writeFileContent(${scriptValue(projectId)}, 'main.tex', ${scriptValue(source)}))`);

    server.setResponder((request) => {
      const messages = request.messages as Message[];
      const system = messages.find((message) => message.role === "system" || message.role === "developer")?.content;
      const helper = typeof system === "string" && system.startsWith("You help a research task with one job.");
      const receivedToolResult = messages.some((message) => message.role === "tool");
      if (helper) {
        return receivedToolResult ? "Read the requested manuscript source." : { name: "read_file", args: { path: "main.tex" } };
      }
      return receivedToolResult ? "The helper read the manuscript and its source was retained." : {
        name: "spawn_agent",
        args: { brief: "Read main.tex and return its source marker.", paths: ["main.tex"] },
      };
    });

    const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => { const task = await m.createResearchTask(${scriptValue({ projectId, title: "Retain helper source", prompt: "Ask a helper to read main.tex, then finish the source review.", runtimeId: "builtin", agentId: "ollama", modelId: "llama3.2", skillIds: [], dependencyIds: [] })}); return m.startResearchTask(task.id); })`);
    let completed: ResearchTask = task;
    await expect.poll(async () => {
      completed = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(item => item.id === ${scriptValue(task.id)}))`);
      return completed.status;
    }, { timeout: 90_000, intervals: [500] }).toBe("awaiting_review");
    expect(completed.result?.inputTokens).toBeGreaterThan(0);
    expect(completed.result?.outputTokens).toBeGreaterThan(0);

    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m => { await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)}); m.useResearchTasksStore.getState().receiveTask(${scriptValue(completed)}); m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, 'activity'); })`);
    const detail = page.locator('[data-testid="research-task-detail"]');
    await expect(detail).toBeVisible();
    await detail.getByText("Observation records and source locators").click();
    await page.evaluate(`(() => {
      const records = [...document.querySelectorAll('[data-testid="task-observations"] ol li')]
        .filter(row => [...row.querySelectorAll('code')].some(code => code.textContent === 'read_file')
          && row.textContent.includes(':helper-1:')
          && row.textContent.includes('main.tex'));
      if (records.length !== 1) throw new Error('Expected exactly one helper read source row, got ' + records.length);
      records[0].setAttribute('data-e2e-helper-source', 'true');
    })()`);
    const helperRecord = detail.locator('[data-e2e-helper-source="true"]');
    // Helpers share the task execution; their call namespace identifies the
    // helper read while the execution label may name the parent session.
    await expect(helperRecord.locator("p").filter({ hasText: "Execution:" })).toContainText(completed.sessionId!);
    await expect(helperRecord).toContainText("main.tex");
    await helperRecord.getByText("Read recorded source range", { exact: true }).click();
    await expect(helperRecord.locator("pre")).toContainText("HELPER_SOURCE_SENTINEL");
    await expect(helperRecord.getByText("The exact file version from this read is retained.")).toBeVisible();
  } finally { await server.close(); }
});

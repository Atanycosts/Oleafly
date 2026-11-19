import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { GroupEvent, GroupMessage, GroupSnapshot, GroupWork, MemberExecution } from "../../src/lib/task-collaboration";
import { test, expect } from "../fixtures";
import type { Page } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const stage = process.env.OLEAFLY_CHECKPOINT_STAGE;
const run = process.env.OLEAFLY_CHECKPOINT_RUN;
const PROVIDER = "checkpoint-recovery-fixture";
const MODEL = "gpt/gpt-6.1-sol";
const SOURCE = "Window 64: 92 percent. Window 128: 91 percent. These are validation observations; no test result or replicate uncertainty is supplied.\n";
const SOURCE_HASH = createHash("sha256").update(SOURCE).digest("hex");
const REVIEW = "Read protocol.md: 128 loses one percentage point on validation; test performance and statistical significance are unverified.";
const INTEGRATED = "Read the colleague result and protocol.md. Retained the one-point validation decrease and the unverified test/significance limits.";

type Turn = {
  member: { id: string; name: string };
  execution: MemberExecution;
  work: GroupWork[];
  messages: GroupMessage[];
  events: GroupEvent[];
};
type Message = { role: string; content: string };
type State = { projectId: string; task: ResearchTask; group: GroupSnapshot; source: string };
type Scenario = { kind: "preexisting" | "frozen"; state: State; omittedId: string; ownerId: string };

function turnFrom(request: Record<string, unknown>): Turn {
  const system = (request.messages as Message[]).filter(message => message.role === "system").map(message => message.content).join("\n");
  const start = system.lastIndexOf("Your current claimed work and source messages, events and annotations.");
  if (start < 0) throw new Error("No current native member context.");
  return JSON.parse(system.slice(system.indexOf("\n{", start) + 1).split("\n")[0]) as Turn;
}

async function api<T>(page: Page, body: string): Promise<T> {
  return page.evaluate<T>(`(async () => {
    const api = await window.__oleaflyE2EImport('/src/lib/tauri.ts');
    const tasks = await window.__oleaflyE2EImport('/src/lib/research-tasks.ts');
    const groups = await window.__oleaflyE2EImport('/src/lib/task-collaboration.ts');
    ${body}
  })()`);
}

async function state(page: Page, projectId: string, taskId: string): Promise<State> {
  return api(page, `return { projectId: ${scriptValue(projectId)}, task: (await tasks.listResearchTasks(${scriptValue(projectId)})).find(task => task.id === ${scriptValue(taskId)}), group: await groups.loadTaskGroup(${scriptValue(projectId)}, ${scriptValue(taskId)}), source: await api.readFileContent(${scriptValue(projectId)}, 'protocol.md') };`);
}

async function settled(page: Page, projectId: string, taskId: string, expected: ResearchTask["status"], executions: number): Promise<State> {
  let current: State;
  await expect.poll(async () => {
    current = await state(page, projectId, taskId);
    if (current.task.status === "failed") throw new Error(current.task.error ?? "Native task failed.");
    return current.task.status === expected && !current.task.startRequested
      && current.group.executions.length === executions
      && current.group.executions.every(execution => execution.status !== "running");
  }, { timeout: 90_000, intervals: [250, 500] }).toBe(true);
  return current!;
}

async function openGroup(page: Page, current: State) {
  await api(page, `
    const files = await window.__oleaflyE2EImport('/src/store/files.ts');
    await files.useFilesStore.getState().openProject(${scriptValue(current.projectId)});
    const settings = await window.__oleaflyE2EImport('/src/store/settings.ts');
    settings.useSettingsStore.getState().setShowTree(true);
    settings.useSettingsStore.getState().setRailTab('research');
  `);
  await expect(page.getByTestId("research-workspace-panel")).toBeVisible({ timeout: 20_000 });
  await api(page, `
    const store = await window.__oleaflyE2EImport('/src/store/research-tasks.ts');
    await store.useResearchTasksStore.getState().bindProject(${scriptValue(current.projectId)});
    store.useResearchTasksStore.getState().receiveTask(${scriptValue(current.task)});
    await store.useResearchTasksStore.getState().selectTask(${scriptValue(current.task.id)});
    store.useResearchTasksStore.getState().openTaskDetail(${scriptValue(current.task.id)}, 'group');
  `);
  await expect(page.getByTestId("research-task-detail")).toBeVisible({ timeout: 20_000 });
}

function work(current: State, id: string): GroupWork {
  const found = current.group.work.find(item => item.id === id);
  if (!found) throw new Error(`Missing retained work ${id}.`);
  return found;
}

function checkpoint(current: State): { workIds: string[]; colleagueWorkIds: string[] } {
  const event = current.group.events?.find(item => item.kind === "member_checkpointed");
  if (!event) throw new Error("No native checkpoint was recorded.");
  return event.evidence as { workIds: string[]; colleagueWorkIds: string[] };
}

// Scripted decisions drive real native tools, scheduling, SQLite and UI. No model is called.
test.describe("native task checkpoint recovery", () => {
  test.skip(!stage || !run, "Set OLEAFLY_CHECKPOINT_STAGE and OLEAFLY_CHECKPOINT_RUN; see e2e/README.md.");
  test.setTimeout(300_000);

  test("prepare native checkpoint handoffs with unrelated and required unfinished work", async ({ tauriPage: page }, testInfo) => {
    test.skip(stage !== "prepare");
    const server = await startMockAiServer();
    const steps = new Map<string, number>();
    server.setResponder(request => {
      if (JSON.stringify(request.messages).includes("Assess responsibility-based participation")) return '{"decisions":[]}';
      const turn = turnFrom(request);
      const step = steps.get(turn.execution.id) ?? 0;
      steps.set(turn.execution.id, step + 1);
      if (turn.member.name === "Explorer" || (turn.member.name === "Methods" && turn.work.some(item => turn.messages.find(message => message.id === item.causeId)?.body === "Leave this required check unreported"))) {
        if (step === 0) return { name: "read_file", args: { path: "protocol.md" } };
        if (step === 1) {
          const handled = turn.work.find(item => turn.messages.find(message => message.id === item.causeId)?.body === "Report this check");
          if (!handled) throw new Error("The partial reviewer did not receive its two work items.");
          return { name: "group_work_settle", args: { workIds: [handled.id], status: "completed", summary: REVIEW } };
        }
        return "One check was reported; the other remains unreported.";
      }
      if (turn.member.name === "Methods") {
        if (step === 0) return { name: "read_file", args: { path: "protocol.md" } };
        return { name: "group_work_settle", args: { workIds: turn.work.map(item => item.id), status: "completed", summary: REVIEW } };
      }
      if (!turn.events.some(event => event.kind === "member_checkpoint_resumed")) return { name: "read_file", args: { path: "protocol.md" } };
      if (step === 0) return { name: "group_context", args: {} };
      if (step === 1) return { name: "read_file", args: { path: "protocol.md" } };
      return { name: "group_work_settle", args: { workIds: turn.work.map(item => item.id), status: "completed", summary: INTEGRATED, resultRefs: [{ objectKind: "file", objectId: "protocol.md", path: "protocol.md", objectRevision: SOURCE_HASH }] } };
    });
    const scenarios: Scenario[] = [];
    try {
      await page.evaluate(`window.__researchTasksSet?.(true)`);
      await api(page, `const config = await api.getConfig(); await api.setConfig({ ...config, ai_custom_providers: [...(config.ai_custom_providers ?? []), { id: ${scriptValue(PROVIDER)}, name: 'Scripted checkpoint recovery', baseURL: ${scriptValue(`${server.url}/v1`)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(PROVIDER)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'user' }] } });`);
      for (const kind of ["preexisting", "frozen"] as const) {
        const created = await api<{ projectId: string; task: ResearchTask; group: GroupSnapshot }>(page, `
          const projectId = await api.createProject(${scriptValue(`Checkpoint ${kind}`)});
          await api.writeFileContent(projectId, 'protocol.md', ${scriptValue(SOURCE)});
          const prompt = 'Read protocol.md and report each requested check separately. Keep unresolved work visible; do not apply changes to the original project.';
          const brief = tasks.defaultBrief(prompt);
          brief.permissions = { network: false, commands: 'off', desktopApps: false };
          brief.budget = { wallClockMinutes: 5, usdCap: null, maxRuns: null, runTimeoutMinutes: 1 };
          const task = await tasks.createResearchTask({ projectId, title: ${scriptValue(`Checkpoint ${kind}`)}, prompt, runtimeId: 'builtin', agentId: ${scriptValue(PROVIDER)}, modelId: ${scriptValue(MODEL)}, skillIds: [], dependencyIds: [], brief });
          const group = await groups.createTaskGroup(projectId, task.id, ['Coordinator', 'Methods', 'Explorer'].map(name => ({ name, responsibility: 'Read the retained protocol and handle only the addressed check.', runtimeId: 'builtin', agentId: ${scriptValue(PROVIDER)}, modelId: ${scriptValue(MODEL)}, skillIds: [], coordinator: name === 'Coordinator' })));
          await groups.setTaskGroupStatus(projectId, group.group.id, 'paused');
          return { projectId, task, group };
        `);
        const member = (name: string) => created.group.members.find(item => item.name === name)!.id;
        const send = (body: string, name: string) => api<GroupMessage>(page, `return groups.sendGroupMessage(${scriptValue(created.projectId)}, ${scriptValue(created.group.group.id)}, { body: ${scriptValue(body)}, recipients: [${scriptValue(member(name))}], replyTo: null, object: null, requestWork: true });`);
        const status = (value: string) => api(page, `await groups.setTaskGroupStatus(${scriptValue(created.projectId)}, ${scriptValue(created.group.group.id)}, ${scriptValue(value)});`);
        let omitted: GroupWork | undefined;
        if (kind === "preexisting") {
          await send("Report this check", "Explorer");
          const request = await send("Leave this old check unreported", "Explorer");
          await status("open");
          const parked = await settled(page, created.projectId, created.task.id, "queued", 1);
          omitted = parked.group.work.find(item => item.causeId === request.id)!;
          expect(omitted.status).toBe("waiting");
          expect(omitted.waits).toEqual([]);
          expect(omitted.resultMessageId).toBeNull();
          await status("paused");
        }
        const ownerRequest = await send("Integrate the independent methods check", "Coordinator");
        await send("Report this check", "Methods");
        const omittedRequest = kind === "frozen" ? await send("Leave this required check unreported", "Methods") : null;
        await status("open");
        const current = await settled(page, created.projectId, created.task.id, "queued", kind === "preexisting" ? 4 : 2);
        const owner = current.group.work.find(item => item.causeId === ownerRequest.id)!;
        omitted ??= current.group.work.find(item => item.causeId === omittedRequest!.id)!;
        expect(current.source).toBe(SOURCE);
        expect(current.task.result).toBeNull();
        expect(work(current, omitted.id)).toEqual(omitted);
        const frozen = checkpoint(current);
        expect(frozen.workIds).toContain(owner.id);
        expect(frozen.colleagueWorkIds.includes(omitted.id)).toBe(kind === "frozen");
        expect(owner.status).toBe(kind === "preexisting" ? "completed" : "checkpointed");
        expect(current.group.events?.some(event => event.kind === "member_checkpoint_resumed")).toBe(kind === "preexisting");
        if (kind === "preexisting") {
          expect(owner.resolution?.summary).toBe(INTEGRATED);
          expect(owner.resolution?.resultRefs[0].objectRevision).toBe(SOURCE_HASH);
        }
        await openGroup(page, current);
        await expect(page.getByTestId(`work-${omitted.id}`)).toContainText("Outcome not reported");
        await expect(page.getByTestId(`work-${owner.id}`)).toContainText(kind === "preexisting" ? INTEGRATED : "Waiting to continue");
        await page.screenshot({ path: resolve(run!, `${kind}-before-restart.png`) });
        scenarios.push({ kind, state: current, omittedId: omitted.id, ownerId: owner.id });
        await page.getByTestId("research-task-detail").press("Escape");
      }
      await writeFile(resolve(run!, "prepared.json"), JSON.stringify(scenarios, null, 2));
    } finally {
      await writeFile(testInfo.outputPath("scripted-requests.json"), JSON.stringify(server.requestBodies().map(body => JSON.parse(body)), null, 2));
      await server.close();
    }
  });

  test("resume native retained work only after explicit Start following process restart", async ({ tauriPage: page }, testInfo) => {
    test.skip(stage !== "resume");
    const scenarios = JSON.parse(await readFile(resolve(run!, "prepared.json"), "utf8")) as Scenario[];
    const server = await startMockAiServer();
    const steps = new Map<string, number>();
    server.setResponder(request => {
      if (JSON.stringify(request.messages).includes("Assess responsibility-based participation")) return '{"decisions":[]}';
      const turn = turnFrom(request);
      const step = steps.get(turn.execution.id) ?? 0;
      steps.set(turn.execution.id, step + 1);
      if (step === 0) return { name: "group_context", args: {} };
      if (step === 1) return { name: "read_file", args: { path: "protocol.md" } };
      return { name: "group_work_settle", args: { workIds: turn.work.map(item => item.id), status: "completed", summary: turn.member.name === "Coordinator" ? INTEGRATED : REVIEW } };
    });
    const completed: Scenario[] = [];
    try {
      await page.evaluate(`window.__researchTasksSet?.(true)`);
      for (const scenario of scenarios) {
        const { projectId, task } = scenario.state;
        const recovered = await state(page, projectId, task.id);
        expect(recovered.group).toEqual(scenario.state.group);
        expect(recovered.task.executionGeneration).toBe(task.executionGeneration);
        expect(recovered.task.status).toBe("queued");
        expect(recovered.task.startRequested).toBe(false);
        expect(recovered.task.isolation).toEqual(task.isolation);
        expect(recovered.source).toBe(SOURCE);
        await api(page, `const config = await api.getConfig(); await api.setConfig({ ...config, ai_custom_providers: config.ai_custom_providers.map(provider => provider.id === ${scriptValue(PROVIDER)} ? { ...provider, baseURL: ${scriptValue(`${server.url}/v1`)} } : provider) });`);
        const requestsBeforeStart = server.requestCount();
        await openGroup(page, recovered);
        await expect(page.getByTestId(`work-${scenario.omittedId}`)).toContainText("Outcome not reported");
        expect(server.requestCount()).toBe(requestsBeforeStart);
        await page.getByTestId("research-task-detail").getByText("Start", { exact: true }).click();
        const final = await settled(page, projectId, task.id, "awaiting_review", scenario.state.group.executions.length + (scenario.kind === "preexisting" ? 1 : 2));
        expect(final.task.executionGeneration).toBeGreaterThan(task.executionGeneration);
        expect(final.task.isolation?.executionRoot).toBe(task.isolation?.executionRoot);
        expect(final.group.work.every(item => item.status === "completed")).toBe(true);
        expect(work(final, scenario.ownerId).resolution?.summary).toBe(INTEGRATED);
        expect(final.source).toBe(SOURCE);
        if (scenario.kind === "preexisting") expect(work(final, scenario.ownerId)).toEqual(work(scenario.state, scenario.ownerId));
        else expect(JSON.stringify(final.group.events?.find(event => event.kind === "member_checkpoint_resumed")?.evidence)).toContain(REVIEW);
        await page.locator('section[aria-label="Task group"]').getByText("Refresh", { exact: true }).click();
        await expect(page.getByTestId(`work-${scenario.omittedId}`)).toContainText(REVIEW);
        await page.screenshot({ path: resolve(run!, `${scenario.kind}-after-explicit-start.png`) });
        completed.push({ ...scenario, state: final });
        await page.getByTestId("research-task-detail").press("Escape");
      }
      await writeFile(resolve(run!, "completed.json"), JSON.stringify(completed, null, 2));
    } finally {
      await writeFile(testInfo.outputPath("scripted-requests.json"), JSON.stringify(server.requestBodies().map(body => JSON.parse(body)), null, 2));
      await server.close();
    }
  });

  test("verify native completed handoffs survive another process restart without duplicate execution", async ({ tauriPage: page }) => {
    test.skip(stage !== "verify");
    const scenarios = JSON.parse(await readFile(resolve(run!, "completed.json"), "utf8")) as Scenario[];
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    for (const scenario of scenarios) {
      const current = await state(page, scenario.state.projectId, scenario.state.task.id);
      expect(current.group).toEqual(scenario.state.group);
      expect(current.task.status).toBe("awaiting_review");
      expect(current.task.executionGeneration).toBe(scenario.state.task.executionGeneration);
      expect(current.task.result).toEqual(scenario.state.task.result);
      expect(current.source).toBe(SOURCE);
      await openGroup(page, current);
      await expect(page.getByTestId(`work-${scenario.ownerId}`)).toContainText(INTEGRATED);
      await page.getByTestId("research-task-detail").press("Escape");
    }
    await writeFile(resolve(run!, "verified.json"), JSON.stringify({ scenarios: scenarios.map(item => ({ kind: item.kind, taskId: item.state.task.id, executionCount: item.state.group.executions.length })), persistedGroupsEqual: true, noDuplicateExecutions: true, originalSourcesUnchanged: true, modelDecisions: "scripted" }, null, 2));
  });
});

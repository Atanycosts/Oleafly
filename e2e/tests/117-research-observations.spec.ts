import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchTask, TaskObservationView } from "../../src/lib/research-tasks";
import { expect, reloadNativePage, test } from "../fixtures";
import { openRailTab, type Page } from "../helpers";
import { scriptValue } from "../script-value";

const source = "# Synthetic observation source\n\nGroup A: 6 of 12. Group B: 9 of 12.\n\nThese are synthetic counts, not a real study.\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function observed(page: Page, task: ResearchTask, after = 0, limit = 20) {
  return page.evaluate<TaskObservationView>(`import("/src/lib/research-tasks.ts").then(m => m.loadResearchTaskObservations(${scriptValue(task.id)}, ${task.executionGeneration}, ${after}, ${limit}))`);
}

test("a real provider queries the same retained observations shown in TaskDetail", async ({ tauriPage }) => {
  test.skip(process.env.OLEAFLY_OBSERVATIONS_LIVE !== "1", "Opt in with a separately prepared supplier library; never reads the normal app library.");
  test.setTimeout(900_000);
  const library = process.env.OLEAFLY_DATA_DIR;
  if (!library) throw new Error("The isolated OLEAFLY_DATA_DIR is required");
  const output = process.env.OLEAFLY_OBSERVATIONS_EVIDENCE_DIR ?? join(library, "observation-evidence");
  mkdirSync(output, { recursive: true });
  const resumeIdentity = process.env.OLEAFLY_OBSERVATIONS_RESUME === "1" ? JSON.parse(readFileSync(join(output, "run-identity.json"), "utf8")) as { projectId: string; taskId: string; originalHashes: Record<string, string> } : null;
  const retained = resumeIdentity ? JSON.parse(readFileSync(join(output, "observations.json"), "utf8")) as TaskObservationView & { allEvents: TaskObservationView["page"]["events"] } : null;
  const projectId = resumeIdentity?.projectId ?? await tauriPage.evaluate<string>(`(async () => {
    const { createMarkdownProject } = await import("/src/lib/tauri.ts");
    return createMarkdownProject("Observation smoke " + Date.now());
  })()`);
  const project = join(library, "projects", projectId);
  if (!resumeIdentity) writeFileSync(join(project, "main.md"), source);
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))) });
  const dirtySource = source + "\nOperator's preexisting dirty note.\n";
  if (!resumeIdentity) {
    git("init");
    git("-c", "user.name=Observation fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
    git("-c", "user.name=Observation fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic starting baseline");
    writeFileSync(join(project, "main.md"), dirtySource);
    writeFileSync(join(project, "preexisting.md"), "Preexisting untracked operator note.\n");
  }
  const originalHashes = resumeIdentity?.originalHashes ?? Object.fromEntries(["main.md", "preexisting.md"].map(path => [path, hash(readFileSync(join(project, path), "utf8"))]));
  await tauriPage.evaluate(`import("/src/store/files.ts").then(m => m.useFilesStore.getState().openProject(${scriptValue(projectId)}))`);
  const prompt = `This is a bounded synthetic integration exercise. Read main.md with read_file (offset 0, limit 200), load_skill id observation-fixture successfully, and then call load_skill id disabled-fixture once to record its disabled error. Do not enable it. Call task_observations with limit 5; inspect its actual provider/model and event sequence IDs. Later call it again using its nextSequence as after_sequence, limit 5. Calculate A=6/12 and B=9/12 and their percentage-point difference. Write outputs/observation-report.md with those calculations, source name, actual provider/model and at least one event sequence you obtained from task_observations. Append exactly the line 'Observation smoke verified.' to main.md using write_file, preserving the source and preexisting note. Finish after these tool calls and return a short summary. Use no web, shell, helpers, extra investigations or other files; framework task records may be updated. Only the two project changes main.md and outputs/observation-report.md are requested.`;
  const task = resumeIdentity ? await tauriPage.evaluate<ResearchTask>(`import("/src/lib/research-tasks.ts").then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(resumeIdentity.taskId)}))`) : await tauriPage.evaluate<ResearchTask>(`(async () => {
    const m = await import("/src/lib/research-tasks.ts");
    const brief = m.defaultBrief("Check synthetic source provenance and observation query identity");
    brief.permissions = { network: false, commands: "off", desktopApps: false };
    brief.reasoningEffort = "low";
    brief.budget.wallClockMinutes = 12;
    brief.successCriteria = ["The returned observation IDs match TaskDetail", "The original synthetic project stays unchanged"];
    const task = await m.createResearchTask({ projectId: ${scriptValue(projectId)}, title: "Native observation smoke", prompt: ${scriptValue(prompt)}, runtimeId: "builtin", agentId: "xiaobai", modelId: "gpt-6.1-sol", skillIds: ["observation-fixture"], dependencyIds: [], brief });
    const s = await import("/src/store/research-tasks.ts");
    s.useResearchTasksStore.getState().receiveTask(task);
    s.useResearchTasksStore.getState().openTaskDetail(task.id, "activity");
    await m.startResearchTask(task.id);
    return task;
  })()`);
  writeFileSync(join(output, "run-identity.json"), JSON.stringify({ projectId, taskId: task.id, sourceSha256: hash(dirtySource), originalHashes }, null, 2));
  console.log("Live observation task:", projectId, task.id);
  let finished = task;
  await expect.poll(async () => {
    finished = await tauriPage.evaluate<ResearchTask>(`import("/src/lib/research-tasks.ts").then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
    return finished.status;
  }, { timeout: 780_000, intervals: [1000, 2500, 5000] }).toMatch(/awaiting_review|failed|cancelled/);
  await expect.poll(async () => {
    finished = await tauriPage.evaluate<ResearchTask>(`import("/src/lib/research-tasks.ts").then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
    return finished.phase;
  }, { timeout: 90_000 }).toBeNull();
  writeFileSync(join(output, "task-final.json"), JSON.stringify(finished, null, 2));
  expect(finished.error).toBeNull();
  expect(finished.status).toBe("awaiting_review");
  const view = await observed(tauriPage, finished, 0, 50);
  const records = [...view.page.events];
  let page = view.page;
  while (page.hasMore) {
    page = (await observed(tauriPage, finished, page.nextSequence, 50)).page;
    records.push(...page.events);
  }
  if (retained) {
    expect(records).toEqual(retained.allEvents);
    expect(view.summary.runtime).toEqual(retained.summary.runtime);
    expect(view.summary.usage).toEqual(retained.summary.usage);
  }
  writeFileSync(join(output, "observations.json"), JSON.stringify({ ...view, allEvents: records }, null, 2));
  expect(view.summary.taskId).toBe(task.id);
  expect(view.summary.projectId).toBe(projectId);
  expect(view.summary.baseline?.initialGitStatus).toContain(" M main.md");
  expect(view.summary.baseline?.initialGitStatus).toContain("?? preexisting.md");
  const runtime = view.summary.runtime?.event;
  expect(runtime?.kind).toBe("observation");
  if (runtime?.kind !== "observation" || runtime.observation.type !== "runtime") throw new Error("No runtime snapshot");
  expect(runtime.observation.providerId).toBe("xiaobai");
  expect(runtime.observation.modelId).toBe("gpt-6.1-sol");
  expect(runtime.observation.injectedSkills.map(s => s.id)).toEqual(["observation-fixture"]);
  expect(runtime.observation.tools.some(t => t.name === "task_observations")).toBe(true);
  const executions = records.flatMap(row => row.event.kind === "observation" && row.event.observation.type === "toolExecution" ? [{ row, value: row.event.observation }] : []);
  expect(executions.some(e => e.value.name === "task_observations" && e.value.status === "done")).toBe(true);
  expect(executions.some(e => e.value.skillId === "observation-fixture" && e.value.skillInstructionsSha256 !== null && e.value.status === "done")).toBe(true);
  expect(executions.some(e => e.value.skillId === "disabled-fixture" && e.value.skillInstructionsSha256 === null && e.value.status === "error")).toBe(true);
  const read = executions.find(e => e.value.name === "read_file" && e.value.source?.path === "main.md");
  expect(read?.value.source?.fileSha256).toBe(hash(dirtySource));
  const report = readFileSync(join(finished.isolation!.executionRoot, "outputs/observation-report.md"), "utf8");
  expect(report).toContain("25");
  writeFileSync(join(output, "observation-report.md"), report);
  for (const [path, expected] of Object.entries(originalHashes)) expect(hash(readFileSync(join(project, path), "utf8"))).toBe(expected);
  expect(finished.result?.changedFiles.some(f => f.path === "preexisting.md")).toBe(false);
  await openRailTab(tauriPage, "Research workspace");
  await tauriPage.evaluate(`import("/src/store/research-tasks.ts").then(m => m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)}, "activity"))`);
  const section = tauriPage.getByTestId("task-observations");
  await expect(section).toContainText("xiaobai / gpt-6.1-sol");
  await section.locator("summary").filter({ hasText: "Observation records and source locators" }).click();
  for (let index = 20; index < records.length; index += 20) {
    await section.getByText("Load more observations", { exact: true }).click();
    await expect(section.locator('[role="status"]')).toHaveCount(0);
  }
  for (const execution of executions) await expect(section).toContainText(execution.value.callId);
  await expect(section).toContainText(read!.value.callId);
  await expect(section).toContainText(`#${read!.row.sequence}`);
  await section.getByText("Read recorded source range", { exact: true }).click();
  await expect(section).toContainText("Group A: 6 of 12");
  await tauriPage.screenshot({ path: join(output, "native-observations.png") });
  await reloadNativePage(tauriPage);
  const reopened = await observed(tauriPage, finished, 0, 50);
  expect(reopened.summary.runtime).toEqual(view.summary.runtime);
  expect(reopened.page.events).toEqual(view.page.events);
  writeFileSync(join(output, "verification.json"), JSON.stringify({ realProvider: true, projectId, taskId: task.id, generation: finished.executionGeneration, recordCount: records.length, sourceSequence: read!.row.sequence, sourceSha256: read!.value.source!.fileSha256, originalHashes, retainedRunMatched: retained !== null, reloadedSameEvents: true, usage: view.summary.usage, evidence: view.summary.evidence }, null, 2));
});

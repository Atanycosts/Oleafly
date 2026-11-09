import { invoke } from "@tauri-apps/api/core";
import {
  createResearchTaskTools,
  createResearchTools,
  type ConfirmFn,
  type ResearchTaskToolsHost,
  type ResearchToolsHost,
} from "@oleafly/ai-tools";
import { hasConfiguredProvider, pickActiveProvider } from "@/lib/ai-providers";
import { getConfig, type AppConfig } from "@/lib/tauri";
import { retrieveProjectChunks } from "@/lib/ai-rag";
import { verifyCitation } from "@/lib/research-literature";
import {
  createResearchTask,
  createDelegatedResearchTask,
  defaultBrief,
  listResearchTasks,
  startResearchTask,
  type ResearchTask,
} from "@/lib/research-tasks";
import { useFilesStore } from "@/store/files";
import { researchTasksEnabled } from "@/store/research-tasks-flag";
import type { AssistantDelegation } from "@/lib/assistant-delegation";

const MAX_SUMMARY = 2_000;
export const TASKS_OFF =
  "Research tasks are turned off. They are experimental in this version; the user can turn them on under Settings, Research, at their own risk.";
const MAX_DEFAULT_GOAL = 2_000;

export interface ResearchToolScope {
  projectId: string | null;
  runtimeId?: "builtin" | "acp";
  agentId?: string;
  modelId?: string;
  delegation?: AssistantDelegation;
}

interface ResearchToolOptions {
  confirm?: ConfirmFn;
  researchScope?: ResearchToolScope;
}

function openProject(projectId: string | null): string {
  if (!projectId) throw new Error("Open a project first.");
  return projectId;
}

export function defaultGoal(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= MAX_DEFAULT_GOAL) return trimmed;
  const cut = trimmed.slice(0, MAX_DEFAULT_GOAL);
  const last = cut.codePointAt(cut.length - 1) ?? 0;
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}

export async function builtinTaskAgent(config: AppConfig): Promise<{ agentId: string; modelId: string }> {
  const { providerId, modelId } = pickActiveProvider(config);
  if (!hasConfiguredProvider(config)) {
    throw new Error(
      "No AI provider has an API key in Oleafly's settings, so a research task has no agent to run it. Ask the user to add a key in Settings, AI, or to create the task from the Research panel.",
    );
  }
  if (!modelId.trim()) {
    throw new Error(
      `No model is chosen for ${providerId} in Oleafly's settings, so a research task can't run. Ask the user to choose one in Settings, AI.`,
    );
  }
  return { agentId: providerId, modelId };
}

function taskStatus(task: ResearchTask) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    phase: task.phase,
    budgetUsedMinutes: Math.round(task.activeMs / 60_000),
    timeBudgetMinutes: task.brief.budget.wallClockMinutes,
    pendingApprovals: task.pendingApprovals,
    resultSummary: (task.result?.summary ?? "").slice(0, MAX_SUMMARY),
    changedFiles: task.result?.changedFiles.length ?? 0,
    recordDir: task.recordDir,
    error: task.error,
  };
}

function researchHost(scope: ResearchToolScope): ResearchToolsHost & ResearchTaskToolsHost {
  return {
  searchLiterature: (query, { limit, sources }) =>
    invoke("literature_search_all", { query: { query, limit, sources: sources ?? [] } }),
  verifyCitation,
  retrieveProjectChunks,
  createResearchTask: async (input) => {
    if (!researchTasksEnabled()) throw new Error(TASKS_OFF);
    const projectId = openProject(scope.projectId);
    const config = await getConfig();
    const agent = scope.agentId
      ? { agentId: scope.agentId, modelId: scope.modelId ?? "" }
      : await builtinTaskAgent(config);
    const brief = defaultBrief(input.brief.goal ?? defaultGoal(input.prompt));
    brief.successCriteria = input.brief.successCriteria ?? [];
    brief.reviewPlanFirst = input.brief.reviewPlanFirst ?? false;
    brief.permissions.commands = "ask";
    brief.permissions.network = input.brief.network ?? false;
    brief.budget.wallClockMinutes =
      input.brief.timeBudgetMinutes ?? config.research_time_budget_minutes ?? brief.budget.wallClockMinutes;
    const draft = {
      projectId,
      title: input.title,
      prompt: input.prompt,
      runtimeId: scope.runtimeId ?? "builtin",
      agentId: agent.agentId,
      modelId: agent.modelId,
      skillIds: input.skillIds,
      dependencyIds: [],
      brief,
    };
    let task = scope.delegation
      ? await createDelegatedResearchTask(draft, scope.delegation)
      : await createResearchTask(draft);
    if (input.start) task = await startResearchTask(task.id);
    return { id: task.id, title: task.title, status: task.status };
  },
  researchTaskStatus: async (id) => {
    const tasks = await listResearchTasks(openProject(scope.projectId));
    if (id) {
      const task = tasks.find((candidate) => candidate.id === id);
      return task ? taskStatus(task) : { error: "No task with that id in this project." };
    }
    return { tasks: tasks.slice(0, 10).map(taskStatus) };
  },
  };
}

export function createResearchAiTools(opts?: ResearchToolOptions) {
  const scope = opts?.researchScope ?? { projectId: useFilesStore.getState().projectId };
  const host = researchHost(scope);
  return { ...createResearchTools(host, opts), ...(researchTasksEnabled() ? createResearchTaskTools(host, opts) : {}) };
}

export function createResearchTaskAiTools(opts?: ResearchToolOptions) {
  const scope = opts?.researchScope ?? { projectId: useFilesStore.getState().projectId };
  return researchTasksEnabled() ? createResearchTaskTools(researchHost(scope), opts) : {};
}

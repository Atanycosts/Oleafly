import type { AssistantDelegation } from "@/lib/assistant-delegation";
import { delegationContext } from "@/lib/assistant-delegation";
import { acpUsable } from "@/lib/acp";
import { createDelegatedResearchTask, defaultBrief, startResearchTask } from "@/lib/research-tasks";
import { researchTasksEnabled } from "@/store/research-tasks-flag";
import { useAcpSessionsStore } from "@/store/acp-sessions";
import { useFilesStore } from "@/store/files";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore } from "@/store/settings";

export async function delegateSelection(request: string, delegation: AssistantDelegation) {
  if (!researchTasksEnabled()) throw new Error("Enable research tasks in Settings, Research before delegating background work.");
  if (delegation.runtimeId === "acp") {
    const agent = useAcpSessionsStore.getState().catalog.find((entry) => entry.definition.id === delegation.agentId);
    if (!agent || !acpUsable(agent) || agent.taskUnavailableReason) {
      throw new Error(agent?.taskUnavailableReason ?? "The selected agent cannot run a background task. The request has not been sent.");
    }
  }
  const brief = defaultBrief(request.slice(0, 2000));
  brief.permissions.commands = "ask";
  brief.permissions.network = false;
  const task = await createDelegatedResearchTask({
    projectId: delegation.projectId,
    title: `${delegation.path}: ${request}`.slice(0, 100),
    prompt: [request, delegationContext(delegation), "The frozen source buffer and original selection are retained in the task's delegation.json. Work in the task copy, compile it and inspect that task's PDF before handing back the result."].join("\n\n"),
    runtimeId: delegation.runtimeId,
    agentId: delegation.agentId,
    modelId: delegation.modelId,
    skillIds: [],
    dependencyIds: [],
    brief,
  }, delegation);
  const started = await startResearchTask(task.id);
  if (useFilesStore.getState().projectId === delegation.projectId) {
    useResearchTasksStore.getState().receiveTask(started);
    useResearchTasksStore.getState().openTaskDetail(started.id);
    useSettingsStore.getState().setRailTab("research");
  }
  return started;
}

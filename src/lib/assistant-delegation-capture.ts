import type { EditorView } from "@codemirror/view";
import { knownProviderConfig, loadProviderConfig, deriveProviderState } from "@/components/ai/provider-config";
import { useFilesStore } from "@/store/files";
import { selectActiveRuntime, useAssistantRuntimeStore } from "@/store/assistant-runtime";
import { useAcpSessionsStore } from "@/store/acp-sessions";
import { acpUsable } from "@/lib/acp";
import { readFileContent } from "@/lib/tauri";
import { currentModelId, groupControls } from "@/components/ai/acp/acp-controls";
import { textSha256, type AssistantDelegation } from "@/lib/assistant-delegation";

export async function captureAssistantTarget(projectId: string): Promise<Pick<AssistantDelegation, "runtimeId" | "agentId" | "modelId">> {
  const runtime = selectActiveRuntime(useAssistantRuntimeStore.getState());
  const sessions = useAcpSessionsStore.getState();
  const sessionId = sessions.activeByProject[projectId];
  const session = sessionId ? sessions.sessions[sessionId] : undefined;
  const acpAgentId = sessions.composers[projectId]?.agentId ?? session?.agentId;
  const configured = knownProviderConfig();
  const provider = runtime === "built-in" ? deriveProviderState(configured ?? await loadProviderConfig()) : null;
  const agentId = runtime === "acp" ? acpAgentId : provider?.provider;
  if (!agentId) throw new Error("Choose an agent before sending the request.");
  if (runtime === "acp") {
    const agent = sessions.catalog.find((entry) => entry.definition.id === agentId);
    if (!agent || !acpUsable(agent) || agent.taskUnavailableReason) throw new Error(agent?.taskUnavailableReason ?? "The selected agent cannot run a background task. The request has not been sent.");
  } else if (!provider?.ready) {
    throw new Error("Configure the selected provider before sending the request.");
  }
  return {
    runtimeId: runtime === "acp" ? "acp" : "builtin",
    agentId,
    modelId: runtime === "acp" ? (session ? currentModelId(groupControls(session.controls).model) ?? session.controls.modelId ?? "" : "") : provider?.model ?? "",
  };
}

export async function captureAssistantDelegation(view: EditorView): Promise<AssistantDelegation> {
  const files = useFilesStore.getState();
  if (!files.projectId || !files.activePath) throw new Error("Open a project file before delegating a selection.");
  const projectId = files.projectId;
  const path = files.activePath;
  const { from, to } = view.state.selection.main;
  const sourceContent = view.state.doc.toString();
  const frozen = {
    projectId,
    path,
    mainDocument: files.mainDoc,
    editorDocVersion: files.docVersion,
    selection: { from, to, text: view.state.sliceDoc(from, to) },
    sourceContent,
  };
  const [target, sourceSha256, diskSha256] = await Promise.all([
    captureAssistantTarget(projectId),
    textSha256(sourceContent),
    readFileContent(projectId, path).then((content) => textSha256(content.replace(/\r\n?/gu, "\n"))),
  ]);
  return {
    ...frozen,
    sourceSha256,
    diskSha256,
    ...target,
  };
}

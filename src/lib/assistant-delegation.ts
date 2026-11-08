export interface AssistantDelegation {
  projectId: string;
  mainDocument: string;
  path: string;
  selection: { from: number; to: number; text: string };
  sourceContent: string;
  sourceSha256: string;
  diskSha256: string;
  editorDocVersion: number;
  runtimeId: "builtin" | "acp";
  agentId: string;
  modelId: string;
}

export async function textSha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}


export function delegationContext(delegation: AssistantDelegation): string {
  const { sourceContent: _sourceContent, ...reference } = delegation;
  return [
    "### Delegated selection (frozen when the user submitted it)",
    JSON.stringify(reference),
    "Use this project, source revision and selection as the target. Read the current source before editing and reconcile any changes. Workspace navigation does not change the delegated target.",
  ].join("\n");
}

import { create } from "zustand";
import { E2E_HOOKS } from "@/lib/e2e-flags";
import { i18n } from "@/i18n";
import { toast } from "@/lib/toast";
import { useAssistantRuntimeStore } from "@/store/assistant-runtime";
import type { AssistantDelegation } from "@/lib/assistant-delegation";

export interface AssistantHandoffOptions {
  autoSend?: boolean;
  images?: string[];
  delegation?: AssistantDelegation;
}

export function handoffRuntimeSwitchMessage(): string {
  return i18n.t(($) => $.core.assistant.handoffRuntimeSwitch);
}

interface AgentHandoffState {
  pendingPrompt: string | null;
  autoSend: boolean;
  pendingImages: string[];
  pendingDelegation: AssistantDelegation | null;
  handoff: (prompt: string, opts?: AssistantHandoffOptions) => void;
  consume: () => { prompt: string; autoSend: boolean; images: string[]; delegation: AssistantDelegation | null } | null;
}

export const useAgentHandoffStore = create<AgentHandoffState>((set, get) => ({
  pendingPrompt: null,
  autoSend: false,
  pendingImages: [],
  pendingDelegation: null,
  handoff: (prompt, opts) => {
    if (opts?.delegation) {
      useAssistantRuntimeStore.getState().setRuntime(opts.delegation.runtimeId === "acp" ? "acp" : "built-in");
    } else if (useAssistantRuntimeStore.getState().switchToBuiltInForHandoff()) {
      toast.infoUnique("assistant-handoff-runtime", handoffRuntimeSwitchMessage());
    }
    set({
      pendingPrompt: prompt,
      autoSend: opts?.autoSend ?? true,
      pendingImages: opts?.images ?? [],
      pendingDelegation: opts?.delegation ? structuredClone(opts.delegation) : null,
    });
  },
  consume: () => {
    const { pendingPrompt, autoSend, pendingImages, pendingDelegation } = get();
    if (!pendingPrompt) return null;
    set({ pendingPrompt: null, autoSend: false, pendingImages: [], pendingDelegation: null });
    return { prompt: pendingPrompt, autoSend, images: pendingImages, delegation: pendingDelegation };
  },
}));

if (typeof window !== "undefined" && E2E_HOOKS) {
  const w = window as unknown as {
    __agentHandoff?: (prompt: string, autoSend?: boolean) => void;
  };
  w.__agentHandoff = (prompt, autoSend = false) =>
    useAgentHandoffStore.getState().handoff(prompt, { autoSend });
}

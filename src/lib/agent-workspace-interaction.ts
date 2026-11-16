import { useAgentWorkspaceStore } from "@/store/agent-workspace";

export function pauseAgentWorkspaceFollow(event: { target: EventTarget | null; type: string; key?: string }) {
  if (event.target instanceof Element && event.target.closest("[data-agent-follow-control]")) return;
  if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Enter", " "].includes(event.key ?? "")) return;
  const store = useAgentWorkspaceStore.getState();
  if (store.following && !store.paused) store.pause();
}

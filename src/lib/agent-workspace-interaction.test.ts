// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { pauseAgentWorkspaceFollow } from "./agent-workspace-interaction";

beforeEach(() => {
  useAgentWorkspaceStore.setState({ projectId: "paper", following: { projectId: "paper", flowKey: "chat:flow" }, paused: false, intentRevision: 0 });
});

it.each(["pointerdown", "wheel", "beforeinput"])("pauses follow when a user takes control through %s", (type) => {
  pauseAgentWorkspaceFollow({ type, target: document.body });
  expect(useAgentWorkspaceStore.getState()).toMatchObject({ paused: true, intentRevision: 1 });
  pauseAgentWorkspaceFollow({ type, target: document.body });
  expect(useAgentWorkspaceStore.getState().intentRevision).toBe(1);
});

it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Enter", " "])("pauses follow for a navigation key: %s", (key) => {
  pauseAgentWorkspaceFollow({ type: "keydown", target: document.body, key });
  expect(useAgentWorkspaceStore.getState().paused).toBe(true);
});

it.each(["Shift", "Control", "a", "Escape", undefined])("keeps follow active for a key that does not navigate: %s", (key) => {
  pauseAgentWorkspaceFollow({ type: "keydown", target: document.body, key });
  expect(useAgentWorkspaceStore.getState()).toMatchObject({ paused: false, intentRevision: 0 });
});

it("allows a nested follow control to handle resume without immediately pausing it again", () => {
  const button = document.createElement("button");
  button.dataset.agentFollowControl = "";
  const label = document.createElement("span");
  button.append(label);
  pauseAgentWorkspaceFollow({ type: "pointerdown", target: label });
  pauseAgentWorkspaceFollow({ type: "keydown", target: label, key: "Enter" });
  expect(useAgentWorkspaceStore.getState()).toMatchObject({ paused: false, intentRevision: 0 });
});

it("does not change user intent when follow is inactive", () => {
  useAgentWorkspaceStore.setState({ following: null });
  pauseAgentWorkspaceFollow({ type: "pointerdown", target: null });
  expect(useAgentWorkspaceStore.getState()).toMatchObject({ paused: false, intentRevision: 0 });
});

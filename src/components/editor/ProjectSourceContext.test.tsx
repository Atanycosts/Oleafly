// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { useFilesStore } from "@/store/files";
import { materialRevision } from "@/lib/material-surface";
import { ProjectSourceContext } from "./ProjectSourceContext";

const controller = vi.hoisted(() => ({ getEditorView: vi.fn() }));
vi.mock("./cm/controller", () => controller);

beforeEach(() => {
  useWorkspaceSurfaceStore.setState({ active: "files" });
  useAgentWorkspaceStore.setState({ views: {} });
  useFilesStore.setState({ projectId: "p", activePath: "notes.md", files: { "notes.md": { content: "a word", dirty: true } } });
  controller.getEditorView.mockReturnValue({ state: { selection: { main: { from: 2, to: 6, empty: false } }, sliceDoc: () => "word" } });
});

it("publishes the actual unsaved source and selection while keeping hidden source updates out of the current Word context", async () => {
  const label = "Source selection";
  render(<ProjectSourceContext projectId="p" path="notes.md" kind="markdown"><div className="cm-editor"><button type="button">{label}</button></div></ProjectSourceContext>);
  const revision = await materialRevision({ text: "a word" });
  await waitFor(() => expect(useAgentWorkspaceStore.getState().views.p).toMatchObject({ revision, dirty: true, role: "working" }));
  fireEvent.mouseUp(screen.getByRole("button", { name: "Source selection" }));
  expect(useAgentWorkspaceStore.getState().views.p.selection).toMatchObject({ revision, anchor: { kind: "text", from: 2, to: 6, quote: "word" } });
  act(() => {
    useWorkspaceSurfaceStore.setState({ active: "word" });
    useAgentWorkspaceStore.getState().publishView({ projectId: "p", documentId: "word", title: "Word", revision: "live", role: "working", kind: "docx" });
    useFilesStore.setState({ files: { "notes.md": { content: "new background source", dirty: true } } });
  });
  await act(async () => { await Promise.resolve(); });
  expect(useAgentWorkspaceStore.getState().views.p.documentId).toBe("word");
});

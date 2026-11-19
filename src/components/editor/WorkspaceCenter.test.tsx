// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalProject } from "@/lib/journal-workbench";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { useFilesStore } from "@/store/files";
import { useDiffStore } from "@/store/diff";
import { useSettingsStore } from "@/store/settings";
import { useMaterialViewerStore } from "@/store/material-viewer";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import type { MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };

const mounts = vi.hoisted(() => ({ word: vi.fn(), journal: vi.fn(), wordUnmount: vi.fn(), reveal: vi.fn(async () => {}) }));
vi.mock("@/lib/docx-agent-host", () => ({ revealDocxWorkspaceTarget: mounts.reveal }));
vi.mock("./Editor", () => ({
  Editor: () => <div data-testid="file-editor" />,
  EditorTabBar: () => <div data-testid="tabs" />,
}));
vi.mock("@/components/research/DocxWorkspaceDialog", async () => {
  const { useEffect, useState } = await import("react");
  return { DocxWorkspaceHost: function Word() {
    const [value, setValue] = useState("");
    useEffect(() => { mounts.word(); return () => { mounts.wordUnmount(); }; }, []);
    const label = "Manuscript";
    return <input aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} />;
  } };
});
vi.mock("@/components/research/JournalChecksPanel", async () => {
  const { useEffect } = await import("react");
  return { JournalWorkspaceHost: function Journal() {
    useEffect(() => { mounts.journal(); }, []);
    const label = "Format comparison";
    return <p>{label}</p>;
  } };
});
vi.mock("@/components/materials/RetainedMaterialViewer", async () => {
  const { useState } = await import("react");
  return { RetainedMaterialViewer: ({ request }: { request: { title: string } }) => {
    const [position, setPosition] = useState("");
    return <div data-testid="retained-material"><p>{request.title}</p><input aria-label={request.title} value={position} onChange={(event) => setPosition(event.target.value)} /></div>;
  } };
});
vi.mock("@/components/materials/MaterialAnnotations", async () => {
  const { useState } = await import("react");
  return { MaterialAnnotations: ({ onMinimize }: { onMinimize?: () => void }) => {
    const [body, setBody] = useState("");
    return <div data-testid="material-feedback"><input aria-label={en.tasks.annotations.body} value={body} onChange={(event) => setBody(event.target.value)} /><button type="button" onClick={onMinimize}>{en.materialAnnotations.minimize}</button></div>;
  } };
});
import { WorkspaceCenter } from "./WorkspaceCenter";

beforeEach(() => {
  vi.clearAllMocks();
  useDocxWorkspaceStore.getState().close();
  useWorkspaceSurfaceStore.setState({ active: "files", journalOpen: false, journalSidebarTarget: null });
  useFilesStore.setState({ projectId: "app", activePath: "main.tex", openTabs: ["main.tex"] });
  useDiffStore.setState({ activeKey: null, diffs: [] });
  useMaterialViewerStore.setState({ request: null, visits: [], returnSurface: "files" });
  useAgentWorkspaceStore.setState({ projectId: null, views: {}, operations: [], following: null, paused: false, latestTarget: null, navigation: null, sequence: 0 });
  useMaterialAnnotationsStore.getState().close();
});

it("retains the unsaved Word surface while switching to checks, files and back", async () => {
  render(<WorkspaceCenter />);
  act(() => useDocxWorkspaceStore.getState().open({
    appProjectId: "app", project: { project_id: "paper", name: "Paper" } as JournalProject,
    world: null, onSaved: async () => {},
  }));
  const editor = await screen.findByLabelText("Manuscript");
  fireEvent.change(editor, { target: { value: "Unsaved manuscript text" } });
  expect(editor.closest('[role="dialog"]')).toBeNull();
  act(() => useWorkspaceSurfaceStore.getState().openJournal());
  await screen.findByText("Format comparison");
  expect(editor).not.toBeVisible();
  act(() => useFilesStore.getState().setActive("main.tex"));
  expect(screen.getByTestId("file-editor")).toBeVisible();
  act(() => useDocxWorkspaceStore.getState().restore());
  expect(editor).toBeVisible();
  expect(editor).toHaveValue("Unsaved manuscript text");
  expect(mounts.word).toHaveBeenCalledOnce();
  expect(mounts.wordUnmount).not.toHaveBeenCalled();
  act(() => useWorkspaceSurfaceStore.getState().closeJournal());
  act(() => useWorkspaceSurfaceStore.getState().openJournal());
  expect(mounts.journal).toHaveBeenCalledOnce();
});

it("focuses the retained Word session when its source file is selected again", async () => {
  render(<WorkspaceCenter />);
  act(() => useDocxWorkspaceStore.getState().open({
    appProjectId: "app", project: { project_id: "paper", name: "Paper" } as JournalProject,
    sourcePath: "paper.docx", world: null, onSaved: async () => {},
  }));
  await screen.findByLabelText("Manuscript");
  act(() => useFilesStore.getState().setActive("main.tex"));
  act(() => useFilesStore.getState().setActive("paper.docx"));
  await waitFor(() => expect(useWorkspaceSurfaceStore.getState().active).toBe("word"));
  expect(mounts.word).toHaveBeenCalledOnce();
});

it("opens a document or checks from the assistant-only layout without changing its saved view mode", () => {
  useSettingsStore.setState({ workspaceHidden: true, viewMode: "pdf" });
  useWorkspaceSurfaceStore.getState().openJournal();
  expect(useSettingsStore.getState().workspaceHidden).toBe(false);
  expect(useSettingsStore.getState().viewMode).toBe("pdf");
});

it("keeps feedback and retained results inside the center while preserving the editable Word session", async () => {
  render(<WorkspaceCenter />);
  act(() => useDocxWorkspaceStore.getState().open({ appProjectId: "app", project: { project_id: "paper", name: "Paper" } as JournalProject, world: null, onSaved: async () => {} }));
  const editor = await screen.findByLabelText("Manuscript");
  fireEvent.change(editor, { target: { value: "Uncommitted edit" } });
  act(() => {
    useMaterialViewerStore.getState().open({ projectId: "app", documentId: "figure", title: "Research figure", kind: "image", revision: "a".repeat(64), load: async () => new Uint8Array([1]) });
    useMaterialAnnotationsStore.getState().open({ projectId: "app", documentId: "figure", path: null, title: "Research figure", kind: "image", revision: "a".repeat(64), source: { bytes: new Uint8Array([1]) } });
  });
  expect(await screen.findByTestId("retained-material")).toHaveTextContent("Research figure");
  expect(await screen.findByTestId("material-feedback")).toBeVisible();
  expect(screen.getByTestId("material-feedback").closest('[data-testid="workspace-center"]')).not.toBeNull();
  expect(editor).not.toBeVisible();
  act(() => useMaterialViewerStore.getState().close());
  expect(editor).toBeVisible();
  expect(editor).toHaveValue("Uncommitted edit");
  expect(mounts.word).toHaveBeenCalledOnce();
});

it("clears materials and feedback when leaving their project", async () => {
  render(<WorkspaceCenter />);
  const document: MaterialDocument = { projectId: "app", documentId: "notes", title: "Notes", path: "notes.md", kind: "markdown", revision: "a".repeat(64), source: { text: "Notes" } };
  act(() => {
    useMaterialAnnotationsStore.getState().open(document);
    useMaterialViewerStore.getState().open({ ...document, load: async () => "Notes" });
  });
  await screen.findByTestId("material-feedback");
  act(() => useFilesStore.setState({ projectId: "another" }));
  await waitFor(() => expect(useMaterialAnnotationsStore.getState().document).toBeNull());
  expect(useMaterialViewerStore.getState().request).toBeNull();
});

it("keeps a material's reading state while visiting another exact material and going back", async () => {
  render(<WorkspaceCenter />);
  const paper = { projectId: "app", documentId: "paper", title: "Evidence PDF", kind: "pdf" as const, revision: "a".repeat(64), load: async () => new Uint8Array([1]) };
  act(() => useMaterialViewerStore.getState().open(paper));
  const position = await screen.findByLabelText("Evidence PDF");
  fireEvent.change(position, { target: { value: "page 9, selected evidence" } });
  act(() => useMaterialViewerStore.getState().open({ ...paper, documentId: "report", title: "Interactive report", kind: "html", revision: "b".repeat(64) }));
  await screen.findByLabelText("Interactive report");
  expect(position).not.toBeVisible();
  expect(position.closest('[data-testid="workspace-material-surface"]')).toHaveAttribute("inert");
  act(() => useMaterialViewerStore.getState().back());
  expect(position).toBeVisible();
  expect(position).toHaveValue("page 9, selected evidence");
  expect(screen.queryByLabelText("Interactive report")).toBeNull();
});

it("pauses navigation on user intent and resumes the latest real target from a light prompt", async () => {
  render(<WorkspaceCenter />);
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "chat" as const, flowId: "flow", chatId: "chat" };
  act(() => {
    store.beginFollow("app", origin);
    store.report({ id: "first", projectId: "app", sessionId: "word", origin, operation: "format", phase: "succeeded", target: { projectId: "app", sessionId: "word", paragraphRef: "p1", sessionRevision: 2 } });
  });
  await waitFor(() => expect(mounts.reveal).toHaveBeenCalledWith(expect.objectContaining({ paragraphRef: "p1" }), expect.any(AbortSignal)));
  fireEvent.wheel(screen.getByTestId("workspace-center"));
  expect(useAgentWorkspaceStore.getState().paused).toBe(true);
  act(() => store.report({ id: "second", projectId: "app", sessionId: "word", origin, operation: "format", phase: "succeeded", target: { projectId: "app", sessionId: "word", paragraphRef: "p2", sessionRevision: 3 } }));
  expect(mounts.reveal).toHaveBeenCalledTimes(1);
  const resume = screen.getByRole("button", { name: "Continue following" });
  fireEvent.pointerDown(resume);
  fireEvent.click(resume);
  await waitFor(() => expect(mounts.reveal).toHaveBeenCalledWith(expect.objectContaining({ paragraphRef: "p2" }), expect.any(AbortSignal)));
  expect(useAgentWorkspaceStore.getState().paused).toBe(false);
});

it("keeps feedback drafts mounted in a center-only overlay while its paper-edge entry remains visible", async () => {
  useSettingsStore.setState({ showTree: true, assistantOpen: true });
  const view = render(<WorkspaceCenter />);
  const document: MaterialDocument = { projectId: "app", documentId: "notes", title: "Notes", path: "notes.md", kind: "markdown", revision: "first", source: { text: "Notes" } };
  act(() => useMaterialAnnotationsStore.getState().open(document));
  const body = await screen.findByRole("textbox", { name: en.tasks.annotations.body });
  fireEvent.change(body, { target: { value: "Preserve this unsent draft" } });
  const overlay = screen.getByTestId("workspace-material-feedback");
  const rail = screen.getByTestId("workspace-material-feedback-rail");
  expect(overlay).toHaveClass("absolute", "w-80", "right-12");
  expect(rail).toHaveClass("w-12");
  expect(overlay.closest('[data-testid="workspace-center"]')).not.toBeNull();
  expect(useSettingsStore.getState()).toMatchObject({ showTree: true, assistantOpen: true });
  fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.minimize }));
  expect(body).not.toBeVisible();
  expect(overlay).toHaveAttribute("inert");
  expect(rail).toBeVisible();
  view.rerender(<WorkspaceCenter />);
  act(() => useSettingsStore.setState({ railTab: "research" }));
  expect(body).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.expand }));
  expect(body).toBeVisible();
  expect(body).toHaveValue("Preserve this unsent draft");
  fireEvent.click(screen.getByRole("button", { name: en.materialAnnotations.minimize }));
  act(() => useMaterialAnnotationsStore.getState().open(document, { kind: "text", from: 0, to: 5, quote: "Notes" }));
  expect(body).toBeVisible();
  expect(body).toHaveValue("Preserve this unsent draft");
  act(() => useFilesStore.setState({ projectId: "another" }));
  await waitFor(() => expect(screen.queryByTestId("workspace-material-feedback-rail")).toBeNull());
});

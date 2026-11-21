// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalProject } from "@/lib/journal-workbench";
import en from "@/i18n/locales/en/editor.json" with { type: "json" };
import researchTools from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";

const api = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/docx-file", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/docx-file")>(),
  openWordDocument: api.open,
}));
import DocxFileView from "./DocxFileView";
import { DocxWorkbenchConnectionError, type OpenedWordDocument } from "@/lib/docx-file";

const manuscript = { project_id: "manuscript", name: "My paper", baseline_id: "saved-version" } as JournalProject;
beforeEach(() => {
  vi.resetAllMocks();
  useDocxWorkspaceStore.getState().close();
  useWorkspaceSurfaceStore.setState({ active: "files" });
  api.open.mockResolvedValue({ project: manuscript, world: null, sourceChanged: false, choices: [] });
});

it("opens a file directly in the retained editor and reopens the latest version after closing", async () => {
  render(<DocxFileView projectId="app" path="英文稿/paper.docx" />);
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request).toMatchObject({ appProjectId: "app", project: manuscript, sourcePath: "英文稿/paper.docx" }));
  act(() => useDocxWorkspaceStore.getState().close());
  api.open.mockResolvedValueOnce({ project: { ...manuscript, baseline_id: "newer" }, world: null, sourceChanged: false, choices: [] });
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordOpen }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project.baseline_id).toBe("newer"));
  expect(api.open).toHaveBeenCalledTimes(2);
});

it("restores the same file's existing editor without re-importing", async () => {
  useDocxWorkspaceStore.getState().open({ appProjectId: "app", project: manuscript, world: null, sourcePath: "paper.docx", onSaved: async () => {} });
  useDocxWorkspaceStore.getState().minimize();
  const original = useDocxWorkspaceStore.getState().request;
  render(<DocxFileView projectId="app" path="paper.docx" />);
  await waitFor(() => expect(useDocxWorkspaceStore.getState().minimized).toBe(false));
  expect(useDocxWorkspaceStore.getState().request).toBe(original);
  expect(api.open).not.toHaveBeenCalled();
});

it("keeps another document's unsaved session and waits for it to close", async () => {
  useDocxWorkspaceStore.getState().open({ appProjectId: "app", project: manuscript, world: null, sourcePath: "other.docx", onSaved: async () => {} });
  const original = useDocxWorkspaceStore.getState().request;
  render(<DocxFileView projectId="app" path="paper.docx" />);
  expect(screen.getByText(en.shell.wordOtherOpen.replace("{{name}}", manuscript.name))).toBeVisible();
  expect(api.open).not.toHaveBeenCalled();
  expect(useDocxWorkspaceStore.getState().request).toBe(original);
  act(() => useDocxWorkspaceStore.getState().close());
  await waitFor(() => expect(api.open).toHaveBeenCalledExactlyOnceWith("app", "paper.docx", undefined, undefined));
});

it("shows import errors and retries from the same file tab", async () => {
  api.open.mockRejectedValueOnce(new Error("Cannot read document"));
  render(<DocxFileView projectId="app" path="paper.docx" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Cannot read document");
  expect(screen.queryByLabelText(researchTools.journal.python)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: researchTools.journal.connect })).not.toBeInTheDocument();
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordOpen }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("connects Workbench from the shared connection form and continues the same document", async () => {
  api.open.mockRejectedValueOnce(new DocxWorkbenchConnectionError("Runtime missing"))
    .mockRejectedValueOnce(new DocxWorkbenchConnectionError("Cannot start Workbench"));
  render(<DocxFileView projectId="app" path="paper.docx" />);
  const python = await screen.findByLabelText(researchTools.journal.python);
  expect(screen.getByRole("button", { name: researchTools.journal.browse })).toBeVisible();
  fireEvent.change(python, { target: { value: "/opt/workbench/python" } });
  fireEvent.click(screen.getByRole("button", { name: researchTools.journal.connect }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cannot start Workbench");
  expect(screen.getByLabelText(researchTools.journal.python)).toHaveValue("/opt/workbench/python");
  fireEvent.click(screen.getByRole("button", { name: researchTools.journal.connect }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request).toMatchObject({
    project: manuscript,
    sourcePath: "paper.docx",
  }));
  expect(api.open).toHaveBeenLastCalledWith("app", "paper.docx", undefined, "/opt/workbench/python");
});

it("does not open the document over another surface when connection finishes", async () => {
  let finishOpen!: (opened: OpenedWordDocument) => void;
  api.open.mockRejectedValueOnce(new DocxWorkbenchConnectionError("Runtime missing"))
    .mockReturnValueOnce(new Promise<OpenedWordDocument>((resolve) => { finishOpen = resolve; }));
  render(<DocxFileView projectId="app" path="paper.docx" />);
  const python = await screen.findByLabelText(researchTools.journal.python);
  fireEvent.change(python, { target: { value: "/opt/workbench/python" } });
  fireEvent.click(screen.getByRole("button", { name: researchTools.journal.connect }));
  act(() => useWorkspaceSurfaceStore.getState().openJournal());
  await act(async () => finishOpen({ project: manuscript, world: null, sourceChanged: false, choices: [] }));
  expect(useWorkspaceSurfaceStore.getState().active).toBe("journal");
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
});

it("does not take over after a pending open leaves Files and the user returns", async () => {
  let finishOpen!: (opened: OpenedWordDocument) => void;
  api.open.mockReturnValueOnce(new Promise<OpenedWordDocument>((resolve) => { finishOpen = resolve; }));
  render(<DocxFileView projectId="app" path="paper.docx" />);
  await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
  act(() => useWorkspaceSurfaceStore.getState().openJournal());
  act(() => useWorkspaceSurfaceStore.getState().showFiles());
  await act(async () => finishOpen({ project: manuscript, world: null, sourceChanged: false, choices: [] }));
  expect(useWorkspaceSurfaceStore.getState().active).toBe("files");
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordOpen }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("ignores a result that arrives after the file tab has changed", async () => {
  let finishPrevious!: (opened: Awaited<ReturnType<typeof api.open>>) => void;
  api.open.mockReturnValueOnce(new Promise((resolve) => { finishPrevious = resolve; }));
  const next = { ...manuscript, project_id: "next", name: "Next paper" };
  const view = render(<DocxFileView key="previous" projectId="app" path="previous.docx" />);
  await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
  api.open.mockResolvedValueOnce({ project: next, world: null, sourceChanged: false, choices: [] });
  view.rerender(<DocxFileView key="next" projectId="app" path="next.docx" />);
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(next));
  finishPrevious({ project: manuscript, world: null, sourceChanged: false, choices: [] });
  await act(async () => { await Promise.resolve(); });
  expect(useDocxWorkspaceStore.getState().request).toMatchObject({ project: next, sourcePath: "next.docx" });
});

it("asks how to handle an externally replaced source before opening the saved manuscript", async () => {
  api.open.mockResolvedValueOnce({ project: manuscript, world: null, sourceChanged: true, choices: [] });
  render(<DocxFileView projectId="app" path="paper.docx" />);
  expect(await screen.findByTestId("word-source-choice")).toHaveTextContent(en.shell.wordSourceChanged);
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", manuscript.name) }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "paper.docx", { workbenchProjectId: manuscript.project_id }, undefined));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("offers exact existing copies and imports separately only when the user chooses", async () => {
  api.open.mockResolvedValueOnce({ project: null, world: null, sourceChanged: false, choices: [manuscript] });
  render(<DocxFileView projectId="app" path="renamed.docx" />);
  expect(await screen.findByTestId("word-source-choice")).toHaveTextContent(en.shell.wordExistingCopy);
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordNewCopy }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "renamed.docx", { newCopy: true }, undefined));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("offers both the old working copy and an exact match for a replacement source", async () => {
  const replacement = { ...manuscript, project_id: "replacement", name: "Replacement paper" };
  api.open.mockResolvedValueOnce({ project: manuscript, world: null, sourceChanged: true, choices: [replacement] });
  render(<DocxFileView projectId="app" path="paper.docx" />);
  await screen.findByTestId("word-source-choice");
  expect(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", manuscript.name) })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", replacement.name) }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "paper.docx", { workbenchProjectId: "replacement" }, undefined));
});

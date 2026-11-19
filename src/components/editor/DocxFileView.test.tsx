// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalProject } from "@/lib/journal-workbench";
import en from "@/i18n/locales/en/editor.json" with { type: "json" };
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

const api = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/docx-file", () => ({ openWordDocument: api.open }));
import DocxFileView from "./DocxFileView";

const manuscript = { project_id: "manuscript", name: "My paper", baseline_id: "saved-version" } as JournalProject;
beforeEach(() => {
  vi.resetAllMocks();
  useDocxWorkspaceStore.getState().close();
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
  await waitFor(() => expect(api.open).toHaveBeenCalledExactlyOnceWith("app", "paper.docx"));
});

it("shows import errors and retries from the same file tab", async () => {
  api.open.mockRejectedValueOnce(new Error("Cannot read document"));
  render(<DocxFileView projectId="app" path="paper.docx" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Cannot read document");
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordOpen }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("asks how to handle an externally replaced source before opening the saved manuscript", async () => {
  api.open.mockResolvedValueOnce({ project: manuscript, world: null, sourceChanged: true, choices: [] });
  render(<DocxFileView projectId="app" path="paper.docx" />);
  expect(await screen.findByTestId("word-source-choice")).toHaveTextContent(en.shell.wordSourceChanged);
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", manuscript.name) }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "paper.docx", { workbenchProjectId: manuscript.project_id }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("offers exact existing copies and imports separately only when the user chooses", async () => {
  api.open.mockResolvedValueOnce({ project: null, world: null, sourceChanged: false, choices: [manuscript] });
  render(<DocxFileView projectId="app" path="renamed.docx" />);
  expect(await screen.findByTestId("word-source-choice")).toHaveTextContent(en.shell.wordExistingCopy);
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordNewCopy }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "renamed.docx", { newCopy: true }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toBe(manuscript));
});

it("offers both the old working copy and an exact match for a replacement source", async () => {
  const replacement = { ...manuscript, project_id: "replacement", name: "Replacement paper" };
  api.open.mockResolvedValueOnce({ project: manuscript, world: null, sourceChanged: true, choices: [replacement] });
  render(<DocxFileView projectId="app" path="paper.docx" />);
  await screen.findByTestId("word-source-choice");
  expect(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", manuscript.name) })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: en.shell.wordContinueCopy.replace("{{name}}", replacement.name) }));
  await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("app", "paper.docx", { workbenchProjectId: "replacement" }));
});

import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ invoke: vi.fn(), connect: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@/lib/journal-workbench", () => ({ connectJournalWorkbench: api.connect }));
import { DocxWorkbenchConnectionError, openWordDocument } from "./docx-file";

beforeEach(() => {
  vi.resetAllMocks();
  api.connect.mockResolvedValue({});
});

it("joins concurrent opens and later reads the latest retained version", async () => {
  let finish!: (value: unknown) => void;
  api.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const first = openWordDocument("app", "英文稿/paper.docx");
  const second = openWordDocument("app", "英文稿/paper.docx");
  expect(second).toBe(first);
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledExactlyOnceWith("journal_word_open", { projectId: "app", path: "英文稿/paper.docx" }));
  finish({ project: { baseline_id: "initial" }, world: null });
  await first;
  api.invoke.mockResolvedValueOnce({ project: { baseline_id: "saved" }, world: null });
  await expect(openWordDocument("app", "英文稿/paper.docx")).resolves.toMatchObject({ project: { baseline_id: "saved" } });
  expect(api.invoke).toHaveBeenCalledTimes(2);
});

it("marks only a failed connection as a workbench connection error and allows retry", async () => {
  api.connect.mockRejectedValueOnce(new Error("Runtime missing"));
  const failure = await openWordDocument("app", "paper.docx").catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(DocxWorkbenchConnectionError);
  expect(failure).toMatchObject({ message: "Runtime missing" });
  expect(api.invoke).not.toHaveBeenCalled();
  api.invoke.mockResolvedValue({ project: { baseline_id: "initial" }, world: null });
  await openWordDocument("app", "paper.docx");
  expect(api.invoke).toHaveBeenCalledOnce();
});

it("connects with the supplied Python before importing the document", async () => {
  api.invoke.mockResolvedValue({ project: { baseline_id: "initial" }, world: null });
  await openWordDocument("app", "paper.docx", { newCopy: true }, "/opt/workbench/python");
  expect(api.connect).toHaveBeenCalledExactlyOnceWith("/opt/workbench/python");
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith("journal_word_open", {
    projectId: "app",
    path: "paper.docx",
    newCopy: true,
  });
});

it("leaves an import failure unchanged", async () => {
  const failure = new Error("Cannot read document");
  api.invoke.mockRejectedValueOnce(failure);
  await expect(openWordDocument("app", "paper.docx")).rejects.toBe(failure);
});

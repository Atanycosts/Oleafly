// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxRecoveryMetadata } from "@/lib/docx-recovery";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

const mocks = vi.hoisted(() => ({
  commit: vi.fn(), list: vi.fn(), read: vi.fn(), discard: vi.fn(), connect: vi.fn(), workspace: vi.fn(), journal: vi.fn(), openProject: vi.fn(), open: vi.fn(),
  files: { projectId: null as string | null, projects: [{ id: "app-project", name: "Paper project" }] },
}));
vi.mock("@/lib/docx-recovery", () => ({ listDocxRecovery: mocks.list, readDocxRecovery: mocks.read, discardDocxRecovery: mocks.discard, commitDocxRecovery: mocks.commit }));
vi.mock("@/lib/journal-workbench", () => ({ connectJournalWorkbench: mocks.connect, journalRequest: mocks.journal, journalQuery: (path: string) => path }));
vi.mock("@/lib/research-workspace", () => ({ getResearchWorkspace: mocks.workspace }));
vi.mock("@/features/open-folder", () => ({ openRecentProject: mocks.openProject }));
vi.mock("@/store/files", () => ({ useFilesStore: Object.assign((selector: (state: typeof mocks.files) => unknown) => selector(mocks.files), { getState: () => mocks.files }) }));

import { DocxRecoveryHost } from "./DocxRecoveryHost";

const text = en.docx.recovery;
const candidate: DocxRecoveryMetadata = {
  appProjectId: "app-project", workbenchProjectId: "paper-project", baseBaselineId: "baseline-old", sourceSha256: "a".repeat(64),
  recoveryKey: "b".repeat(64), contentSha256: "c".repeat(64), revision: 8, updatedAt: "2026-11-12T02:00:00.000Z",
};
const snapshot = { ...candidate, bytes: Uint8Array.from([80, 75, 9, 9]) };
const project = { project_id: candidate.workbenchProjectId, name: "Manuscript", baseline_id: "baseline-current", binding: null, latest_check: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.projectId = null;
  useDocxWorkspaceStore.setState({ request: null, minimized: false, recoveryOpen: false, open: mocks.open });
  mocks.list.mockResolvedValue({ snapshots: [candidate], failures: [] });
  mocks.read.mockResolvedValue(snapshot);
  mocks.discard.mockResolvedValue(true);
  mocks.connect.mockResolvedValue({});
  mocks.workspace.mockResolvedValue({ journalProjectId: candidate.workbenchProjectId });
  mocks.journal.mockResolvedValue({ projects: [project], worlds: [] });
  mocks.openProject.mockImplementation(async (id: string) => { mocks.files.projectId = id; });
});

async function showCandidates() {
  render(<DocxRecoveryHost />);
  fireEvent.click(await screen.findByTestId("docx-recovery-open"));
  return screen.getByTestId("docx-recovery-dialog");
}

describe("DOCX startup recovery", () => {
  it("discovers in the library without starting Workbench and restores only after explicit selection", async () => {
    const dialog = await showCandidates();
    expect(dialog).toHaveTextContent("Paper project");
    expect(mocks.connect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ appProjectId: candidate.appProjectId, project, recovery: snapshot, world: null })));
    expect(mocks.openProject).toHaveBeenCalledWith(candidate.appProjectId);
  });

  it("requires a second confirmation and retains a changed checkpoint", async () => {
    const dialog = await showCandidates();
    fireEvent.click(within(dialog).getByTestId("docx-recovery-discard"));
    expect(mocks.discard).not.toHaveBeenCalled();
    mocks.discard.mockResolvedValue(false);
    fireEvent.click(screen.getByTestId("docx-recovery-confirm-discard"));
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith(candidate));
    await waitFor(() => expect(screen.getByTestId("docx-recovery-confirm-discard").closest('[role="dialog"]')).toHaveTextContent(text.changed));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("refreshes a changed selection without restoring newer bytes under an old choice", async () => {
    const dialog = await showCandidates();
    mocks.read.mockResolvedValue({ ...snapshot, contentSha256: "d".repeat(64) });
    fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.changed));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it("keeps an unavailable project's checkpoint and exposes the reason", async () => {
    const dialog = await showCandidates();
    mocks.workspace.mockResolvedValue({ journalProjectId: "another-manuscript" });
    fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.linkChanged));
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows bad checkpoint failures alongside healthy recoverable copies", async () => {
    mocks.list.mockResolvedValue({ snapshots: [candidate], failures: [{ recoveryKey: "bad", error: "hash mismatch" }] });
    const dialog = await showCandidates();
    expect(dialog).toHaveTextContent(text.unreadable);
    expect(dialog).toHaveTextContent("hash mismatch");
    expect(within(dialog).getByTestId("docx-recovery-restore")).toBeEnabled();
  });
});

const pendingSnapshot = { ...snapshot, taskState: {
  document: { sessionId: "old", appProjectId: candidate.appProjectId, workbenchProjectId: candidate.workbenchProjectId,
    baselineId: candidate.baseBaselineId, sourceSha256: candidate.sourceSha256, sessionRevision: 8, savedRevision: 0 },
  applied: [], receipts: [], pendingSave: { projectId: candidate.workbenchProjectId, expectedBaselineId: candidate.baseBaselineId,
    filename: "paper.docx", reason: "Save", requestId: "fixed-save", revision: 8 },
} };

it("confirms the fixed save then opens the actual saved baseline without a recovered session", async () => {
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.commit.mockResolvedValue({ baselineId: project.baseline_id, sourceSha256: candidate.contentSha256, revision: 8 });
  const dialog = await showCandidates();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ project, recovery: undefined })));
  expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(pendingSnapshot);
  expect(mocks.journal.mock.calls.filter(([path]) => path === "/api/state")).toHaveLength(2);
  expect(mocks.discard).toHaveBeenCalledWith(pendingSnapshot);
  expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(mocks.discard.mock.invocationCallOrder[0]);
  expect(mocks.discard.mock.invocationCallOrder[0]).toBeLessThan(mocks.open.mock.invocationCallOrder[0]);
});

it("keeps an interrupted fixed save available for the exact same retry", async () => {
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.list.mockResolvedValue({ snapshots: [pendingSnapshot], failures: [] });
  mocks.commit.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ baselineId: project.baseline_id, sourceSha256: candidate.contentSha256, revision: 8 });
  const dialog = await showCandidates();
  expect(within(dialog).getByTestId("docx-recovery-discard")).toBeDisabled();
  expect(dialog).toHaveTextContent(text.pendingSaveHelp);
  expect(within(dialog).getByTestId("docx-recovery-download")).toBeEnabled();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Response lost"));
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(within(dialog).getByTestId("docx-recovery-discard")).toBeDisabled();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
  expect(mocks.commit.mock.calls[0]).toEqual(mocks.commit.mock.calls[1]);
});

it("settles a historical save but retains recovery when Workbench now has a newer baseline", async () => {
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.list.mockResolvedValue({ snapshots: [pendingSnapshot], failures: [] });
  mocks.commit.mockResolvedValue({ baselineId: "historical-saved", sourceSha256: candidate.contentSha256, revision: 8 });
  const dialog = await showCandidates();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text.savedHistorical));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(within(dialog).getByTestId("docx-recovery-download")).toBeEnabled();
  expect(within(dialog).getByTestId("docx-recovery-discard")).toBeEnabled();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-discard"));
  fireEvent.click(screen.getByTestId("docx-recovery-confirm-discard"));
  await waitFor(() => expect(mocks.discard).toHaveBeenCalledOnce());
  expect(mocks.commit).toHaveBeenCalledOnce();
});

it("does not discard a selection that gained an unconfirmed fixed save", async () => {
  const dialog = await showCandidates();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-discard"));
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.list.mockResolvedValue({ snapshots: [pendingSnapshot], failures: [] });
  fireEvent.click(screen.getByTestId("docx-recovery-confirm-discard"));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-recovery-confirm-discard").closest('[role="dialog"]')).toHaveTextContent(text.pendingSaveHelp);
});

it.each(["BASELINE_CONFLICT", "REJECTED", "IDEMPOTENCY_CONFLICT"])("keeps a refused %s request in the list for download or discard", async (refusal) => {
  mocks.list.mockResolvedValue({ snapshots: [pendingSnapshot], failures: [] });
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.commit.mockResolvedValueOnce({ refusal });
  const dialog = await showCandidates();
  expect(within(dialog).getByTestId("docx-recovery-discard")).toBeDisabled();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`${text.saveRefused} (${refusal})`));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.openProject).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
  expect(within(dialog).getByTestId("docx-recovery-download")).toBeEnabled();
  expect(within(dialog).getByTestId("docx-recovery-discard")).toBeEnabled();
  fireEvent.click(within(dialog).getByRole("button", { name: text.refresh }));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent(refusal);
  fireEvent.click(within(dialog).getByTestId("docx-recovery-discard"));
  fireEvent.click(screen.getByTestId("docx-recovery-confirm-discard"));
  await waitFor(() => expect(mocks.discard).toHaveBeenCalledExactlyOnceWith(pendingSnapshot));
  expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(pendingSnapshot);
});

it("keeps a different snapshot hash unconfirmed after a known refusal", async () => {
  mocks.list.mockResolvedValue({ snapshots: [pendingSnapshot], failures: [] });
  mocks.read.mockResolvedValue(pendingSnapshot);
  mocks.commit.mockResolvedValueOnce({ refusal: "REJECTED" });
  const dialog = await showCandidates();
  fireEvent.click(within(dialog).getByTestId("docx-recovery-restore"));
  await waitFor(() => expect(within(dialog).getByTestId("docx-recovery-discard")).toBeEnabled());
  mocks.list.mockResolvedValue({ snapshots: [{ ...pendingSnapshot, contentSha256: "d".repeat(64) }], failures: [] });
  fireEvent.click(within(dialog).getByRole("button", { name: text.refresh }));
  await waitFor(() => expect(within(dialog).getByTestId("docx-recovery-discard")).toBeDisabled());
});

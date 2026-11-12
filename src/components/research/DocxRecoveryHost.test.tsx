// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxRecoveryMetadata } from "@/lib/docx-recovery";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), read: vi.fn(), discard: vi.fn(), connect: vi.fn(), workspace: vi.fn(), journal: vi.fn(), openProject: vi.fn(), open: vi.fn(),
  files: { projectId: null as string | null, projects: [{ id: "app-project", name: "Paper project" }] },
}));
vi.mock("@/lib/docx-recovery", () => ({ listDocxRecovery: mocks.list, readDocxRecovery: mocks.read, discardDocxRecovery: mocks.discard }));
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

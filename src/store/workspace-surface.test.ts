// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalProject } from "@/lib/journal-workbench";
import type { MaterialDocument } from "@/lib/material-surface";
import { useDocxWorkspaceStore } from "./docx-workspace";
import { openMaterialAnnotations, useMaterialAnnotationsStore } from "./material-annotations";
import { useSettingsStore } from "./settings";
import { useWorkspaceSurfaceStore } from "./workspace-surface";

beforeEach(() => {
  useDocxWorkspaceStore.setState({ request: null, context: null, minimized: false, closingBlocked: false });
  useMaterialAnnotationsStore.getState().close();
  useWorkspaceSurfaceStore.setState({ active: "files", journalOpen: false, journalBusy: false, journalSidebarTarget: null });
  useSettingsStore.setState({ workspaceHidden: false, assistantOpen: true });
});

it("reveals hidden surfaces while preserving the active editing request and annotation binding", () => {
  const request = { appProjectId: "paper", project: { project_id: "working" } as JournalProject, world: null, onSaved: vi.fn(async () => {}) };
  useDocxWorkspaceStore.getState().open(request);
  useDocxWorkspaceStore.getState().setClosingBlocked(true);
  const material: MaterialDocument = { projectId: "paper", documentId: "working", title: "Paper", kind: "docx", path: null,
    revision: "working-revision", source: { bytes: new Uint8Array([80, 75]) } };
  const beforeStartTask = vi.fn(async () => {});
  openMaterialAnnotations(material, { kind: "object", id: "paragraph-2" }, { beforeStartTask });
  const annotations = useMaterialAnnotationsStore.getState();
  const workspace = useWorkspaceSurfaceStore.getState();
  for (const [navigate, active] of [[workspace.showFiles, "files"], [workspace.showMaterial, "material"], [workspace.openJournal, "journal"], [workspace.showWord, "word"]] as const) {
    useSettingsStore.setState({ workspaceHidden: true });
    navigate();
    expect(useWorkspaceSurfaceStore.getState().active).toBe(active);
    expect(useSettingsStore.getState()).toMatchObject({ workspaceHidden: false, assistantOpen: true });
    expect(useDocxWorkspaceStore.getState()).toMatchObject({ request, closingBlocked: true });
    expect(useDocxWorkspaceStore.getState().request).toBe(request);
    expect(useMaterialAnnotationsStore.getState()).toBe(annotations);
  }
  expect(beforeStartTask).not.toHaveBeenCalled();
});

it("returns to files when closing the active journal and preserves another active surface when closing an inactive journal", () => {
  const workspace = useWorkspaceSurfaceStore.getState();
  workspace.openJournal();
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ active: "journal", journalOpen: true });
  workspace.closeJournal();
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ active: "files", journalOpen: false });
  workspace.openJournal();
  workspace.showWord();
  workspace.closeJournal();
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ active: "word", journalOpen: false });
});

it("keeps journal work and its sidebar host across surface navigation until their owner clears them", () => {
  const workspace = useWorkspaceSurfaceStore.getState();
  const sidebar = document.createElement("aside");
  workspace.setJournalSidebarTarget(sidebar);
  workspace.setJournalBusy(true);
  workspace.openJournal();
  workspace.showMaterial();
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ active: "material", journalOpen: true, journalBusy: true, journalSidebarTarget: sidebar });
  workspace.setJournalSidebarTarget(null);
  workspace.setJournalBusy(false);
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ journalSidebarTarget: null, journalBusy: false });
});

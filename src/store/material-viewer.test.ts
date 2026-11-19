import { beforeEach, describe, expect, it } from "vitest";
import { useMaterialViewerStore, type MaterialViewerRequest } from "./material-viewer";
import { useWorkspaceSurfaceStore } from "./workspace-surface";
import { useSettingsStore } from "./settings";

const request: MaterialViewerRequest = { projectId: "project", documentId: "paper", kind: "pdf", title: "Paper",
  revision: "a".repeat(64), load: async () => new Uint8Array([1]) };

beforeEach(() => {
  useMaterialViewerStore.setState({ request: null, visits: [], returnSurface: "files" });
  useWorkspaceSurfaceStore.setState({ active: "files", journalOpen: false });
  useSettingsStore.setState({ assistantOpen: true, workspaceHidden: false });
});

describe("retained materials in the central workspace", () => {
  it("opens and restores a material without changing the Agent panel", () => {
    useSettingsStore.setState({ workspaceHidden: true });
    useMaterialViewerStore.getState().open(request);
    expect(useWorkspaceSurfaceStore.getState().active).toBe("material");
    expect(useSettingsStore.getState()).toMatchObject({ assistantOpen: true, workspaceHidden: false });
    useWorkspaceSurfaceStore.getState().showFiles();
    useMaterialViewerStore.getState().restore();
    expect(useMaterialViewerStore.getState().request).toBe(request);
    expect(useWorkspaceSurfaceStore.getState().active).toBe("material");
  });

  it("returns to the Word surface after replacing one retained material with another", () => {
    useWorkspaceSurfaceStore.getState().showWord();
    useMaterialViewerStore.getState().open(request);
    useMaterialViewerStore.getState().open({ ...request, revision: "b".repeat(64) });
    useMaterialViewerStore.getState().close();
    expect(useWorkspaceSurfaceStore.getState().active).toBe("word");
    expect(useMaterialViewerStore.getState().request).toBeNull();
  });

  it("clears an inactive retained material without stealing the current surface", () => {
    useMaterialViewerStore.getState().open(request);
    useWorkspaceSurfaceStore.getState().openJournal();
    useMaterialViewerStore.getState().close();
    expect(useWorkspaceSurfaceStore.getState().active).toBe("journal");
  });

  it("returns through exact material visits before returning to the working surface", () => {
    useWorkspaceSurfaceStore.getState().showWord();
    const second = { ...request, documentId: "report", revision: "b".repeat(64) };
    useMaterialViewerStore.getState().open(request);
    useMaterialViewerStore.getState().open(second);
    expect(useMaterialViewerStore.getState().visits.map((visit) => visit.request)).toEqual([request, second]);
    useMaterialViewerStore.getState().back();
    expect(useMaterialViewerStore.getState().request).toBe(request);
    expect(useWorkspaceSurfaceStore.getState().active).toBe("material");
    useMaterialViewerStore.getState().back();
    expect(useWorkspaceSurfaceStore.getState().active).toBe("word");
    expect(useMaterialViewerStore.getState().visits).toEqual([]);
  });

  it("starts a new visit chain after user returns to work or changes projects", () => {
    useMaterialViewerStore.getState().open(request);
    useWorkspaceSurfaceStore.getState().showFiles();
    useMaterialViewerStore.getState().open({ ...request, documentId: "another" });
    expect(useMaterialViewerStore.getState().visits).toHaveLength(1);
    useMaterialViewerStore.getState().open({ ...request, projectId: "another-project" });
    expect(useMaterialViewerStore.getState().visits).toHaveLength(1);
  });
});

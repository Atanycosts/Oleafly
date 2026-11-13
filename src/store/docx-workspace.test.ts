import { beforeEach, expect, it, vi } from "vitest";
import type { JournalProject, JournalWorld } from "@/lib/journal-workbench";
import { useDocxWorkspaceStore, type DocxWorkspaceRequest } from "./docx-workspace";

function request(overrides: Partial<DocxWorkspaceRequest> = {}): DocxWorkspaceRequest {
  return {
    appProjectId: "app-project",
    project: { project_id: "manuscript", baseline_id: "original" } as JournalProject,
    world: null,
    onSaved: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => useDocxWorkspaceStore.getState().close());

it("updates the same document's context while retaining its preparation request", () => {
  const store = useDocxWorkspaceStore.getState();
  const original = request();
  store.open(original);
  store.minimize();
  const next = request({
    project: { ...original.project, baseline_id: "newer-snapshot" },
    world: { version_id: "world-next" } as JournalWorld,
  });
  store.open(next);
  const state = useDocxWorkspaceStore.getState();
  expect(state.request).toBe(original);
  expect(state.request?.project.baseline_id).toBe("original");
  expect(state.context).toEqual({ world: next.world, onSaved: next.onSaved });
  expect(state.minimized).toBe(false);
});

it.each([
  { appProjectId: "another-app" },
  { project: { project_id: "another-manuscript" } as JournalProject },
])("does not change the active context for a different document: %j", (identity) => {
  const store = useDocxWorkspaceStore.getState();
  const original = request({ world: { version_id: "world-original" } as JournalWorld });
  store.open(original);
  const context = useDocxWorkspaceStore.getState().context;
  store.minimize();
  store.open(request({ ...identity, world: null }));
  expect(useDocxWorkspaceStore.getState()).toMatchObject({ request: original, context, minimized: false });
  expect(useDocxWorkspaceStore.getState().context).toBe(context);
});

it("clears context on close and initializes it for the next document", () => {
  const store = useDocxWorkspaceStore.getState();
  store.open(request());
  store.close();
  expect(useDocxWorkspaceStore.getState()).toMatchObject({ request: null, context: null });
  const next = request({ appProjectId: "next-app" });
  store.open(next);
  expect(useDocxWorkspaceStore.getState().request).toBe(next);
  expect(useDocxWorkspaceStore.getState().context).toEqual({ world: null, onSaved: next.onSaved });
});

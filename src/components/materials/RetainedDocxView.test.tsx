// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { EditorSnapshot } from "@docx-editor.dev/core/contracts/editor";
import type { MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { MaterialViewContext } from "./MaterialViewContext";
import { RetainedDocxView } from "./RetainedDocxView";

const mocks = vi.hoisted(() => ({
  listener: null as (() => void) | null,
  unsubscribe: vi.fn(),
  snapshot: {
    isLoading: false,
    isOpening: false,
    parseError: null,
    page: { total: 1 },
    selectionCollapsed: true,
    selection: null as EditorSnapshot["selection"],
  },
  query: vi.fn(() => "Selected retained text"),
  scrollToAnchor: vi.fn(),
  highlightAnchor: vi.fn(),
}));

vi.mock("@docx-editor.dev/react", () => {
  const editor = {
    snapshot: () => mocks.snapshot,
    query: mocks.query,
    scrollToAnchor: mocks.scrollToAnchor,
    highlightAnchor: mocks.highlightAnchor,
    on: (_event: string, listener: () => void) => {
      mocks.listener = listener;
      return () => { mocks.listener = null; mocks.unsubscribe(); };
    },
  };
  return {
    useDocxEditor: () => editor,
    useFonts: (source: unknown) => source,
    useEditorState: (selector: (snapshot: typeof mocks.snapshot) => unknown) => selector(mocks.snapshot),
  };
});
vi.mock("./WordDocument", () => ({ WordDocument: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/docx-fonts", () => ({ createDocxFontResolver: () => () => undefined }));

const document: MaterialDocument = {
  projectId: "project", documentId: "docx:retained", path: null, title: "Retained manuscript", kind: "docx",
  revision: "exact-retained-sha256", source: { bytes: Uint8Array.from([80, 75]) },
};
const bytes = Uint8Array.from([80, 75]);
function view() {
  return <MaterialViewContext document={document} active materialRole="original">
    <RetainedDocxView bytes={bytes} title={document.title} anchor={{ kind: "object", id: "paragraph:original-id" }} />
  </MaterialViewContext>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = null;
  mocks.snapshot.isOpening = false;
  mocks.snapshot.selection = null;
  mocks.snapshot.selectionCollapsed = true;
  useAgentWorkspaceStore.setState({ projectId: document.projectId, views: {} });
});

it("publishes the real retained Word selection with its own revision and no write address", () => {
  const rendered = render(view());
  const current = () => useAgentWorkspaceStore.getState().views[document.projectId];
  expect(mocks.scrollToAnchor).toHaveBeenCalledWith({ paraId: "original-id" });
  expect(current().selection).toBeNull();
  mocks.snapshot.selection = { from: { paraId: "retained-para" }, to: { paraId: "retained-para" } };
  mocks.snapshot.selectionCollapsed = false;
  act(() => mocks.listener?.());
  expect(current()).toMatchObject({ role: "original", revision: document.revision, selection: {
    revision: document.revision,
    anchor: { kind: "object", id: "retained-para", label: "Selected retained text" },
  } });
  expect(current().sessionId).toBeUndefined();
  expect(current().selection?.paragraphRef).toBeUndefined();
  mocks.snapshot.selectionCollapsed = true;
  act(() => mocks.listener?.());
  expect(current().selection).toBeNull();
  rendered.unmount();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.listener).toBeNull();
});

it("waits for the retained document to finish opening before publishing a selected object", () => {
  mocks.snapshot.isOpening = true;
  mocks.snapshot.selection = { from: { paraId: "retained-para" }, to: { paraId: "retained-para" } };
  mocks.snapshot.selectionCollapsed = false;
  const rendered = render(view());
  expect(mocks.listener).toBeNull();
  expect(useAgentWorkspaceStore.getState().views[document.projectId].selection).toBeNull();
  mocks.snapshot.isOpening = false;
  rendered.rerender(view());
  expect(useAgentWorkspaceStore.getState().views[document.projectId].selection?.anchor)
    .toEqual({ kind: "object", id: "retained-para", label: "Selected retained text" });
});

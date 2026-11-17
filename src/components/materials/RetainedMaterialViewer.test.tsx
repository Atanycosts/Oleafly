// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { createMaterialDocument, type MaterialAnchor } from "@/lib/material-surface";
import { useMaterialViewerStore, type MaterialViewerRequest } from "@/store/material-viewer";
import { loadMaterialView, RetainedMaterialViewer } from "./RetainedMaterialViewer";
import en from "@/i18n/locales/en/editor.json";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";

const renders = vi.hoisted(() => ({ currentMounts: 0, currentUnmounts: 0,
  pdf: vi.fn(), image: vi.fn(), docx: vi.fn(), source: vi.fn(), diagram: vi.fn(), html: vi.fn(), markdown: vi.fn(),
}));
vi.mock("./MaterialPdfView", async () => {
  const { useEffect } = await import("react");
  return { MaterialPdfView: function Pdf(props: ComponentProps<typeof import("./MaterialPdfView").MaterialPdfView>) {
    renders.pdf(props);
    const { document } = props;
    useEffect(() => {
      if (document.title === "Current") renders.currentMounts += 1;
      return () => { if (document.title === "Current") renders.currentUnmounts += 1; };
    }, [document.title]);
    return <span>{document.title}</span>;
  } };
});
vi.mock("./MaterialImageView", () => ({ MaterialImageView: (props: ComponentProps<typeof import("./MaterialImageView").MaterialImageView>) => { renders.image(props); return <div data-testid="image-renderer" />; } }));
vi.mock("./RetainedDocxView", () => ({ RetainedDocxView: (props: ComponentProps<typeof import("./RetainedDocxView").RetainedDocxView>) => { renders.docx(props); return <div data-testid="docx-renderer" />; } }));
vi.mock("./RetainedSourceView", () => ({ RetainedSourceView: (props: ComponentProps<typeof import("./RetainedSourceView").RetainedSourceView>) => { renders.source(props); return <div data-testid="source-renderer" />; } }));
vi.mock("./RetainedDiagramView", () => ({ RetainedDiagramView: (props: ComponentProps<typeof import("./RetainedDiagramView").RetainedDiagramView>) => { renders.diagram(props); return <div data-testid="diagram-renderer" />; } }));
vi.mock("./MaterialHtmlView", () => ({ MaterialHtmlView: (props: ComponentProps<typeof import("./MaterialHtmlView").MaterialHtmlView>) => { renders.html(props); return <div data-testid="html-renderer" />; } }));
vi.mock("@/components/editor/MarkdownPreview", () => ({ MarkdownPreview: (props: ComponentProps<typeof import("@/components/editor/MarkdownPreview").MarkdownPreview>) => { renders.markdown(props); return <div data-testid="markdown-renderer" />; } }));
beforeEach(() => {
  vi.clearAllMocks();
  useAgentWorkspaceStore.setState({ views: {} });
  useMaterialViewerStore.setState({ request: null, visits: [], returnSurface: "files" });
  useMaterialAnnotationsStore.getState().close();
  useWorkspaceSurfaceStore.setState({ active: "files", journalOpen: false });
});
afterEach(() => vi.unstubAllGlobals());

async function request(text: string): Promise<MaterialViewerRequest> {
  const document = await createMaterialDocument({ projectId: "project", documentId: "paper", path: null, kind: "pdf", title: "Current" }, { text });
  return { ...document, load: async () => text };
}

it("verifies the captured bytes instead of displaying content under an unrelated revision", async () => {
  const version = await request("retained\r\nbytes");
  const loaded = await loadMaterialView(version, { ...version, revision: `sha256:${version.revision}` });
  expect(new TextDecoder().decode(loaded.bytes)).toBe("retained\r\nbytes");
  expect(loaded.document.revision).toBe(version.revision);
  await expect(loadMaterialView(version, { ...version, load: async () => "changed" })).rejects.toThrow("material_version_mismatch");
});

it("keeps both renderers mounted while switching the spatial stack and a single version", async () => {
  renders.currentMounts = 0;
  renders.currentUnmounts = 0;
  const current = await request("current");
  const previous = await request("earlier");
  render(<RetainedMaterialViewer request={{ ...current, previous: { ...previous, title: "Earlier" } }} />);
  await screen.findByText("Current", { selector: "span" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.compare }), { button: 0, ctrlKey: false });
  await screen.findByText("Earlier", { selector: "span" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.single }), { button: 0, ctrlKey: false });
  expect(screen.getByText("Earlier", { selector: "span" }).closest("[data-version=previous]")).toHaveAttribute("hidden");
  expect(screen.getByTestId("material-version-stack")).toHaveAttribute("data-mode", "current");
  expect(renders).toMatchObject({ currentMounts: 1, currentUnmounts: 0 });
});

it("discards a delayed load after another material has opened", async () => {
  const current = await request("current");
  const old = await request("earlier");
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const view = render(<RetainedMaterialViewer request={{ ...old, title: "Old", load: () => pending }} />);
  view.rerender(<RetainedMaterialViewer request={current} />);
  await screen.findByText("Current", { selector: "span" });
  await act(async () => { finish("earlier"); });
  expect(screen.queryByText("Old", { selector: "span" })).toBeNull();
});

it.each([undefined, "task_input", "checked"] as const)("publishes the visible version's own %s role and ignores a retained hidden visit", async (role) => {
  const current = await request("current");
  const previous = await request("earlier");
  const view = render(<RetainedMaterialViewer request={{ ...current, role: "result", previous: { ...previous, title: "Earlier", role } }} />);
  await waitFor(() => expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: current.revision, role: "result" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.compare }), { button: 0, ctrlKey: false });
  await screen.findByText("Earlier", { selector: "span" });
  fireEvent.click(screen.getByRole("button", { name: en.materials.previous }));
  await waitFor(() => expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: previous.revision, role: role ?? "evidence" }));
  act(() => useAgentWorkspaceStore.getState().publishView({ projectId: "project", documentId: "working", title: "Working", kind: "docx", revision: "7", role: "working" }));
  view.rerender(<RetainedMaterialViewer request={current} active={false} />);
  await screen.findByText("Current", { selector: "span" });
  expect(useAgentWorkspaceStore.getState().views.project.documentId).toBe("working");
});

it("freezes binary content independently of the loader's mutable buffer", async () => {
  const bytes = new Uint8Array([80, 75, 0, 255]);
  const document = await createMaterialDocument({ projectId: "project", documentId: "word", path: "paper.docx", kind: "docx", title: "Paper" }, { bytes });
  const version: MaterialViewerRequest = { ...document, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", load: async () => bytes };
  const loaded = await loadMaterialView(version, version);
  bytes[0] = 0;
  expect(loaded.bytes).toEqual(new Uint8Array([80, 75, 0, 255]));
  expect(loaded.document.source).toMatchObject({ bytes: new Uint8Array([80, 75, 0, 255]), mediaType: version.mediaType });
  expect(loaded.document).toMatchObject({ documentId: "word", path: "paper.docx", revision: document.revision });
});

it("renders the verified snapshot when the loader's buffer changes during hashing", async () => {
  const content = "Retained\r\nsource";
  const bytes = new TextEncoder().encode(content);
  const document = await createMaterialDocument({ projectId: "project", documentId: "source", path: "main.tex", kind: "source", title: "Source" }, { bytes });
  const version: MaterialViewerRequest = { ...document, load: async () => bytes };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const pendingHash = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, input) => {
    const result = await digest(algorithm, input);
    bytes.fill(0);
    return result;
  });
  try {
    const loaded = await loadMaterialView(version, version);
    expect(loaded.document.revision).toBe(document.revision);
    expect(Array.from(loaded.bytes)).toEqual(Array.from(new TextEncoder().encode(content)));
    expect(loaded.text).toBe(content);
  } finally {
    pendingHash.mockRestore();
  }
});

it.each([
  { kind: "source", testId: "source-renderer", path: "notes/main.tex", anchor: { kind: "text", from: 2, to: 5, quote: "句子" } },
  { kind: "diagram", testId: "diagram-renderer", path: null, anchor: { kind: "object", id: "node-1" } },
  { kind: "markdown", testId: "markdown-renderer", path: "notes/summary.md", anchor: { kind: "text", from: 0, to: 4, quote: "标题" } },
  { kind: "html", testId: "html-renderer", path: null, anchor: { kind: "html", selector: "#summary", quote: "句子" } },
] as const)("opens the retained $kind renderer with its exact text, identity and anchor", async ({ kind, testId, path, anchor }) => {
  const content = "标题\r\n句子 — retained text";
  const document = await createMaterialDocument({ projectId: "project", documentId: `file:${kind}`, path, kind, title: "Retained source" }, { text: content });
  const version: MaterialViewerRequest = { ...document, anchor, load: async () => new TextEncoder().encode(content) };
  render(<RetainedMaterialViewer request={version} />);
  await screen.findByTestId(testId);
  const renderer = renders[kind];
  const props = renderer.mock.calls.at(-1)?.[0];
  expect(props).toMatchObject({ anchor, document: { projectId: "project", documentId: document.documentId, path, kind, revision: document.revision } });
  if (kind === "html") expect(props.bundle).toBe(content);
  else {
    expect(props.content).toBe(content);
    expect(props.path).toBe(path ?? document.title);
  }
  if (kind === "markdown") expect(props.projectId).toBe("project");
  expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: document.revision, role: "evidence", kind });
});

it("opens Markdown without a project path using the renderer's empty-path contract", async () => {
  const document = await createMaterialDocument({ projectId: "project", documentId: "generated-markdown", path: null, kind: "markdown", title: "Generated summary" }, { text: "# Summary" });
  render(<RetainedMaterialViewer request={{ ...document, load: async () => "# Summary" }} />);
  await screen.findByTestId("markdown-renderer");
  expect(renders.markdown.mock.calls.at(-1)?.[0]).toMatchObject({ content: "# Summary", path: "", projectId: "project" });
});

it("opens retained Word bytes at their anchor and creates whole-document feedback for that same version", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const document = await createMaterialDocument({ projectId: "project", documentId: "word", path: null, kind: "docx", title: "Paper original" }, { bytes });
  const anchor = { kind: "object" as const, id: "paragraph-3" };
  render(<RetainedMaterialViewer request={{ ...document, anchor, load: async () => bytes }} />);
  await screen.findByTestId("docx-renderer");
  expect(renders.docx.mock.calls.at(-1)?.[0]).toEqual({ bytes, title: document.title, anchor });
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateWhole }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document: { documentId: "word", revision: document.revision, source: { bytes } }, anchor: { kind: "whole" }, options: {} });
});

it.each([
  { anchor: { kind: "page", page: 4, rects: [] }, page: 4 },
  { anchor: { kind: "pdf", pages: [{ page: 6, rects: [] }], rotation: 0 }, page: 6 },
  { anchor: undefined, page: 1 },
  { anchor: { kind: "page", page: 4, rects: [] }, initialPage: 2, page: 2 },
] satisfies { anchor?: MaterialAnchor; initialPage?: number; page: number }[])("passes the retained PDF anchor and initial page $page to the viewer", async ({ anchor, page, ...options }) => {
  const current = await request("pdf bytes");
  render(<RetainedMaterialViewer request={{ ...current, anchor, ...options }} />);
  await screen.findByText("Current", { selector: "span" });
  expect(renders.pdf.mock.calls.at(-1)?.[0]).toMatchObject({ anchor, initialPage: page, document: { revision: current.revision }, bytes: new TextEncoder().encode("pdf bytes") });
});

it("creates an image URL with its retained media type and revokes each URL on replacement and unmount", async () => {
  let urlSequence = 0;
  const createObjectURL = vi.fn<(object: Blob) => string>(() => `blob:retained-image-${++urlSequence}`);
  const revokeObjectURL = vi.fn();
  const NativeURL = URL;
  class ImageURL extends NativeURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", ImageURL);
  const firstBytes = new Uint8Array([1, 2, 3]);
  const first = await createMaterialDocument({ projectId: "project", documentId: "image", path: "scan.bin", kind: "image", title: "Scan" }, { bytes: firstBytes });
  const second = await createMaterialDocument({ ...first, path: "figure.png" }, { bytes: new Uint8Array([4, 5, 6]) });
  const anchor = { kind: "region" as const, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
  const view = render(<RetainedMaterialViewer request={{ ...first, mediaType: "image/jpeg", anchor, load: async () => firstBytes }} />);
  await waitFor(() => expect(renders.image.mock.calls.at(-1)?.[0]).toMatchObject({ src: "blob:retained-image-1", anchor, document: { revision: first.revision } }));
  const firstBlob = createObjectURL.mock.calls[0][0] as Blob;
  expect(firstBlob.type).toBe("image/jpeg");
  expect(firstBlob.size).toBe(firstBytes.byteLength);
  view.rerender(<RetainedMaterialViewer request={{ ...second, load: async () => new Uint8Array([4, 5, 6]) }} />);
  await waitFor(() => expect(renders.image.mock.calls.at(-1)?.[0]).toMatchObject({ document: { revision: second.revision } }));
  expect(renders.image.mock.calls.at(-1)?.[0].src).not.toBe("blob:retained-image-1");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:retained-image-1");
  expect(createObjectURL.mock.calls.at(-1)?.[0].type).toBe("image/png");
  view.unmount();
  expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(createObjectURL.mock.results.map(({ value }) => value));
});

it.each(["load", "hash"] as const)("keeps the renderer hidden after a %s failure and retries the retained loader", async (failure) => {
  const current = await request("retained");
  const load = vi.fn<MaterialViewerRequest["load"]>();
  if (failure === "load") load.mockRejectedValueOnce(new Error("Retained source is temporarily unavailable"));
  else load.mockResolvedValueOnce("different bytes");
  load.mockResolvedValue("retained");
  render(<RetainedMaterialViewer request={{ ...current, load }} />);
  expect(await screen.findByText(failure === "hash" ? en.materials.verifyFailed : "Retained source is temporarily unavailable")).toBeInTheDocument();
  expect(renders.pdf).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: en.materials.retry }));
  await screen.findByText("Current", { selector: "span" });
  expect(load).toHaveBeenCalledTimes(2);
  expect(renders.pdf.mock.calls.at(-1)?.[0].document.revision).toBe(current.revision);
});

it("returns through retained visits before leaving the material surface and closes to the working surface", async () => {
  const first = { ...await request("first"), title: "First material" };
  const second = { ...await request("second"), title: "Second material" };
  useWorkspaceSurfaceStore.getState().showWord();
  useMaterialViewerStore.getState().open(first);
  useMaterialViewerStore.getState().open(second);
  const view = render(<RetainedMaterialViewer request={second} />);
  const backLabel = en.materials.backToMaterial.replace("{{title}}", first.title);
  fireEvent.click(screen.getByRole("button", { name: backLabel }));
  expect(useMaterialViewerStore.getState().request).toBe(first);
  expect(useWorkspaceSurfaceStore.getState().active).toBe("material");
  view.rerender(<RetainedMaterialViewer request={first} />);
  fireEvent.click(screen.getByRole("button", { name: en.materials.backToWorkspace }));
  expect(useMaterialViewerStore.getState()).toMatchObject({ request: null, visits: [] });
  expect(useWorkspaceSurfaceStore.getState().active).toBe("word");
  act(() => useMaterialViewerStore.getState().open(second));
  view.rerender(<RetainedMaterialViewer request={second} />);
  fireEvent.click(screen.getByRole("button", { name: en.materials.close }));
  expect(useMaterialViewerStore.getState().request).toBeNull();
  expect(useWorkspaceSurfaceStore.getState().active).toBe("word");
});

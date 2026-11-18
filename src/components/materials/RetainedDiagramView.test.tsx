// @vitest-environment jsdom
import { createContext } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RetainedDiagramView } from "./RetainedDiagramView";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import en from "@/i18n/locales/en/editor.json";

const diagramHarness = vi.hoisted(() => ({
  kind: null as "mermaid" | "typst" | null,
  load: vi.fn(async () => {}),
  read: vi.fn(),
  fromStandalone: vi.fn(),
  mermaidBlocks: vi.fn(),
  fromSource: vi.fn(),
}));

vi.mock("@/components/diagram/diagram-kit", () => ({ KIT: {} }));
vi.mock("@oleafly/latex", () => ({ diagramFromSource: diagramHarness.fromSource }));
vi.mock("@oleafly/diagram", () => ({
  DiagramKitContext: createContext({}),
  languageForPath: () => diagramHarness.kind,
  diagramLanguage: () => ({
    load: diagramHarness.load,
    read: diagramHarness.read,
    fromStandalone: diagramHarness.fromStandalone,
  }),
  mermaidBlocks: diagramHarness.mermaidBlocks,
  DiagramCanvas: ({ model }: { model: { nodes: Array<{ id: string }> } }) => {
    const id = model.nodes[0].id;
    return <div data-id={id}>{id === "node-a" ? "Original object" : id}</div>;
  },
}));

beforeEach(() => {
  diagramHarness.kind = null;
  diagramHarness.load.mockReset();
  diagramHarness.load.mockResolvedValue(undefined);
  diagramHarness.read.mockReset();
  diagramHarness.fromStandalone.mockReset();
  diagramHarness.mermaidBlocks.mockReset();
  diagramHarness.fromSource.mockReset();
  diagramHarness.fromSource.mockReturnValue({
    nodes: [{ id: "node-a" }],
    edges: [],
  });
});

it("reveals the original node id and adds feedback against the retained document", async () => {
  const document = { projectId: "p", documentId: "stable-diagram", path: "figure.tex", title: "Figure", kind: "diagram" as const, revision: "frozen", source: { text: "original source" } };
  render(<RetainedDiagramView document={document} content="original source" path="figure.tex" anchor={{ kind: "object", id: "node-a" }} />);
  await waitFor(() => expect(screen.getByText("Original object")).toHaveAttribute("data-material-anchor", "true"));
  fireEvent.click(screen.getByRole("button", { name: en.materials.diagramObject }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document, anchor: { kind: "object", id: "node-a" } });
});

it("loads a fenced Mermaid diagram and a standalone Typst diagram", async () => {
  const fenced = "```mermaid\ngraph TD; A-->B\n```";
  diagramHarness.kind = "mermaid";
  diagramHarness.mermaidBlocks.mockReturnValue([{ code: "graph TD; A-->B" }]);
  diagramHarness.read.mockReturnValue({
    model: { nodes: [{ id: "mermaid-node" }], edges: [] },
  });
  const first = render(
    <RetainedDiagramView
      content={fenced}
      path="diagram.md"
    />,
  );

  expect(await screen.findByText("mermaid-node")).toBeInTheDocument();
  expect(diagramHarness.load).toHaveBeenCalledOnce();
  expect(diagramHarness.mermaidBlocks).toHaveBeenCalledWith(fenced);
  expect(diagramHarness.read).toHaveBeenCalledWith("graph TD; A-->B");
  first.unmount();

  diagramHarness.kind = "typst";
  const typst = "#import \"@preview/fletcher:0.5.8\": diagram\n#diagram()";
  diagramHarness.fromStandalone.mockReturnValue({ code: "#diagram()" });
  diagramHarness.read.mockReturnValue({ model: { nodes: [{ id: "typst-node" }], edges: [] } });
  render(
    <RetainedDiagramView
      content={typst}
      path="diagram.typ"
    />,
  );

  expect(await screen.findByText("typst-node")).toBeInTheDocument();
  expect(diagramHarness.fromStandalone).toHaveBeenCalledWith(typst);
  expect(diagramHarness.read).toHaveBeenLastCalledWith("#diagram()");
});

it("ignores a stale async engine result after the retained source changes", async () => {
  diagramHarness.kind = "mermaid";
  diagramHarness.mermaidBlocks.mockReturnValue([]);
  let finishLoadingOld!: () => void;
  diagramHarness.load.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishLoadingOld = resolve;
  }));
  diagramHarness.read.mockImplementation((source: string) => ({
    model: { nodes: [{ id: source }], edges: [] },
  }));
  const view = render(
    <RetainedDiagramView content="old-node" path="diagram.mmd" />,
  );
  expect(diagramHarness.load).toHaveBeenCalledOnce();

  view.rerender(
    <RetainedDiagramView content="new-node" path="diagram.mmd" />,
  );
  expect(await screen.findByText("new-node")).toBeInTheDocument();

  await act(async () => { finishLoadingOld(); });
  expect(screen.queryByText("old-node")).not.toBeInTheDocument();
  expect(screen.getByText("new-node")).toBeInTheDocument();
});

it("shows engine failures and does not render an empty engine result", async () => {
  diagramHarness.kind = "mermaid";
  diagramHarness.mermaidBlocks.mockReturnValue([{ code: "broken" }]);
  diagramHarness.load.mockRejectedValueOnce(new Error("Engine failed"));
  const first = render(
    <RetainedDiagramView content="broken" path="diagram.md" />,
  );

  expect(await screen.findByText(/Engine failed/)).toBeInTheDocument();
  first.unmount();

  diagramHarness.read.mockReturnValueOnce({ model: null });
  render(<RetainedDiagramView content="empty" path="diagram.md" />);
  expect(
    await screen.findByText(en.materials.notRenderable),
  ).toBeInTheDocument();
});

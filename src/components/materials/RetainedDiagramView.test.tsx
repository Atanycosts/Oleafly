// @vitest-environment jsdom
import { createContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RetainedDiagramView } from "./RetainedDiagramView";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import en from "@/i18n/locales/en/editor.json";
vi.mock("@/components/diagram/diagram-kit", () => ({ KIT: {} }));
vi.mock("@oleafly/latex", () => ({ diagramFromSource: () => ({ nodes: [{ id: "node-a" }], edges: [] }) }));
vi.mock("@oleafly/diagram", () => ({ DiagramKitContext: createContext({}), languageForPath: () => "tikz", diagramLanguage: vi.fn(), mermaidBlocks: vi.fn(), DiagramCanvas: () => <div data-id="node-a">{"Original object"}</div> }));
it("reveals the original node id and adds feedback against the retained document", async () => {
  const document = { projectId: "p", documentId: "stable-diagram", path: "figure.tex", title: "Figure", kind: "diagram" as const, revision: "frozen", source: { text: "original source" } };
  render(<RetainedDiagramView document={document} content="original source" path="figure.tex" anchor={{ kind: "object", id: "node-a" }} />);
  await waitFor(() => expect(screen.getByText("Original object")).toHaveAttribute("data-material-anchor", "true"));
  fireEvent.click(screen.getByRole("button", { name: en.materials.diagramObject }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document, anchor: { kind: "object", id: "node-a" } });
});

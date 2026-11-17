// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import en from "@/i18n/locales/en/editor.json";
import type { MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { MaterialViewContext } from "./MaterialViewContext";
import { RetainedSourceView } from "./RetainedSourceView";

const material: MaterialDocument = {
  projectId: "paper", documentId: "file:paper.md", title: "Retained paper", path: "paper.md",
  kind: "markdown", revision: "retained-version", source: { text: "First retained paragraph" },
};

function editor() {
  const content = screen.getByTestId("retained-source-view").querySelector<HTMLElement>(".cm-content");
  const view = content && EditorView.findFromDOM(content);
  if (!view) throw new Error("Retained source editor did not mount");
  return view;
}

beforeEach(() => {
  useMaterialAnnotationsStore.getState().close();
  useAgentWorkspaceStore.setState({ views: {} });
});

it("shows retained source as read-only and opens whole-material feedback without needing a selection", () => {
  render(<RetainedSourceView document={material} content="First retained paragraph" path="paper.md" />);
  expect(editor().state.doc.toString()).toBe("First retained paragraph");
  expect(editor().state.readOnly).toBe(true);
  expect(editor().contentDOM).toHaveAttribute("contenteditable", "false");
  expect(screen.getByRole("button", { name: en.materials.annotateSelection })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateWhole }));
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document: material, anchor: { kind: "whole" } });
});

it("publishes the actual selected quote and binds feedback to the displayed retained revision", () => {
  render(<MaterialViewContext document={material} active materialRole="evidence">
    <RetainedSourceView document={material} content="First retained paragraph" path="paper.md" />
  </MaterialViewContext>);
  const view = editor();
  act(() => view.dispatch({ selection: { anchor: 6, head: 14 } }));
  const anchor = { kind: "text", from: 6, to: 14, quote: "retained" };
  expect(useAgentWorkspaceStore.getState().views.paper.selection).toEqual({ revision: material.revision, anchor });
  const selectionButton = screen.getByRole("button", { name: en.materials.annotateSelection });
  expect(fireEvent.mouseDown(selectionButton)).toBe(false);
  fireEvent.click(selectionButton);
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document: material, anchor });
  act(() => view.dispatch({ selection: { anchor: 6 } }));
  expect(selectionButton).toBeDisabled();
  expect(useAgentWorkspaceStore.getState().views.paper.selection).toBeNull();
});

it("restores bounded source anchors and destroys the old view when another retained version is shown", () => {
  const rendered = render(<RetainedSourceView document={material} content="First retained paragraph" path="paper.md"
    anchor={{ kind: "text", from: 6, to: 500, quote: "old quote" }} />);
  const previous = editor();
  expect(previous.state.sliceDoc(previous.state.selection.main.from, previous.state.selection.main.to)).toBe("retained paragraph");
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateSelection }));
  expect(useMaterialAnnotationsStore.getState().anchor).toEqual({ kind: "text", from: 6, to: 24, quote: "retained paragraph" });
  rendered.rerender(<RetainedSourceView content="next" path="source.unknown" anchor={{ kind: "text", from: 20, to: 40, quote: "out of bounds" }} />);
  expect(previous.dom.isConnected).toBe(false);
  expect(editor().state.doc.toString()).toBe("next");
  expect(editor().state.selection.main.empty).toBe(true);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  const current = editor();
  rendered.unmount();
  expect(current.dom.isConnected).toBe(false);
});

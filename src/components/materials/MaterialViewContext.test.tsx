// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { MaterialViewContext, useMaterialViewSelection } from "./MaterialViewContext";

function Selection() {
  const [anchor, setAnchor] = useState<MaterialAnchor | null>(null);
  useMaterialViewSelection(anchor);
  const label = "Select content";
  return <button type="button" onClick={() => setAnchor({ kind: "text", from: 2, to: 6, quote: "word" })}>{label}</button>;
}

beforeEach(() => useAgentWorkspaceStore.setState({ views: {} }));

it("updates the visible exact-version selection without exposing it as a writable live address", () => {
  const document: MaterialDocument = { projectId: "project", documentId: "report", title: "Report", kind: "source", path: null, revision: "frozen", source: { text: "a word" } };
  render(<MaterialViewContext document={document} active materialRole="result"><Selection /></MaterialViewContext>);
  fireEvent.click(screen.getByRole("button", { name: "Select content" }));
  expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: "frozen", role: "result",
    selection: { revision: "frozen", anchor: { kind: "text", from: 2, to: 6, quote: "word" } } });
  expect(useAgentWorkspaceStore.getState().views.project.selection?.paragraphRef).toBeUndefined();
});

it("does not carry a selection into a different content revision", () => {
  const document: MaterialDocument = { projectId: "project", documentId: "report", title: "Report", kind: "source", path: null, revision: "first", source: { text: "a word" } };
  const view = render(<MaterialViewContext document={document} active materialRole="working"><Selection /></MaterialViewContext>);
  fireEvent.click(screen.getByRole("button", { name: "Select content" }));
  expect(useAgentWorkspaceStore.getState().views.project.selection).not.toBeNull();
  view.rerender(<MaterialViewContext document={{ ...document, revision: "second", source: { text: "changed" } }} active materialRole="working"><Selection /></MaterialViewContext>);
  expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: "second", selection: null });
});

it("keeps the last interacted surface current while another visible surface updates in the background", () => {
  const source: MaterialDocument = { projectId: "project", documentId: "source", title: "Source", kind: "source", path: null, revision: "first", source: { text: "source" } };
  const pdf: MaterialDocument = { ...source, documentId: "pdf", title: "PDF", kind: "pdf" };
  const body = (revision: string) => <><MaterialViewContext document={{ ...source, revision }} active materialRole="working"><button type="button">{source.title}</button></MaterialViewContext><MaterialViewContext document={pdf} active materialRole="result"><button type="button">{pdf.title}</button></MaterialViewContext></>;
  const view = render(body("first"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "PDF" }));
  expect(useAgentWorkspaceStore.getState().views.project.documentId).toBe("pdf");
  view.rerender(body("second"));
  expect(useAgentWorkspaceStore.getState().views.project.documentId).toBe("pdf");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Source" }));
  expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ documentId: "source", revision: "second" });
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import type { DocxSession } from "@/lib/docx-session";
import type { AutomationHandle } from "@docx-editor.dev/core/automation";

const text = en.docx.equationTools;

const mocks = vi.hoisted(() => ({ writeEquation: vi.fn() }));
const previewMocks = vi.hoisted(() => ({ equationToSvgDocument: vi.fn() }));

vi.mock("@/lib/docx-agent-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/docx-agent-host")>();
  return { ...actual, DOCX_AGENT_HOST: { ...actual.DOCX_AGENT_HOST, writeEquation: mocks.writeEquation } };
});

vi.mock("@/features/equation-export", () => ({
  equationToSvgDocument: previewMocks.equationToSvgDocument,
}));

import { DocxEquationPanel } from "./DocxEquationPanel";

function paragraphHandle(ref: string): AutomationHandle<"paragraph"> {
  return { kind: "paragraph", ref } as AutomationHandle<"paragraph">;
}

function session(initial: { text: string; equations: readonly unknown[] } = { text: "", equations: [] }) {
  let revision = 0;
  const listeners = new Set<(next: number) => void>();
  const paragraphs = [{ ref: "first", paraId: "para-first", text: initial.text }];
  let currentEquations = initial.equations;
  const handles = paragraphs.map(({ ref }) => paragraphHandle(ref));
  const session: DocxSession = {
    revision: () => revision,
    listParagraphHandles: () => handles,
    paragraphHandleForId: (paraId) =>
      paragraphs.some(({ paraId: candidate }) => candidate === paraId)
        ? paragraphHandle("first")
        : undefined,
    listParagraphs: () => paragraphs.map(({ ref, paraId, text: paragraphText }) => ({
      handle: paragraphHandle(ref), text: paragraphText, paraId,
    })),
    readParagraph: (handle) => {
      const paragraph = paragraphs.find(({ ref }) => ref === handle.ref)!;
      return {
        paragraphRef: paragraph.ref,
        revision,
        paraId: paragraph.paraId,
        modelText: paragraph.text,
        displayText: paragraph.text,
        atoms: currentEquations.map((equation, index) => ({
          objectRef: `first:math-${index}`,
          kind: "math" as const,
          modelRange: { start: 0, end: 1 },
          displayRange: { start: 0, end: 1 },
          displayText: "",
          readable: true,
          complete: true,
          editable: false,
          payload: equation,
        })),
        editableRanges: [{ start: 0, end: paragraph.text.length }],
      };
    },
    captureTarget: (paragraph) => ({
      paragraph, original: paragraphs.find(({ ref }) => ref === paragraph.ref)!.text,
      revision, paraId: paragraphs.find(({ ref }) => ref === paragraph.ref)!.paraId,
    }),
    applySuggestion: () => ({ ok: false, code: "unsupported-target" as const,
      message: "Not supported.", changed: false, revision }),
    replaceParagraphRange: () => ({ ok: false, code: "unsupported-target" as const, message: "Not supported.",
      changed: false, revision }),
    isSuggestionApplied: () => false,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => {},
  };
  return {
    session,
    revision: () => revision,
    bump() { revision += 1; },
    publish() { for (const listener of listeners) listener(revision); },
    setEquations(next: readonly unknown[]) { currentEquations = next; },
  };
}

function equation(source: Record<string, unknown>) {
  return { equationFingerprint: "fp-1", source };
}

function equationSource(overrides: Record<string, unknown> = {}) {
  return {
    status: "bound", latex: "bound-latex", macros: "bound-macros",
    sourceHash: "bound-hash", display: false, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  previewMocks.equationToSvgDocument.mockResolvedValue("<svg><g /></svg>");
  mocks.writeEquation.mockResolvedValue({
    ok: true, changed: true, revision: 1, warnings: [], sourceHash: "hash-1",
    document: { sessionId: "session-1", baselineId: "baseline", sessionRevision: 1,
      savedRevision: 0, dirty: true },
  });
});

describe("DocxEquationPanel", () => {
  it("inserts an inline equation from an empty selected paragraph", async () => {
    const harness = session();
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByTestId("docx-equation-panel")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "x^2" } });
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(mocks.writeEquation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0,
      latex: "x^2", offset: 0, display: false,
    }, undefined));
    expect(screen.getByTestId("docx-equation-result")).toHaveTextContent(text.results);
  });

  it("inserts at the collapsed caret and explains an end insertion when no offset is available", async () => {
    const harness = session({ text: "abc", equations: [] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0", collapsedModelOffset: 2 }} />);
    await waitFor(() => expect(screen.getByLabelText(text.target)).toBeInTheDocument());
    expect(screen.getByRole("option", { name: text.insertAtCaret })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(mocks.writeEquation).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 2, display: false }), undefined,
    ));
  });

  it("protects an edited draft when the document revision changes", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource()),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toHaveValue("bound-latex"));
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "draft" } });
    act(() => { harness.bump(); harness.publish(); });
    expect(screen.getByLabelText(text.source)).toHaveValue("draft");
    expect(screen.getByRole("status")).toHaveTextContent(text.fingerprintMismatch);
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
  });

  it("syncs all source fields when switching between equations", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ macros: "first-macros", display: false })),
      equation(equationSource({ latex: "second-latex", macros: "", sourceHash: "second-hash", display: true })),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toHaveValue("bound-latex"));
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "unwanted-draft" } });
    fireEvent.change(screen.getByLabelText(text.macros), { target: { value: "unwanted-macros" } });
    fireEvent.click(screen.getByRole("radio", { name: text.display }));
    fireEvent.change(screen.getByLabelText(text.target), { target: { value: "first:math-1" } });
    expect(screen.getByLabelText(text.source)).toHaveValue("second-latex");
    expect(screen.getByLabelText(text.macros)).toHaveValue("");
    expect(screen.getByRole("radio", { name: text.display })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: text.adopt })).not.toBeInTheDocument();
  });

  it("previews source only on request and shows result without internal hashes", async () => {
    const harness = session();
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toBeInTheDocument());
    expect(previewMocks.equationToSvgDocument).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: text.preview }));
    await waitFor(() => expect(previewMocks.equationToSvgDocument).toHaveBeenCalledWith(
      "{\n\nx\n}", false,
    ));
    expect(screen.getByTestId("docx-equation-preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(screen.getByTestId("docx-equation-result")).toBeInTheDocument());
    expect(screen.getByTestId("docx-equation-result")).not.toHaveTextContent("hash-1");
  });

  it("requires adoptSource before replacing stale imported math", async () => {
    const harness = session({ text: "E", equations: [
      equation({ status: "stale", latex: "old", macros: "", sourceHash: "old-hash", display: false }),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(document.getElementById("docx-equation-adopt")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "new" } });
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    expect(screen.getByRole("button", { name: text.replace })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: text.replace }));
    await waitFor(() => expect(mocks.writeEquation).toHaveBeenCalledWith({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0,
      latex: "new", objectRef: "first:math-0", expectedFingerprint: "fp-1", adoptSource: true,
    }, undefined));
    expect(screen.getByTestId("docx-equation-result")).toHaveTextContent(text.results);
  });

  it("shows conversion and write warnings without treating them as success-only", async () => {
    const harness = session();
    mocks.writeEquation.mockResolvedValueOnce({
      ok: false, changed: false, revision: 0, code: "conversion-failed",
      message: "bad latex", warnings: ["missing brace"],
      document: { sessionId: "session-1", baselineId: "baseline", sessionRevision: 0,
        savedRevision: 0, dirty: true },
    });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByTestId("docx-equation-panel")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(screen.getByTestId("docx-equation-result")).toBeInTheDocument());
    expect(screen.getByTestId("docx-equation-result")).toHaveTextContent("missing brace");
  });

  it("refreshes when the session revision changes", async () => {
    const harness = session({ text: "E", equations: [
      equation({ status: "bound", latex: "old", macros: "", sourceHash: "hash", display: true }),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toHaveValue("old"));
    expect(screen.getByRole("radio", { name: text.display })).toBeChecked();
    act(() => harness.bump());
    await waitFor(() => expect(screen.getByLabelText(text.target)).toBeInTheDocument());
    expect(screen.getByLabelText(text.source)).toHaveValue("old");

  });

  it("keeps an explicit insertion target when a paragraph already has equations", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ sourceHash: "hash-first" })),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0", collapsedModelOffset: 2 }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.target), { target: { value: "" } });
    expect(screen.getByLabelText(text.source)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y" } });
    expect(screen.getByRole("button", { name: text.insert })).toBeEnabled();
    act(() => { harness.bump(); harness.publish(); });
    expect(screen.getByRole("option", { name: text.insertAtCaret })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(text.fingerprintMismatch);
    expect(screen.getByRole("button", { name: text.insert })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText(text.source)).toHaveValue("");
    expect(screen.getByRole("button", { name: text.insert })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y" } });
    expect(screen.getByRole("button", { name: text.insert })).toBeEnabled();
  });

  it("protects a macros-only draft and refreshes only on explicit request", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ sourceHash: "hash-first" })),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toHaveValue("bound-latex"));
    fireEvent.change(screen.getByLabelText(text.macros), { target: { value: "\\foo{x}" } });
    act(() => { harness.bump(); harness.publish(); });
    expect(screen.getByLabelText(text.source)).toHaveValue("bound-latex");
    expect(screen.getByLabelText(text.macros)).toHaveValue("\\foo{x}");
    expect(screen.getByRole("status")).toHaveTextContent(text.fingerprintMismatch);
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    expect(screen.getByRole("button", { name: text.refresh })).toBeEnabled();
  });

  it("renders a preview error as text and preserves the source after edits", async () => {
    const harness = session();
    previewMocks.equationToSvgDocument.mockRejectedValueOnce(new Error("MathJax failed"));
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "\\bad{y}" } });
    fireEvent.click(screen.getByRole("button", { name: text.preview }));
    await waitFor(() => expect(screen.getByTestId("docx-equation-preview")).toHaveTextContent("MathJax failed"));
    expect(screen.getByLabelText(text.source)).toHaveValue("\\bad{y}");
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "\\bad{" } });
    expect(screen.queryByTestId("docx-equation-preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText(text.source)).toHaveValue("\\bad{");
  });

  it("reloads the newly bound target after a successful insert and preserves the result", async () => {
    const harness = session({ text: "abc", equations: [] });
    mocks.writeEquation.mockImplementationOnce(async (request) => {
      harness.setEquations([equation({ status: "bound", latex: "new", macros: "",
        sourceHash: request.latex === "new" ? "new-hash" : "stale-hash", display: false })]);
      harness.bump();
      harness.publish();
      return {
        ok: true, changed: true, revision: harness.revision(), warnings: [], sourceHash: "new-hash",
        document: { sessionId: "session-1", baselineId: "baseline", sessionRevision: harness.revision(),
          savedRevision: 0, dirty: true },
      };
    });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0", collapsedModelOffset: 0 }} />);
    await waitFor(() => expect(screen.getByLabelText(text.source)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(screen.getByRole("option", { selected: true })).toHaveAttribute("value", "first:math-0"));
    expect(screen.getByLabelText(text.source)).toHaveValue("new");
    expect(mocks.writeEquation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0,
      latex: "new", offset: 0, display: false,
    }), undefined);
    expect(screen.getByTestId("docx-equation-result")).toBeInTheDocument();
  });

  it("hides equation controls when the panel is inactive", () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource()),
    ] });
    render(<DocxEquationPanel active={false} sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    expect(screen.getByTestId("docx-equation-panel")).toBeInTheDocument();
    expect(screen.queryByLabelText(text.target)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(text.source)).not.toBeInTheDocument();
  });
});

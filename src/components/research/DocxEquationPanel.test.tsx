// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { DocxEquationPanel, type DocxEquationDraft, type DocxEquationTarget } from "./DocxEquationPanel";

const clickedEquation: DocxEquationTarget = {
  paragraphRef: "first",
  revision: 0,
  equation: { objectRef: "first:math-1", expectedFingerprint: "fp-2", offset: 3, end: 4,
    status: "unbound", latex: "", macros: "", display: false },
};

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

function equation(source: Record<string, unknown>, fingerprint = "fp-1") {
  return { equationFingerprint: fingerprint, source };
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
  it("binds an explicit captured target to its exact equation in the same paragraph", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ latex: "first-latex" })),
      equation(equationSource({ latex: "second-latex" }), "fp-2"),
    ] });
    const view = render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} captured={clickedEquation} />);
    const target = screen.getByLabelText(text.target) as HTMLSelectElement;
    expect(target).toHaveValue("first:math-1");
    expect(screen.getByLabelText(text.source)).toHaveValue("second-latex");
    expect(screen.getByRole("button", { name: text.replace })).toBeVisible();

    view.rerender(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} captured={null} />);
    await waitFor(() => expect(target).toHaveValue(""));
    expect(screen.getByRole("button", { name: text.insert })).toBeVisible();
    expect(screen.queryByRole("button", { name: text.replace })).not.toBeInTheDocument();
  });

  it("drops a captured target when the session revision changes", async () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ latex: "first-latex" })),
      equation(equationSource({ latex: "second-latex" }), "fp-2"),
    ] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} captured={clickedEquation} />);
    expect(screen.getByLabelText(text.target)).toHaveValue("first:math-1");
    act(() => { harness.bump(); harness.publish(); });
    await waitFor(() => expect(screen.getByLabelText(text.target)).toHaveValue(""));
    expect(screen.getByRole("button", { name: text.insert })).toBeVisible();
    expect(screen.queryByRole("button", { name: text.replace })).not.toBeInTheDocument();
  });

  it("does not submit a formula draft after the user returns to text in the same paragraph", () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource()),
      equation(equationSource(), "fp-2"),
    ] });
    const selection = { paragraphRef: clickedEquation.paragraphRef, revision: "0" };
    const view = render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={selection} captured={clickedEquation} />);
    const source = screen.getByLabelText(text.source);
    fireEvent.change(source, { target: { value: "draft" } });
    expect(screen.getByRole("button", { name: text.replace })).toBeEnabled();

    view.rerender(<DocxEquationPanel active sessionId="session-1" session={harness.session} selection={selection} />);
    expect(source).toHaveValue("draft");
    const replace = screen.getByRole("button", { name: text.replace });
    expect(replace).toBeDisabled();
    fireEvent.click(replace);
    expect(mocks.writeEquation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(screen.queryByRole("button", { name: text.replace })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.insert })).toBeDisabled();
  });

  it("replaces only the activated equation with explicit source adoption", async () => {
    const harness = session();
    const onClose = vi.fn();
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose }} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    const replace = screen.getByRole("button", { name: text.replace });
    expect(replace).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    fireEvent.click(replace);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.writeEquation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0,
      latex: "y^2", objectRef: "first:math-1", expectedFingerprint: "fp-2", adoptSource: true,
    }, { signal: expect.any(AbortSignal) });
  });

  it("keeps the contextual draft but refuses replacement after a revision change", () => {
    const harness = session();
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose: vi.fn() }} />);
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    act(() => { harness.bump(); harness.publish(); });
    expect(screen.getByLabelText(text.source)).toHaveValue("draft");
    expect(screen.getByRole("status")).toHaveTextContent(text.contextChanged);
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    expect(mocks.writeEquation).not.toHaveBeenCalled();
  });

  it("restores the complete contextual draft after the editor surface unmounts", () => {
    const harness = session();
    let draft: DocxEquationDraft | undefined;
    const storeDraft = (next: DocxEquationDraft | null) => { draft = next ?? undefined; };
    const panel = () => <DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, draft, onDraftChange: storeDraft, onClose: vi.fn() }} />;
    const view = render(panel());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    fireEvent.change(screen.getByLabelText(text.macros), { target: { value: "\\newcommand{\\sq}[1]{#1^2}" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    expect(draft).toEqual({
      latex: "y^2",
      macros: "\\newcommand{\\sq}[1]{#1^2}",
      adoptSource: true,
    });

    view.unmount();
    render(panel());
    expect(screen.getByLabelText(text.source)).toHaveValue("y^2");
    expect(screen.getByLabelText(text.macros)).toHaveValue("\\newcommand{\\sq}[1]{#1^2}");
    expect(screen.getByRole("checkbox", { name: text.adopt })).toBeChecked();
    expect(screen.getByRole("button", { name: text.replace })).toBeEnabled();
  });

  it("keeps focus on Close while replacing an equation and showing conversion warnings", async () => {
    const user = userEvent.setup();
    const harness = session();
    let finishWrite!: (result: { ok: boolean; warnings: string[] }) => void;
    mocks.writeEquation.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose: vi.fn() }} />);
    screen.getByLabelText(text.source).focus();
    await user.keyboard("y^2");
    const adopt = screen.getByRole("checkbox", { name: text.adopt });
    adopt.focus();
    await user.keyboard("[Space]");
    expect(adopt).toBeChecked();
    const replace = screen.getByRole("button", { name: text.replace });
    expect(replace).toBeEnabled();
    replace.focus();
    await user.keyboard("{Enter}");
    const close = screen.getByRole("button", { name: /^Close$/u });
    expect(replace).toBeDisabled();
    expect(close).toHaveFocus();
    await act(async () => finishWrite({ ok: true, warnings: ["Conversion warning"] }));
    expect(screen.getByRole("status")).toHaveTextContent("Conversion warning");
    expect(replace).not.toBeInTheDocument();
    expect(close).toHaveFocus();
  });

  it("keeps Escape in document tools while a replacement is pending", async () => {
    const user = userEvent.setup();
    const harness = session({ text: "\uFFFC", equations: [equation({ status: "unbound" })] });
    const onEscape = vi.fn();
    mocks.writeEquation.mockImplementationOnce(() => new Promise(() => {}));
    const { unmount } = render(<aside aria-label={text.title} onKeyDown={(event) => {
      if (event.key === "Escape") onEscape();
    }}><DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} /></aside>);
    await screen.findByRole("checkbox", { name: text.adopt });
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    const replace = screen.getByRole("button", { name: text.replace });
    replace.focus();
    await user.keyboard("{Enter}");
    expect(replace).toBeDisabled();
    expect(screen.getByRole("heading", { name: text.title })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
    unmount();
  });

  it("keeps Escape in document tools after a replacement warning", async () => {
    const user = userEvent.setup();
    const harness = session({ text: "\uFFFC", equations: [equation({ status: "unbound" })] });
    const onEscape = vi.fn();
    let finishWrite!: (result: { ok: boolean; warnings: string[] }) => void;
    mocks.writeEquation.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    render(<aside aria-label={text.title} onKeyDown={(event) => {
      if (event.key === "Escape") onEscape();
    }}><DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} /></aside>);
    await screen.findByRole("checkbox", { name: text.adopt });
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    const replace = screen.getByRole("button", { name: text.replace });
    replace.focus();
    await user.keyboard("{Enter}");
    await act(async () => finishWrite({ ok: true, warnings: ["Conversion warning"] }));
    expect(screen.getByRole("status")).toHaveTextContent("Conversion warning");
    expect(screen.getByRole("heading", { name: text.title })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("does not restore paper focus when context completes after the user leaves", async () => {
    const user = userEvent.setup();
    const harness = session();
    const outsideLabel = "Outside";
    const onClose = vi.fn();
    let finishWrite!: (result: { ok: boolean; warnings: string[] }) => void;
    mocks.writeEquation.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    render(<><DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose }} />
      <button type="button">{outsideLabel}</button></>);
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    const replace = screen.getByRole("button", { name: text.replace });
    replace.focus();
    await user.keyboard("{Enter}");
    const outside = screen.getByRole("button", { name: outsideLabel });
    outside.focus();
    await act(async () => finishWrite({ ok: true, warnings: [] }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(outside).toHaveFocus();
  });

  it("keeps focus on Close when replacement starts while the source field has focus", async () => {
    const harness = session();
    let finishWrite!: (result: { ok: boolean; warnings: string[] }) => void;
    mocks.writeEquation.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose: vi.fn() }} />);
    const source = screen.getByLabelText(text.source);
    fireEvent.change(source, { target: { value: "y^2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    source.focus();

    fireEvent.click(screen.getByRole("button", { name: text.replace }));
    const close = screen.getByRole("button", { name: /^Close$/u });
    expect(close).toHaveFocus();
    await act(async () => finishWrite({ ok: true, warnings: ["Conversion warning"] }));
    expect(close).toHaveFocus();
  });

  it("cancels a pending contextual write when its surface closes", () => {
    const harness = session();
    mocks.writeEquation.mockImplementationOnce(() => new Promise(() => {}));
    const { unmount } = render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      contextual={{ target: clickedEquation, onClose: vi.fn() }} />);
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "y^2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    fireEvent.click(screen.getByRole("button", { name: text.replace }));
    const signal = mocks.writeEquation.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("lets a reopened document tools panel retry while the cancelled conversion finishes", async () => {
    const harness = session();
    let finishFirst!: (result: { ok: boolean; warnings: string[] }) => void;
    let finishRetry!: (result: { ok: boolean; warnings: string[] }) => void;
    mocks.writeEquation
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const panel = (active: boolean) => <DocxEquationPanel active={active} sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />;
    const { rerender } = render(panel(true));
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "x^2" } });
    const insert = () => screen.getByRole("button", { name: text.insert });
    fireEvent.click(insert());
    expect(insert()).toBeDisabled();
    rerender(panel(false));
    expect(mocks.writeEquation.mock.calls[0][1]?.signal?.aborted).toBe(true);
    rerender(panel(true));
    expect(screen.getByLabelText(text.source)).toHaveValue("x^2");
    expect(insert()).toBeEnabled();
    fireEvent.click(insert());
    expect(insert()).toBeDisabled();
    await act(async () => finishFirst({ ok: true, warnings: ["Cancelled conversion"] }));
    expect(screen.queryByTestId("docx-equation-result")).not.toBeInTheDocument();
    expect(insert()).toBeDisabled();
    await act(async () => finishRetry({ ok: true, warnings: [] }));
    expect(screen.getByTestId("docx-equation-result")).toHaveTextContent(text.results);
  });

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
    }, { signal: expect.any(AbortSignal) }));
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
      expect.objectContaining({ offset: 2, display: false }), { signal: expect.any(AbortSignal) },
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

  it("keeps LaTeX and macros when refreshing the same unchanged equation", () => {
    const harness = session({ text: "E", equations: [equation(equationSource())] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    const latex = screen.getByLabelText(text.source);
    const macros = screen.getByLabelText(text.macros);
    fireEvent.change(latex, { target: { value: "y^2" } });
    fireEvent.change(macros, { target: { value: "\\newcommand{\\vect}{\\mathbf}" } });
    act(() => { harness.bump(); harness.publish(); });
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(latex).toHaveValue("y^2");
    expect(macros).toHaveValue("\\newcommand{\\vect}{\\mathbf}");
    fireEvent.click(screen.getByRole("button", { name: text.replace }));
    expect(mocks.writeEquation).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1,
      expectedFingerprint: "fp-1", objectRef: "first:math-0", latex: "y^2" }), expect.anything());
  });

  it("does not reuse a draft for a different equation occupying the same slot", () => {
    const harness = session({ text: "E", equations: [equation(equationSource())] });
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paraId: "para-first", revision: "0" }} />);
    const latex = screen.getByLabelText(text.source);
    fireEvent.change(latex, { target: { value: "draft" } });
    act(() => {
      harness.setEquations([equation(equationSource({ latex: "replacement", macros: "" }), "fp-replacement")]);
      harness.bump();
      harness.publish();
    });
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(latex).toHaveValue("replacement");
    expect(mocks.writeEquation).not.toHaveBeenCalled();
  });

  it("refreshes the newly selected equation instead of rebinding an older draft", () => {
    const harness = session({ text: "abc", equations: [
      equation(equationSource({ latex: "first-latex" })),
      equation(equationSource({ latex: "second-latex", macros: "" }), "fp-2"),
    ] });
    const selection = { paragraphRef: "first", revision: "0" };
    const { rerender } = render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={selection} />);
    const source = screen.getByLabelText(text.source);
    fireEvent.change(source, { target: { value: "draft for the first equation" } });
    rerender(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={selection} captured={clickedEquation} />);
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: text.refresh }));
    expect(screen.getByLabelText(text.target)).toHaveValue("first:math-1");
    expect(source).toHaveValue("second-latex");
    expect(mocks.writeEquation).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByRole("checkbox", { name: text.adopt })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "new" } });
    expect(screen.getByRole("button", { name: text.replace })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    expect(screen.getByRole("button", { name: text.replace })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: text.replace }));
    await waitFor(() => expect(mocks.writeEquation).toHaveBeenCalledWith({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0,
      latex: "new", objectRef: "first:math-0", expectedFingerprint: "fp-1", adoptSource: true,
    }, { signal: expect.any(AbortSignal) }));
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

  it.each(["finishes", "fails"] as const)("keeps the new draft's preview when the old preview %s late", async (outcome) => {
    const harness = session();
    let resolveOld!: (svg: string) => void;
    let rejectOld!: (cause: Error) => void;
    previewMocks.equationToSvgDocument
      .mockImplementationOnce(() => new Promise<string>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockResolvedValueOnce("<svg><title>New formula</title></svg>");
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paragraphRef: "first" }} />);
    const source = screen.getByLabelText(text.source);
    const preview = screen.getByRole("button", { name: text.preview });

    fireEvent.change(source, { target: { value: "a^2" } });
    fireEvent.click(preview);
    expect(preview).toBeDisabled();
    fireEvent.change(source, { target: { value: "b^2" } });
    fireEvent.click(preview);
    const rendered = await screen.findByTestId("docx-equation-preview");
    expect(rendered).toHaveTextContent("New formula");

    await act(async () => {
      if (outcome === "finishes") resolveOld("<svg><title>Old formula</title></svg>");
      else rejectOld(new Error("Old formula failed"));
    });
    expect(rendered).toHaveTextContent("New formula");
    expect(rendered).not.toHaveTextContent("Old formula");
    expect(source).toHaveValue("b^2");
  });

  it("retains a LaTeX draft after a rejected write and retries at the same captured equation", async () => {
    const harness = session({ text: "\uFFFC", equations: [equation({ status: "unbound" })] });
    mocks.writeEquation.mockRejectedValueOnce(new Error("Editor did not accept the write"));
    render(<DocxEquationPanel active sessionId="session-1" session={harness.session}
      selection={{ paragraphRef: "first" }} />);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(text.unbound);
    const source = screen.getByLabelText(text.source);
    const macros = screen.getByLabelText(text.macros);
    fireEvent.change(source, { target: { value: "\\sq{x}" } });
    fireEvent.change(macros, { target: { value: "\\newcommand{\\sq}[1]{#1^2}" } });
    const replace = screen.getByRole("button", { name: text.replace });
    expect(replace).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: text.adopt }));
    fireEvent.click(replace);

    const result = await screen.findByTestId("docx-equation-result");
    expect(result).toHaveTextContent("Editor did not accept the write");
    expect(source).toHaveValue("\\sq{x}");
    expect(macros).toHaveValue("\\newcommand{\\sq}[1]{#1^2}");
    expect(screen.getByRole("checkbox", { name: text.adopt })).toBeChecked();

    fireEvent.click(replace);
    await waitFor(() => expect(screen.getByTestId("docx-equation-result")).toHaveTextContent(text.results));
    const write = { sessionId: "session-1", paragraphRef: "first", expectedRevision: 0, objectRef: "first:math-0",
      expectedFingerprint: "fp-1", latex: "\\sq{x}", macros: "\\newcommand{\\sq}[1]{#1^2}", adoptSource: true };
    expect(mocks.writeEquation.mock.calls).toEqual([
      [write, { signal: expect.any(AbortSignal) }], [write, { signal: expect.any(AbortSignal) }],
    ]);
  });

  it("offers a display equation only in an empty paragraph and clears the target when its paragraph disappears", async () => {
    const empty = session();
    const filled = session({ text: "Keep this sentence", equations: [{}] });
    const selected = { paragraphRef: "first", collapsedModelOffset: 100 };
    const view = render(<DocxEquationPanel active sessionId="session-1" session={empty.session} selection={selected} />);
    fireEvent.change(screen.getByLabelText(text.source), { target: { value: "x^2" } });
    fireEvent.click(screen.getByRole("radio", { name: text.display }));
    fireEvent.click(screen.getByRole("radio", { name: text.inline }));
    expect(screen.getByRole("radio", { name: text.inline })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: text.display }));
    fireEvent.click(screen.getByRole("button", { name: text.insert }));
    await waitFor(() => expect(screen.getByTestId("docx-equation-result")).toHaveTextContent(text.results));
    expect(mocks.writeEquation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1", paragraphRef: "first", expectedRevision: 0, latex: "x^2", offset: 0, display: true,
    }, { signal: expect.any(AbortSignal) });

    view.rerender(<DocxEquationPanel active sessionId="session-2" session={filled.session} selection={selected} />);
    expect(screen.getByRole("radio", { name: text.display })).toBeDisabled();
    expect(screen.getByRole("option", { name: text.insertAtEnd })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: text.replace })).not.toBeInTheDocument();
    view.rerender(<DocxEquationPanel active sessionId="session-2" session={filled.session} selection={{ paragraphRef: "removed" }} />);
    expect(screen.getByText(text.noSelection)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.insert })).not.toBeInTheDocument();
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
    }), { signal: expect.any(AbortSignal) });
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

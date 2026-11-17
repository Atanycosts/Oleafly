// @vitest-environment jsdom
import { createRef, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import { WordDocument, type WordDocumentRef } from "./WordDocument";

type SavedEditor = Pick<NonNullable<ReturnType<DocxEditorRef["getEditor"]>>, "save">;
const engine = vi.hoisted(() => ({ editor: null as SavedEditor | null, rootProps: vi.fn() }));

vi.mock("@docx-editor.dev/react", () => ({
  useDocxEditor: () => engine.editor,
  DocxEditor: {
    Root: ({ children, ...props }: { children: ReactNode }) => { engine.rootProps(props); return children; },
    Viewport: ({ children }: { children: ReactNode }) => <div data-testid="word-viewport">{children}</div>,
    HeaderFooterChrome: () => <div data-testid="header-footer" />,
    NotesChrome: () => <div data-testid="notes" />,
    Content: () => <div data-testid="word-content" />,
    Loading: ({ overlay, indicator }: { overlay: boolean; indicator: ReactNode }) => <div data-testid="loading" data-overlay={overlay}>{indicator}</div>,
    OpenFailure: () => <div data-testid="open-failure" />,
  },
}));

beforeEach(() => {
  engine.editor = null;
  engine.rootProps.mockReset();
});

it("provides the public ref before the engine is ready and refreshes it when the editor changes", async () => {
  const ref = createRef<WordDocumentRef>();
  const title = "Working paper";
  const rendered = render(<WordDocument ref={ref} title={title} />);
  expect(ref.current?.getEditor()).toBeNull();
  await expect(ref.current?.save()).resolves.toBeNull();
  const saved = new Uint8Array([80, 75]).buffer;
  const save = vi.fn(async () => saved);
  engine.editor = { save };
  rendered.rerender(<WordDocument ref={ref} title={title} />);
  expect(ref.current?.getEditor()).toBe(engine.editor);
  await expect(ref.current?.save()).resolves.toBe(saved);
  expect(save).toHaveBeenCalledOnce();
  const failure = new Error("Working document could not be serialized");
  const nextSave = vi.fn<SavedEditor["save"]>().mockRejectedValue(failure);
  engine.editor = { save: nextSave };
  rendered.rerender(<WordDocument ref={ref} title={title} />);
  await expect(ref.current?.save()).rejects.toBe(failure);
  expect(save).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(ref.current).toBeNull();
});

it("forwards engine input and keeps document chrome, custom children and loading inside the named surface", () => {
  const data = new Uint8Array([80, 75]);
  const onFontError = vi.fn();
  const childLabel = "Selection tools";
  const title = "Retained paper";
  render(<WordDocument title={title} className="retained-paper" document={data} mode="view" onFontError={onFontError}>
    <button type="button">{childLabel}</button>
  </WordDocument>);
  expect(engine.rootProps).toHaveBeenCalledWith({ document: data, mode: "view", onFontError });
  const surface = screen.getByRole("region", { name: "Retained paper" });
  expect(surface).toHaveClass("retained-paper");
  const viewport = within(surface).getByTestId("word-viewport");
  for (const testId of ["header-footer", "notes", "word-content"]) expect(within(viewport).getByTestId(testId)).toBeInTheDocument();
  expect(within(viewport).getByRole("button", { name: childLabel })).toBeInTheDocument();
  expect(within(surface).getByTestId("loading")).toHaveAttribute("data-overlay", "true");
  expect(within(surface).getByTestId("open-failure")).toBeInTheDocument();
});

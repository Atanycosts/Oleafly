// @vitest-environment jsdom
import {
  mountPaginatedSurface,
  type DocxEditorInstance,
  type PaginatedSurface,
} from "@docx-editor.dev/core/editor";
import {
  forEachSemanticDrawing,
  type SemanticDrawingVisit,
} from "@docx-editor.dev/core/layout";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { readDocxFieldAction } from "@/lib/docx-citation-fields";
import { readDocxContextDrawing, readDocxDrawingAtCaret } from "@/lib/docx-context-drawing";
import { registerDocxHistory, runDocxHistory } from "@/lib/docx-history";
import { createDocxSession, type DocxSession } from "@/lib/docx-session";
import { DocxContextTools } from "./DocxContextTools";
import type { DocxEquationDraft } from "./DocxEquationPanel";

const editorRef = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("@docx-editor.dev/react", () => ({
  useDocxEditor: () => editorRef.current,
}));

vi.mock("@/lib/docx-citation-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docx-citation-write")>()),
  DOCX_CITATION_PREVIEW: true,
}));

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const B = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ),
);

function picture(): string {
  return `<w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Adjacent picture" descr="Adjacent picture"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="picture.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function docx(withCitation: boolean, withSecondParagraph: boolean, trackChanges: boolean): Uint8Array {
  const citation = `<w:fldSimple w:instr="CITATION Ref1"><w:r><w:t>[1]</w:t></w:r></w:fldSimple>`;
  const secondParagraph = withSecondParagraph
    ? `<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>`
    : "";
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/customXml/item1.xml" ContentType="application/xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:m="${M}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:r="${R}"><w:body><w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>${withCitation ? citation : ""}<w:r>${picture()}</w:r><w:r><w:t xml:space="preserve"> tail </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p>${secondParagraph}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rIdImage" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rIdSources" Type="${R}/customXml" Target="../customXml/item1.xml"/>${trackChanges ? `<Relationship Id="rIdSettings" Type="${R}/settings" Target="settings.xml"/>` : ""}</Relationships>`,
    ),
    ...(trackChanges ? {
      "word/settings.xml": strToU8(`<w:settings xmlns:w="${W}"><w:trackRevisions/></w:settings>`),
    } : {}),
    "word/media/image1.png": PNG,
    "customXml/item1.xml": strToU8(
      `<b:Sources xmlns:b="${B}"><b:Source><b:Tag>Ref1</b:Tag><b:Title>Adjacent citation</b:Title><b:URL>https://example.org/article</b:URL></b:Source></b:Sources>`,
    ),
  });
}

interface Fixture {
  readonly session: DocxSession;
  readonly surface: PaginatedSurface;
  readonly wrapper: HTMLElement;
  readonly equationDrafts: Map<string, DocxEquationDraft>;
  readonly exec: ReturnType<typeof vi.fn>;
  readonly annotate: Mock<ComponentProps<typeof DocxContextTools>["onAnnotate"]>;
  readonly openPanel: Mock<() => void>;
  setViewportRect(rect: DOMRect): void;
  readonly dispose: () => void;
}

const fixtureRef: { current: Fixture | null } = { current: null };

function Harness() {
  const fixture = fixtureRef.current;
  return <section>
    <div className="docx-editor__scroll-container" tabIndex={-1}>
      <div data-testid="surface-host" />
    </div>
    <DocxContextTools working={fixture ? {
      session: fixture.session,
      sessionId: "fixture",
      equationDrafts: fixture.equationDrafts,
    } : undefined} onAnnotate={fixture?.annotate ?? (async () => {})} onOpenPanel={fixture?.openPanel} />
  </section>;
}

function mount(withCitation: boolean, withSecondParagraph = false, trackChanges = false) {
  const rendered = render(<Harness />);
  const wrapper = rendered.container.firstElementChild as HTMLElement;
  const surfaceHost = screen.getByTestId("surface-host");
  const opened = mountPaginatedSurface(surfaceHost, docx(withCitation, withSecondParagraph, trackChanges), {
    editingMode: "edit",
    imageDecodePort: {
      decode: async () => ({
        pixelWidth: 1,
        pixelHeight: 1,
        dpiX: 96,
        dpiY: 96,
      }),
    },
    measurer: {
      measure: (text) => text.length * 6,
      lineMetrics: () => ({ height: 14, baseline: 11 }),
    },
  });
  if (!opened.ok) throw new Error(opened.reason);
  const surface = opened.surface;
  const session = createDocxSession({
    surface,
    exec: () => ({ ok: true }),
    on: () => () => {},
    can: () => ({ ok: false }),
  } as unknown as DocxEditorInstance);
  const readParagraph = session.readParagraph.bind(session);
  Object.assign(session, {
    readParagraph(handle: Parameters<DocxSession["readParagraph"]>[0]) {
      const paragraph = readParagraph(handle);
      return {
        ...paragraph,
        atoms: paragraph.atoms.map((atom) => {
          if (atom.kind !== "math") return atom;
          const existing = atom.payload && typeof atom.payload === "object"
            ? atom.payload as Record<string, unknown> : {};
          return {
            ...atom,
            payload: {
              ...existing,
              equationFingerprint: "formula-fingerprint",
              source: {
                status: "bound",
                latex: "x+1",
                macros: "",
                sourceHash: "formula-hash",
                display: false,
              },
            },
          };
        }),
      };
    },
  });
  session.insertCitation = vi.fn<NonNullable<DocxSession["insertCitation"]>>(() => ({
    ok: true, revision: session.revision(), changed: true,
  }));
  const pages = wrapper.querySelector<HTMLElement>(".docx-pages");
  if (!pages) throw new Error("The fixture has no pages layer.");
  pages.tabIndex = -1;
  const exec = vi.fn();
  const annotate = vi.fn<ComponentProps<typeof DocxContextTools>["onAnnotate"]>(async () => {});
  const editor = {
    surface,
    snapshot: () => {
      const { anchor, head } = surface.state().selection;
      return {
        selectionCollapsed: anchor.paragraphId === head.paragraphId && anchor.offset === head.offset,
        selection: {
          from: { paraId: surface.session.paraIdOf(anchor.paragraphId) },
          to: { paraId: surface.session.paraIdOf(head.paragraphId) },
        },
      };
    },
    on: () => () => {},
    exec,
    focus: vi.fn(() => surface.focus()),
    query: vi.fn(() => surface.selectedText()),
  };
  const equationDrafts = new Map<string, DocxEquationDraft>();
  let viewportBounds = new DOMRect(0, 0, 500, 400);
  const fixture = {
    session,
    surface,
    wrapper,
    equationDrafts,
    exec,
    annotate,
    openPanel: vi.fn(),
    setViewportRect(rect: DOMRect) {
      viewportBounds = rect;
    },
    dispose() {
      fixtureRef.current = null;
      editorRef.current = null;
      session.dispose();
      surface.destroy();
      rendered.unmount();
    },
  };
  fixtureRef.current = fixture;
  editorRef.current = editor;
  act(() => rendered.rerender(<Harness />));
  const viewport = wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
  if (!viewport) throw new Error("The fixture has no viewport.");
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => viewportBounds);
  return fixture;
}

function bodyDrawing(surface: PaginatedSurface): SemanticDrawingVisit {
  let found: SemanticDrawingVisit | undefined;
  forEachSemanticDrawing(surface.layout(), (visit) => {
    if (visit.rootStory === "body" && visit.story === "body") found ??= visit;
  });
  if (!found) throw new Error("The fixture has no body drawing.");
  return found;
}

async function readyBodyDrawing(surface: PaginatedSurface): Promise<SemanticDrawingVisit> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    surface.layout();
    const visit = bodyDrawing(surface);
    if (visit.drawing.resource.kind === "ready") return visit;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The fixture drawing did not finish decoding.");
}

function pressShiftF10(fixture: Fixture) {
  return pressKey(fixture, "F10", { shiftKey: true });
}

function pressKey(fixture: Fixture, key: string, init: KeyboardEventInit = {}) {
  const pages = fixture.wrapper.querySelector<HTMLElement>(".docx-pages");
  if (!pages) throw new Error("The fixture has no pages layer.");
  return fireEvent.keyDown(pages, { key, ...init });
}

function showField(fixture: Fixture) {
  const field = fixture.wrapper.querySelector<HTMLElement>('[data-field-atom="field"]');
  if (!field) throw new Error("The fixture has no painted citation field.");
  return vi.spyOn(field, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 24, 42, 14));
}

function showDrawing(fixture: Fixture, drawingNodeId: string) {
  const drawing = Array.from(fixture.wrapper.querySelectorAll<HTMLElement>(".docx-drawing"))
    .find((element) => element.dataset.drawingNodeId === drawingNodeId);
  if (!drawing) throw new Error("The fixture has no painted drawing.");
  return vi.spyOn(drawing, "getBoundingClientRect").mockReturnValue(new DOMRect(64, 24, 96, 48));
}

function bodyEquation(fixture: Fixture) {
  const element = fixture.wrapper.querySelector<HTMLElement>("[data-docx-equation]");
  const id = element?.dataset.docxEquation;
  const painted = id ? fixture.surface.equations.equationById(id) : null;
  if (!element || !painted) throw new Error("The fixture has no painted equation.");
  return { element, painted };
}

function showEquation(fixture: Fixture) {
  const equation = bodyEquation(fixture);
  const rect = vi.spyOn(equation.element, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(24, 24, 42, 14));
  return { ...equation, rect };
}

function selectEquation(fixture: Fixture, painted: ReturnType<typeof bodyEquation>["painted"], range = false) {
  const anchor = { paragraphId: painted.paragraphId, offset: painted.start };
  fixture.surface.setSelection({
    anchor,
    head: { paragraphId: painted.paragraphId, offset: range ? painted.end : painted.start },
  });
}

function openEquationDraft(fixture: Fixture) {
  const equation = showEquation(fixture);
  selectEquation(fixture, equation.painted);
  expect(pressShiftF10(fixture)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Edit LaTeX" }));
  const source = screen.getByRole("textbox", { name: "LaTeX source" });
  expect(source).toHaveFocus();
  fireEvent.change(source, { target: { value: "y^2" } });
  return { ...equation, source };
}

async function settlePlacement() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

function showCaret(fixture: Fixture) {
  const page = fixture.wrapper.querySelector<HTMLElement>(".docx-page[data-page-index]");
  if (!page) throw new Error("The fixture has no page.");
  const caret = document.createElement("span");
  caret.dataset.docxCaret = "";
  page.append(caret);
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 400));
  vi.spyOn(caret, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 24, 1, 14));
  return page;
}

afterEach(() => {
  fixtureRef.current?.dispose();
  fixtureRef.current = null;
  editorRef.current = null;
});

describe("DOCX keyboard context targets", () => {
  it("does not choose between a resolvable citation and an adjacent picture", async () => {
    const fixture = mount(true);
    try {
      const visit = await readyBodyDrawing(fixture.surface);
      const paragraph = fixture.session.listParagraphs()[0];
      if (!paragraph) throw new Error("The fixture has no paragraph.");
      const semantics = fixture.session.readParagraph(paragraph.handle);
      const field = semantics.atoms.find((atom) => atom.kind === "field");
      if (!field) throw new Error("The fixture has no citation field.");
      expect(field.modelRange).toEqual({ start: 4, end: 5 });
      expect(readDocxFieldAction(semantics, field.modelRange,
        () => fixture.surface.session.currentPackage())?.action.kind).toBe("citation");
      expect(visit.drawing.start).toBe(field.modelRange.end);

      const afterPicture = {
        paragraphId: visit.drawing.kind === "inlineDrawing"
          ? visit.drawing.paragraphId
          : visit.drawing.anchorParagraphId,
        offset: visit.drawing.start + 1,
      };
      fixture.surface.setSelection({ anchor: afterPicture, head: afterPicture });
      pressKey(fixture, "ArrowLeft");
      expect(fixture.surface.state().selection).toEqual({
        anchor: { ...afterPicture, offset: visit.drawing.start },
        head: { ...afterPicture, offset: visit.drawing.start },
      });
      expect(readDocxDrawingAtCaret(fixture.surface, fixture.session)).toMatchObject({ kind: "drawing" });
      showField(fixture);
      showCaret(fixture);

      expect(pressShiftF10(fixture)).toBe(false);
      expect(screen.queryByTestId("docx-context-tools")).toBeNull();
      expect(screen.queryByRole("button", { name: "Insert citation" })).toBeNull();
      expect(fixture.surface.drawingSelectionIntent()).toEqual({ kind: "none" });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps a keyboard range exactly matching a citation as text", () => {
    const fixture = mount(true);
    try {
      const paragraph = fixture.session.listParagraphs()[0];
      if (!paragraph) throw new Error("The fixture has no paragraph.");
      const semantics = fixture.session.readParagraph(paragraph.handle);
      const field = semantics.atoms.find((atom) => atom.kind === "field");
      if (!field) throw new Error("The fixture has no citation field.");
      const paragraphId = fixture.surface.session.paragraphIds()[0];
      if (!paragraphId) throw new Error("The fixture paragraph has no identity.");
      const anchor = { paragraphId, offset: field.modelRange.start };
      const head = { ...anchor, offset: field.modelRange.end };
      fixture.surface.setSelection({ anchor, head });
      expect(fixture.surface.state().selection).toEqual({ anchor, head });
      showField(fixture);

      pressShiftF10(fixture);
      expect(screen.queryByRole("button", { name: "View citation" })).not.toBeInTheDocument();
    } finally {
      fixture.dispose();
    }
  });

  it("keeps a keyboard range exactly matching an equation as text", () => {
    const fixture = mount(true);
    try {
      const { painted } = showEquation(fixture);
      selectEquation(fixture, painted, true);
      expect(fixture.surface.state().selection).toEqual({
        anchor: { paragraphId: painted.paragraphId, offset: painted.start },
        head: { paragraphId: painted.paragraphId, offset: painted.end },
      });

      pressShiftF10(fixture);
      expect(screen.queryByRole("button", { name: "Edit LaTeX" })).not.toBeInTheDocument();
    } finally {
      fixture.dispose();
    }
  });

  it("copies an explicitly requested cross-paragraph selection without annotation", () => {
    const fixture = mount(false, true);
    try {
      const pages = fixture.wrapper.querySelector<HTMLElement>(".docx-pages");
      if (!pages) throw new Error("The fixture has no pages layer.");
      const lines = Array.from(fixture.wrapper.querySelectorAll<HTMLElement>(".docx-line"));
      const firstLine = lines.find((line) => line.textContent?.includes("See"));
      const secondLine = lines.find((line) => line.textContent?.includes("Second paragraph"));
      if (!firstLine || !secondLine) throw new Error("The fixture has no cross-paragraph lines.");
      vi.spyOn(secondLine, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 24, 120, 14));

      const [firstParagraph, secondParagraph] = fixture.surface.session.paragraphIds();
      if (!firstParagraph || !secondParagraph) throw new Error("The fixture has no paragraph pair.");
      pages.focus();
      const selection = {
        anchor: { paragraphId: firstParagraph, offset: 0 },
        head: { paragraphId: secondParagraph, offset: 0 },
      };
      act(() => fixture.surface.setSelection(selection));

      const range = document.createRange();
      range.setStart(firstLine, 0);
      range.setEnd(secondLine, secondLine.childNodes.length);
      const native = document.getSelection();
      if (!native) throw new Error("The fixture has no native selection.");
      native.removeAllRanges();
      native.addRange(range);
      const selectedText = native.toString();
      expect(selectedText).toContain("Second paragraph");

      expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
      expect(fixture.surface.state().selection).toEqual(selection);
      expect(pages).toHaveFocus();
      expect(pressKey(fixture, "c", { metaKey: true })).toBe(true);
      expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
      expect(fixture.surface.state().selection).toEqual(selection);
      expect(pages).toHaveFocus();

      expect(pressShiftF10(fixture)).toBe(false);
      expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Annotate selection" })).not.toBeInTheDocument();
      expect(fixture.surface.state().selection).toEqual(selection);

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(fixture.exec).toHaveBeenCalledWith({ type: "copy" });
      expect(fixture.surface.state().selection).toEqual(selection);
      expect(pages).toHaveFocus();
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ["Copy", "selection"],
    ["Annotate selection", "selection"],
    ["Copy", "revision"],
    ["Annotate selection", "revision"],
  ])("does not apply %s after the floating strip's %s changes", (action, changed) => {
    const fixture = mount(false, true);
    try {
      const pages = screen.getByRole("textbox", { name: "Document content" });
      const line = fixture.wrapper.querySelector<HTMLElement>(".docx-line");
      const [paragraphId, otherParagraphId] = fixture.surface.session.paragraphIds();
      const text = line?.querySelector(".layout-run-text")?.firstChild;
      if (!line || !paragraphId || !otherParagraphId || !text) throw new Error("The fixture has no painted paragraphs.");
      vi.spyOn(line, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 24, 120, 14));
      const selection = { anchor: { paragraphId, offset: 0 }, head: { paragraphId, offset: 3 } };
      pages.focus();
      act(() => fixture.surface.setSelection(selection));
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      const native = document.getSelection();
      if (!native) throw new Error("The fixture has no native selection.");
      native.removeAllRanges();
      native.addRange(range);
      expect(pressShiftF10(fixture)).toBe(false);
      const button = screen.getByRole("button", { name: action });
      button.focus();

      const current = changed === "selection" ? { ...selection, head: { paragraphId, offset: 2 } } : selection;
      const revision = fixture.surface.session.revision();
      act(() => {
        if (changed === "selection") fixture.surface.setSelection(current);
        else expect(fixture.surface.session.applyTreeOps([
          { op: "insertText", paragraphId: otherParagraphId, offset: 0, text: "Edited " },
        ]).committed).toBe(true);
      });
      expect(fixture.surface.session.revision()).toBe(revision + (changed === "revision" ? 1 : 0));
      expect(fixture.surface.state().selection).toEqual(current);
      expect(button).toHaveFocus();
      fireEvent.click(button);

      expect(fixture.exec).not.toHaveBeenCalled();
      expect(fixture.annotate).not.toHaveBeenCalled();
      expect(fixture.surface.state().selection).toEqual(current);
      expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
      expect(pages).toHaveFocus();
    } finally {
      fixture.dispose();
    }
  });

  it.each(["Copy", "Annotate selection"])("does not apply %s after its selected line scrolls out of view", (action) => {
    const fixture = mount(false, true);
    const viewport = fixture.wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
    const pages = screen.getByRole("textbox", { name: "Document content" });
    const line = fixture.wrapper.querySelector<HTMLElement>(".docx-line");
    const [paragraphId] = fixture.surface.session.paragraphIds();
    const text = line?.querySelector(".layout-run-text")?.firstChild;
    if (!viewport || !line || !paragraphId || !text) throw new Error("The fixture has no painted paragraph.");
    const rect = vi.spyOn(line, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 24, 120, 14));
    const selection = { anchor: { paragraphId, offset: 0 }, head: { paragraphId, offset: 3 } };
    pages.focus();
    act(() => fixture.surface.setSelection(selection));
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    const native = document.getSelection();
    if (!native) throw new Error("The fixture has no native selection.");
    native.removeAllRanges();
    native.addRange(range);
    expect(pressShiftF10(fixture)).toBe(false);
    const button = screen.getByRole("button", { name: action });
    button.focus();
    expect(button).toHaveFocus();

    viewport.scrollTop = 100;
    rect.mockReturnValue(new DOMRect(24, -76, 120, 14));
    fireEvent.scroll(viewport);
    fireEvent.click(button);

    expect(fixture.exec).not.toHaveBeenCalled();
    expect(fixture.annotate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
    expect(fixture.surface.state().selection).toEqual(selection);
    expect(viewport.scrollTop).toBe(100);
    expect(viewport).toHaveFocus();
  });

  it("can view an existing citation but cannot open insertion with Track Changes on", async () => {
    const fixture = mount(true, false, true);
    await readyBodyDrawing(fixture.surface);
    const [paragraphId] = fixture.surface.session.paragraphIds();
    const caret = { paragraphId, offset: 3 };
    fixture.surface.setSelection({ anchor: caret, head: caret });
    showCaret(fixture);

    pressShiftF10(fixture);
    expect(screen.queryByRole("button", { name: "Insert citation" })).not.toBeInTheDocument();

    showField(fixture);
    const fieldStart = { paragraphId, offset: 4 };
    fixture.surface.setSelection({ anchor: fieldStart, head: fieldStart });
    expect(pressShiftF10(fixture)).toBe(false);
    expect(screen.getByRole("button", { name: "View citation" })).toBeVisible();
  });

  it("keeps the citation picker at the captured caret when the page is repainted", async () => {
    const fixture = mount(true);
    try {
      await readyBodyDrawing(fixture.surface);
      const paragraphId = fixture.surface.session.paragraphIds()[0];
      if (!paragraphId) throw new Error("The fixture has no paragraph.");
      const fieldStart = { paragraphId, offset: 4 };
      fixture.surface.setSelection({ anchor: fieldStart, head: fieldStart });
      pressKey(fixture, "ArrowLeft");
      expect(fixture.surface.state().selection).toEqual({
        anchor: { ...fieldStart, offset: 3 },
        head: { ...fieldStart, offset: 3 },
      });
      const page = showCaret(fixture);

      expect(pressShiftF10(fixture)).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Insert citation" }));
      const search = screen.getByRole("searchbox");
      fireEvent.change(search, { target: { value: "Search in progress" } });
      const repaint = page.cloneNode(true) as HTMLElement;
      repaint.querySelector("[data-docx-caret]")?.remove();
      vi.spyOn(repaint, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 400));
      await act(async () => {
        page.replaceWith(repaint);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      expect(screen.getByRole("searchbox")).toBe(search);
      expect(search).toHaveValue("Search in progress");
      expect(search).toHaveFocus();
    } finally {
      fixture.dispose();
    }
  });

  it("keeps undo and redo in the citation search until focus returns to the draft", () => {
    const fixture = mount(false);
    fixture.wrapper.dataset.docxHistory = "working";
    const unregister = registerDocxHistory(fixture.wrapper, () => ({ exec: fixture.exec }));
    try {
      const [paragraphId] = fixture.surface.session.paragraphIds();
      const caret = { paragraphId, offset: 2 };
      act(() => fixture.surface.setSelection({ anchor: caret, head: caret }));
      showCaret(fixture);
      expect(pressShiftF10(fixture)).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Insert citation" }));
      const search = screen.getByRole("searchbox");
      expect(search).toHaveFocus();

      expect(runDocxHistory(document.activeElement, false)).toBe(false);
      expect(runDocxHistory(document.activeElement, true)).toBe(false);
      expect(fixture.exec).not.toHaveBeenCalled();

      fireEvent.keyDown(search, { key: "Escape" });
      expect(screen.getByRole("textbox", { name: "Document content" })).toHaveFocus();
      expect(runDocxHistory(document.activeElement, false)).toBe(true);
      expect(fixture.exec).toHaveBeenCalledExactlyOnceWith({ type: "undo" });
    } finally {
      unregister();
      fixture.dispose();
    }
  });

  it.each(["picker", "viewport"] as const)(
    "refuses a stale citation confirmation with focus on the %s",
    async (focused) => {
      const fixture = mount(true, true);
      try {
        await readyBodyDrawing(fixture.surface);
        const [paragraphId, nextParagraphId] = fixture.surface.session.paragraphIds();
        if (!paragraphId || !nextParagraphId) throw new Error("The fixture has no paragraph pair.");
        const caret = { paragraphId, offset: 3 };
        fixture.surface.setSelection({ anchor: caret, head: caret });
        showCaret(fixture);
        expect(pressShiftF10(fixture)).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Insert citation" }));
        fireEvent.click(screen.getByRole("button", { name: "Adjacent citation" }));
        const confirm = screen.getByRole("button", { name: "Insert citation" });
        expect(confirm).toBeEnabled();

        const viewport = fixture.wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
        if (!viewport) throw new Error("The fixture has no viewport.");
        const focusOwner = focused === "picker" ? confirm : viewport;
        focusOwner.focus();
        viewport.scrollTop = 100;
        const moved = { paragraphId: nextParagraphId, offset: 3 };
        act(() => fixture.surface.setSelection({ anchor: moved, head: moved }));
        expect(focusOwner).toHaveFocus();
        fireEvent.click(confirm);

        expect(fixture.session.insertCitation).not.toHaveBeenCalled();
        expect(fixture.surface.state().selection).toEqual({ anchor: moved, head: moved });
        expect(screen.queryByRole("dialog", { name: "Insert citation" })).not.toBeInTheDocument();
        expect(focused === "picker" ? screen.getByRole("textbox", { name: "Document content" }) : viewport).toHaveFocus();
        expect(viewport.scrollTop).toBe(100);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("keeps an isolated citation action", async () => {
    const fixture = mount(true);
    try {
      const visit = await readyBodyDrawing(fixture.surface);
      const paragraph = fixture.session.listParagraphs()[0];
      if (!paragraph) throw new Error("The fixture has no paragraph.");
      const field = fixture.session.readParagraph(paragraph.handle).atoms.find((atom) => atom.kind === "field");
      if (!field) throw new Error("The fixture has no citation field.");

      const paragraphId = visit.drawing.kind === "inlineDrawing"
        ? visit.drawing.paragraphId
        : visit.drawing.anchorParagraphId;
      const fieldStart = { paragraphId, offset: field.modelRange.start };
      fixture.surface.setSelection({ anchor: fieldStart, head: fieldStart });
      expect(fixture.surface.state().selection).toEqual({ anchor: fieldStart, head: fieldStart });
      showField(fixture);
      expect(pressShiftF10(fixture)).toBe(false);
      expect(screen.getByRole("button", { name: "View citation" })).toBeVisible();
    } finally {
      fixture.dispose();
    }
  });

  it.each(["citation action", "source link"])("dismisses an offscreen field before using its %s", (control) => {
    const fixture = mount(true);
    const viewport = fixture.wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
    const [paragraphId] = fixture.surface.session.paragraphIds();
    if (!viewport || !paragraphId) throw new Error("The fixture has no painted paragraph.");
    const pages = screen.getByRole("textbox", { name: "Document content" });
    const caret = { paragraphId, offset: 4 };
    pages.focus();
    act(() => fixture.surface.setSelection({ anchor: caret, head: caret }));
    const fieldRect = showField(fixture);
    expect(pressShiftF10(fixture)).toBe(false);
    let action = screen.getByRole("button", { name: "View citation" });
    if (control === "source link") {
      fireEvent.click(action);
      action = screen.getByRole("link", { name: /Adjacent citation/ });
    }
    expect(action).toHaveFocus();

    const open = vi.spyOn(window, "open").mockReturnValue(window);
    try {
      viewport.scrollTop = 100;
      fieldRect.mockReturnValue(new DOMRect(24, -76, 42, 14));
      fireEvent.scroll(viewport);
      fireEvent.click(action);

      expect(open).not.toHaveBeenCalled();
      expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
      expect(viewport).toHaveFocus();
      expect(viewport.scrollTop).toBe(100);
      expect(fixture.surface.state().selection).toEqual({ anchor: caret, head: caret });
    } finally {
      open.mockRestore();
    }
  });

  it("hands an immediate Enter to the keyboard-invoked picture action", async () => {
    const fixture = mount(false);
    try {
      const visit = await readyBodyDrawing(fixture.surface);
      const paragraphId = visit.drawing.kind === "inlineDrawing"
        ? visit.drawing.paragraphId
        : visit.drawing.anchorParagraphId;
      const afterPicture = { paragraphId, offset: visit.drawing.start + 1 };
      fixture.surface.setSelection({ anchor: afterPicture, head: afterPicture });
      pressKey(fixture, "ArrowLeft");
      showDrawing(fixture, visit.drawing.drawingNodeId);

      const pages = screen.getByRole("textbox", { name: "Document content" });
      pages.focus();
      const revision = fixture.session.revision();
      const invoke = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
      let enterTarget: Element | null = null;
      const recordEnter = (event: KeyboardEvent) => {
        if (event.key === "Enter") enterTarget = event.target as Element;
      };
      fixture.wrapper.addEventListener("keydown", recordEnter, true);
      act(() => {
        pages.dispatchEvent(invoke);
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      fixture.wrapper.removeEventListener("keydown", recordEnter, true);
      expect(invoke.defaultPrevented).toBe(true);
      expect(fixture.session.revision()).toBe(revision);
      expect(enterTarget).toBe(screen.getByRole("button", { name: "View image" }));
    } finally {
      fixture.dispose();
    }
  });

  it("keeps an explicit picture selection", async () => {
    const fixture = mount(true);
    try {
      const visit = await readyBodyDrawing(fixture.surface);
      const paragraphId = visit.drawing.kind === "inlineDrawing"
        ? visit.drawing.paragraphId
        : visit.drawing.anchorParagraphId;
      act(() => {
        expect(fixture.surface.selectDrawing(visit.drawing.drawingNodeId, paragraphId)).toBe(true);
      });
      expect(fixture.surface.drawingSelectionIntent()).toEqual({
        kind: "pointer",
        drawingNodeId: visit.drawing.drawingNodeId,
      });
      expect(readDocxContextDrawing(fixture.surface, fixture.session)).toMatchObject({
        kind: "image",
        previewable: true,
        readImage: expect.any(Object),
      });
      showDrawing(fixture, visit.drawing.drawingNodeId);
      expect(pressShiftF10(fixture)).toBe(false);
      expect(screen.getByRole("button", { name: "View image" })).toBeVisible();
    } finally {
      fixture.dispose();
    }
  });

  it.each(["Edit LaTeX", "View image", "Insert citation"])("does not open %s or yield feedback after its target scrolls away", async (label) => {
    const fixture = mount(false);
    const viewport = fixture.wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
    if (!viewport) throw new Error("The fixture has no viewport.");
    const readImage = vi.spyOn(fixture.session, "readImage");
    let moveOffscreen: () => void;
    if (label === "Edit LaTeX") {
      const equation = showEquation(fixture);
      selectEquation(fixture, equation.painted);
      moveOffscreen = () => { equation.rect.mockReturnValue(new DOMRect(24, -76, 42, 14)); };
    } else if (label === "View image") {
      const { drawing } = await readyBodyDrawing(fixture.surface);
      act(() => {
        expect(fixture.surface.selectDrawing(drawing.drawingNodeId,
          drawing.kind === "inlineDrawing" ? drawing.paragraphId : drawing.anchorParagraphId)).toBe(true);
      });
      const rect = showDrawing(fixture, drawing.drawingNodeId);
      moveOffscreen = () => { rect.mockReturnValue(new DOMRect(24, -76, 42, 14)); };
    } else {
      const [paragraphId] = fixture.surface.session.paragraphIds();
      const caret = { paragraphId, offset: 3 };
      act(() => fixture.surface.setSelection({ anchor: caret, head: caret }));
      const page = showCaret(fixture);
      moveOffscreen = () => { vi.mocked(page.getBoundingClientRect).mockReturnValue(new DOMRect(0, -100, 500, 400)); };
    }
    expect(pressShiftF10(fixture)).toBe(false);
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveFocus();
    const selection = fixture.surface.state().selection;

    viewport.scrollTop = 100;
    moveOffscreen();
    fireEvent.scroll(viewport);
    fireEvent.click(button);

    expect(readImage).not.toHaveBeenCalled();
    expect(fixture.openPanel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
    expect(viewport).toHaveFocus();
    expect(viewport.scrollTop).toBe(100);
    expect(fixture.surface.state().selection).toEqual(selection);
  });

  it("keeps an explicitly clicked equation on the keyboard route", () => {
    const fixture = mount(true);
    const original = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    try {
      const { element } = showEquation(fixture);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => element,
      });
      fireEvent.pointerDown(element, { button: 0, isPrimary: true, pointerId: 1, clientX: 30, clientY: 30 });
      fireEvent.pointerUp(element, { button: 0, isPrimary: true, pointerId: 1, clientX: 30, clientY: 30 });
      fireEvent.click(element, { detail: 1, clientX: 30, clientY: 30 });
      expect(screen.getByRole("button", { name: "Edit LaTeX" })).toBeVisible();

      fireEvent.keyDown(screen.getByTestId("docx-context-tools"), { key: "Escape" });
      expect(screen.queryByTestId("docx-context-tools")).not.toBeInTheDocument();
      pressShiftF10(fixture);
      expect(screen.getByRole("button", { name: "Edit LaTeX" })).toBeVisible();
    } finally {
      if (original) Object.defineProperty(document, "elementFromPoint", original);
      else Reflect.deleteProperty(document, "elementFromPoint");
      fixture.dispose();
    }
  });
});

describe("DOCX equation overlay placement", () => {
  it.each(["scrolls out of view", "becomes too narrow"] as const)(
    "keeps the draft and moves focus to the viewport when the popup %s",
    async (placement) => {
      const fixture = mount(true);
      try {
        const equation = openEquationDraft(fixture);
        const viewport = fixture.wrapper.querySelector<HTMLElement>(".docx-editor__scroll-container");
        if (!viewport) throw new Error("The fixture has no viewport.");
        viewport.scrollTop = 180;
        const selection = fixture.surface.state().selection;
        const scrollTop = viewport.scrollTop;
        const rebind = vi.spyOn(fixture.surface, "setSelection");

        if (placement === "scrolls out of view") {
          equation.rect.mockReturnValue(new DOMRect(24, -80, 42, 14));
        } else {
          fixture.setViewportRect(new DOMRect(0, 0, 7, 400));
        }
        fireEvent.scroll(viewport);
        await settlePlacement();

        expect(screen.queryByRole("dialog", { name: "Edit LaTeX" })).not.toBeInTheDocument();
        expect(viewport).toHaveFocus();
        expect(rebind).not.toHaveBeenCalled();
        expect(fixture.surface.state().selection).toEqual(selection);
        expect(viewport.scrollTop).toBe(scrollTop);
        expect([...fixture.equationDrafts.values()]).toContainEqual({
          latex: "y^2",
          macros: "",
          adoptSource: false,
        });

        fixture.setViewportRect(new DOMRect(0, 0, 500, 400));
        selectEquation(fixture, equation.painted);
        showEquation(fixture);
        expect(pressShiftF10(fixture)).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Edit LaTeX" }));
        expect(screen.getByRole("textbox", { name: "LaTeX source" })).toHaveValue("y^2");
      } finally {
        fixture.dispose();
      }
    },
  );
});

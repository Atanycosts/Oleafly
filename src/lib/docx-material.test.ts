// @vitest-environment jsdom
import {
  DEFAULT_REVISION_MARKUP,
  DEFAULT_REVIEW_PANE,
  type Editor,
  type EditorSnapshot,
} from "@docx-editor.dev/core/contracts/editor";
import type { DocxEditorInstance, PaginatedSurface } from "@docx-editor.dev/core/editor";
import { describe, expect, it, vi } from "vitest";
import { captureWorkingDocxMaterial, readDocxMaterialSelection } from "./docx-material";

function snapshot(selection: EditorSnapshot["selection"], selectionCollapsed = false): EditorSnapshot {
  return {
    scope: { kind: "body" },
    isLoading: false,
    parseError: null,
    editable: true,
    zoom: 1,
    reviewPane: DEFAULT_REVIEW_PANE,
    revisionMarkup: DEFAULT_REVISION_MARKUP,
    collaborationStatus: "inactive",
    selection,
    selectionCollapsed,
    formatting: null,
    table: null,
    tocContext: null,
    image: null,
    page: { current: 1, total: 1 },
  };
}

describe("DOCX material adapter", () => {
  it("uses the stable paragraph identity for a selection contained in one paragraph", () => {
    const editor = materialEditor("1A2B3C4D", 0, 26, "Selected treatment effect.");
    expect(readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "1A2B3C4D" },
    }))).toEqual({
      anchor: { kind: "object", id: "1A2B3C4D", label: "Selected treatment effect.", range: { from: 0, to: 26 } },
      quote: "Selected treatment effect.",
    });
  });

  it("distinguishes identical selected text by its paragraph model range", () => {
    const editor = materialEditor("1A2B3C4D", 0, 4, "same");
    const first = readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "1A2B3C4D" },
    }));
    editor.surface.state = () => ({
      selection: {
        anchor: { paragraphId: "paragraph-node", offset: 12 },
        head: { paragraphId: "paragraph-node", offset: 8 },
      },
    } as ReturnType<PaginatedSurface["state"]>);
    const second = readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "1A2B3C4D" },
    }));
    expect(first?.quote).toBe(second?.quote);
    expect(first?.anchor).toMatchObject({ id: "1A2B3C4D", range: { from: 0, to: 4 } });
    expect(second?.anchor).toMatchObject({ id: "1A2B3C4D", range: { from: 8, to: 12 } });
  });

  it("does not claim a precise object for a caret or cross-paragraph selection", () => {
    const editor = materialEditor("1A2B3C4D", 0, 14, "Two paragraphs");
    expect(readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "1A2B3C4D" },
    }, true))).toBeNull();
    expect(readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "5E6F7890" },
    }))).toBeNull();
  });

  it("rejects the frozen annotation when editing changes the session during export", async () => {
    let revision = 4;
    const editor = {
      save: vi.fn(async () => {
        revision = 5;
        return new Uint8Array([80, 75, 3, 4]).buffer;
      }),
    } as unknown as Pick<Editor, "save">;
    await expect(captureWorkingDocxMaterial({
      metadata: { projectId: "app-project", documentId: "docx:paper", title: "paper.docx" },
      editor,
      session: { revision: () => revision },
    })).rejects.toMatchObject({ code: "revision-changed" });
  });
});

function materialEditor(paraId: string, from: number, to: number, quote: string) {
  return {
    query: vi.fn(() => quote),
    snapshot: vi.fn(() => snapshot({ from: { paraId }, to: { paraId } })),
    surface: {
      session: { nodeIdOf: (id: string) => id === paraId ? "paragraph-node" : null },
      state: () => ({
        selection: {
          anchor: { paragraphId: "paragraph-node", offset: from },
          head: { paragraphId: "paragraph-node", offset: to },
        },
      } as ReturnType<PaginatedSurface["state"]>),
    },
  } as unknown as Pick<DocxEditorInstance, "query" | "snapshot" | "surface"> & {
    surface: Pick<PaginatedSurface, "session" | "state">;
  };
}

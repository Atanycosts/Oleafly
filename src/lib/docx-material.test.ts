// @vitest-environment jsdom
import {
  DEFAULT_REVISION_MARKUP,
  DEFAULT_REVIEW_PANE,
  type Editor,
  type EditorSnapshot,
} from "@docx-editor.dev/core/contracts/editor";
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
    const editor = { query: vi.fn(() => "Selected treatment effect.") } as unknown as Editor;
    expect(readDocxMaterialSelection(editor, snapshot({
      from: { paraId: "1A2B3C4D" },
      to: { paraId: "1A2B3C4D" },
    }))).toEqual({
      anchor: { kind: "object", id: "1A2B3C4D", label: "Selected treatment effect." },
      quote: "Selected treatment effect.",
    });
  });

  it("does not claim a precise object for a caret or cross-paragraph selection", () => {
    const editor = { query: vi.fn(() => "Two paragraphs") } as unknown as Editor;
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

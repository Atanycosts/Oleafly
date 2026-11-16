import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveMaterialAnnotation } from "./material-annotations";
import type { MaterialDocument } from "./material-surface";
import type { TaskAnnotationDraft } from "./task-collaboration";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => api);
const draft: TaskAnnotationDraft = { target: { projectId: "paper", taskId: null, objectKind: "material", objectId: "file", objectRevision: "old", path: null }, body: "Keep evidence", parentId: null, mentions: [], explicitRequest: false };
beforeEach(() => api.invoke.mockReset());
describe("material source retention boundary", () => {
  it("sends complete large bytes independently of annotation source limits", async () => {
    const text = "字".repeat(100_000);
    const document: MaterialDocument = { projectId: "paper", documentId: "file", title: "Paper", path: "paper.md", kind: "markdown", revision: "hash", source: { text } };
    await saveMaterialAnnotation(document, { kind: "whole" }, draft);
    const payload = api.invoke.mock.calls[0][1];
    expect(payload.bytes).toHaveLength(300_000);
    expect(new TextDecoder().decode(new Uint8Array(payload.bytes))).toBe(text);
    expect(payload.document).not.toHaveProperty("source");
  });
  it("replies use the parent's retained source without capturing a newer buffer", async () => {
    const source = vi.fn().mockRejectedValue(new Error("new buffer unavailable"));
    const document: MaterialDocument = { projectId: "paper", documentId: "file", title: "Paper", path: "paper.md", kind: "markdown", revision: "new", source };
    await saveMaterialAnnotation(document, { kind: "whole" }, { ...draft, parentId: "old-comment" });
    expect(source).not.toHaveBeenCalled();
    expect(api.invoke).toHaveBeenCalledWith("material_annotation_save", expect.objectContaining({ parentId: "old-comment", bytes: [] }));
  });
});

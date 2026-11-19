import { describe, expect, it } from "vitest";
import { createMaterialDocument, materialRevision, materialTarget, sameMaterialVersion } from "./material-surface";

const metadata = { projectId: "paper", documentId: "file:figure", path: "figure.svg", title: "Figure", kind: "image" as const };
describe("material identity", () => {
  it("hashes exact bytes and freezes caller-owned buffers", async () => {
    const bytes = new TextEncoder().encode("first\r\n");
    const document = await createMaterialDocument(metadata, { bytes });
    bytes.fill(0);
    expect(await materialRevision(await (typeof document.source === "function" ? document.source() : document.source))).toBe(document.revision);
    expect(document.revision).not.toBe(await materialRevision({ text: "first\n" }));
    expect(await materialRevision({ text: "first\r\n" })).toBe(document.revision);
  });
  it("keeps discussion identity across revisions and renames, while distinguishing versions and projects", async () => {
    const old = await createMaterialDocument(metadata, { text: "old" });
    const current = await createMaterialDocument({ ...metadata, path: "renamed.svg" }, { text: "new" });
    expect(materialTarget(old)).toMatchObject({ objectId: metadata.documentId, path: null });
    expect(materialTarget(current).objectId).toBe(materialTarget(old).objectId);
    expect(sameMaterialVersion(old, current)).toBe(false);
    expect(sameMaterialVersion(old, { ...old, projectId: "other" })).toBe(false);
    expect(sameMaterialVersion(old, { ...old, documentId: "other" })).toBe(false);
  });
});

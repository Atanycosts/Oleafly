import { expect, it } from "vitest";
import { candidateVerificationTargets, confirmedCandidateTargets } from "./docx-candidate-verification";
import type { DocxFormatSemanticLocation } from "./docx-format-finding-identity";

const part = "/word/document.xml";
const span = (objectId: string, start: number, end: number, ownerKey = "p0"): DocxFormatSemanticLocation => ({
  objectId, part, kind: "run", key: `${ownerKey}:${start}`, run: { ownerKey, start, end },
});
const index = (...entries: DocxFormatSemanticLocation[]) => ({ byObjectId: new Map(entries.map((item) => [item.objectId, item])) });
const target = { caseId: "original-case", propertyPath: "run.fontSizePt", expected: 12, location: span("original", 0, 10) };
const finding = (objectId: string, verdict: "observed_match" | "cannot_determine" = "observed_match", observed = 12) => ({
  object_id: objectId, property_path: target.propertyPath, verdict, observed,
});

it("checks every part of a split run without relying on its old XML id", () => {
  const selected = candidateVerificationTargets([target], index(
    span("first", 0, 4), span("second", 4, 10), span("next", 10, 13), span("unrelated", 0, 10, "p1"),
  ));
  expect(selected).toEqual([{ case_id: "original-case", property_path: "run.fontSizePt", object_ids: ["first", "second"] }]);
  expect(confirmedCandidateTargets([target], selected, [finding("first"), finding("second")])).toEqual([true]);
  expect(confirmedCandidateTargets([target], selected, [finding("first"), finding("second", "cannot_determine")])).toEqual([false]);
  expect(confirmedCandidateTargets([target], selected, [finding("first"), finding("original")])).toEqual([false]);
  expect(confirmedCandidateTargets([target], selected, [finding("first"), finding("second", "observed_match", 13)])).toEqual([false]);
});

it("does not confirm a detached, shortened or merged run", () => {
  for (const after of [index(), index(span("original", 0, 4)), index(span("original", 0, 11))]) {
    const selected = candidateVerificationTargets([target], after);
    expect(selected[0].object_ids).toEqual([]);
    expect(confirmedCandidateTargets([target], selected, [finding("original")])).toEqual([false]);
  }
});

it("uses the final paragraph identity when its XML path changes", () => {
  const original = { objectId: "old", part, kind: "paragraph", key: "p0" };
  const after = { ...original, objectId: "new" };
  const edit = { caseId: "check-case", propertyPath: "paragraph.alignment", expected: "left", location: original };
  const selected = candidateVerificationTargets([edit], index(after));
  const record = { object_id: "new", property_path: edit.propertyPath, observed: "left", verdict: "observed_match" as const };
  expect(selected[0].object_ids).toEqual(["new"]);
  expect(confirmedCandidateTargets([edit], selected, [record])).toEqual([true]);
  expect(confirmedCandidateTargets([edit], selected, [{ ...record, property_path: "paragraph.keepLines" }])).toEqual([false]);
});

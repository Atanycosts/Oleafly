import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDocxFormatFacts } from "./docx-format";
import {
  createDocxFormatSemanticIndex,
  findingMatchesSemanticTarget,
  sameDocxFormatSemanticObject,
} from "./docx-format-finding-identity";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  });
}

async function locations(bytes: Uint8Array) {
  const snapshot = (await openDocxFormatFacts(bytes)).snapshot;
  return {
    snapshot,
    index: createDocxFormatSemanticIndex(snapshot),
  };
}

describe("DOCX finding identity across formatting writes", () => {
  it("matches a paragraph and its run after pPr is inserted", async () => {
    const before = await locations(docx(
      '<w:p w14:paraId="12345678"><w:r><w:t>Alpha</w:t></w:r></w:p>',
    ));
    const after = await locations(docx(
      '<w:p w14:paraId="12345678"><w:pPr><w:keepNext/></w:pPr><w:r><w:t>Alpha</w:t></w:r></w:p>',
    ));
    const beforeParagraph = before.snapshot.objects.find(
      (object) => object.kind === "paragraph",
    );
    const afterParagraph = after.snapshot.objects.find(
      (object) => object.kind === "paragraph",
    );
    const beforeRun = before.snapshot.objects.find((object) => object.kind === "run");
    const afterRun = after.snapshot.objects.find((object) => object.kind === "run");
    if (!beforeParagraph || !afterParagraph || !beforeRun || !afterRun) {
      throw new Error("Expected one paragraph and one run in each snapshot.");
    }

    expect(beforeRun.object_id).not.toBe(afterRun.object_id);
    expect(beforeRun.path).toEqual([0, 0, 0, 0]);
    expect(afterRun.path).toEqual([0, 0, 0, 1]);
    expect(sameDocxFormatSemanticObject(
      before.index.byObjectId.get(beforeParagraph.object_id),
      after.index.byObjectId.get(afterParagraph.object_id),
    )).toBe(true);
    expect(sameDocxFormatSemanticObject(
      before.index.byObjectId.get(beforeRun.object_id),
      after.index.byObjectId.get(afterRun.object_id),
    )).toBe(true);
  });

  it("matches split runs to the original paragraph text interval", async () => {
    const before = await locations(docx(
      '<w:p w14:paraId="12345678"><w:r><w:t>Alpha</w:t></w:r></w:p>',
    ));
    const after = await locations(docx(
      '<w:p w14:paraId="12345678"><w:r><w:t>Al</w:t></w:r><w:r><w:t>pha</w:t></w:r></w:p>',
    ));
    const beforeRun = before.snapshot.objects.find((object) => object.kind === "run");
    if (!beforeRun) throw new Error("Expected one run in the source snapshot.");
    const afterRuns = after.snapshot.objects.filter((object) => object.kind === "run");
    const original = before.index.byObjectId.get(beforeRun.object_id);

    expect(afterRuns).toHaveLength(2);
    expect(afterRuns.every((run) =>
      sameDocxFormatSemanticObject(original, after.index.byObjectId.get(run.object_id)),
    )).toBe(true);
    const secondRun = afterRuns[1];
    if (!secondRun) throw new Error("Expected the second split run.");
    expect(findingMatchesSemanticTarget({
      case_id: "case-after-drift",
      object_id: secondRun.object_id,
      property_path: "run.fontSizePt",
    }, {
      caseId: "case-before-drift",
      propertyPath: "run.fontSizePt",
      location: original,
    }, after.index)).toBe(true);
    expect(findingMatchesSemanticTarget({
      case_id: "case-after-drift",
      object_id: secondRun.object_id,
      property_path: "run.bold",
    }, {
      caseId: "case-before-drift",
      propertyPath: "run.fontSizePt",
      location: original,
    }, after.index)).toBe(false);
  });

  it("keeps paragraph-relative identity when the parser generates the paraId", async () => {
    const before = await locations(docx(
      "<w:p><w:r><w:t>Untracked</w:t></w:r></w:p>",
    ));
    const after = await locations(docx(
      "<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr><w:r><w:t>Untracked</w:t></w:r></w:p>",
    ));
    const beforeParagraph = before.snapshot.objects.find(
      (object) => object.kind === "paragraph",
    );
    const afterParagraph = after.snapshot.objects.find(
      (object) => object.kind === "paragraph",
    );
    if (!beforeParagraph || !afterParagraph) {
      throw new Error("Expected one paragraph in each snapshot.");
    }
    const beforeLocation = before.index.byObjectId.get(beforeParagraph.object_id);
    const afterLocation = after.index.byObjectId.get(afterParagraph.object_id);

    expect(beforeLocation?.paraId).toBeDefined();
    expect(afterLocation?.paraId).toBe(beforeLocation?.paraId);
    expect(sameDocxFormatSemanticObject(beforeLocation, afterLocation)).toBe(true);
  });

  it("does not attach a run finding across paragraphs or with a missing target", async () => {
    const document = await locations(docx(
      '<w:p><w:r><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p>',
    ));
    const runs = document.snapshot.objects.filter((object) => object.kind === "run");
    const paragraph = document.snapshot.objects.find((object) => object.kind === "paragraph");
    const [alpha, beta] = runs.map((run) => document.index.byObjectId.get(run.object_id));
    if (!alpha || !beta || !paragraph) throw new Error("Expected two located runs and a paragraph.");

    expect(sameDocxFormatSemanticObject(alpha, beta)).toBe(false);
    expect(sameDocxFormatSemanticObject(undefined, beta)).toBe(false);
    expect(sameDocxFormatSemanticObject({ ...alpha, part: "/word/header1.xml" }, beta)).toBe(false);
    expect(sameDocxFormatSemanticObject(
      document.index.byObjectId.get(paragraph.object_id),
      beta,
    )).toBe(false);
  });

  it("keeps an empty formatting run at its paragraph boundary", async () => {
    const before = await locations(docx(
      "<w:p><w:r><w:rPr><w:b/></w:rPr></w:r><w:r><w:t>Alpha</w:t></w:r></w:p>",
    ));
    const after = await locations(docx(
      "<w:p><w:pPr><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr></w:r><w:r><w:t>Alpha</w:t></w:r></w:p>",
    ));
    const emptyRun = (snapshot: typeof before.snapshot) => snapshot.objects.find(
      (object) => object.kind === "run" && !object.text,
    );
    const sourceRun = emptyRun(before.snapshot);
    const savedRun = emptyRun(after.snapshot);
    if (!sourceRun || !savedRun) throw new Error("Expected the empty formatting runs.");

    expect(sameDocxFormatSemanticObject(
      before.index.byObjectId.get(sourceRun.object_id),
      after.index.byObjectId.get(savedRun.object_id),
    )).toBe(true);
  });
});

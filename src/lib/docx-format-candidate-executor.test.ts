// @vitest-environment node
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { openDocxFormatFacts } from "./docx-format";
import { validateDocxFormatCandidateBytes } from "./docx-format-candidate";
import {
  applyDocxFormatCandidates,
  applyReadyDocxFormatCandidates,
} from "./docx-format-candidate-executor";
import { planDocxTablePagination, verifyDocxTablePagination } from "./docx-table-pagination";
import type {
  ReadyDocxFormatCandidate,
} from "./docx-format-candidate-plan";
import { openDocxFormatSession } from "./docx-session";

function fixtureBytes(body: string) {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  });
}

function candidate(
  id: string,
  objectId: string,
  paragraphRef: string,
  scope: ReadyDocxFormatCandidate["scope"],
  propertyPath: string,
  operation: ReadyDocxFormatCandidate["operation"],
): ReadyDocxFormatCandidate {
  return {
    candidateId: id,
    scope,
    location: {
      objectId,
      part: "/word/document.xml",
      path: [],
      role: "body",
      paragraphRef,
    },
    changes: [{
      findingCaseId: `finding:${id}`,
      propertyPath,
      observed: null,
      expected: null,
      templateObjectIds: [],
      templateObjectCount: 0,
      templateRoleBasis: [],
    }],
    status: "ready",
    operation,
  };
}

it("splits a rejected batch and commits only the independently valid candidate", async () => {
  const { session, tree } = openDocxFormatSession(fixtureBytes(
    "<w:p><w:r><w:t>First</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Second</w:t></w:r></w:p>",
  ));
  try {
    const [first, second] = session.listParagraphs();
    if (!first || !second) throw new Error("Expected two body paragraphs.");
    const invalid = candidate(
      "invalid-run",
      "/word/document.xml#0.0.0",
      first.handle.ref,
      "run",
      "run.fontSizePt",
      {
        paragraphRef: first.handle.ref,
        range: { start: 0, end: 100 },
        font: { size: 9 },
      },
    );
    const valid = candidate(
      "valid-paragraph",
      "/word/document.xml#0.0.1",
      second.handle.ref,
      "paragraph",
      "paragraph.alignment",
      {
        paragraphRef: second.handle.ref,
        paragraph: { alignment: "Centered" },
      },
    );
    const list = vi.spyOn(session, "listParagraphs");

    const result = await applyReadyDocxFormatCandidates(
      session,
      [invalid, valid],
      2,
    );

    expect(list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(["valid-paragraph"]);
    expect(session.revision()).toBe(1);
    const xml = strFromU8(unzipSync(tree.save())["word/document.xml"]);
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).not.toContain('<w:sz w:val="18"');
  } finally {
    session.dispose();
  }
});

it("writes only the requested East Asian font slot and paragraph flag without mounting an editor", async () => {
  const { session, tree } = openDocxFormatSession(fixtureBytes(
    '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsiaTheme="minorEastAsia"/></w:rPr><w:t>中文</w:t></w:r></w:p>',
  ));
  try {
    const [{ handle }] = session.listParagraphs();
    const result = await applyReadyDocxFormatCandidates(session, [
      candidate("font", "run", handle.ref, "run", "run.fontFamilyEastAsia", {
        paragraphRef: handle.ref,
        range: { start: 0, end: 2 },
        font: { nameEastAsia: "SimSun" },
      }),
      candidate("keep", "paragraph", handle.ref, "paragraph", "paragraph.keepNext", {
        paragraphRef: handle.ref,
        paragraph: { keepNext: true },
      }),
    ]);
    expect(result).toEqual(["font", "keep"]);
    const xml = strFromU8(unzipSync(tree.save())["word/document.xml"]);
    expect(xml).toContain('w:ascii="Arial"');
    expect(xml).toContain('w:eastAsia="SimSun"');
    expect(xml).not.toContain("eastAsiaTheme");
    expect(xml).toContain("<w:keepNext/>");
    expect(xml).toContain("<w:t>中文</w:t>");
  } finally {
    session.dispose();
  }
});

it("leaves branch-dependent findings unresolved and formats the following paragraph", async () => {
  const left = '<w:pPr><w:jc w:val="left"/></w:pPr>';
  const bytes = fixtureBytes(
    `<w:p>${left}<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    '<mc:Choice Requires="w"><w:r><w:t>Choice</w:t></w:r></mc:Choice>' +
    '<mc:Fallback><w:r><w:t>Fallback</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>' +
    `<w:p>${left}<w:r><w:t>Following</w:t></w:r></w:p>`,
  );
  const { snapshot } = await openDocxFormatFacts(bytes);
  const paragraphs = snapshot.objects.filter(({ kind }) => kind === "paragraph");
  expect(paragraphs.map(({ text }) => text)).toEqual(["Choice", "Following"]);

  const result = await applyDocxFormatCandidates({
    bytes,
    baselineId: "baseline",
    check: { checkId: "check", baselineId: "baseline", sourceSha256: snapshot.source_sha256, validity: "CURRENT" },
    findings: paragraphs.map(({ object_id, kind, part, path, text }) => ({
      case_id: `alignment-${text}`,
      object_id, kind, part, path, role: "body",
      property_path: "paragraph.alignment", observed: "left", expected: "center",
      expected_value_count: 1, template_object_ids: ["template-paragraph"], verdict: "observed_difference",
    })),
  });
  expect(result.plan.unresolved).toMatchObject([{ findingCaseId: "alignment-Choice", reason: "live_target_unavailable" }]);
  expect(result.appliedCandidateIds).toHaveLength(1);
  const after = await openDocxFormatFacts(result.candidateBytes);
  expect(after.snapshot.objects.filter(({ kind }) => kind === "paragraph")).toMatchObject([
    { text: "Choice", properties: { paragraph: { alignment: "left" } } },
    { text: "Following", properties: { paragraph: { alignment: "center" } } },
  ]);
});

it("preserves adjacent layout and font attributes when applying supported findings", async () => {
  const bytes = fixtureBytes(
    '<w:p><w:pPr><w:ind w:left="120" w:rightChars="100"/>' +
    '<w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>' +
    '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Tahoma"/></w:rPr><w:t>Hello</w:t></w:r></w:p>',
  );
  const facts = await openDocxFormatFacts(bytes);
  const paragraph = facts.snapshot.objects.find(({ kind, text }) => kind === "paragraph" && text === "Hello");
  const run = facts.snapshot.objects.find(({ kind, text }) => kind === "run" && text === "Hello");
  if (!paragraph || !run) throw new Error("Expected the paragraph and run for Hello.");
  const changes = [
    { object: paragraph, property: "paragraph.spacing.after", observed: 6, expected: 12 },
    { object: paragraph, property: "paragraph.indent.left", observed: 6, expected: 12 },
    { object: run, property: "run.fontFamily", observed: "Arial", expected: "Calibri" },
  ];
  const result = await applyDocxFormatCandidates({
    bytes, facts, baselineId: "baseline",
    check: { checkId: "check", baselineId: "baseline", sourceSha256: facts.snapshot.source_sha256, validity: "CURRENT" },
    findings: changes.map(({ object, property, observed, expected }) => ({
      case_id: property, object_id: object.object_id, part: object.part, path: object.path, kind: object.kind, role: "body",
      property_path: property, observed, expected,
      expected_value_count: 1, template_object_ids: ["template-object"], verdict: "observed_difference",
    })),
  });

  expect(result.appliedCandidateIds).toHaveLength(2);
  expect(await validateDocxFormatCandidateBytes(bytes, result.candidateBytes)).toMatchObject({ status: "accepted" });
  const xml = strFromU8(unzipSync(result.candidateBytes)["word/document.xml"]);
  expect(xml).toMatch(/<w:spacing(?=[^>]*w:after="240")(?=[^>]*w:line="276")(?=[^>]*w:lineRule="auto")/);
  expect(xml).toMatch(/<w:ind(?=[^>]*w:left="240")(?=[^>]*w:rightChars="100")/);
  expect(xml).toMatch(/<w:rFonts(?=[^>]*w:ascii="Calibri")(?=[^>]*w:cs="Tahoma")/);
});

const cell = (content: string) => `<w:tc><w:p><w:r><w:t>${content}</w:t></w:r></w:p></w:tc>`;
const tableRow = (label: string, properties = "", secondCell = cell("42")) =>
  `<w:tr>${properties ? `<w:trPr>${properties}</w:trPr>` : ""}${cell(label)}${secondCell}</w:tr>`;
const table = (rows: string, firstRowStyle = true) =>
  `<w:tbl><w:tblPr><w:tblLook w:firstRow="${firstRowStyle ? 1 : 0}"/></w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${rows}</w:tbl>`;
const tableHeaderTemplate = [{ column_count: 2, rows: [{ object_id: "template-row", location: "Heading" }] }];

it.each([
  { mode: "pagination alone", editParagraph: false },
  { mode: "with paragraph formatting", editParagraph: true },
])("adds only missing pagination flags $mode and verifies the saved rows", async ({ editParagraph }) => {
  const tableXml = table(
    tableRow("Heading", '<w:cantSplit/><w:trHeight w:val="320" w:hRule="atLeast"/>') +
    tableRow("Short", '<w:trHeight w:val="340" w:hRule="atLeast"/><w:jc w:val="center"/>') +
    tableRow("Short B") +
    tableRow("Tall", '<w:trHeight w:val="14000" w:hRule="atLeast"/>') +
    tableRow("Opted out", '<w:cantSplit w:val="0"/>') +
    tableRow("Wrapped", "", cell("Long text ".repeat(300))) +
    tableRow("Merged", "", '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p/></w:tc>') +
    tableRow("Continued", "", '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>'),
  );
  const bytes = fixtureBytes(`<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>Lead-in</w:t></w:r></w:p>${tableXml}`);
  const facts = await openDocxFormatFacts(bytes);
  const tablePagination = planDocxTablePagination(facts, tableHeaderTemplate);
  expect(tablePagination.map(({ row, flag }) => [row, flag])).toEqual([
    [1, "tblHeader"], [2, "cantSplit"], [3, "cantSplit"],
  ]);
  expect(verifyDocxTablePagination(facts, tablePagination).map(({ confirmed }) => confirmed)).toEqual([false, false, false]);

  const lead = facts.snapshot.objects.find(({ kind, text }) => kind === "paragraph" && text === "Lead-in");
  if (!lead) throw new Error("Expected the lead-in paragraph.");
  const result = await applyDocxFormatCandidates({
    bytes, facts, baselineId: "baseline", tablePagination,
    findings: editParagraph ? [{
      case_id: "alignment-lead", object_id: lead.object_id, part: lead.part, path: lead.path, kind: lead.kind, role: "body",
      property_path: "paragraph.alignment", observed: "left", expected: "center",
      expected_value_count: 1, template_object_ids: ["template-paragraph"], verdict: "observed_difference",
    }] : [],
    check: { checkId: "check", baselineId: "baseline", sourceSha256: facts.snapshot.source_sha256, validity: "CURRENT" },
  });
  expect(result.appliedCandidateIds).toHaveLength(editParagraph ? 1 : 0);
  expect(result.appliedTablePagination).toEqual(tablePagination);
  expect((await validateDocxFormatCandidateBytes(bytes, result.candidateBytes)).status).toBe("accepted");
  const xml = strFromU8(unzipSync(result.candidateBytes)["word/document.xml"]);
  expect(xml).toContain('<w:trPr><w:cantSplit/><w:trHeight w:hRule="atLeast" w:val="320"/><w:tblHeader/></w:trPr>');
  expect(xml).toContain('<w:trPr><w:cantSplit/><w:trHeight w:hRule="atLeast" w:val="340"/><w:jc w:val="center"/></w:trPr>');
  expect(xml).toContain('<w:trPr><w:cantSplit w:val="0"/></w:trPr>');
  const saved = await openDocxFormatFacts(result.candidateBytes);
  expect(saved.snapshot.objects.find(({ kind, text }) => kind === "paragraph" && text === "Lead-in"))
    .toMatchObject({ properties: { paragraph: { alignment: editParagraph ? "center" : "left" } } });
  expect(verifyDocxTablePagination(saved, tablePagination)).toMatchObject([
    { confirmed: true, text: "Heading", paraId: expect.any(String) },
    { confirmed: true, text: "Short", paraId: expect.any(String) },
    { confirmed: true, text: "Short B", paraId: expect.any(String) },
  ]);
  expect(planDocxTablePagination(saved, tableHeaderTemplate)).toEqual([]);
});

it.each([
  { template: [], first: "", firstRowStyle: true },
  { template: tableHeaderTemplate, first: "", firstRowStyle: false },
  { template: tableHeaderTemplate, first: '<w:tblHeader w:val="off"/>', firstRowStyle: true },
])("does not turn first-row styling or an explicit opt-out into a repeat header", async ({ template, first, firstRowStyle }) => {
  const facts = await openDocxFormatFacts(fixtureBytes(table(tableRow("Heading", first) + tableRow("Data"), firstRowStyle)));
  expect(planDocxTablePagination(facts, template).map(({ row, flag }) => [row, flag])).toEqual([[2, "cantSplit"]]);
});

it("yields after a batch so cancellation prevents the next write", async () => {
  const { session, tree } = openDocxFormatSession(fixtureBytes(
    "<w:p><w:r><w:t>First</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Second</w:t></w:r></w:p>",
  ));
  try {
    const controller = new AbortController();
    const formatBatch = session.formatBatch!;
    const writes = vi.spyOn(session, "formatBatch").mockImplementation((operations, revision) => {
      const result = formatBatch(operations, revision);
      setTimeout(() => controller.abort(), 0);
      return result;
    });
    const pending = applyReadyDocxFormatCandidates(session, session.listParagraphs().map(({ handle }, index) =>
      candidate(String(index), String(index), handle.ref, "paragraph", "paragraph.alignment", {
        paragraphRef: handle.ref,
        paragraph: { alignment: "Centered" },
      }),
    ), 1, controller.signal);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toHaveBeenCalledTimes(1);
    const xml = strFromU8(unzipSync(tree.save())["word/document.xml"]);
    expect(xml.match(/<w:jc w:val="center"\/>/g)).toHaveLength(1);
  } finally {
    session.dispose();
  }
});

import { describe, expect, it } from "vitest";
import {
  planDocxFormatCandidates,
  type DocxFormatCandidateAddress,
  type DocxFormatTemplateFinding,
  type PlanDocxFormatCandidatesInput,
} from "./docx-format-candidate-plan";

const SHA = "a".repeat(64);

function finding(
  overrides: Partial<DocxFormatTemplateFinding> & Pick<
    DocxFormatTemplateFinding,
    "case_id" | "object_id" | "property_path" | "expected"
  >,
): DocxFormatTemplateFinding {
  return {
    kind: "paragraph",
    role: "body",
    part: "/word/document.xml",
    path: [0, 0, 0],
    observed: null,
    expected_value_count: 1,
    template_object_ids: ["/word/document.xml#0.1"],
    template_object_count: 1,
    template_role_basis: [{ source: "style_name", value: "Body", certainty: "inferred" }],
    verdict: "observed_difference",
    ...overrides,
  };
}

function input(
  findings: DocxFormatTemplateFinding[],
  addresses: Map<string, DocxFormatCandidateAddress>,
  overrides: Partial<PlanDocxFormatCandidatesInput> = {},
): PlanDocxFormatCandidatesInput {
  return {
    check: {
      checkId: "check-1",
      baselineId: "baseline-1",
      sourceSha256: SHA,
      validity: "CURRENT",
      summary: { observed_difference: findings.length },
      findingTotal: 10,
    },
    document: {
      revision: 0,
      baselineId: "baseline-1",
      sourceSha256: SHA,
    },
    findings,
    addresses,
    ...overrides,
  };
}

describe("DOCX format candidate planning", () => {
  it("merges findings on one paragraph and keeps conflicting template values blocked", () => {
    const findings = [
      finding({
        case_id: "before",
        object_id: "/word/document.xml#0.0.0",
        property_path: "paragraph.spacing.before",
        observed: 0,
        expected: 8,
      }),
      finding({
        case_id: "after",
        object_id: "/word/document.xml#0.0.0",
        property_path: "paragraph.spacing.after",
        observed: 0,
        expected: 6,
      }),
      finding({
        case_id: "left",
        object_id: "/word/document.xml#0.0.1",
        property_path: "paragraph.alignment",
        observed: "right",
        expected: "left",
        path: [0, 0, 1],
      }),
      finding({
        case_id: "center",
        object_id: "/word/document.xml#0.0.1",
        property_path: "paragraph.alignment",
        observed: "right",
        expected: "center",
        path: [0, 0, 1],
      }),
    ];
    const plan = planDocxFormatCandidates(input(findings, new Map([
      ["/word/document.xml#0.0.0", { paragraphRef: "p1", paraId: "11111111", text: "Title" }],
      ["/word/document.xml#0.0.1", { paragraphRef: "p2", paraId: "22222222", text: "Body" }],
    ])));

    expect(plan.status).toBe("ready");
    expect(plan.readyCandidates).toHaveLength(1);
    expect(plan.readyCandidates[0]).toMatchObject({
      scope: "paragraph",
      location: {
        objectId: "/word/document.xml#0.0.0",
        paragraphRef: "p1",
        paraId: "11111111",
        text: "Title",
      },
      operation: {
        paragraphRef: "p1",
        paragraph: { spaceBefore: 8, spaceAfter: 6 },
      },
    });
    expect(plan.readyCandidates[0]?.changes.map((change) => change.findingCaseId))
      .toEqual(["after", "before"]);
    expect(plan.blockedCandidates).toHaveLength(1);
    expect(plan.blockedCandidates[0]?.conflicts).toContainEqual(expect.objectContaining({
      code: "conflicting_expected_values",
      findingCaseIds: ["left", "center"],
    }));
    expect(plan.summary).toMatchObject({
      differenceFindings: 4,
      readyCandidates: 1,
      readyFindings: 2,
      blockedCandidates: 1,
      blockedFindings: 2,
    });
  });

  it("uses an exact run range and refuses a paragraph-wide font fallback", () => {
    const findings = [
      finding({
        case_id: "size",
        kind: "run",
        object_id: "/word/document.xml#0.0.0.3.0",
        property_path: "run.fontSizePt",
        observed: 10,
        expected: 12,
        path: [0, 0, 0, 3, 0],
      }),
      finding({
        case_id: "bold",
        kind: "run",
        object_id: "/word/document.xml#0.0.0.4.0",
        property_path: "run.bold",
        observed: false,
        expected: true,
        path: [0, 0, 0, 4, 0],
      }),
    ];
    const plan = planDocxFormatCandidates(input(findings, new Map([
      ["/word/document.xml#0.0.0.3.0", {
        paragraphRef: "p1",
        text: "Alpha beta",
        range: { start: 0, end: 5 },
      }],
      ["/word/document.xml#0.0.0.4.0", { paragraphRef: "p1", text: "Alpha beta" }],
    ])));

    expect(plan.readyCandidates).toHaveLength(1);
    expect(plan.readyCandidates[0]?.operation).toEqual({
      paragraphRef: "p1",
      range: { start: 0, end: 5 },
      font: { size: 12 },
    });
    expect(plan.unresolved).toContainEqual(expect.objectContaining({
      findingCaseId: "bold",
      reason: "run_range_unavailable",
    }));
  });

  it.each([
    ["paragraph.frame.present", true, false],
    ["paragraph.frame.widthPt", 20, 30],
    ["paragraph.keepNext", true, false],
    ["paragraph.keepLines", true, false],
    ["section.columns.count", 1, 2],
    ["section.margins.leftTwips", 1440, 1080],
  ])("leaves %s in review without blocking an independent formatting edit", (property, observed, expected) => {
    const objectId = "/word/document.xml#0.0.1";
    const plan = planDocxFormatCandidates(input([
      finding({ case_id: "layout", object_id: objectId, property_path: property, observed, expected }),
      finding({ case_id: "spacing", object_id: objectId, property_path: "paragraph.spacing.after", observed: 0, expected: 6 }),
    ], new Map([[objectId, { paragraphRef: "target" }]])));
    expect(plan.operations).toEqual([{ paragraphRef: "target", paragraph: { spaceAfter: 6 } }]);
    expect(plan.unresolved).toContainEqual(expect.objectContaining({ findingCaseId: "layout", propertyPath: property, reason: "layout_review" }));
  });

  it.each([
    { kind: "tc", role: "table", property_path: "cell.vAlign", observed: "center", expected: "top" },
    { kind: "paragraph", role: "body", property_path: "paragraph.alignment", observed: "center", expected: "left" },
    { kind: "run", role: "body", property_path: "run.fontSizePt", observed: 7.5, expected: 8 },
    { kind: "run", role: "body", property_path: "run.bold", observed: true, expected: false },
  ])("keeps in-table $property_path in review", (fields) => {
    const objectId = "/word/document.xml#0.0.1.2.0";
    const plan = planDocxFormatCandidates(input([
      finding({ ...fields, case_id: "table", object_id: objectId, table_context: { row_index: 0 } }),
    ], new Map([[objectId, { paragraphRef: "cell-body", range: { start: 0, end: 6 } }]])));
    expect(plan.operations).toEqual([]);
    expect(plan.unresolved).toContainEqual(expect.objectContaining({ findingCaseId: "table", reason: "layout_review" }));
  });

  it("blocks the whole plan when the retained check no longer matches the bytes", () => {
    const plan = planDocxFormatCandidates(input([
      finding({
        case_id: "keep",
        object_id: "/word/document.xml#0.0.0",
        property_path: "paragraph.keepNext",
        expected: true,
      }),
    ], new Map([
      ["/word/document.xml#0.0.0", { paragraphRef: "p1" }],
    ]), {
      document: {
        revision: 4,
        baselineId: "baseline-2",
        sourceSha256: "b".repeat(64),
      },
    }));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "baseline_changed",
      "source_changed",
    ]);
    expect(plan.operations).toEqual([]);
    expect(plan.unresolved).toContainEqual(expect.objectContaining({
      findingCaseId: "keep",
      reason: "document_check_mismatch",
    }));
  });

  it("refuses a stale retained check before planning any live target", () => {
    const findings = [
      finding({
        case_id: "keep",
        object_id: "/word/document.xml#0.0.0",
        property_path: "paragraph.keepNext",
        expected: true,
      }),
    ];
    const base = input(findings, new Map([
      ["/word/document.xml#0.0.0", { paragraphRef: "p1" }],
    ]));
    const plan = planDocxFormatCandidates({
      ...base,
      check: { ...base.check, validity: "STALE" },
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["check_stale"]);
    expect(plan.readyCandidates).toEqual([]);
    expect(plan.summary.unresolvedByReason).toEqual({
      document_check_mismatch: 1,
    });
  });

  it("preserves the before check, template evidence, and paragraph anchor", () => {
    const findings = [
      finding({
        case_id: "spacing",
        object_id: "/word/document.xml#0.0.2.0",
        property_path: "paragraph.spacing.after",
        observed: 5,
        expected: 10,
        path: [0, 0, 2, 0],
      }),
    ];
    const plan = planDocxFormatCandidates(input(findings, new Map([
      ["/word/document.xml#0.0.2.0", { paragraphRef: "last-body", text: "Conclusion" }],
    ])));

    expect(plan.beforeCheck).toEqual({
      checkId: "check-1",
      summary: { observed_difference: 1 },
      findingTotal: 10,
    });
    expect(plan.readyCandidates.map((candidate) => candidate.operation)).toEqual([
      {
        paragraphRef: "last-body",
        paragraph: { spaceAfter: 10 },
      },
    ]);
    expect(plan.readyCandidates[0]?.changes[0]).toMatchObject({
      findingCaseId: "spacing",
      propertyPath: "paragraph.spacing.after",
      templateObjectIds: ["/word/document.xml#0.1"],
      templateObjectCount: 1,
    });
    expect(plan.readyCandidates[0]?.location.text).toBe("Conclusion");
    expect(plan.operations.every((operation) => !("target" in operation))).toBe(true);
    expect(plan.changedObjectIds).toEqual(["/word/document.xml#0.0.2.0"]);
    expect(plan.changedParagraphRefs).toEqual(["last-body"]);
  });
});

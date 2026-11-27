import type { DocxFormatBatchItem } from "@oleafly/ai-tools";

type ParagraphWrite = NonNullable<DocxFormatBatchItem["paragraph"]>;
type FontWrite = NonNullable<DocxFormatBatchItem["font"]>;

export type DocxFormatCandidateScope = "paragraph" | "run";

export interface DocxFormatTemplateFinding {
  case_id: string;
  object_id: string;
  kind: string;
  role: string;
  part: string;
  path: number[];
  property_path: string;
  observed: unknown;
  expected: unknown;
  expected_value_count: number;
  template_object_ids: string[];
  template_object_count?: number;
  template_role_basis?: unknown[];
  role_basis?: unknown[];
  region?: unknown;
  table_context?: unknown;
  reason?: string;
  verdict: string;
}

export interface DocxFormatCandidateAddress {
  paragraphRef: string;
  paraId?: string;
  text?: string;
  range?: { start: number; end: number };
}

export interface DocxFormatCheckSummary {
  checkId: string;
  summary: Record<string, number>;
  findingTotal?: number;
}

export interface PlanDocxFormatCandidatesInput {
  check: {
    checkId: string;
    baselineId: string;
    sourceSha256: string;
    validity: "CURRENT" | "STALE";
    summary?: Record<string, number>;
    findingTotal?: number;
  };
  document: {
    revision: number;
    baselineId: string;
    sourceSha256: string;
  };
  findings: readonly DocxFormatTemplateFinding[];
  addresses: ReadonlyMap<string, DocxFormatCandidateAddress>;
}

export interface DocxFormatCandidateLocation {
  objectId: string;
  part: string;
  path: readonly number[];
  role: string;
  text?: string;
  paragraphRef: string;
  paraId?: string;
  region?: unknown;
}

export interface DocxFormatCandidateChange {
  findingCaseId: string;
  propertyPath: string;
  observed: unknown;
  expected: unknown;
  templateObjectIds: readonly string[];
  templateObjectCount: number;
  templateRoleBasis: readonly unknown[];
}

export interface DocxFormatCandidateConflict {
  code: "conflicting_expected_values";
  message: string;
  propertyPath?: string;
  findingCaseIds: readonly string[];
}

interface ReadyCandidateCommon {
  candidateId: string;
  scope: DocxFormatCandidateScope;
  location: DocxFormatCandidateLocation;
  changes: readonly DocxFormatCandidateChange[];
}

export interface ReadyDocxFormatCandidate extends ReadyCandidateCommon {
  status: "ready";
  operation: DocxFormatBatchItem;
}

export interface BlockedDocxFormatCandidate extends ReadyCandidateCommon {
  status: "blocked";
  conflicts: readonly DocxFormatCandidateConflict[];
}

export type DocxFormatCandidate =
  | ReadyDocxFormatCandidate
  | BlockedDocxFormatCandidate;

export type DocxFormatUnresolvedReason =
  | "ambiguous_template_value"
  | "layout_review"
  | "property_not_writable"
  | "live_target_unavailable"
  | "run_range_unavailable"
  | "document_check_mismatch";

export interface DocxFormatUnresolvedFinding {
  findingCaseId: string;
  objectId: string;
  propertyPath: string;
  reason: DocxFormatUnresolvedReason;
  detail: string;
}

export interface DocxFormatPlanBlocker {
  code: "check_stale" | "baseline_changed" | "source_changed";
  message: string;
}

export interface DocxFormatCandidatePlan {
  status: "ready" | "blocked";
  revision: number;
  sourceSha256: string;
  beforeCheck: DocxFormatCheckSummary;
  operations: readonly DocxFormatBatchItem[];
  readyCandidates: readonly ReadyDocxFormatCandidate[];
  blockedCandidates: readonly BlockedDocxFormatCandidate[];
  unresolved: readonly DocxFormatUnresolvedFinding[];
  blockers: readonly DocxFormatPlanBlocker[];
  changedObjectIds: readonly string[];
  changedParagraphRefs: readonly string[];
  summary: {
    differenceFindings: number;
    ignoredFindings: number;
    readyCandidates: number;
    readyFindings: number;
    blockedCandidates: number;
    blockedFindings: number;
    unresolvedFindings: number;
    unresolvedByReason: Record<string, number>;
  };
}

interface PlannedField {
  value: unknown;
  findingCaseId: string;
  propertyPath: string;
}

interface PlannedApplication {
  scope: DocxFormatCandidateScope;
  fields: readonly [string, unknown][];
}

interface CandidateGroup {
  key: string;
  scope: DocxFormatCandidateScope;
  address: DocxFormatCandidateAddress;
  finding: DocxFormatTemplateFinding;
  changes: DocxFormatCandidateChange[];
  fields: Map<string, PlannedField>;
  conflicts: DocxFormatCandidateConflict[];
}

const PAGINATION_PROPERTIES = new Set([
  "paragraph.keepNext",
  "paragraph.keepLines",
  "paragraph.widowControl",
  "paragraph.pageBreakBefore",
]);

export function requiresDocxLayoutReview(finding: DocxFormatTemplateFinding): boolean {
  const property = finding.property_path;
  return finding.role === "table" || finding.table_context !== undefined
    || property.startsWith("section.") || property.startsWith("paragraph.frame.")
    || PAGINATION_PROPERTIES.has(property);
}

const PARAGRAPH_POINT_FIELDS: Readonly<Record<string, keyof ParagraphWrite>> = {
  "paragraph.indent.firstLine": "firstLineIndent",
  "paragraph.indent.left": "leftIndent",
  "paragraph.indent.right": "rightIndent",
  "paragraph.spacing.before": "spaceBefore",
  "paragraph.spacing.after": "spaceAfter",
};

const PARAGRAPH_ALIGNMENTS: Readonly<Record<string, NonNullable<ParagraphWrite["alignment"]>>> = {
  left: "Left",
  center: "Centered",
  right: "Right",
  both: "Justified",
  justify: "Justified",
};

const RUN_FONT_FIELDS: Readonly<
  Record<
    string,
    {
      field: keyof FontWrite;
      kind: "boolean" | "positive_number" | "font_name";
    }
  >
> = {
  "run.bold": { field: "bold", kind: "boolean" },
  "run.italic": { field: "italic", kind: "boolean" },
  "run.fontSizePt": { field: "size", kind: "positive_number" },
  "run.fontFamily": { field: "name", kind: "font_name" },
  "run.fontFamilyEastAsia": { field: "nameEastAsia", kind: "font_name" },
};

export const DOCX_CANDIDATE_WRITE_PROPERTIES = [
  ...Object.keys(PARAGRAPH_POINT_FIELDS), "paragraph.alignment", ...Object.keys(RUN_FONT_FIELDS),
];

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function findingChange(finding: DocxFormatTemplateFinding): DocxFormatCandidateChange {
  return {
    findingCaseId: finding.case_id,
    propertyPath: finding.property_path,
    observed: finding.observed,
    expected: finding.expected,
    templateObjectIds: [...finding.template_object_ids],
    templateObjectCount: finding.template_object_count ?? finding.template_object_ids.length,
    templateRoleBasis: [...(finding.template_role_basis ?? [])],
  };
}

function candidateLocation(
  finding: DocxFormatTemplateFinding,
  address: DocxFormatCandidateAddress,
): DocxFormatCandidateLocation {
  return {
    objectId: finding.object_id,
    part: finding.part,
    path: [...finding.path],
    role: finding.role,
    ...(address.text === undefined ? {} : { text: address.text }),
    paragraphRef: address.paragraphRef,
    ...(address.paraId === undefined ? {} : { paraId: address.paraId }),
    ...(finding.region === undefined ? {} : { region: finding.region }),
  };
}

function candidateId(
  scope: DocxFormatCandidateScope,
  finding: DocxFormatTemplateFinding,
  changes: readonly DocxFormatCandidateChange[],
): string {
  const identities = [...new Set(changes.map((change) => change.findingCaseId))].sort();
  return `format-candidate:${scope}:${finding.object_id}:${identities.join("+")}`;
}

function unresolved(
  finding: DocxFormatTemplateFinding,
  reason: DocxFormatUnresolvedReason,
  detail: string,
): DocxFormatUnresolvedFinding {
  return {
    findingCaseId: finding.case_id,
    objectId: finding.object_id,
    propertyPath: finding.property_path,
    reason,
    detail,
  };
}

function mapFinding(
  finding: DocxFormatTemplateFinding,
  address: DocxFormatCandidateAddress,
):
  | { ok: true; application: PlannedApplication }
  | { ok: false; reason: DocxFormatUnresolvedReason; detail: string } {
  const property = finding.property_path;
  const expected = finding.expected;
  const pointField = PARAGRAPH_POINT_FIELDS[property];
  if (pointField) {
    return isFiniteNumber(expected)
      ? { ok: true, application: { scope: "paragraph", fields: [[pointField, expected]] } }
      : { ok: false, reason: "property_not_writable", detail: "The template value is not a paragraph point value." };
  }
  if (property === "paragraph.alignment") {
    const alignment = typeof expected === "string" ? PARAGRAPH_ALIGNMENTS[expected] : undefined;
    return alignment
      ? { ok: true, application: { scope: "paragraph", fields: [["alignment", alignment]] } }
      : { ok: false, reason: "property_not_writable", detail: "The template alignment has no existing DOCX alignment write." };
  }
  const font = RUN_FONT_FIELDS[property];
  if (font) {
    if (!address.range || address.range.start >= address.range.end) {
      return {
        ok: false,
        reason: "run_range_unavailable",
        detail: "Run formatting needs an exact UTF-16 range; a paragraph-wide font write would change unrelated runs.",
      };
    }
    if (font.kind === "boolean" && typeof expected === "boolean") {
      return { ok: true, application: { scope: "run", fields: [[font.field, expected]] } };
    }
    if (font.kind === "positive_number" && isFiniteNumber(expected) && expected > 0) {
      return { ok: true, application: { scope: "run", fields: [[font.field, expected]] } };
    }
    if (font.kind === "font_name" && typeof expected === "string" && expected.trim()) {
      return { ok: true, application: { scope: "run", fields: [[font.field, expected]] } };
    }
    return { ok: false, reason: "property_not_writable", detail: "The template run value cannot be written through the existing font operation." };
  }
  return {
    ok: false,
    reason: "property_not_writable",
    detail: "This effective-format property has no existing narrow DOCX write.",
  };
}

function groupKey(
  scope: DocxFormatCandidateScope,
  address: DocxFormatCandidateAddress,
): string {
  if (scope === "paragraph") return `${scope}\0${address.paragraphRef}`;
  const range = address.range;
  return `run\0${address.paragraphRef}\0${range?.start ?? ""}\0${range?.end ?? ""}`;
}

function mergeGroupField(
  group: CandidateGroup,
  field: string,
  value: unknown,
  change: DocxFormatCandidateChange,
): void {
  const existing = group.fields.get(field);
  if (existing && stableKey(existing.value) !== stableKey(value)) {
    group.conflicts.push({
      code: "conflicting_expected_values",
      message: `Template findings disagree on ${change.propertyPath}.`,
      propertyPath: change.propertyPath,
      findingCaseIds: [existing.findingCaseId, change.findingCaseId],
    });
    return;
  }
  if (!existing) {
    group.fields.set(field, {
      value,
      findingCaseId: change.findingCaseId,
      propertyPath: change.propertyPath,
    });
  }
}

function addToGroup(
  groups: Map<string, CandidateGroup>,
  finding: DocxFormatTemplateFinding,
  address: DocxFormatCandidateAddress,
  application: PlannedApplication,
): void {
  const key = groupKey(application.scope, address);
  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      scope: application.scope,
      address,
      finding,
      changes: [],
      fields: new Map(),
      conflicts: [],
    };
    groups.set(key, group);
  }
  const change = findingChange(finding);
  group.changes.push(change);
  for (const [field, value] of application.fields) {
    mergeGroupField(group, field, value, change);
  }
}

function buildOperation(
  group: CandidateGroup,
): DocxFormatBatchItem | null {
  const paragraphRef = group.address.paragraphRef;
  if (group.conflicts.length > 0 || group.fields.size === 0) return null;
  if (group.scope === "paragraph") {
    const paragraph: Record<string, unknown> = {};
    for (const [field, planned] of group.fields) paragraph[field] = planned.value;
    return { paragraphRef, paragraph: paragraph as ParagraphWrite };
  }
  const font: Record<string, unknown> = {};
  for (const [field, planned] of group.fields) font[field] = planned.value;
  return { paragraphRef, range: group.address.range, font: font as FontWrite };
}

function planBlockers(
  input: PlanDocxFormatCandidatesInput,
): DocxFormatPlanBlocker[] {
  const blockers: DocxFormatPlanBlocker[] = [];
  if (input.check.validity !== "CURRENT") {
    blockers.push({
      code: "check_stale",
      message: "Only a CURRENT retained template check can produce an adoption plan.",
    });
  }
  if (input.check.baselineId !== input.document.baselineId) {
    blockers.push({
      code: "baseline_changed",
      message: "The check belongs to another DOCX baseline.",
    });
  }
  if (input.check.sourceSha256 !== input.document.sourceSha256) {
    blockers.push({
      code: "source_changed",
      message: "The live DOCX source does not match the bytes compared by the check.",
    });
  }
  return blockers;
}

function blockedPlan(
  input: PlanDocxFormatCandidatesInput,
  blockers: readonly DocxFormatPlanBlocker[],
): DocxFormatCandidatePlan {
  const differences = input.findings.filter((finding) => finding.verdict === "observed_difference");
  const unresolvedFindings = differences.map((finding) =>
    unresolved(
      finding,
      "document_check_mismatch",
      "The plan was blocked before a live target could be trusted.",
    ));
  return {
    status: "blocked",
    revision: input.document.revision,
    sourceSha256: input.document.sourceSha256,
    beforeCheck: {
      checkId: input.check.checkId,
      summary: { ...(input.check.summary ?? {}) },
      ...(input.check.findingTotal === undefined ? {} : { findingTotal: input.check.findingTotal }),
    },
    operations: [],
    readyCandidates: [],
    blockedCandidates: [],
    unresolved: unresolvedFindings,
    blockers,
    changedObjectIds: [],
    changedParagraphRefs: [],
    summary: {
      differenceFindings: differences.length,
      ignoredFindings: input.findings.length - differences.length,
      readyCandidates: 0,
      readyFindings: 0,
      blockedCandidates: 0,
      blockedFindings: 0,
      unresolvedFindings: unresolvedFindings.length,
      unresolvedByReason: unresolvedFindings.length
        ? { document_check_mismatch: unresolvedFindings.length }
        : {},
    },
  };
}

export function planDocxFormatCandidates(
  input: PlanDocxFormatCandidatesInput,
): DocxFormatCandidatePlan {
  const blockers = planBlockers(input);
  if (blockers.length > 0) return blockedPlan(input, blockers);

  const differences = input.findings.filter((finding) => finding.verdict === "observed_difference");
  const groups = new Map<string, CandidateGroup>();
  const unresolvedFindings: DocxFormatUnresolvedFinding[] = [];

  for (const finding of differences) {
    if (finding.reason || finding.expected_value_count !== 1) {
      unresolvedFindings.push(unresolved(
        finding,
        "ambiguous_template_value",
        finding.reason ?? "The template profile does not provide one exact expected value.",
      ));
      continue;
    }
    if (requiresDocxLayoutReview(finding)) {
      unresolvedFindings.push(unresolved(
        finding,
        "layout_review",
        "This template difference needs a layout check before changing how the page flows.",
      ));
      continue;
    }
    const address = input.addresses.get(finding.object_id);
    if (!address) {
      unresolvedFindings.push(unresolved(
        finding,
        "live_target_unavailable",
        "No live paragraph address was supplied for this manuscript object.",
      ));
      continue;
    }
    const mapped = mapFinding(finding, address);
    if (!mapped.ok) {
      unresolvedFindings.push(unresolved(finding, mapped.reason, mapped.detail));
      continue;
    }
    addToGroup(groups, finding, address, mapped.application);
  }

  const readyCandidates: ReadyDocxFormatCandidate[] = [];
  const blockedCandidates: BlockedDocxFormatCandidate[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const operation = buildOperation(group);
    const changes = [...group.changes].sort((left, right) =>
      left.propertyPath.localeCompare(right.propertyPath) ||
      left.findingCaseId.localeCompare(right.findingCaseId));
    const common = {
      candidateId: candidateId(group.scope, group.finding, changes),
      scope: group.scope,
      location: candidateLocation(group.finding, group.address),
      changes,
    };
    if (operation && group.conflicts.length === 0) {
      readyCandidates.push({ ...common, status: "ready", operation });
    } else {
      blockedCandidates.push({ ...common, status: "blocked", conflicts: group.conflicts });
    }
  }

  const changedObjectIds = [...new Set(readyCandidates.map((candidate) => candidate.location.objectId))].sort();
  const changedParagraphRefs = [...new Set(readyCandidates.map((candidate) => candidate.location.paragraphRef))].sort();
  const readyFindings = new Set(readyCandidates.flatMap((candidate) =>
    candidate.changes.map((change) => change.findingCaseId))).size;
  const blockedFindings = new Set(blockedCandidates.flatMap((candidate) =>
    candidate.changes.map((change) => change.findingCaseId))).size;
  const unresolvedByReason: Record<string, number> = {};
  for (const finding of unresolvedFindings) {
    unresolvedByReason[finding.reason] = (unresolvedByReason[finding.reason] ?? 0) + 1;
  }

  return {
    status: "ready",
    revision: input.document.revision,
    sourceSha256: input.document.sourceSha256,
    beforeCheck: {
      checkId: input.check.checkId,
      summary: { ...(input.check.summary ?? {}) },
      ...(input.check.findingTotal === undefined ? {} : { findingTotal: input.check.findingTotal }),
    },
    operations: readyCandidates.map((candidate) => candidate.operation),
    readyCandidates,
    blockedCandidates,
    unresolved: unresolvedFindings,
    blockers: [],
    changedObjectIds,
    changedParagraphRefs,
    summary: {
      differenceFindings: differences.length,
      ignoredFindings: input.findings.length - differences.length,
      readyCandidates: readyCandidates.length,
      readyFindings,
      blockedCandidates: blockedCandidates.length,
      blockedFindings,
      unresolvedFindings: unresolvedFindings.length,
      unresolvedByReason,
    },
  };
}

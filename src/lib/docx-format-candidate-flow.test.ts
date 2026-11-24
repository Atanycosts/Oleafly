import { beforeEach, expect, it, vi } from "vitest";
import type { AgentToolOutput, AgentToolRequest } from "@/lib/agent-backend";
import type { DocxFormatFacts, DocxFormatSnapshotV1 } from "@/lib/docx-format";
import type { DocxFindingGroup } from "@/lib/docx-finding-review";
import type { DocxTablePaginationChange } from "@/lib/docx-table-pagination";
import type { DocxSource } from "@/lib/docx-workbench";
import type { JournalProject, JournalWorld } from "@/lib/journal-workbench";
import type {
  CandidateJournalCheck,
  DocxFormatSnapshotReference,
  PreparedJournalTemplate,
} from "@/lib/docx-template-client";

const api = vi.hoisted(() => ({
  prepare: vi.fn(),
  record: vi.fn(),
  reference: vi.fn(),
  check: vi.fn(),
  createCandidate: vi.fn(),
  saveCandidate: vi.fn(),
  apply: vi.fn(),
  agent: vi.fn(),
  openFacts: vi.fn(),
  journalRequest: vi.fn(),
  planPagination: vi.fn(),
  verifyPagination: vi.fn(),
}));

vi.mock("@/lib/docx-template-client", () => ({
  prepareJournalTemplate: api.prepare,
  recordDocxFormat: api.record,
  referenceDocxFormat: api.reference,
  checkCandidateJournalTemplate: api.check,
}));
vi.mock("@/lib/docx-format-candidate", () => ({
  createDocxFormatCandidateCopy: api.createCandidate,
  saveDocxFormatCandidateCopy: api.saveCandidate,
}));
vi.mock("@/lib/docx-format-candidate-executor", () => ({
  applyDocxFormatCandidates: api.apply,
}));
vi.mock("@/lib/agent-backend", () => ({
  runViaBackend: api.agent,
}));
vi.mock("@/lib/docx-format", () => ({
  openDocxFormatFacts: api.openFacts,
}));
vi.mock("@/lib/docx-table-pagination", () => ({
  planDocxTablePagination: api.planPagination,
  verifyDocxTablePagination: api.verifyPagination,
}));
vi.mock("@/lib/journal-workbench", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/journal-workbench")>(),
  journalRequest: api.journalRequest,
}));

import { DOCX_CANDIDATE_WRITE_PROPERTIES } from "./docx-format-candidate-plan";
import { prepareDocxFormatCandidate } from "./docx-format-candidate-flow";

const SOURCE_SHA = "1".repeat(64);
const METHOD_VERSION = "docx-core-format-snapshot-test";
const world: JournalWorld = {
  version_id: "world-version",
  journal_id: "journal",
  journal_name: "Test Journal",
  version_ordinal: 1,
  created_at: "2026-11-22T00:00:00Z",
  scope: { article_type: "research_article", stage: "initial_submission", language: "en" },
  sources: [],
  rules: [],
  coverage_gaps: [],
  limitations: [],
};
const captured: DocxSource = {
  project_id: "manuscript-project",
  baseline_id: "manuscript-baseline",
  source_sha256: SOURCE_SHA,
  filename: "manuscript.docx",
  bytes: Uint8Array.from([1, 2, 3]),
};
const candidateProject: JournalProject = {
  project_id: "candidate-project",
  name: "Format candidate",
  baseline_id: "candidate-baseline",
  binding: null,
  latest_check: null,
};
const sourceSnapshotReference: DocxFormatSnapshotReference = {
  baseline_id: captured.baseline_id,
  source_sha256: SOURCE_SHA,
  snapshot_artifact_version_id: "snapshot-artifact-version",
  method_version: METHOD_VERSION,
};
const snapshotReference: DocxFormatSnapshotReference = {
  baseline_id: candidateProject.baseline_id,
  source_sha256: SOURCE_SHA,
  snapshot_artifact_version_id: "snapshot-artifact-version",
  method_version: METHOD_VERSION,
};
const snapshot = {
  schema_version: 1,
  source_sha256: SOURCE_SHA,
  method_version: METHOD_VERSION,
  objects: [],
} as unknown as DocxFormatSnapshotV1;
const facts = { snapshot } as DocxFormatFacts;
const groups: DocxFindingGroup[] = [{
  id: "body-font-size",
  category: "body",
  action: "run.fontSizePt",
  counts: { observed_match: 0, observed_difference: 0, cannot_determine: 0 },
  location_count: 0,
}];

function prepared(reference?: DocxFormatSnapshotReference): PreparedJournalTemplate {
  return {
    world,
    binding: null,
    refreshed: false,
    ...(reference ? { snapshot_reference: reference } : {}),
  };
}

function candidateCheck(checkId: string, observedDifference: number): CandidateJournalCheck {
  return {
    check_id: checkId,
    project_id: candidateProject.project_id,
    baseline_id: candidateProject.baseline_id,
    world_version_id: world.version_id,
    validity: "CURRENT",
    binding_id: "candidate-binding",
    source_sha256: SOURCE_SHA,
    reader_version: METHOD_VERSION,
    snapshot_artifact_version_id: snapshotReference.snapshot_artifact_version_id,
    template_comparison: {
      total: observedDifference,
      finding_summary: {
        observed_match: 0,
        observed_difference: observedDifference,
        cannot_determine: 0,
      },
    },
  };
}

function respondToEvidenceQueries(check: CandidateJournalCheck): void {
  api.journalRequest.mockImplementation(async (path: string, request: {
    operation: string;
    target: { check_id: string };
  }) => {
    if (path !== "/api/docx-query") throw new Error(`Unexpected journal request: ${path}`);
    const identity = {
      check_id: check.check_id,
      baseline_id: check.baseline_id,
      source_sha256: check.source_sha256,
    };
    if (request.operation === "candidate_findings") {
      return { ...identity, findings: [], template_locations: {}, next_offset: null };
    }
    if (request.operation === "finding_groups") return { ...identity, groups };
    throw new Error(`Unexpected DOCX query: ${request.operation}`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.prepare.mockResolvedValue(prepared());
  api.record.mockResolvedValue(snapshotReference);
  api.reference.mockResolvedValue(snapshotReference);
  api.createCandidate.mockResolvedValue(candidateProject);
  api.openFacts.mockResolvedValue(facts);
});

it.each([
  { label: "a clean first check", observedDifference: 0, operations: ["finding_groups"] },
  {
    label: "differences without a writable finding",
    observedDifference: 2,
    operations: ["candidate_findings", "finding_groups"],
  },
])("reviews $label only against the final candidate check", async ({ observedDifference, operations }) => {
  const checkId = `check-${observedDifference}`;
  const check = candidateCheck(checkId, observedDifference);
  api.check.mockResolvedValue(check);
  respondToEvidenceQueries(check);
  const onPrepared = vi.fn();

  const result = await prepareDocxFormatCandidate({
    captured,
    name: "Format candidate",
    worldVersionId: world.version_id,
    onPrepared,
    execution: "chat-tool",
    signal: new AbortController().signal,
  });

  expect(onPrepared).toHaveBeenCalledWith(prepared());
  expect(api.prepare).toHaveBeenCalledWith(
    captured.project_id,
    captured.baseline_id,
    world.version_id,
    "agent",
    true,
  );
  expect(api.journalRequest.mock.calls.map(([path, request]) => [path, request.operation]))
    .toEqual(operations.map((operation) => ["/api/docx-query", operation]));
  expect(api.journalRequest).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ operation: "finding_verification" }),
  );
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.saveCandidate).not.toHaveBeenCalled();
  expect(api.agent).not.toHaveBeenCalled();
  expect(result.findingReview).toEqual({ checkId, groups });
  expect(result.project).toMatchObject({
    project_id: candidateProject.project_id,
    baseline_id: candidateProject.baseline_id,
    binding: {
      binding_id: check.binding_id,
      baseline_id: check.baseline_id,
      world_version_id: check.world_version_id,
    },
  });
  expect(result.unresolvedGroupCount).toBe(0);
});

it("reads only one writable page when the candidate review has no writable findings", async () => {
  const check = candidateCheck("check-unwritable", 2);
  api.check.mockResolvedValue(check);
  respondToEvidenceQueries(check);

  await prepareDocxFormatCandidate({
    captured,
    name: "Format candidate",
    onPrepared: vi.fn(),
    execution: "chat-tool",
    signal: new AbortController().signal,
  });

  expect(api.journalRequest).toHaveBeenCalledTimes(2);
  expect(api.journalRequest).toHaveBeenNthCalledWith(1, "/api/docx-query", {
    operation: "candidate_findings",
    target: { check_id: check.check_id },
    offset: 0,
    limit: 1_000,
    property_paths: DOCX_CANDIDATE_WRITE_PROPERTIES,
  });
  expect(api.journalRequest).toHaveBeenNthCalledWith(2, "/api/docx-query", {
    operation: "finding_groups",
    target: { check_id: check.check_id },
  });
});

it("saves and rechecks pagination-only writes without inventing comparison findings", async () => {
  const header = { object_id: "template-header", location: "Template · Table 1 · R1" };
  const change: DocxTablePaginationChange = {
    rowId: "row-in-edit-tree", tableNumber: 1, row: 1, flag: "tblHeader", property: "row.isHeader", templateRow: header,
  };
  const savedBytes = Uint8Array.from([4, 5, 6]);
  const savedSha = "2".repeat(64);
  const saved = { ...candidateProject, baseline_id: "saved-baseline" };
  const savedSnapshot = { ...snapshot, source_sha256: savedSha };
  const savedFacts = { ...facts, snapshot: savedSnapshot };
  const savedReference = { ...snapshotReference, baseline_id: saved.baseline_id, source_sha256: savedSha,
    snapshot_artifact_version_id: "saved-snapshot" };
  const initialCheck = { ...candidateCheck("initial", 0), table_header_templates: [{ column_count: 2, rows: [header] }] };
  const finalCheck = { ...candidateCheck("checked-after-save", 0), baseline_id: saved.baseline_id,
    source_sha256: savedSha, snapshot_artifact_version_id: savedReference.snapshot_artifact_version_id };
  api.planPagination.mockReturnValue([change]);
  api.openFacts.mockResolvedValueOnce(facts).mockResolvedValueOnce(savedFacts);
  api.record.mockResolvedValueOnce(snapshotReference).mockResolvedValueOnce(savedReference);
  api.check.mockResolvedValueOnce(initialCheck).mockResolvedValueOnce(finalCheck);
  api.apply.mockResolvedValue({ candidateBytes: savedBytes, appliedCandidateIds: [], appliedTablePagination: [change], plan: { readyCandidates: [] } });
  api.saveCandidate.mockResolvedValue(saved);
  api.verifyPagination.mockReturnValue([{ change, confirmed: true, id: "checked-row", paraId: "saved-para", text: "Heading" }]);
  respondToEvidenceQueries(finalCheck);

  const result = await prepareDocxFormatCandidate({ captured, name: "Pagination", onPrepared: vi.fn(),
    execution: "chat-tool", signal: new AbortController().signal });

  expect(api.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ findings: [], tablePagination: [change] }), expect.any(AbortSignal));
  expect(api.saveCandidate).toHaveBeenCalledTimes(1);
  expect(api.check).toHaveBeenLastCalledWith(saved, world.version_id, savedReference);
  expect(api.verifyPagination).toHaveBeenCalledExactlyOnceWith(savedFacts, [change]);
  expect(api.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/docx-query", {
    operation: "finding_groups", target: { check_id: finalCheck.check_id },
  });
  expect(result.candidateCheck).toBe(finalCheck);
  expect(result.unconfirmedChanges).toEqual([]);
  expect(result.changes).toEqual([{
    id: "checked-row:row.isHeader", paraId: "saved-para", location: "Heading", row: 1,
    role: "table", property: "row.isHeader", before: false, expected: true,
    templateObjectId: header.object_id, templateLocation: header.location,
    group: { category: "table", action: "page_flow", object_number: 1, table_area: "header" },
  }]);
});

it.each([null, "Provider failed after inspection"])("finalizes an inspection-only run without writes (error: %s)", async (error) => {
  const check = candidateCheck("check-inspect-only", 2);
  api.check.mockResolvedValue(check);
  respondToEvidenceQueries(check);
  api.agent.mockImplementation(async (_request, handlers: {
    onToolRequest: (request: AgentToolRequest) => Promise<AgentToolOutput>;
  }) => {
    const inspection = await handlers.onToolRequest({ id: "inspect", name: "inspect_template_format", arguments: "{}" });
    expect(JSON.parse(inspection.output)).toEqual({ differences: 2, cannotDetermine: 0 });
    expect(api.journalRequest).not.toHaveBeenCalled();
    return { error, stopped_at_cap: false };
  });

  const result = prepareDocxFormatCandidate({
    captured,
    name: "Format candidate",
    onPrepared: vi.fn(),
    execution: {},
    signal: new AbortController().signal,
  });
  if (error) {
    await expect(result).rejects.toThrow(error);
    expect(api.journalRequest).not.toHaveBeenCalled();
  } else {
    await expect(result).resolves.toMatchObject({
      bytes: captured.bytes, changes: [], unconfirmedChanges: [], findingReview: { checkId: check.check_id, groups },
    });
    expect(api.journalRequest).toHaveBeenCalledExactlyOnceWith("/api/docx-query", {
      operation: "finding_groups", target: { check_id: check.check_id },
    });
  }
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.saveCandidate).not.toHaveBeenCalled();
});

it.each([
  {
    label: "reuses an exact retained format snapshot",
    retainedMethodVersion: METHOD_VERSION,
    reusesReference: true,
  },
  {
    label: "records facts when the retained snapshot method is stale",
    retainedMethodVersion: "docx-core-format-snapshot-older",
    reusesReference: false,
  },
])("$label", async ({ retainedMethodVersion, reusesReference }) => {
  const retained = { ...sourceSnapshotReference, method_version: retainedMethodVersion };
  const check = candidateCheck(`check-${reusesReference ? "retained" : "recorded"}`, 0);
  api.prepare.mockResolvedValue(prepared(retained));
  api.check.mockResolvedValue(check);
  respondToEvidenceQueries(check);

  await prepareDocxFormatCandidate({
    captured,
    name: "Format candidate",
    onPrepared: vi.fn(),
    execution: "chat-tool",
    signal: new AbortController().signal,
  });

  if (reusesReference) {
    expect(api.reference).toHaveBeenCalledWith(candidateProject, captured.project_id, retained);
    expect(api.record).not.toHaveBeenCalled();
  } else {
    expect(api.reference).not.toHaveBeenCalled();
    expect(api.record).toHaveBeenCalledWith(candidateProject.project_id, candidateProject.baseline_id, snapshot);
  }
});

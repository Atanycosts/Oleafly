import { beforeEach, expect, it, vi } from "vitest";
import type { DocxFindingGroup } from "@/lib/docx-finding-review";
import type { JournalWorld } from "@/lib/journal-workbench";
import type { DocxCandidateReviewRecord } from "@/lib/docx-format-candidate-review";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  loadSource: vi.fn(),
  groups: vi.fn(),
  digest: vi.fn(),
}));

vi.mock("@/lib/journal-workbench", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/journal-workbench")>(),
  journalRequest: api.request,
}));
vi.mock("@/lib/docx-workbench", () => ({ loadDocxSource: api.loadSource }));
vi.mock("@/lib/docx-finding-review", () => ({ fetchDocxFindingGroups: api.groups }));
vi.mock("@/lib/docx-recovery", () => ({ docxContentSha256: api.digest }));

import {
  loadCandidateReviewView,
  readCandidateReview,
  readCandidateSummary,
  retainedReviewItems,
  saveCandidateReview,
} from "./docx-format-candidate-review";

const SHA = "1".repeat(64);
const groups: DocxFindingGroup[] = [{
  id: "body-font",
  category: "body",
  action: "run.fontFamily",
  counts: { observed_match: 0, observed_difference: 1, cannot_determine: 0 },
  location_count: 1,
}];
const world: JournalWorld = {
  version_id: "world-version",
  journal_id: "journal",
  journal_name: "Journal",
  version_ordinal: 2,
  created_at: "2026-11-24T00:00:00Z",
  scope: { article_type: "research_article", stage: "revision", language: "en" },
  sources: [],
  rules: [],
  coverage_gaps: [],
  limitations: [],
};

function record(overrides: Partial<DocxCandidateReviewRecord> = {}): DocxCandidateReviewRecord {
  return {
    candidate_project_id: "candidate-project",
    input_baseline_id: "input-baseline",
    input_source_sha256: "2".repeat(64),
    candidate_baseline_id: "candidate-baseline",
    candidate_source_sha256: SHA,
    candidate_binding_id: "candidate-binding",
    candidate_check_id: "candidate-check",
    world_version_id: world.version_id,
    snapshot_artifact_version_id: "snapshot-version",
    snapshot_method_version: "docx-format-1",
    target_baseline_id: "target-baseline",
    target_source_sha256: "3".repeat(64),
    target_binding_id: "target-binding",
    original_source_sha256: null,
    confirmed_items: [{
      id: "confirmed",
      property: "run.fontFamily",
      role: "body",
      before: "Arial",
      expected: "Times New Roman",
      group: { category: "body", action: "font" },
      para_id: "para-confirmed",
      location: "Introduction",
      template_location: "Body text",
      template_object_id: "template-body",
    }],
    unconfirmed_items: [],
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "candidate-project",
    baseline_id: "candidate-baseline",
    source_sha256: SHA,
    filename: "candidate.docx",
    bytes: Uint8Array.from([1, 2, 3]),
    ...overrides,
  };
}

function findings(overrides: Record<string, unknown> = {}) {
  return {
    check_id: "candidate-check",
    baseline_id: "candidate-baseline",
    source_sha256: SHA,
    groups,
    ...overrides,
  };
}

beforeEach(() => {
  api.request.mockReset();
  api.loadSource.mockReset();
  api.groups.mockReset();
  api.digest.mockReset();
  api.loadSource.mockResolvedValue(candidate());
  api.groups.mockResolvedValue(findings());
  api.digest.mockResolvedValue(SHA);
});

it("builds bounded candidate-summary and review requests", async () => {
  const review = record();
  api.request.mockResolvedValue({ review });

  await readCandidateReview("candidate-project");
  await readCandidateSummary("candidate-project");
  await readCandidateSummary("candidate-project", {
    checkId: "candidate-check",
    collection: "remaining",
    offset: 0,
    limit: 20,
  });
  await saveCandidateReview("candidate-project", null, review);

  expect(api.request.mock.calls.map(([path]) => path)).toEqual([
    "/api/template-candidate-review?project_id=candidate-project",
    "/api/template-candidate-summary?project_id=candidate-project",
    "/api/template-candidate-summary?project_id=candidate-project&check_id=candidate-check&collection=remaining&offset=0&limit=20",
    "/api/template-candidate-review",
  ]);
  expect(api.request).toHaveBeenLastCalledWith("/api/template-candidate-review", {
    project_id: "candidate-project",
    expected_candidate_check_id: null,
    review,
  });
});

it("retains optional review locations without writing empty identity fields", () => {
  expect(retainedReviewItems([
    {
      id: "located",
      property: "paragraph.alignment",
      role: "body",
      before: "left",
      expected: "center",
      group: { category: "body", action: "alignment" },
      paraId: "para-1",
      location: "Body paragraph",
      templateLocation: "Body text",
      templateObjectId: "template-1",
    },
    {
      id: "bare",
      property: "run.bold",
      role: "body",
      before: false,
      expected: true,
      group: { category: "body", action: "emphasis" },
      location: "   ",
    },
  ])).toEqual([
    {
      id: "located",
      property: "paragraph.alignment",
      role: "body",
      before: "left",
      expected: "center",
      group: { category: "body", action: "alignment" },
      para_id: "para-1",
      location: "Body paragraph",
      template_location: "Body text",
      template_object_id: "template-1",
    },
    {
      id: "bare",
      property: "run.bold",
      role: "body",
      before: false,
      expected: true,
      group: { category: "body", action: "emphasis" },
    },
  ]);
});

it("reloads the retained candidate, template world, and finding review together", async () => {
  api.request.mockResolvedValue(world);

  const view = await loadCandidateReviewView(record(), "candidate.docx");

  expect(view).toMatchObject({
    filename: "candidate.docx",
    world,
    refreshed: false,
    unconfirmedChanges: [],
    findingReview: { checkId: "candidate-check", groups },
  });
  expect([...view.bytes]).toEqual([1, 2, 3]);
  expect(view.changes).toEqual([{
    id: "confirmed",
    property: "run.fontFamily",
    role: "body",
    before: "Arial",
    expected: "Times New Roman",
    group: { category: "body", action: "font" },
    paraId: "para-confirmed",
    location: "Introduction",
    templateLocation: "Body text",
    templateObjectId: "template-body",
  }]);
  expect(api.request).toHaveBeenCalledWith(
    "/api/world?version_id=world-version",
  );
  expect(api.loadSource).toHaveBeenCalledWith("candidate-project", "candidate-baseline");
  expect(api.groups).toHaveBeenCalledWith("candidate-check");
  expect(api.digest).toHaveBeenCalledWith(candidate().bytes);
});

it.each([
  ["candidate project", { candidate: { project_id: "other-project" } }],
  ["candidate baseline", { candidate: { baseline_id: "other-baseline" } }],
  ["candidate source hash", { candidate: { source_sha256: "4".repeat(64) } }],
  ["candidate bytes", { digest: "5".repeat(64) }],
  ["template world", { world: { version_id: "other-world" } }],
  ["finding check", { findings: { check_id: "other-check" } }],
  ["finding baseline", { findings: { baseline_id: "other-baseline" } }],
  ["finding source hash", { findings: { source_sha256: "6".repeat(64) } }],
])("refuses a retained view when the %s does not match", async (_label, mismatch: {
  candidate?: Record<string, unknown>;
  digest?: string;
  world?: Partial<JournalWorld>;
  findings?: Record<string, unknown>;
}) => {
  api.loadSource.mockResolvedValue(candidate(mismatch.candidate));
  api.groups.mockResolvedValue(findings(mismatch.findings));
  api.digest.mockResolvedValue(mismatch.digest ?? SHA);
  api.request.mockResolvedValue({ ...world, ...mismatch.world });

  await expect(loadCandidateReviewView(record(), "candidate.docx"))
    .rejects.toThrow("The retained candidate does not match its review.");
});

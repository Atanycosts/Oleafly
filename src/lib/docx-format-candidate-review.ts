import type { DocxNodeAddress } from "@oleafly/ai-tools";
import type { DocxFindingGroup, DocxFindingLocation, DocxFindingReview, DocxFindingVerdict } from "@/lib/docx-finding-review";
import { fetchDocxFindingGroups } from "@/lib/docx-finding-review";
import type { CandidateReviewItem } from "@/lib/docx-format-candidate-flow";
import { docxContentSha256 } from "@/lib/docx-recovery";
import { loadDocxSource } from "@/lib/docx-workbench";
import { journalQuery, journalRequest, type JournalGap, type JournalWorld } from "@/lib/journal-workbench";

type RetainedReviewItem = Omit<CandidateReviewItem, "paraId" | "templateLocation" | "templateObjectId"> & {
  para_id?: string;
  template_location?: string;
  template_object_id?: string;
};

export interface DocxCandidateReviewRecord {
  candidate_project_id: string;
  input_baseline_id: string;
  input_source_sha256: string;
  candidate_baseline_id: string;
  candidate_source_sha256: string;
  candidate_binding_id: string;
  candidate_check_id: string;
  world_version_id: string;
  snapshot_artifact_version_id: string;
  snapshot_method_version: string;
  target_baseline_id: string;
  target_source_sha256: string;
  target_binding_id: string | null;
  original_source_sha256: string | null;
  confirmed_items: RetainedReviewItem[];
  unconfirmed_items: RetainedReviewItem[];
}

type CandidateSummaryCollection = "confirmed" | "unconfirmed" | "remaining";
type UnresolvedVerdict = Exclude<DocxFindingVerdict, "observed_match">;

interface CandidateRemainingGroup extends DocxFindingGroup {
  examples: Partial<Record<UnresolvedVerdict, {
    case_id: string;
    object_id: string;
    part: string;
    property_path: string;
    observed: unknown;
    expected: unknown;
    template_object_ids: string[];
    node_address?: DocxNodeAddress;
    reason?: string;
    location: Omit<DocxFindingLocation, "counts">;
  }>>;
}

export interface DocxCandidateSummary extends Omit<DocxCandidateReviewRecord, "confirmed_items" | "unconfirmed_items"> {
  target_project_id: string;
  status: "ready" | "conflict";
  reason?: "target_baseline_changed" | "target_binding_changed" | "candidate_baseline_changed" | "candidate_binding_changed";
  template: Pick<JournalWorld, "version_id" | "version_ordinal" | "journal_id" | "journal_name" | "scope">
    & Pick<NonNullable<JournalWorld["template"]>, "source_id" | "normalized_source_id" | "snapshot_source_id" | "source_sha256" | "original_sha256">
    & { name: string; authority: "user_designated_template" };
  checker_version: string;
  counts: Record<CandidateSummaryCollection | UnresolvedVerdict, number>;
  source_coverage_gaps: (JournalGap & { source_id: string | null })[];
  candidate_reader_gaps: { code: string; detail: string; object_count: number; example_object_id: string | null }[];
}

type CandidateSummaryPage = { total: number; next_offset: number | null } & (
  | { collection: "confirmed" | "unconfirmed"; items: RetainedReviewItem[] }
  | { collection: "remaining"; items: CandidateRemainingGroup[] }
);

type CandidateSummaryQuery = { checkId?: string } & (
  | { collection?: never; offset?: never; limit?: never }
  | { collection: CandidateSummaryCollection; offset?: number; limit?: number }
);

export type DocxCandidateSummaryResponse = { schema_version: 1 } & (
  | { summary: null; page?: never }
  | { summary: DocxCandidateSummary; page?: CandidateSummaryPage }
);

export interface DocxCandidateReviewView {
  filename: string;
  bytes: Uint8Array;
  world: JournalWorld;
  refreshed: boolean;
  changes: CandidateReviewItem[];
  unconfirmedChanges: CandidateReviewItem[];
  findingReview: DocxFindingReview;
}

type RetainedCandidate = { review: DocxCandidateReviewRecord; status: "ready" | "conflict" };

export function readCandidateReview(projectId: string) {
  return journalRequest<RetainedCandidate | { review: null }>(
    journalQuery("/api/template-candidate-review", { project_id: projectId }),
  );
}

export function readCandidateSummary(projectId: string, { checkId, collection, offset, limit }: CandidateSummaryQuery = {}) {
  return journalRequest<DocxCandidateSummaryResponse>(journalQuery("/api/template-candidate-summary", {
    project_id: projectId,
    ...(checkId === undefined ? {} : { check_id: checkId }),
    ...(collection === undefined ? {} : { collection }),
    ...(offset === undefined ? {} : { offset: String(offset) }),
    ...(limit === undefined ? {} : { limit: String(limit) }),
  }));
}

export function saveCandidateReview(projectId: string, expectedCheckId: string | null, review: DocxCandidateReviewRecord) {
  return journalRequest<RetainedCandidate>("/api/template-candidate-review", {
    project_id: projectId, expected_candidate_check_id: expectedCheckId, review,
  });
}

export function retainedReviewItems(items: CandidateReviewItem[]): RetainedReviewItem[] {
  return items.map(({ paraId, templateLocation, templateObjectId, location, ...item }) => ({
    ...item, ...(paraId ? { para_id: paraId } : {}), ...(location?.trim() ? { location } : {}),
    ...(templateLocation ? { template_location: templateLocation } : {}),
    ...(templateObjectId ? { template_object_id: templateObjectId } : {}),
  }));
}

export async function loadCandidateReviewView(record: DocxCandidateReviewRecord, filename: string): Promise<DocxCandidateReviewView> {
  const [candidate, world, findings] = await Promise.all([
    loadDocxSource(record.candidate_project_id, record.candidate_baseline_id),
    journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: record.world_version_id })),
    fetchDocxFindingGroups(record.candidate_check_id),
  ]);
  if (candidate.project_id !== record.candidate_project_id || candidate.baseline_id !== record.candidate_baseline_id ||
    candidate.source_sha256 !== record.candidate_source_sha256 ||
    await docxContentSha256(candidate.bytes) !== record.candidate_source_sha256 ||
    world.version_id !== record.world_version_id || findings.check_id !== record.candidate_check_id ||
    findings.baseline_id !== record.candidate_baseline_id || findings.source_sha256 !== record.candidate_source_sha256) {
    throw new Error("The retained candidate does not match its review.");
  }
  const displayItems = (items: RetainedReviewItem[]): CandidateReviewItem[] => items.map(
    ({ para_id, template_location, template_object_id, ...item }) =>
      ({ ...item, paraId: para_id, templateLocation: template_location, templateObjectId: template_object_id }),
  );
  return {
    filename, bytes: candidate.bytes, world, refreshed: false,
    changes: displayItems(record.confirmed_items), unconfirmedChanges: displayItems(record.unconfirmed_items),
    findingReview: { checkId: findings.check_id, groups: findings.groups },
  };
}

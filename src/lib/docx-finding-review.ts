import type { DocxFormatTemplateFinding } from "@/lib/docx-format-candidate-plan";
import { journalRequest } from "@/lib/journal-workbench";

export type DocxFindingVerdict = "observed_match" | "observed_difference" | "cannot_determine";
export type DocxFindingCounts = Record<DocxFindingVerdict, number>;

export interface DocxFindingGroup {
  id: string;
  category: "title" | "heading" | "body" | "table" | "formula" | "figure" | "figure_caption" | "table_caption" | "references" | "other";
  action: string;
  heading_level?: number;
  object_number?: number;
  table_area?: "header" | "body" | "exception";
  counts: DocxFindingCounts;
  location_count: number;
}

export interface DocxFindingLocation {
  id: string;
  para_id?: string;
  label?: string;
  object_number?: number;
  row?: number;
  column?: number;
  counts: DocxFindingCounts;
}

export interface DocxFindingReview {
  checkId: string;
  groups: DocxFindingGroup[];
}

interface FindingPage {
  total: number;
  next_offset: number | null;
}

export interface DocxFindingCheckIdentity {
  check_id: string;
  source_sha256: string;
  baseline_id: string;
}

export interface DocxFindingDetail extends DocxFormatTemplateFinding {
  line_spacing_rule?: { observed: unknown; expected: unknown };
}

const REVIEW_PAGE_SIZE = 20;

export function fetchDocxFindingGroups(checkId: string) {
  return journalRequest<DocxFindingCheckIdentity & { groups: DocxFindingGroup[] }>("/api/docx-query", {
    operation: "finding_groups", target: { check_id: checkId },
  });
}

export function fetchDocxFindingLocations(checkId: string, groupId: string, verdict: DocxFindingVerdict, offset = 0) {
  return journalRequest<FindingPage & { locations: DocxFindingLocation[] }>("/api/docx-query", {
    operation: "finding_locations", target: { check_id: checkId }, group_id: groupId, verdict, offset, limit: REVIEW_PAGE_SIZE,
  });
}

export function fetchDocxFindingDetails(checkId: string, groupId: string, locationId: string, verdict: DocxFindingVerdict, offset = 0) {
  return journalRequest<FindingPage & { findings: DocxFindingDetail[] }>("/api/docx-query", {
    operation: "findings", target: { check_id: checkId }, group_id: groupId, location_id: locationId, verdict, offset, limit: REVIEW_PAGE_SIZE,
  });
}

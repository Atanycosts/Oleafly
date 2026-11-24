import type { EffortLevel } from "@oleafly/ai-core";
import { openDocxFormatFacts, type DocxFormatSnapshotV1 } from "@/lib/docx-format";
import { runDocxFormatCandidateAgent } from "@/lib/docx-format-candidate-agent";
import { createDocxFormatCandidateCopy, saveDocxFormatCandidateCopy } from "@/lib/docx-format-candidate";
import { applyDocxFormatCandidates, type ApplyDocxFormatCandidatesInput, type DocxFormatCandidateApplication } from "@/lib/docx-format-candidate-executor";
import { DOCX_CANDIDATE_WRITE_PROPERTIES, type DocxFormatTemplateFinding } from "@/lib/docx-format-candidate-plan";
import { fetchDocxFindingGroups, type DocxFindingCheckIdentity, type DocxFindingGroup } from "@/lib/docx-finding-review";
import { createDocxFormatSemanticIndex } from "@/lib/docx-format-finding-identity";
import {
  candidateVerificationTargets, confirmedCandidateTargets, type DocxCandidateTarget, type DocxCandidateVerificationFinding,
} from "@/lib/docx-candidate-verification";
import {
  checkCandidateJournalTemplate, prepareJournalTemplate, recordDocxFormat, referenceDocxFormat,
  type DocxFormatSnapshotReference, type PreparedJournalTemplate,
} from "@/lib/docx-template-client";
import type { DocxSource } from "@/lib/docx-workbench";
import { planDocxTablePagination, verifyDocxTablePagination } from "@/lib/docx-table-pagination";
import { journalRequest, type JournalProject, type JournalWorld } from "@/lib/journal-workbench";

export interface CandidateReviewItem {
  id: string;
  paraId?: string;
  location?: string;
  property: string;
  role: string;
  row?: number;
  before?: unknown;
  expected?: unknown;
  templateLocation?: string;
  templateObjectId?: string;
  group: Pick<DocxFindingGroup, "category" | "action" | "heading_level" | "object_number" | "table_area">;
}

const CANDIDATE_PAGE_SIZE = 1_000;
const VERIFICATION_BATCH_SIZE = 500;

function assertFindingSource(response: DocxFindingCheckIdentity, check: DocxFindingCheckIdentity) {
  if (response.check_id !== check.check_id || response.baseline_id !== check.baseline_id || response.source_sha256 !== check.source_sha256) {
    throw new Error("The format evidence belongs to a different candidate check or baseline.");
  }
}

async function compare(project: JournalProject, world: JournalWorld, bytes: Uint8Array, signal: AbortSignal,
  retained?: { projectId: string; reference: DocxFormatSnapshotReference }) {
  signal.throwIfAborted();
  const facts = await openDocxFormatFacts(bytes);
  const { source_sha256, method_version } = facts.snapshot;
  signal.throwIfAborted();
  const reusable = retained?.reference.source_sha256 === source_sha256 && retained.reference.method_version === method_version
    ? retained : undefined;
  const reference = reusable
    ? await referenceDocxFormat(project, reusable.projectId, reusable.reference)
    : await recordDocxFormat(project.project_id, project.baseline_id, facts.snapshot);
  if (reference.baseline_id !== project.baseline_id || reference.source_sha256 !== source_sha256 ||
    reference.method_version !== method_version ||
    (reusable && reference.snapshot_artifact_version_id !== reusable.reference.snapshot_artifact_version_id)) {
    throw new Error("The retained format snapshot does not match the candidate source and method.");
  }
  signal.throwIfAborted();
  const check = await checkCandidateJournalTemplate(project, world.version_id, reference);
  if (check.project_id !== project.project_id || check.baseline_id !== project.baseline_id ||
    check.world_version_id !== world.version_id || check.source_sha256 !== source_sha256 ||
    check.reader_version !== method_version || check.snapshot_artifact_version_id !== reference.snapshot_artifact_version_id ||
    check.validity !== "CURRENT") {
    throw new Error("The DOCX check does not describe the current candidate and selected template.");
  }
  const readWritable = async () => {
    const findings: DocxFormatTemplateFinding[] = [];
    const templateLocations = new Map<string, string>();
    let offset: number | null = 0;
    while (offset !== null) {
      signal.throwIfAborted();
      const page: DocxFindingCheckIdentity & {
        findings: DocxFormatTemplateFinding[];
        template_locations: Record<string, string>;
        next_offset: number | null;
      } = await journalRequest("/api/docx-query", {
        operation: "candidate_findings", target: { check_id: check.check_id }, offset, limit: CANDIDATE_PAGE_SIZE,
        property_paths: DOCX_CANDIDATE_WRITE_PROPERTIES,
      });
      assertFindingSource(page, check);
      findings.push(...page.findings);
      for (const [id, label] of Object.entries(page.template_locations)) templateLocations.set(id, label);
      offset = page.next_offset;
    }
    return { findings, templateLocations };
  };
  const input = (findings: DocxFormatTemplateFinding[]): ApplyDocxFormatCandidatesInput => ({
    bytes, facts, findings, baselineId: project.baseline_id,
    check: {
      checkId: check.check_id, baselineId: check.baseline_id, validity: check.validity,
      sourceSha256: check.source_sha256, summary: check.template_comparison.finding_summary,
      findingTotal: check.template_comparison.total,
    },
  });
  const binding = { binding_id: check.binding_id, baseline_id: check.baseline_id, world_version_id: check.world_version_id };
  return { project: { ...project, binding }, check, facts, readWritable, input };
}

interface AppliedTarget extends DocxCandidateTarget {
  item: CandidateReviewItem;
}

function appliedGroup(role: string, property: string, outline: unknown, text: string | undefined): CandidateReviewItem["group"] {
  const category = role === "document_title" ? "title" : role === "heading" ? "heading" : role === "body" ? "body"
    : role === "reference" ? "references" : role === "caption" ? /^\s*(?:表|table\b)/iu.test(text ?? "") ? "table_caption" : "figure_caption" : "other";
  const action = property.startsWith("paragraph.spacing.") ? "paragraph_spacing" : property.startsWith("paragraph.indent.") ? "indent"
    : property === "paragraph.alignment" ? "alignment" : property === "run.bold" || property === "run.italic" ? "emphasis"
    : property === "run.fontSizePt" ? "size" : "font";
  return { category, action, ...(category === "heading" && typeof outline === "number" && outline < 9 ? { heading_level: outline + 1 } : {}) };
}

interface AppliedRound {
  application: DocxFormatCandidateApplication;
  snapshot: DocxFormatSnapshotV1;
  templateLocations: ReadonlyMap<string, string>;
}

function appliedTargets(rounds: readonly AppliedRound[]): AppliedTarget[] {
  const targets = new Map<string, AppliedTarget>();
  for (const round of rounds) {
    const applied = new Set(round.application.appliedCandidateIds);
    const index = createDocxFormatSemanticIndex(round.snapshot);
    const objects = new Map(round.snapshot.objects.map((object) => [object.object_id, object]));
    for (const entry of round.application.plan.readyCandidates) {
      if (!applied.has(entry.candidateId)) continue;
      const object = objects.get(entry.location.objectId);
      const owner = object?.kind === "run" ? objects.get(String(object.evidence.paragraph_object_id)) : object;
      const paragraph = owner?.properties.paragraph;
      const outline = paragraph && typeof paragraph === "object" && !Array.isArray(paragraph) ? paragraph.outlineLevel : undefined;
      for (const change of entry.changes) {
        const location = index.byObjectId.get(entry.location.objectId);
        const identity = location
          ? JSON.stringify([change.propertyPath, location.key, location.run?.end]) : change.findingCaseId;
        const previous = targets.get(identity);
        const templateLocation = change.templateObjectIds.slice(0, 2)
          .map((id) => round.templateLocations.get(id) ?? id).join(" / ") || undefined;
        targets.set(identity, {
          caseId: change.findingCaseId,
          propertyPath: change.propertyPath,
          expected: change.expected,
          location,
          item: {
            id: change.findingCaseId, paraId: entry.location.paraId,
            property: change.propertyPath, role: entry.location.role, location: entry.location.text,
            before: previous ? previous.item.before : change.observed, expected: change.expected,
            templateLocation, templateObjectId: change.templateObjectIds[0],
            group: appliedGroup(entry.location.role, change.propertyPath, outline, owner?.text),
          },
        });
      }
    }
  }
  return [...targets.values()];
}

async function reviewChanges(
  check: DocxFindingCheckIdentity,
  targets: readonly AppliedTarget[],
  snapshot: DocxFormatSnapshotV1,
  signal: AbortSignal,
) {
  const changes: CandidateReviewItem[] = [];
  const unconfirmedChanges: CandidateReviewItem[] = [];
  if (!targets.length) return { changes, unconfirmedChanges };
  const index = createDocxFormatSemanticIndex(snapshot);
  const selection = candidateVerificationTargets(targets, index);
  const findings: DocxCandidateVerificationFinding[] = [];
  for (let start = 0; start < selection.length; start += VERIFICATION_BATCH_SIZE) {
    signal.throwIfAborted();
    const response = await journalRequest<DocxFindingCheckIdentity & { findings: DocxCandidateVerificationFinding[] }>("/api/docx-query", {
      operation: "finding_verification", target: { check_id: check.check_id }, targets: selection.slice(start, start + VERIFICATION_BATCH_SIZE),
    });
    assertFindingSource(response, check);
    findings.push(...response.findings);
  }
  const confirmed = confirmedCandidateTargets(targets, selection, findings);
  for (const [position, target] of targets.entries()) {
    const matched = index.byObjectId.get(selection[position].object_ids[0]);
    (confirmed[position] ? changes : unconfirmedChanges).push({
      ...target.item, paraId: matched?.paraId ?? target.item.paraId,
    });
  }
  return { changes, unconfirmedChanges };
}

export async function prepareDocxFormatCandidate({ captured, name, worldVersionId, onPrepared, execution, signal }: {
  captured: DocxSource; name: string; worldVersionId?: string; onPrepared(prepared: PreparedJournalTemplate): void;
  execution: { effort?: EffortLevel } | "chat-tool"; signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const prepared = await prepareJournalTemplate(captured.project_id, captured.baseline_id, worldVersionId,
    execution === "chat-tool" ? "agent" : "user", true);
  onPrepared(prepared);
  signal.throwIfAborted();
  const { world } = prepared;
  const sourceReference = prepared.snapshot_reference;
  if (sourceReference && (sourceReference.baseline_id !== captured.baseline_id || sourceReference.source_sha256 !== captured.source_sha256)) {
    throw new Error("The retained format snapshot belongs to a different manuscript baseline.");
  }
  const retained = sourceReference ? { projectId: captured.project_id, reference: sourceReference } : undefined;
  const compareInput = async () => {
    const project = await createDocxFormatCandidateCopy(name, captured);
    const initial = await compare(project, world, captured.bytes, signal, retained);
    const templates = initial.check.table_header_templates;
    const tablePagination = templates ? planDocxTablePagination(initial.facts, templates) : [];
    return { initial, tablePagination, inputBaselineId: project.baseline_id, inputSourceSha256: initial.check.source_sha256 };
  };
  let comparison: ReturnType<typeof compareInput> | undefined;
  const inspect = () => comparison ??= compareInput();
  const finishReview = async (current: Awaited<ReturnType<typeof compare>>, bytes: Uint8Array, rounds: readonly AppliedRound[]) => {
    const { changes, unconfirmedChanges } = await reviewChanges(current.check, appliedTargets(rounds), current.facts.snapshot, signal);
    const pagination = rounds.flatMap(({ application }) => application.appliedTablePagination);
    if (pagination.length) {
      for (const { change, id, confirmed, paraId, text } of verifyDocxTablePagination(current.facts, pagination)) {
        (confirmed ? changes : unconfirmedChanges).push({
          id: `${id}:${change.property}`, paraId, location: text, row: change.row,
          property: change.property, role: "table", before: false, expected: true,
          templateLocation: change.templateRow?.location, templateObjectId: change.templateRow?.object_id,
          group: { category: "table", action: "page_flow", object_number: change.tableNumber,
            table_area: change.flag === "tblHeader" ? "header" : "body" },
        });
      }
    }
    signal.throwIfAborted();
    const { groups, ...reviewIdentity } = await fetchDocxFindingGroups(current.check.check_id);
    assertFindingSource(reviewIdentity, current.check);
    signal.throwIfAborted();
    const { inputBaselineId, inputSourceSha256 } = await inspect();
    return {
      ...prepared, project: current.project, bytes, changes, unconfirmedChanges,
      inputBaselineId, inputSourceSha256, candidateCheck: current.check,
      findingReview: { checkId: current.check.check_id, groups },
      unresolvedGroupCount: groups.filter(({ counts }) => counts.observed_difference || counts.cannot_determine).length,
    };
  };
  const apply = async () => {
    const { initial, tablePagination } = await inspect();
    let current = initial;
    let bytes = captured.bytes;
    const rounds: AppliedRound[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const pagination = attempt === 0 ? tablePagination : [];
      const { findings, templateLocations } = current.check.template_comparison.finding_summary.observed_difference
        ? await current.readWritable() : { findings: [], templateLocations: new Map<string, string>() };
      if (!findings.length && !pagination.length) break;
      const application = await applyDocxFormatCandidates({ ...current.input(findings), tablePagination: pagination }, signal);
      if (!application.appliedCandidateIds.length && !application.appliedTablePagination.length) break;
      rounds.push({ application, snapshot: current.facts.snapshot, templateLocations });
      bytes = application.candidateBytes;
      const saved = await saveDocxFormatCandidateCopy(current.project, captured, bytes);
      current = await compare(saved, world, bytes, signal);
    }
    return finishReview(current, bytes, rounds);
  };

  if (execution === "chat-tool") return apply();
  let review: Awaited<ReturnType<typeof apply>> | undefined;
  await runDocxFormatCandidateAgent({
    journal: world.journal_name, effort: execution.effort, signal,
    inspect: async () => {
      const { initial, tablePagination } = await inspect();
      const { finding_summary: counts } = initial.check.template_comparison;
      return { differences: counts.observed_difference, cannotDetermine: counts.cannot_determine,
        ...(tablePagination.length ? { tablePaginationChanges: tablePagination.length } : {}) };
    },
    apply: async () => {
      review = await apply();
      return { changes: review.changes.length, unresolvedGroups: review.unresolvedGroupCount, unconfirmedChanges: review.unconfirmedChanges.length };
    },
  });
  if (review) return review;
  if (comparison) return finishReview((await comparison).initial, captured.bytes, []);
  throw new Error("The formatting tool did not return a candidate.");
}

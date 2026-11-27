import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { loadDocxSource } from "@/lib/docx-workbench";
import type { DocxFindingGroup } from "@/lib/docx-finding-review";
import { journalQuery, journalRequest, JournalWorkbenchError, type JournalBinding, type JournalCheck, type JournalProject, type JournalScope, type JournalState, type JournalTemplateSummary, type JournalWorld } from "@/lib/journal-workbench";
import type { DocxFormatSnapshotV1 } from "@/lib/docx-format-types";

export interface NormalizedJournalTemplate {
  original: { filename: string; content_base64: string };
  normalized: { filename: string; content_base64: string; provenance: {
    engine: string; version: string; method: string; converted_sha256: string;
  } | null };
  original_sha256: string;
  source_sha256: string;
}

export async function docxFormatSnapshot(bytes: Uint8Array): Promise<DocxFormatSnapshotV1> {
  const { openDocxFormatFacts } = await import("@/lib/docx-format");
  return (await openDocxFormatFacts(bytes)).snapshot;
}

export async function importJournalTemplate(
  file: File,
  context: JournalScope & { journal_id: string; journal_name: string },
  sources: { name: string; kind: string; content_base64: string }[] = [],
): Promise<JournalWorld> {
  const normalized = await invoke<NormalizedJournalTemplate>("journal_template_normalize", {
    name: file.name,
    contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    executable: null,
  });
  const snapshot = await docxFormatSnapshot(base64ToBytes(normalized.normalized.content_base64));
  if (snapshot.source_sha256 !== normalized.source_sha256) throw new Error("The normalized template identity changed during import.");
  return journalRequest<JournalWorld>("/api/template-world", {
    ...context, original: normalized.original, normalized: normalized.normalized, snapshot, sources,
  });
}

export interface TemplateWorkingCopy {
  project: JournalProject;
  origin: { request_id: string; world_version_id: string; baseline_id: string; source_sha256: string };
}

export interface PreparedJournalTemplate {
  world: JournalWorld;
  binding: JournalBinding | null;
  refreshed: boolean;
  snapshot_reference?: DocxFormatSnapshotReference | null;
}

export async function prepareJournalTemplate(
  projectId: string,
  baselineId: string,
  worldVersionId?: string,
  surface: "user" | "agent" = "user",
  includeSnapshotReference = false,
): Promise<PreparedJournalTemplate> {
  const request = {
    project_id: projectId,
    expected_baseline_id: baselineId,
    surface,
    ...(worldVersionId ? { world_version_id: worldVersionId } : {}),
    ...(includeSnapshotReference ? { include_snapshot_reference: true } : {}),
  };
  try {
    return await journalRequest("/api/template-prepare", request);
  } catch (cause) {
    if (!(cause instanceof JournalWorkbenchError) || cause.detail.code !== "template_snapshot_recapture_required" || !cause.detail.world_version_id) throw cause;
    const versionId = cause.detail.world_version_id;
    let snapshot: DocxFormatSnapshotV1;
    try {
      const retained = await loadTemplateSource(versionId);
      snapshot = await docxFormatSnapshot(retained.bytes);
    } catch {
      throw new JournalWorkbenchError({ error: "The saved template DOCX cannot be read with the current reader. Recapture the template.",
        code: "template_source_unavailable", action: "recapture_template", retryable_with_same_params: false });
    }
    return journalRequest("/api/template-prepare", {
      ...request, retained_snapshot: { world_version_id: versionId, snapshot },
    });
  }
}

export function journalTemplates(state: JournalState): JournalTemplateSummary[] {
  return state.worlds.filter((world): world is JournalTemplateSummary => "template_preparation" in world);
}

export async function loadTemplateSource(worldVersionId: string): Promise<{
  worldVersionId: string; sourceSha256: string; bytes: Uint8Array;
}> {
  const source = await journalRequest<{ world_version_id: string; source_sha256: string; content_base64: string }>(
    journalQuery("/api/template-source", { world_version_id: worldVersionId }),
  );
  if (source.world_version_id !== worldVersionId) throw new Error("The template source belongs to another world version.");
  const bytes = base64ToBytes(source.content_base64);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  if (sha256 !== source.source_sha256) throw new Error("The retained template bytes do not match their source hash.");
  return { worldVersionId, sourceSha256: sha256, bytes };
}

export function startTemplateWorkingCopy(
  worldVersionId: string,
  name: string,
  requestId: string,
): Promise<TemplateWorkingCopy> {
  return journalRequest("/api/template-copy", {
    world_version_id: worldVersionId, name, request_id: requestId,
  });
}

/** Recompute from the exact retained bytes; a live editor export is never passed as this baseline. */
export async function retainDocxFormat(projectId: string, baselineId: string): Promise<DocxFormatSnapshotV1> {
  const source = await loadDocxSource(projectId, baselineId);
  const snapshot = await docxFormatSnapshot(source.bytes);
  if (snapshot.source_sha256 !== source.source_sha256) throw new Error("The format snapshot does not match the retained DOCX source.");
  await recordDocxFormat(projectId, baselineId, snapshot);
  return snapshot;
}

export interface DocxFormatSnapshotReference {
  baseline_id: string;
  source_sha256: string;
  snapshot_artifact_version_id: string;
  method_version: string;
}

function snapshotReferencePayload({ baseline_id, source_sha256, snapshot_artifact_version_id, method_version }: DocxFormatSnapshotReference): DocxFormatSnapshotReference {
  return { baseline_id, source_sha256, snapshot_artifact_version_id, method_version };
}

export function recordDocxFormat(projectId: string, baselineId: string, snapshot: DocxFormatSnapshotV1) {
  return journalRequest<DocxFormatSnapshotReference>("/api/docx-format", { project_id: projectId, baseline_id: baselineId, snapshot });
}

export function referenceDocxFormat(project: JournalProject, sourceProjectId: string, reference: DocxFormatSnapshotReference) {
  return journalRequest<DocxFormatSnapshotReference>("/api/docx-format", {
    project_id: project.project_id,
    baseline_id: project.baseline_id,
    retained_snapshot: { project_id: sourceProjectId, reference: snapshotReferencePayload(reference) },
  });
}

/** This operation explicitly chooses a template; ordinary check-current-binding keeps its own semantics. */
type DocxTemplateCheck<Mode extends "summary" | undefined> = (
  Mode extends "summary" ? Pick<JournalCheck, "check_id" | "project_id" | "baseline_id" | "world_version_id" | "validity"> : JournalCheck
) & {
  binding_id: string;
  template_comparison: { source_sha256: string; total: number; finding_summary: Record<string, number>; findings_artifact_version_id: string }
    & (Mode extends "summary" ? { groups: DocxFindingGroup[] } : object);
};

export async function checkJournalTemplate(
  project: JournalProject,
  worldVersionId: string,
  surface: "user" | "agent" = "user",
): Promise<DocxTemplateCheck<undefined>> {
  await retainDocxFormat(project.project_id, project.baseline_id);
  return checkRetainedJournalTemplate(project, worldVersionId, surface);
}

export function checkRetainedJournalTemplate<Mode extends "summary" | undefined = undefined>(
  project: JournalProject,
  worldVersionId: string,
  surface: "user" | "agent",
  response?: Mode,
): Promise<DocxTemplateCheck<Mode>> {
  return journalRequest("/api/template-check", {
    ...templateCheckPayload(project, worldVersionId, surface),
    ...(response ? { response } : {}),
  });
}

export type CandidateJournalCheck = Pick<JournalCheck, "check_id" | "project_id" | "baseline_id" | "world_version_id" | "validity"> & {
  binding_id: string;
  source_sha256: string;
  reader_version: string;
  snapshot_artifact_version_id: string;
  table_header_templates?: readonly import("./docx-table-pagination").DocxTableHeaderTemplate[];
  template_comparison: { total: number; finding_summary: Record<string, number> };
};

export function checkCandidateJournalTemplate(project: JournalProject, worldVersionId: string, reference: DocxFormatSnapshotReference) {
  return journalRequest<CandidateJournalCheck>("/api/template-check", {
    ...templateCheckPayload(project, worldVersionId, "agent"),
    response: "candidate",
    snapshot_reference: snapshotReferencePayload(reference),
  });
}

function templateCheckPayload(project: JournalProject, worldVersionId: string, surface: "user" | "agent") {
  return {
    project_id: project.project_id,
    expected_baseline_id: project.baseline_id,
    world_version_id: worldVersionId,
    expected_binding_id: project.binding?.binding_id ?? null,
    request_id: `template-check-${crypto.randomUUID()}`,
    origin: { surface },
  };
}

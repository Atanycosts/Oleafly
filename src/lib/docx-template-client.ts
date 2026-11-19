import { invoke } from "@tauri-apps/api/core";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { loadDocxSource } from "@/lib/docx-workbench";
import { journalQuery, journalRequest, type JournalCheck, type JournalProject, type JournalScope, type JournalWorld } from "@/lib/journal-workbench";
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
  await journalRequest("/api/docx-format", { project_id: projectId, baseline_id: baselineId, snapshot });
  return snapshot;
}

/** This operation explicitly chooses a template; ordinary check-current-binding keeps its own semantics. */
export async function checkJournalTemplate(
  project: JournalProject,
  worldVersionId: string,
  surface: "user" | "agent" = "user",
): Promise<JournalCheck> {
  await retainDocxFormat(project.project_id, project.baseline_id);
  return journalRequest<JournalCheck>("/api/template-check", {
    project_id: project.project_id,
    expected_baseline_id: project.baseline_id,
    world_version_id: worldVersionId,
    expected_binding_id: project.binding?.binding_id ?? null,
    request_id: `template-check-${crypto.randomUUID()}`,
    origin: { surface },
  });
}

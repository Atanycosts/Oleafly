import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import { journalQuery, journalRequest } from "@/lib/journal-workbench";

export interface DocxSource {
  project_id: string;
  baseline_id: string;
  source_sha256: string;
  filename: string;
  bytes: Uint8Array;
}

export async function loadDocxSource(projectId: string, baselineId: string): Promise<DocxSource> {
  const source = await journalRequest<Omit<DocxSource, "bytes"> & { content_base64: string }>(
    journalQuery("/api/manuscript-source", { project_id: projectId, baseline_id: baselineId }),
  );
  const { content_base64, ...identity } = source;
  return { ...identity, bytes: base64ToBytes(content_base64) };
}

export interface DocxSave {
  project_id: string;
  expected_baseline_id: string;
  filename: string;
  content_base64: string;
  reason: string;
  request_id: string;
  revision: number;
}

/** Retain this request until its outcome is known; a retry must carry the same bytes and ID. */
export function prepareDocxSave(source: DocxSource, revision: number, bytes: ArrayBuffer): DocxSave {
  return {
    project_id: source.project_id,
    expected_baseline_id: source.baseline_id,
    filename: source.filename,
    content_base64: bytesToBase64(new Uint8Array(bytes)),
    reason: `User saved the Oleafly DOCX working copy at session revision ${revision}.`,
    request_id: `docx-${crypto.randomUUID()}`,
    revision,
  };
}

export async function saveDocxBaseline(save: DocxSave): Promise<{ baselineId: string; revision: number }> {
  const { revision, ...payload } = save;
  const result = await journalRequest<{ status: "APPLIED"; result_baseline_id: string }>("/api/baseline", payload);
  return { baselineId: result.result_baseline_id, revision };
}

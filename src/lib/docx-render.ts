import { invoke } from "@tauri-apps/api/core";
import { journalQuery, journalRequest } from "@/lib/journal-workbench";

export interface DocxRender {
  bundle_id: string;
  baseline_id: string;
  registered_at: string;
  manifest: {
    source_sha256: string;
    pdf_sha256: string;
    page_count: number;
    render_record: {
      renderer_engine: string;
      renderer_version: string;
      renderer_path: string;
    };
  };
}

export const findDocxRenderer = () => invoke<string | null>("journal_docx_renderer");

export async function loadDocxRenders(projectId: string, baselineId: string): Promise<DocxRender[]> {
  const result = await journalRequest<{ derived_renders: DocxRender[] }>(journalQuery("/api/derived-renders", {
    project_id: projectId, baseline_id: baselineId,
  }));
  return result.derived_renders;
}

/** Recover a completed render before starting or retrying a conversion. */
export async function ensureDocxRender(projectId: string, baselineId: string, executable: string): Promise<DocxRender> {
  const records = await loadDocxRenders(projectId, baselineId);
  const existing = records.find((record) => record.manifest.render_record.renderer_path === executable);
  if (existing) return existing;
  const result = await invoke<DocxRender>("journal_docx_render", { projectId, baselineId, executable });
  if (result.baseline_id !== baselineId) throw new Error("The PDF does not belong to the selected saved DOCX version.");
  return result;
}

export async function loadDocxPdf(projectId: string, render: DocxRender): Promise<Uint8Array> {
  const result = await invoke<ArrayBuffer | number[]>("journal_docx_pdf", {
    projectId, baselineId: render.baseline_id, bundleId: render.bundle_id,
  });
  return new Uint8Array(result);
}

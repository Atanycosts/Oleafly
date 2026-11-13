import { invoke } from "@tauri-apps/api/core";
import { journalQuery, journalRequest } from "@/lib/journal-workbench";

const DOCX_RENDER_REPORT_VERSION = "libreoffice-headless-1.2.0";

export interface DocxRender {
  bundle_id: string;
  baseline_id: string;
  registered_at: string;
  manifest: {
    source_sha256: string;
    pdf_sha256: string;
    page_count: number;
    render_record: {
      report_version?: string;
      renderer_engine: string;
      renderer_version: string;
      renderer_path: string;
      font_cache_sha256?: string;
      supplied_fonts?: {
        path: string;
        sha256: string;
        family?: string;
        postscript?: string;
        version?: string | null;
        weight?: number;
        style?: string;
      }[];
      pdf_font_names?: string[];
    };
  };
}

export const findDocxRenderer = () => invoke<string | null>("journal_docx_renderer");

interface RenderListing {
  derived_renders: DocxRender[];
  font_cache_sha256: string;
}

const renderListing = (projectId: string, baselineId: string) =>
  journalRequest<RenderListing>(journalQuery("/api/derived-renders", {
    project_id: projectId, baseline_id: baselineId,
  }));

export async function loadDocxRenders(projectId: string, baselineId: string): Promise<DocxRender[]> {
  return (await renderListing(projectId, baselineId)).derived_renders;
}

const pending = new Map<string, Promise<DocxRender>>();

/** Recover a completed render before starting or retrying a conversion. */
export async function ensureDocxRender(
  projectId: string,
  baselineId: string,
  executable: string,
  force = false,
): Promise<DocxRender> {
  const listing = await renderListing(projectId, baselineId);
  if (!force) {
    const existing = listing.derived_renders.reverse().find((record) =>
      record.manifest.render_record.renderer_path === executable
      && record.manifest.render_record.report_version === DOCX_RENDER_REPORT_VERSION
      && record.manifest.render_record.font_cache_sha256 === listing.font_cache_sha256
    );
    if (existing) return existing;
  }
  const key = JSON.stringify([projectId, baselineId, executable, listing.font_cache_sha256]);
  const active = pending.get(key);
  if (active) return active;
  const conversion = invoke<DocxRender>("journal_docx_render", { projectId, baselineId, executable })
    .then((result) => {
      if (result.baseline_id !== baselineId) throw new Error("The PDF does not belong to the selected saved DOCX version.");
      return result;
    })
    .finally(() => { pending.delete(key); });
  pending.set(key, conversion);
  return conversion;
}

export async function loadDocxPdf(projectId: string, render: DocxRender): Promise<Uint8Array> {
  const result = await invoke<ArrayBuffer | number[]>("journal_docx_pdf", {
    projectId, baselineId: render.baseline_id, bundleId: render.bundle_id,
  });
  return new Uint8Array(result);
}

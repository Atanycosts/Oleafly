import { invoke } from "@tauri-apps/api/core";

export interface RetainedPaperReference {
  projectId: string;
  path: string;
  pdfSha256: string;
}

export interface PaperText {
  key: string;
  title: string | null;
  sourceUrl: string | null;
  pages: number;
  text: string;
  nextOffset: number | null;
  stored: string[];
  source: {
    path: string;
    fileSha256: string;
    offset: number;
    endOffset: number;
    truncated: boolean;
    snapshotRetained: boolean | null;
    pdf?: {
      path: string;
      sha256: string;
      pageCount: number;
      pageStart: number | null;
      pageEnd: number | null;
    };
  };
  pdfReference: RetainedPaperReference;
}

type PaperRequest =
  | { kind: "doi"; doi: string }
  | { kind: "arxiv"; id: string }
  | { kind: "url"; url: string }
  | { kind: "path"; path: string; root_id: string | null };

export function readProjectPaper(projectId: string, input: {
  doi?: string; arxiv?: string; url?: string; path?: string; root_id?: string;
  reference?: RetainedPaperReference;
  offset?: number; max_chars?: number;
}): Promise<PaperText> {
  const request: PaperRequest = input.doi ? { kind: "doi", doi: input.doi }
    : input.arxiv ? { kind: "arxiv", id: input.arxiv }
    : input.url ? { kind: "url", url: input.url }
    : { kind: "path", path: input.path ?? "", root_id: input.root_id ?? null };
  return invoke<PaperText>("read_project_paper", {
    projectId, request, offset: input.offset ?? null, maxChars: input.max_chars ?? null,
    reference: input.reference ?? null,
  });
}

export const readRetainedPaperPdf = (reference: RetainedPaperReference) =>
  invoke<ArrayBuffer>("read_retained_paper_pdf", { reference });

export interface CitationCheck {
  verified: boolean;
  source: "doi" | "crossref-search";
  doi: string | null;
  matchedTitle: string | null;
  score: number | null;
  bibtex: string | null;
  reason: string | null;
}

export const verifyCitation = (input: { doi?: string; title?: string }) =>
  invoke<CitationCheck>("verify_citation", { doi: input.doi ?? null, title: input.title ?? null });

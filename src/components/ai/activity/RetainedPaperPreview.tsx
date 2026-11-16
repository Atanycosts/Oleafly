import { useTranslation } from "react-i18next";
import { readRetainedPaperPdf, type RetainedPaperReference } from "@/lib/research-literature";
import { useMaterialViewerStore } from "@/store/material-viewer";

export function RetainedPaperPreview({ reference, pageStart }: Readonly<{
  reference: RetainedPaperReference;
  pageStart?: number;
  pageEnd?: number;
  pageCount?: number;
}>) {
  const { t } = useTranslation("ai");
  return <button type="button" className="rounded px-1.5 py-1 text-[0.625rem] font-medium hover:bg-accent" onClick={() => {
    const captured = { ...reference };
    useMaterialViewerStore.getState().open({
      projectId: captured.projectId, documentId: `paper:${captured.path}`, title: captured.path.split("/").pop() ?? captured.path,
      path: captured.path, kind: "pdf", revision: captured.pdfSha256, initialPage: pageStart,
      load: async () => new Uint8Array(await readRetainedPaperPdf(captured)),
    });
  }}>{t(($) => $.ai.paperReader.openPdf)}</button>;
}

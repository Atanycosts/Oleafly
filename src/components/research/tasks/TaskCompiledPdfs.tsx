import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import { extractPdfText } from "@/lib/pdf-text";
import { pdfPageToPng } from "@/lib/pdf-image";
import { listTaskCompiledPdfs, readTaskCompiledPdf, type TaskCompiledArtifact } from "@/lib/research-tasks";
import { Button } from "@/components/ui/button";
import { CopyableBlock } from "@/components/ui/copyable-block";

export function TaskCompiledPdfs({ taskId, generation, status, reference }: { taskId: string; generation: number; status: string; reference?: TaskCompiledArtifact }) {
  const { t } = useTranslation(["researchTools"]);
  const [artifacts, setArtifacts] = useState<TaskCompiledArtifact[]>([]);
  const [selected, setSelected] = useState<TaskCompiledArtifact | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef({ taskId, generation, path: selected?.path });
  selection.current = { taskId, generation, path: selected?.path };
  const isCurrent = (identity: typeof selection.current) => {
    const current = selection.current;
    return current.taskId === identity.taskId && current.generation === identity.generation && current.path === identity.path;
  };
  useEffect(() => {
    let active = true;
    setArtifacts(reference ? [reference] : []); setSelected(reference ?? null); setBytes(null); setText(null); setImage(null); setError(null);
    if (reference) return;
    if (status === "queued") return;
    void listTaskCompiledPdfs(taskId, generation)
      .then((rows) => { if (active) setArtifacts(rows); })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [taskId, generation, status, reference]);
  useEffect(() => {
    let active = true;
    setBytes(null); setText(null); setImage(null);
    if (selected) void readTaskCompiledPdf(taskId, generation, selected)
      .then((value) => { if (active) setBytes(new Uint8Array(value)); })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [taskId, generation, selected]);
  if (!artifacts.length && !error) return null;
  const readText = () => {
    if (!bytes) return;
    const identity = selection.current;
    void extractPdfText(bytes).then((value) => {
      if (isCurrent(identity)) setText(value.pages.map((page, index) => `${t(($) => $.researchTools.tasks.detail.compiledPdfPage, { page: index + 1 })}\n${page}`).join("\n\n"));
    }).catch((cause) => { if (isCurrent(identity)) setError(String(cause)); });
  };
  const renderPage = () => {
    if (!bytes) return;
    const identity = selection.current;
    void pdfPageToPng(bytes).then((value) => { if (isCurrent(identity)) setImage(value); })
      .catch((cause) => { if (isCurrent(identity)) setError(String(cause)); });
  };
  return <section className="space-y-3" aria-label={t(($) => $.researchTools.tasks.detail.compiledPdfs)}>
    <h4 className="text-sm font-medium">{t(($) => $.researchTools.tasks.detail.compiledPdfs)}</h4>
    {error && <p role="alert">{error}</p>}
    {artifacts.map((artifact) => <Button key={artifact.path} variant="outline" onClick={() => { setError(null); setSelected(artifact); }}>
      {artifact.mainDocument} · {artifact.pdfSha256.slice(0, 10)}
    </Button>)}
    {bytes && selected && <>
      <p className="break-all text-xs">{t(($) => $.researchTools.tasks.detail.compiledPdfIdentity, { generation, input: selected.inputFingerprint.slice(0, 12), size: selected.size })}</p>
      <Button variant="outline" onClick={readText}>{t(($) => $.researchTools.tasks.detail.compiledPdfText)}</Button>
      <Button variant="outline" onClick={renderPage}>{t(($) => $.researchTools.tasks.detail.compiledPdfRender)}</Button>
      <div className="h-96 overflow-auto"><PdfViewer data={bytes} documentIdentity={selected.path} scale={1} /></div>
      {text !== null && <CopyableBlock source={text}><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{text}</pre></CopyableBlock>}
      {image && <img src={image} alt={t(($) => $.researchTools.tasks.detail.compiledPdfFirstPage)} />}
    </>}
  </section>;
}

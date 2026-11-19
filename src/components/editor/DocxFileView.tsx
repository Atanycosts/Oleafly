import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { openWordDocument, type OpenedWordDocument, type WordOpenChoice } from "@/lib/docx-file";
import { basename } from "@/lib/path-utils";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

/** The file tab and Journal checks open the same retained editor, save and recovery flow. */
export default function DocxFileView({ projectId, path }: { projectId: string; path: string }) {
  const { t } = useTranslation("editor");
  const request = useDocxWorkspaceStore((state) => state.request);
  const [document, setDocument] = useState<OpenedWordDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const mounted = useRef(false);
  const current = request?.appProjectId === projectId && (request.sourcePath === path || request.project.project_id === document?.project?.project_id);
  const otherOpen = !!request && !current;
  const needsChoice = !!document && (document.sourceChanged || document.choices.length > 0);
  const choices = document ? [...new Map([
    ...(document.sourceChanged && document.project ? [document.project] : []),
    ...document.choices,
  ].map((item) => [item.project_id, item])).values()] : [];

  const open = useCallback(async (choice?: WordOpenChoice) => {
    if (useDocxWorkspaceStore.getState().request) return;
    setLoading(true);
    setError(null);
    try {
      const opened = choice ? await openWordDocument(projectId, path, choice) : await openWordDocument(projectId, path);
      if (!mounted.current) return;
      setDocument(opened);
      if (!opened.project || (!choice && opened.sourceChanged)) return;
      useDocxWorkspaceStore.getState().open({
        appProjectId: projectId, project: opened.project, world: opened.world, sourcePath: path,
        onSaved: async () => {},
      });
    } catch (cause) {
      if (mounted.current) setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId, path]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (started.current) return;
    if (current) {
      started.current = true;
      useDocxWorkspaceStore.getState().restore();
      return;
    }
    if (request) return;
    started.current = true;
    void open();
  }, [open, request, current]);

  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="word-file-view">
    {loading ? <Spinner /> : <FileText className="size-10 text-muted-foreground" />}
    <p className="text-sm font-medium">{basename(path)}</p>
    <p className="max-w-md text-sm text-muted-foreground">{t(($) => $.editor.shell.wordWorkingCopy)}</p>
    {error && <p role="alert" className="max-w-lg break-words text-sm text-destructive">{t(($) => $.editor.shell.wordLoadFailed, { detail: error })}</p>}
    {otherOpen ? <>
      <p className="max-w-md text-sm text-muted-foreground">{t(($) => $.editor.shell.wordOtherOpen, { name: request.project.name })}</p>
      <Button size="sm" variant="outline" onClick={() => useDocxWorkspaceStore.getState().restore()}>{t(($) => $.editor.shell.wordReturn)}</Button>
    </> : needsChoice ? <div className="flex max-w-lg flex-col items-center gap-2" data-testid="word-source-choice">
      <p className="text-sm text-muted-foreground">{t(($) => document.sourceChanged ? $.editor.shell.wordSourceChanged : $.editor.shell.wordExistingCopy)}</p>
      {choices.map((item) => <Button key={item.project_id} size="sm" disabled={loading} onClick={() => void open({ workbenchProjectId: item.project_id })}>
        {t(($) => $.editor.shell.wordContinueCopy, { name: item.name })}
      </Button>)}
      <Button size="sm" variant="outline" disabled={loading} onClick={() => void open({ newCopy: true })}>{t(($) => $.editor.shell.wordNewCopy)}</Button>
    </div> : <Button size="sm" disabled={loading} onClick={() => {
      if (current) useDocxWorkspaceStore.getState().restore();
      else void open();
    }}>{t(($) => $.editor.shell.wordOpen)}</Button>}
  </div>;
}

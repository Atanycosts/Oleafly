import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { WorkbenchConnectionForm } from "@/components/research/WorkbenchConnectionForm";
import { DocxWorkbenchConnectionError, openWordDocument, type OpenedWordDocument, type WordOpenChoice } from "@/lib/docx-file";
import { basename } from "@/lib/path-utils";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";

/** The file tab and Journal checks open the same retained editor, save and recovery flow. */
export default function DocxFileView({ projectId, path }: { projectId: string; path: string }) {
  const { t } = useTranslation("editor");
  const request = useDocxWorkspaceStore((state) => state.request);
  const [document, setDocument] = useState<OpenedWordDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; connection?: { choice?: WordOpenChoice } } | null>(null);
  const started = useRef(false);
  const mounted = useRef(false);
  const current = request?.appProjectId === projectId && (request.sourcePath === path || request.project.project_id === document?.project?.project_id);
  const otherOpen = !!request && !current;
  const connectionFailure = failure?.connection;
  const needsChoice = !!document && (document.sourceChanged || document.choices.length > 0);
  const choices = document ? [...new Map([
    ...(document.sourceChanged && document.project ? [document.project] : []),
    ...document.choices,
  ].map((item) => [item.project_id, item])).values()] : [];

  const open = useCallback(async (choice?: WordOpenChoice, python?: string) => {
    if (useDocxWorkspaceStore.getState().request) return;
    const autoOpen = useWorkspaceSurfaceStore.getState().active === "files";
    let leftFiles = false;
    const unsubscribe = useWorkspaceSurfaceStore.subscribe((state, previous) => {
      if (previous.active === "files" && state.active !== "files") leftFiles = true;
    });
    setLoading(true);
    if (!python) setFailure(null);
    try {
      const opened = await openWordDocument(projectId, path, choice, python);
      if (!mounted.current) return;
      setFailure(null);
      setDocument(opened);
      if (!opened.project || (!choice && opened.sourceChanged)) return;
      if (useDocxWorkspaceStore.getState().request || !autoOpen || leftFiles) return;
      useDocxWorkspaceStore.getState().open({
        appProjectId: projectId, project: opened.project, world: opened.world, sourcePath: path,
        onSaved: async () => {},
      });
    } catch (cause) {
      if (mounted.current) setFailure({
        message: cause instanceof Error ? cause.message : String(cause),
        connection: cause instanceof DocxWorkbenchConnectionError ? { choice } : undefined,
      });
    } finally {
      unsubscribe();
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
    {!loading && failure && <p role="alert" className="max-w-lg break-words text-sm text-destructive">{t(($) => $.editor.shell.wordLoadFailed, { detail: failure.message })}</p>}
    {otherOpen ? <>
      <p className="max-w-md text-sm text-muted-foreground">{t(($) => $.editor.shell.wordOtherOpen, { name: request.project.name })}</p>
      <Button size="sm" variant="outline" onClick={() => useDocxWorkspaceStore.getState().restore()}>{t(($) => $.editor.shell.wordReturn)}</Button>
    </> : connectionFailure ? <WorkbenchConnectionForm busy={loading} onConnect={(python) => void open(connectionFailure.choice, python)} />
    : needsChoice ? <div className="flex max-w-lg flex-col items-center gap-2" data-testid="word-source-choice">
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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { openRecentProject } from "@/features/open-folder";
import { downloadDocxCopy } from "@/lib/docx-download";
import { discardDocxRecovery, listDocxRecovery, readDocxRecovery, type DocxRecoveryListing, type DocxRecoveryMetadata } from "@/lib/docx-recovery";
import { connectJournalWorkbench, journalQuery, journalRequest, type JournalState, type JournalWorld } from "@/lib/journal-workbench";
import { getResearchWorkspace } from "@/lib/research-workspace";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useFilesStore } from "@/store/files";

/** Startup discovery stays independent of Workbench and the on-demand DOCX editor. */
export function DocxRecoveryHost() {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.recovery, { returnObjects: true });
  const projects = useFilesStore((state) => state.projects);
  const request = useDocxWorkspaceStore((state) => state.request);
  const open = useDocxWorkspaceStore((state) => state.recoveryOpen);
  const setOpen = useDocxWorkspaceStore((state) => state.setRecoveryOpen);
  const [listing, setListing] = useState<DocxRecoveryListing>({ snapshots: [], failures: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<DocxRecoveryMetadata | null>(null);

  useEffect(() => {
    if (request) return;
    let active = true;
    void listDocxRecovery().then((value) => {
      if (active) setListing(value);
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [request]);

  async function refresh() {
    setListing(await listDocxRecovery());
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function readSelected(candidate: DocxRecoveryMetadata) {
    const snapshot = await readDocxRecovery(candidate);
    if (!snapshot || snapshot.contentSha256 !== candidate.contentSha256) {
      await refresh();
      throw new Error(text.changed);
    }
    return snapshot;
  }

  async function restore(candidate: DocxRecoveryMetadata) {
    const snapshot = await readSelected(candidate);
    await connectJournalWorkbench();
    const [workspace, state] = await Promise.all([
      getResearchWorkspace(candidate.appProjectId),
      journalRequest<JournalState>("/api/state"),
    ]);
    if (workspace.journalProjectId !== candidate.workbenchProjectId) throw new Error(text.linkChanged);
    const project = state.projects.find((item) => item.project_id === candidate.workbenchProjectId);
    if (!project) throw new Error(text.projectMissing);
    const world = project.binding
      ? await journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: project.binding.world_version_id }))
      : null;
    await openRecentProject(candidate.appProjectId);
    if (useFilesStore.getState().projectId !== candidate.appProjectId) throw new Error(text.projectMissing);
    useDocxWorkspaceStore.getState().open({
      appProjectId: candidate.appProjectId, project, world, recovery: snapshot,
      onSaved: refresh,
    });
    setOpen(false);
  }

  async function download(candidate: DocxRecoveryMetadata) {
    const snapshot = await readSelected(candidate);
    await downloadDocxCopy(snapshot.bytes, `recovered-${candidate.workbenchProjectId}.docx`);
  }

  const available = listing.snapshots.length > 0 || listing.failures.length > 0 || error !== null;
  return <>
    {available && !request && <Button className="fixed bottom-6 right-6 z-40 shadow-lg" data-testid="docx-recovery-open" onClick={() => setOpen(true)}>
      <RotateCcw className="mr-2 size-4" />{text.open} ({listing.snapshots.length})
    </Button>}
    <Dialog open={open && !request} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" closeDisabled={busy} data-testid="docx-recovery-dialog">
        <DialogHeader><DialogTitle>{text.title}</DialogTitle><DialogDescription>{text.description}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {listing.snapshots.map((candidate) => <section key={candidate.recoveryKey} data-testid="docx-recovery-candidate" data-recovery-key={candidate.recoveryKey} className="space-y-2 rounded border p-3 text-xs">
          <p className="font-medium">{projects.find((project) => project.id === candidate.appProjectId)?.name ?? candidate.appProjectId}</p>
          <p>{`${new Date(candidate.updatedAt).toLocaleString()} · r${candidate.revision}`}</p>
          <p className="break-all text-muted-foreground">{candidate.workbenchProjectId} · {candidate.baseBaselineId}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} data-testid="docx-recovery-restore" onClick={() => void perform(() => restore(candidate))}>{text.restore}</Button>
            <Button size="sm" variant="outline" disabled={busy} data-testid="docx-recovery-download" onClick={() => void perform(() => download(candidate))}><Download className="mr-1 size-3" />{text.download}</Button>
            <Button size="sm" variant="ghost" disabled={busy} data-testid="docx-recovery-discard" onClick={() => setDiscard(candidate)}><Trash2 className="mr-1 size-3" />{text.discard}</Button>
          </div>
        </section>)}
        {listing.failures.length > 0 && <section className="space-y-2 text-xs" role="alert"><p>{text.unreadable}</p>{listing.failures.map((failure) => <p key={failure.recoveryKey} className="break-all text-muted-foreground">{failure.recoveryKey}: {failure.error}</p>)}</section>}
        {listing.snapshots.length === 0 && <p className="text-sm text-muted-foreground">{text.empty}</p>}
        <Button variant="outline" disabled={busy} onClick={() => void perform(refresh)}>{text.refresh}</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={discard !== null} onOpenChange={(value) => { if (!value && !busy) setDiscard(null); }}>
      <DialogContent closeDisabled={busy}>
        <DialogHeader><DialogTitle>{text.discardTitle}</DialogTitle><DialogDescription>{text.discardHelp}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <Button variant="destructive" disabled={busy} data-testid="docx-recovery-confirm-discard" onClick={() => void perform(async () => {
          if (!discard) return;
          if (!await discardDocxRecovery(discard)) { await refresh(); throw new Error(text.changed); }
          setDiscard(null);
          await refresh();
        })}>{text.discard}</Button>
      </DialogContent>
    </Dialog>
  </>;
}

import { lazy, Suspense, useEffect, useId, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Editor, EditorTabBar } from "./Editor";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { diffKey, useDiffStore } from "@/store/diff";
import { useZenStore } from "@/store/zen";
import { useFilesStore } from "@/store/files";
import { useMaterialViewerStore } from "@/store/material-viewer";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { pauseAgentWorkspaceFollow } from "@/lib/agent-workspace-interaction";
import { AgentWorkspaceFeedback } from "@/components/materials/AgentWorkspaceFeedback";

const WordWorkspace = lazy(() => import("@/components/research/DocxWorkspaceDialog").then((m) => ({ default: m.DocxWorkspaceHost })));
const JournalWorkspace = lazy(() => import("@/components/research/JournalChecksPanel").then((m) => ({ default: m.JournalWorkspaceHost })));
const MaterialViewer = lazy(() => import("@/components/materials/RetainedMaterialViewer").then((m) => ({ default: m.RetainedMaterialViewer })));
const MaterialAnnotations = lazy(() => import("@/components/materials/MaterialAnnotations").then((m) => ({ default: m.MaterialAnnotations })));

/** Each work surface stays mounted while another tab is visible. */
export function WorkspaceCenter() {
  const { t } = useTranslation("researchTools");
  const active = useWorkspaceSurfaceStore((s) => s.active);
  const journalOpen = useWorkspaceSurfaceStore((s) => s.journalOpen);
  const [journalKept, setJournalKept] = useState(journalOpen);
  if (journalOpen && !journalKept) setJournalKept(true);
  const wordOpen = useDocxWorkspaceStore((s) => s.request !== null);
  const wordPath = useDocxWorkspaceStore((s) => s.request?.sourcePath);
  const activePath = useFilesStore((s) => s.activePath);
  const projectId = useFilesStore((s) => s.projectId);
  const material = useMaterialViewerStore((s) => s.request);
  const materialVisits = useMaterialViewerStore((s) => s.visits);
  const navigation = useAgentWorkspaceStore((s) => s.navigation);
  const followPaused = useAgentWorkspaceStore((s) => s.paused);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const annotationDocument = useMaterialAnnotationsStore((s) => s.document);
  const annotationAnchor = useMaterialAnnotationsStore((s) => s.anchor);
  const annotationOptions = useMaterialAnnotationsStore((s) => s.options);
  const [feedbackExpanded, setFeedbackExpanded] = useState(true);
  const feedbackId = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit annotation opens change these references; background task updates do not.
  useEffect(() => { setFeedbackExpanded(true); }, [annotationDocument, annotationAnchor, annotationOptions]);
  const zen = useZenStore((s) => s.active);
  const diffFocused = useDiffStore((s) => s.activeKey !== null && s.diffs.some((d) => diffKey(d) === s.activeKey));
  useEffect(() => {
    if (active === "files" && wordPath && activePath === wordPath && !diffFocused) useDocxWorkspaceStore.getState().restore();
  }, [active, activePath, diffFocused, wordPath]);
  useEffect(() => {
    if (material && material.projectId !== projectId) useMaterialViewerStore.getState().close();
    if (annotationDocument && annotationDocument.projectId !== projectId) useMaterialAnnotationsStore.getState().close();
  }, [projectId, material, annotationDocument]);
  useEffect(() => { useAgentWorkspaceStore.getState().setProject(projectId); }, [projectId]);
  useEffect(() => {
    if (!navigation || followPaused || navigation.target.projectId !== projectId) return;
    const controller = new AbortController();
    setNavigationError(null);
    void import("@/lib/docx-agent-host").then(async ({ revealDocxWorkspaceTarget }) => {
      const store = useAgentWorkspaceStore.getState();
      if (!controller.signal.aborted && !store.paused && store.navigation?.sequence === navigation.sequence) await revealDocxWorkspaceTarget(navigation.target, controller.signal);
    }).catch((cause) => { if (!controller.signal.aborted) setNavigationError(String(cause)); });
    return () => controller.abort();
  }, [navigation, followPaused, projectId]);
  useLayoutEffect(() => {
    if (projectId && active !== "word") useAgentWorkspaceStore.getState().clearView(projectId);
  }, [projectId, active, activePath, material, diffFocused]);
  const loading = <p role="status" className="p-6 text-sm text-muted-foreground">{t(($) => $.researchTools.docx.loading)}</p>;
  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background" data-testid="workspace-center"
    onPointerDownCapture={pauseAgentWorkspaceFollow} onWheelCapture={pauseAgentWorkspaceFollow}
    onBeforeInputCapture={pauseAgentWorkspaceFollow} onKeyDownCapture={pauseAgentWorkspaceFollow}>
    {!zen && <EditorTabBar diffFocused={diffFocused} />}
    <AgentWorkspaceFeedback />
    {navigationError && <p role="status" className="border-b px-3 py-1 text-xs text-muted-foreground" title={navigationError}>{t(($) => $.researchTools.workspace.navigationUnavailable)}</p>}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
    <div className={`relative min-h-0 min-w-0 flex-1 ${annotationDocument ? "pr-12" : ""}`}>
      <div className="h-full min-h-0" hidden={active !== "files"} inert={active !== "files" || undefined}><Editor showTabBar={false} /></div>
      {wordOpen && <div className="h-full min-h-0" hidden={active !== "word"} inert={active !== "word" || undefined} data-testid="workspace-word-surface">
        <ErrorBoundary surface="editor"><Suspense fallback={loading}><WordWorkspace /></Suspense></ErrorBoundary>
      </div>}
      {journalKept && <div className="h-full min-h-0" hidden={active !== "journal"} inert={active !== "journal" || undefined} data-testid="workspace-journal-surface">
        <ErrorBoundary surface="editor"><Suspense fallback={loading}><JournalWorkspace /></Suspense></ErrorBoundary>
      </div>}
      {material && materialVisits.map((visit) => {
        const hidden = active !== "material" || visit.id !== materialVisits.at(-1)?.id;
        return <div key={visit.id} className="h-full min-h-0" hidden={hidden} inert={hidden || undefined} data-testid="workspace-material-surface">
          <ErrorBoundary surface="editor"><Suspense fallback={loading}><MaterialViewer request={visit.request} active={!hidden} /></Suspense></ErrorBoundary>
        </div>;
      })}
    </div>
    {annotationDocument && <>
      <div className="absolute inset-y-0 right-0 z-20 flex w-12 flex-col items-center border-l bg-background py-2" data-testid="workspace-material-feedback-rail">
        <Button type="button" variant={feedbackExpanded ? "secondary" : "ghost"} size="icon" className="size-9" aria-label={t(($) => $.researchTools.materialAnnotations.expand)} aria-expanded={feedbackExpanded} aria-controls={feedbackId} onClick={() => setFeedbackExpanded((expanded) => !expanded)}><MessageSquareText className="size-4" /></Button>
      </div>
      <aside id={feedbackId} hidden={!feedbackExpanded} inert={!feedbackExpanded || undefined} className="absolute inset-y-2 right-12 z-30 w-80 max-w-[calc(100%-3rem)] overflow-auto rounded-l-lg border bg-background shadow-xl" data-testid="workspace-material-feedback">
        <ErrorBoundary surface="editor" resetKey={`${annotationDocument.documentId}:${annotationDocument.revision}`}><Suspense fallback={loading}><MaterialAnnotations onMinimize={() => setFeedbackExpanded(false)} /></Suspense></ErrorBoundary>
      </aside>
    </>}
    </div>
  </div>;
}

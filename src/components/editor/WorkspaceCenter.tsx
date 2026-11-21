import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
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
  const feedbackEntries = useMaterialAnnotationsStore((s) => s.feedback);
  const openFeedback = useMaterialAnnotationsStore((s) => s.open);
  const setFeedbackExpanded = useMaterialAnnotationsStore((s) => s.setExpanded);
  const closeFeedback = useMaterialAnnotationsStore((s) => s.close);
  const feedbackOverWord = active === "word";
  const diffFocused = useDiffStore((s) => s.activeKey !== null && s.diffs.some((d) => diffKey(d) === s.activeKey));
  const viewedMaterial = useAgentWorkspaceStore((state) => projectId ? state.views[projectId] : undefined);
  const matchingFeedback = feedbackEntries.filter(({ document, options }) => {
    if (document.projectId !== projectId) return false;
    const { documentId, revision } = document;
    const view = viewedMaterial;
    const matchesVersion = (version: string) => revision.replace(/^sha256:/u, "") === version.replace(/^sha256:/u, "");
    if (feedbackOverWord) {
      if (view?.documentId !== documentId) return false;
      return options.wordSessionId
        ? view.role === "working" && view.sessionId === options.wordSessionId
        : view.role !== "working" && matchesVersion(view.revision);
    }
    if (options.wordSessionId) return false;
    if (active === "material" && material?.documentId === documentId) {
      return material.previous ? view?.documentId === documentId && matchesVersion(view.revision) : matchesVersion(material.revision);
    }
    return active === "files" && !diffFocused && (documentId === `file:${activePath}` || documentId.startsWith("compiled:"));
  });
  const feedback = matchingFeedback[0];
  const wordFeedbackChoices = matchingFeedback.filter(({ document }) => document.kind === "docx")
    .sort((left, right) => left.key.localeCompare(right.key));
  const wordToolsOpen = useDocxWorkspaceStore((s) => s.toolsOpen);
  const feedbackVisible = !!feedback?.expanded && !(feedbackOverWord && wordToolsOpen);
  const feedbackKey = feedback?.key;
  const feedbackExpanded = feedback?.expanded;
  const feedbackId = useId();
  const feedbackButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit annotation opens change these references; background task updates do not.
  useLayoutEffect(() => {
    if (feedbackExpanded && feedbackOverWord && feedback.document === annotationDocument && feedback.options === annotationOptions) {
      useDocxWorkspaceStore.getState().setToolsOpen(false);
    }
  }, [annotationDocument, annotationAnchor, annotationOptions, feedbackExpanded]);
  useEffect(() => {
    if (feedbackKey && feedbackOverWord && wordToolsOpen && useDocxWorkspaceStore.getState().toolsOpen) setFeedbackExpanded(feedbackKey, false);
  }, [feedbackKey, feedbackOverWord, setFeedbackExpanded, wordToolsOpen]);
  const yieldFeedbackToContextTool = useCallback(() => {
    if (feedbackKey && feedbackOverWord) setFeedbackExpanded(feedbackKey, false);
  }, [feedbackKey, feedbackOverWord, setFeedbackExpanded]);
  const zen = useZenStore((s) => s.active);
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
  const wordReceipt = feedbackOverWord && <div className="flex h-full max-w-[40%] shrink-0 items-center gap-1 border-l px-1.5 empty:hidden" data-testid="workspace-word-receipt-slot">
    {navigationError && <Tooltip label={navigationError}>
      <span role="status" className="inline-flex items-center text-destructive">
        <CircleAlert className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{t(($) => $.researchTools.workspace.navigationUnavailable)}</span>
      </span>
    </Tooltip>}
    <AgentWorkspaceFeedback inline />
  </div>;
  return <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background" data-testid="workspace-center"
    onPointerDownCapture={pauseAgentWorkspaceFollow} onWheelCapture={pauseAgentWorkspaceFollow}
    onBeforeInputCapture={pauseAgentWorkspaceFollow} onKeyDownCapture={pauseAgentWorkspaceFollow}>
    {zen ? feedbackOverWord && <div className="flex h-9 shrink-0 items-center justify-end border-b">{wordReceipt}</div>
      : <EditorTabBar diffFocused={diffFocused} trailing={wordReceipt} />}
    {!feedbackOverWord && <div>
      <AgentWorkspaceFeedback />
      {navigationError && <p role="status" className="border-b px-3 py-1 text-xs text-muted-foreground"><Tooltip label={navigationError}><span>{t(($) => $.researchTools.workspace.navigationUnavailable)}</span></Tooltip></p>}
    </div>}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
    <div className={`relative min-h-0 min-w-0 flex-1 ${feedback && !feedbackOverWord ? "pr-12" : ""}`}>
      <div className="h-full min-h-0" hidden={active !== "files"} inert={active !== "files" || undefined}><Editor showTabBar={false} /></div>
      {wordOpen && <div className="h-full min-h-0" hidden={active !== "word"} inert={active !== "word" || undefined} data-testid="workspace-word-surface">
        <ErrorBoundary surface="editor"><Suspense fallback={loading}><WordWorkspace feedbackVisible={feedbackOverWord && feedbackVisible}
          onContextToolActivate={yieldFeedbackToContextTool} /></Suspense></ErrorBoundary>
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
    {feedback && <div className={feedbackOverWord
        ? "absolute bottom-3 right-6 z-30 rounded-md border bg-background shadow-sm"
        : "absolute inset-y-0 right-0 z-20 flex w-12 flex-col items-center border-l bg-background py-2"}
        data-testid="workspace-material-feedback-rail">
        <Button ref={feedbackButton} type="button" variant={feedbackVisible ? "secondary" : "ghost"} size="icon" className="size-9" aria-label={t(($) => $.researchTools.materialAnnotations.expand)} aria-expanded={feedbackVisible} aria-controls={feedbackId} onClick={() => {
          if (feedbackOverWord && wordToolsOpen) useDocxWorkspaceStore.getState().setToolsOpen(false);
          setFeedbackExpanded(feedback.key, !feedbackVisible);
        }}><MessageSquareText className="size-4" /></Button>
      </div>}
    <aside id={feedbackId} hidden={!feedbackVisible} inert={!feedbackVisible || undefined}
      className={`absolute z-30 w-80 max-w-[calc(100%-3rem)] overflow-auto rounded-lg border bg-background shadow-xl ${feedbackOverWord ? "bottom-14 right-3 top-12" : "inset-y-2 right-12"}`}
      data-testid="workspace-material-feedback">
      {feedback?.document.kind === "docx" && wordFeedbackChoices.length > 1 && <div className="border-b px-3 py-2">
        <select className="w-full min-w-0 rounded border bg-background px-2 py-1 text-sm" value={feedback.key}
          aria-label={t(($) => $.researchTools.materialAnnotations.feedbackTarget)} onChange={(event) => {
            const choice = wordFeedbackChoices.find(({ key }) => key === event.currentTarget.value);
            if (choice) openFeedback(choice.document, choice.anchor, choice.options);
          }}>
          {wordFeedbackChoices.map(({ key, anchor, options }) => {
            const revision = options.wordSessionRevision;
            const old = revision !== undefined && revision !== viewedMaterial?.sessionRevision;
            const target = anchor.kind === "object" && anchor.label ? anchor.label : t(($) => $.researchTools.materialAnnotations[anchor.kind]);
            const label = old ? `${t(($) => $.researchTools.materialAnnotations.oldVersion)} ${revision} · ${target}` : target;
            return <option key={key} value={key}>{label}</option>;
          })}
        </select>
      </div>}
      {feedbackEntries.filter(({ document }) => document.projectId === projectId).map((entry) => {
        const current = entry.key === feedbackKey;
        return <div key={entry.key} hidden={!current} inert={!current || undefined}>
          <ErrorBoundary surface="editor" resetKey={entry.document.revision}><Suspense fallback={loading}>
            <MaterialAnnotations key={entry.document.revision} document={entry.document} anchor={entry.anchor} options={entry.options} current={current}
              wordRevision={current && feedbackOverWord ? viewedMaterial?.sessionRevision : undefined}
              active={current && feedbackVisible} onMinimize={() => {
                setFeedbackExpanded(entry.key, false);
                feedbackButton.current?.focus({ preventScroll: true });
              }} onClose={() => closeFeedback(entry.key)} />
          </Suspense></ErrorBoundary>
        </div>;
      })}
    </aside>
    </div>
  </div>;
}

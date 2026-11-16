import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator, type GroupImperativeHandle, type Layout } from "react-resizable-panels";
import { registerEditorMutationOwner } from "@/lib/editor-mutation-lease";
import { FileText, ImageOff, Settings2 } from "lucide-react";
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { EditorContextMenu } from "./EditorContextMenu";
import { EditorToolbar } from "./EditorToolbar";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { TypstToolbar } from "./TypstToolbar";
import { SelectionActionMenu } from "./SelectionActionMenu";
import { DiffView } from "./diff/DiffView";
import { MaterialPdfView } from "@/components/materials/MaterialPdfView";
import { MaterialImageView } from "@/components/materials/MaterialImageView";
import { MaterialViewContext } from "@/components/materials/MaterialViewContext";
import { ProjectSourceContext } from "./ProjectSourceContext";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { createMaterialDocument, type MaterialDocument } from "@/lib/material-surface";
import { openMaterialAnnotations } from "@/store/material-annotations";
import { Button } from "@/components/ui/button";
import { SidebarCollapseToggle } from "@/components/layout/WorkspaceControls";
import { Tooltip } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getEditorView, wrapSelection } from "./cm/controller";
import { useFilesStore } from "@/store/files";
import { isManagedProjectPath, isReadOnlyLink } from "@/lib/project-paths";
import { inWidgetControl } from "@/lib/field-history";
import { ChangedOnDiskBanner } from "./ChangedOnDiskBanner";
import { CloseAssistantTabsButton, EditorTabStrip } from "./EditorTabStrip";
import { useDiffStore, diffKey } from "@/store/diff";
import { useSettingsStore } from "@/store/settings";
import { useZenStore } from "@/store/zen";
import { base64ToUint8Array, readFileBase64 } from "@/lib/tauri";
import { imageMime, isImagePath } from "@/lib/image-mime";
import { basename } from "@/lib/path-utils";
import { cn } from "@/lib/utils";
import { CollabRemovedFileSlot } from "@/components/collab/CollabSlots";
import {
  formattingForPath,
  formattingProfileForPath,
  pathUsesEngineSource,
} from "@/lib/document-engine";
import { useVisualModeStore } from "@/store/visual-mode";
import { getMarkdownSplitSize, setMarkdownSplitSize } from "@/lib/wysiwyg-mode";
import {
  PANEL_STYLE,
  panelLimitProps,
  percent,
  useSeparatorHitArea,
  useSeparatorKeyboard,
  type PanelLimits,
} from "@/lib/panel-layout";
import { flushWysiwygPendingEdits, setWysiwygVisibilityController } from "./wysiwyg/controller";
import { ProofreadingNotifications } from "./ProofreadingNotifications";
import { LoadingState } from "@/components/ui/empty";
const WysiwygEditor = lazy(() =>
  import("./wysiwyg/WysiwygEditor").then((m) => ({ default: m.WysiwygEditor })),
);
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })));
const MARKDOWN_SOURCE_PANEL = "markdown-source-pane";
const MARKDOWN_PREVIEW_PANEL = "markdown-preview-pane";
const MARKDOWN_PANE_LIMITS: PanelLimits = { minSize: 20 };
const MARKDOWN_SPLIT_LIMITS = {
  [MARKDOWN_SOURCE_PANEL]: MARKDOWN_PANE_LIMITS,
  [MARKDOWN_PREVIEW_PANEL]: MARKDOWN_PANE_LIMITS,
};
const FORMATTING_SHORTCUTS: ReadonlyMap<string, "bold" | "italic"> = new Map([
  ["b", "bold"],
  ["i", "italic"],
]);

function PdfFileView({ projectId, path }: Readonly<{ projectId: string; path: string }>) {
  const { t } = useTranslation(["common", "editor"]);
  const active = useWorkspaceSurfaceStore((state) => state.active === "files");
  const [loaded, setLoaded] = useState<{ bytes: Uint8Array; document: MaterialDocument } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setErr(null);
    readFileBase64(projectId, path)
      .then(async (b64) => {
        const bytes = base64ToUint8Array(b64);
        const document = await createMaterialDocument({ projectId, documentId: `file:${path}`, path, title: basename(path), kind: "pdf" }, { bytes, mediaType: "application/pdf" });
        if (!cancelled) setLoaded({ bytes, document });
      })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, path]);

  if (err) {
    return (
      <div className="p-6 text-sm text-destructive">
        {t(($) => $.editor.shell.pdfLoadFailed, { detail: err })}
      </div>
    );
  }
  if (!loaded) return <div className="p-6 text-sm text-muted-foreground">{t(($) => $.common.state.loading)}</div>;
  return <MaterialViewContext document={loaded.document} active={active} materialRole="working"><MaterialPdfView key={loaded.document.revision} document={loaded.document} bytes={loaded.bytes} /></MaterialViewContext>;
}

function ImageFileView({ projectId, path }: Readonly<{ projectId: string; path: string }>) {
  const { t } = useTranslation(["common", "editor"]);
  const active = useWorkspaceSurfaceStore((state) => state.active === "files");
  const [loaded, setLoaded] = useState<{ src: string; document: MaterialDocument } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [undecodable, setUndecodable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setErr(null);
    setUndecodable(false);
    readFileBase64(projectId, path)
      .then(async (b64) => {
        const document = await createMaterialDocument({ projectId, documentId: `file:${path}`, path, title: basename(path), kind: "image" }, { bytes: base64ToUint8Array(b64), mediaType: imageMime(path) });
        if (!cancelled) setLoaded({ src: `data:${imageMime(path)};base64,${b64}`, document });
      })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, path]);

  if (err) {
    return (
      <div className="p-6 text-sm text-destructive">
        {t(($) => $.editor.shell.imageLoadFailed, { detail: err })}
      </div>
    );
  }
  if (!loaded) return <div className="p-6 text-sm text-muted-foreground">{t(($) => $.common.state.loading)}</div>;
  if (undecodable) {
    return (
      <div
        data-testid="image-undecodable"
        className="flex h-full flex-col items-center justify-center text-center text-muted-foreground"
      >
        <ImageOff className="mb-3 size-10 opacity-30" />
        <p className="text-sm">{basename(path)}</p>
        <p className="text-xs">{t(($) => $.editor.shell.imageUnreadable)}</p>
      </div>
    );
  }
  return <MaterialViewContext document={loaded.document} active={active} materialRole="working"><MaterialImageView key={loaded.document.revision} document={loaded.document} src={loaded.src} onError={() => setUndecodable(true)} /></MaterialViewContext>;
}

const HtmlOutputPanel = lazy(() => import("@/components/preview/HtmlOutputPanel").then((module) => ({ default: module.HtmlOutputPanel })));
const DiagramMainFileView = lazy(() => import("./DiagramMainFileView"));
const DocxFileView = lazy(() => import("./DocxFileView"));

function keepEditorFocus(event: MouseEvent) {
  if (!(event.target instanceof Element) || !event.target.classList.contains("cm-scroller")) return;
  event.preventDefault();
  getEditorView()?.focus();
}

function openFileKind(activePath: string | null) {
  return {
    isWordFile: activePath != null && /\.docx?$/i.test(activePath),
    isPdfFile: activePath?.toLowerCase().endsWith(".pdf"),
    isImageFile: activePath != null && isImagePath(activePath),
    isOpaqueFile:
      activePath != null &&
      /\.(zip|gz|eps|ttf|otf|woff2?)$/i.test(activePath),
  };
}

function markdownModeFor(split: boolean, visual: boolean): "both" | "visual" | "code" {
  if (split) return "both";
  return visual ? "visual" : "code";
}

export function EditorTabBar({ diffFocused }: { diffFocused: boolean }) {
  const { t } = useTranslation(["editor"]);
  return <div className="flex h-9 shrink-0 items-center border-b">
    <div className="flex shrink-0 items-center border-r border-border pl-2 pr-1"><SidebarCollapseToggle /></div>
    <EditorTabStrip diffFocused={diffFocused} />
    <div className="flex shrink-0 items-center gap-1 border-l border-border pl-1 pr-2">
      <CloseAssistantTabsButton />
      <Tooltip label={t(($) => $.editor.shell.editorSettings)} side="bottom">
        <button type="button" aria-label={t(($) => $.editor.shell.editorSettings)}
          onClick={() => useSettingsStore.getState().openSettingsAt("appearance", "editor")}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground">
          <Settings2 className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  </div>;
}

export function Editor({ showTabBar = true }: { showTabBar?: boolean }) {
  const { t } = useTranslation(["common", "editor"]);
  const zen = useZenStore((s) => s.active);
  const interactionRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = interactionRoot.current;
    if (!zen || !root) return;
    root.addEventListener("mousedown", keepEditorFocus);
    return () => root.removeEventListener("mousedown", keepEditorFocus);
  }, [zen]);
  useLayoutEffect(() => registerEditorMutationOwner({
    projectId: () => useFilesStore.getState().projectId,
    setLocked: (locked) => {
      const element = interactionRoot.current;
      if (!element) return;
      element.inert = locked;
      if (locked) element.setAttribute("aria-busy", "true");
      else element.removeAttribute("aria-busy");
    },
  }), []);
  const activePath = useFilesStore((s) => s.activePath);
  const manifestHome = useFilesStore((s) => s.manifestHome);
  const managedFile = !!activePath && isManagedProjectPath(activePath, manifestHome);
  const linkedFile = useFilesStore(
    (s) => !!s.activePath && isReadOnlyLink(s.activePath, s.tree),
  );
  const diffs = useDiffStore((s) => s.diffs);
  const activeKey = useDiffStore((s) => s.activeKey);
  const diffFocused = activeKey !== null && diffs.some((d) => diffKey(d) === activeKey);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (!el?.closest(".cm-editor")) return;
      if (inWidgetControl(el)) return;
      const { activePath: path, engine, engineLoaded } = useFilesStore.getState();
      const action = FORMATTING_SHORTCUTS.get(e.key.toLowerCase());
      if (!action) return;
      const f = formattingForPath(engine, engineLoaded, path, action);
      if (f?.kind !== "wrap") return;
      e.preventDefault();
      wrapSelection(f.before, f.after);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasOpenFile = activePath !== null;
  const { isWordFile, isPdfFile, isImageFile, isOpaqueFile } = openFileKind(activePath);
  const projectId = useFilesStore((s) => s.projectId);
  const projectKind = useFilesStore((s) => s.projectKind);
  const mainDoc = useFilesStore((s) => s.mainDoc);
  const isDiagramMainFile = projectKind === "diagram" && activePath === mainDoc;
  const engineLoaded = useFilesStore((s) => s.engineLoaded);
  const engine = useFilesStore((s) => s.engine);
  const formattingProfile = useFilesStore((s) => s.engine.capabilities.formatting_profile);
  const isMarkdownFile = /\.(md|markdown)$/iu.test(activePath ?? "");
  const toolbarProfile = formattingProfileForPath(engine, engineLoaded, activePath);
  const showLatexToolbar = !zen && toolbarProfile === "latex";
  const markdownIsEngineSource =
    engineLoaded && formattingProfile === "markdown" && pathUsesEngineSource(engine, activePath);
  const showMarkdownToolbar = !zen && toolbarProfile === "markdown";
  const showTypstToolbar = !zen && toolbarProfile === "typst";

  const wysiwyg = useVisualModeStore((s) => s.enabled);
  const markdownSplitEnabled = useVisualModeStore((s) => s.markdownSplit);
  const markdownSplitLayout = useVisualModeStore((s) => s.markdownSplitLayout);
  const loadVisualMode = useVisualModeStore((s) => s.loadProject);
  useEffect(() => {
    loadVisualMode(projectId);
  }, [projectId, loadVisualMode]);
  const setWysiwyg = useCallback((next: boolean) => {
    useVisualModeStore.getState().setEnabled(next);
  }, []);
  const toggleWysiwyg = () => setWysiwyg(!wysiwyg);
  const markdownSplit = isMarkdownFile && markdownSplitEnabled;
  const stackMarkdownSplit = markdownSplitLayout === "stacked";
  const markdownSourceSize = getMarkdownSplitSize(projectId);
  const saveMarkdownSplitSize = useCallback((layout: Layout) => {
    const sourceSize = layout[MARKDOWN_SOURCE_PANEL];
    if (projectId && sourceSize !== undefined && layout[MARKDOWN_PREVIEW_PANEL] !== undefined) {
      setMarkdownSplitSize(projectId, sourceSize);
    }
  }, [projectId]);
  const markdownGroupRef = useRef<GroupImperativeHandle>(null);
  const markdownSplitHitArea = useSeparatorHitArea(0.25);
  const onMarkdownSeparatorKeyDown = useSeparatorKeyboard(markdownGroupRef, MARKDOWN_SPLIT_LIMITS);
  const markdownVisual = wysiwyg && isMarkdownFile && !markdownSplit;
  const markdownMode = markdownModeFor(markdownSplit, markdownVisual);
  const showBreadcrumbs =
    !zen &&
    !isDiagramMainFile && /\.(?:tex|latex|ltx|typ)$/iu.test(activePath ?? "");

  useEffect(() => {
    setWysiwygVisibilityController(setWysiwyg);
    return () => setWysiwygVisibilityController(null);
  }, [setWysiwyg]);

  const renderTextArea = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      {managedFile ? (
        <output
          data-testid="managed-file-notice"
          className="border-b px-4 py-2 text-sm text-muted-foreground"
        >
          {t(($) => $.editor.shell.managedFileReadOnly, { file: activePath })}
        </output>
      ) : null}
      {projectId && activePath && <div className="flex shrink-0 gap-2 border-b px-3 py-1">
        <Button size="xs" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (markdownVisual) flushWysiwygPendingEdits();
          const view = markdownVisual ? null : getEditorView();
          const text = view?.state.doc.toString() ?? useFilesStore.getState().files[activePath]?.content ?? "";
          const range = view?.state.selection.main;
          void createMaterialDocument({ projectId, documentId: `file:${activePath}`, path: activePath, title: basename(activePath), kind: isMarkdownFile ? "markdown" : "source" }, { text, mediaType: "text/plain" }).then((document) => openMaterialAnnotations(document, range && !range.empty ? { kind: "text", from: range.from, to: range.to, quote: text.slice(range.from, range.to) } : undefined));
        }}>{t(($) => $.editor.materials.sourceSelection)}</Button>
      </div>}
      <ChangedOnDiskBanner />
      {linkedFile && !managedFile ? (
        <output
          data-testid="linked-file-notice"
          className="border-b px-4 py-2 text-sm text-muted-foreground"
        >
          {t(($) => $.editor.shell.linkedFileReadOnly, { file: activePath })}
        </output>
      ) : null}
      {showBreadcrumbs ? <Breadcrumbs visual={wysiwyg} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
      {isMarkdownFile ? (
        <div
          aria-hidden={!markdownVisual}
          inert={!markdownVisual ? true : undefined}
          className={cn(
            "absolute inset-0",
            !markdownVisual && "invisible pointer-events-none select-none",
          )}
        >
          <Suspense
            fallback={
              <LoadingState
                className="h-full justify-center"
                label={t(($) => $.common.state.loading)}
              />
            }
          >
            <WysiwygEditor wysiwyg={markdownVisual} />
          </Suspense>
        </div>
      ) : null}
      <div
        aria-hidden={markdownVisual}
        inert={markdownVisual ? true : undefined}
        className={cn(
          "absolute inset-0",
          markdownVisual && "invisible pointer-events-none select-none",
        )}
      >
        <Group
          orientation={stackMarkdownSplit ? "vertical" : "horizontal"}
          groupRef={markdownGroupRef}
          onLayoutChanged={saveMarkdownSplitSize}
          resizeTargetMinimumSize={markdownSplitHitArea}
        >
          <Panel
            id={MARKDOWN_SOURCE_PANEL}
            defaultSize={percent(markdownSourceSize)}
            {...panelLimitProps(MARKDOWN_PANE_LIMITS)}
            style={PANEL_STYLE}
          >
            <EditorContextMenu>
              <CodeMirrorEditor active={!markdownVisual} />
            </EditorContextMenu>
            <SelectionActionMenu />
          </Panel>
          {markdownSplit && <>
            <Separator
              id="markdown-split-resize"
              disableDoubleClick
              aria-label={`${t(($) => $.editor.toolbar.code)} / ${t(($) => $.editor.preview.markdown)}`}
              onKeyDownCapture={onMarkdownSeparatorKeyDown}
              className={cn("shrink-0 select-none bg-border/60 transition-colors hover:bg-primary/30 focus-visible:bg-primary/30",
                stackMarkdownSplit ? "h-1" : "w-1")}
            />
            <Panel
              id={MARKDOWN_PREVIEW_PANEL}
              defaultSize={percent(100 - markdownSourceSize)}
              {...panelLimitProps(MARKDOWN_PANE_LIMITS)}
              style={PANEL_STYLE}
            >
              <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">{t(($) => $.common.state.loading)}</div>}>
                <MarkdownPreview key={`${projectId}:${activePath}`} />
              </Suspense>
            </Panel>
          </>}
        </Group>
      </div>
      </div>
    </div>
  );

  const renderFileArea = () => {
    if (isDiagramMainFile && wysiwyg && projectId && activePath) {
      return (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <LoadingState
                className="h-full justify-center"
                label={t(($) => $.common.state.loading)}
              />
            }
          >
            <DiagramMainFileView projectId={projectId} path={activePath} />
          </Suspense>
        </div>
      );
    }
    if (isDiagramMainFile) {
      const body = (
        <div className="min-h-0 flex-1 overflow-hidden">
          <EditorContextMenu>
            <CodeMirrorEditor />
          </EditorContextMenu>
          <SelectionActionMenu />
        </div>
      );
      return projectId && activePath ? <ProjectSourceContext projectId={projectId} path={activePath} kind="source">{body}</ProjectSourceContext> : body;
    }
    if (isWordFile && projectId && activePath) {
      return <Suspense fallback={<LoadingState className="h-full justify-center" label={t(($) => $.common.state.loading)} />}>
        <DocxFileView key={`${projectId}:${activePath}`} projectId={projectId} path={activePath} />
      </Suspense>;
    }
    if (activePath && /\.html?$/iu.test(activePath) && projectId) {
      return <div className="min-h-0 flex-1"><Suspense fallback={null}><HtmlOutputPanel key={`${projectId}:${activePath}`} projectId={projectId} path={activePath} builtAt={null} /></Suspense></div>;
    }
    if (isPdfFile && projectId && activePath) {
      return (
        <div className="min-h-0 flex-1 overflow-auto bg-sidebar">
          <PdfFileView key={`${projectId}:${activePath}`} projectId={projectId} path={activePath} />
        </div>
      );
    }
    if (isImageFile && projectId && activePath) {
      return (
        <div className="min-h-0 flex-1 overflow-auto bg-sidebar">
          <ImageFileView key={`${projectId}:${activePath}`} projectId={projectId} path={activePath} />
        </div>
      );
    }
    if (isOpaqueFile && activePath) {
      return (
        <div
          data-testid="binary-file-notice"
          className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground"
        >
          <FileText className="mb-3 size-10 opacity-30" />
          <p className="text-sm">{basename(activePath)}</p>
          <p className="text-xs">{t(($) => $.editor.shell.binaryFile)}</p>
        </div>
      );
    }
    const body = renderTextArea();
    return projectId && activePath ? <ProjectSourceContext projectId={projectId} path={activePath} kind={isMarkdownFile ? "markdown" : "source"}>{body}</ProjectSourceContext> : body;
  };

  const renderBody = () => {
    if (diffFocused) {
      return (
        <ErrorBoundary
          fallback={
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {t(($) => $.editor.shell.diffCrashed)}
            </div>
          }
        >
          <DiffView />
        </ErrorBoundary>
      );
    }
    if (!hasOpenFile) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground">
          <FileText className="mb-3 size-10 opacity-30" />
          <p className="text-sm">{t(($) => $.editor.shell.noFileOpen)}</p>
          <p className="text-xs">{t(($) => $.editor.shell.noFileOpenHint)}</p>
        </div>
      );
    }
    return (
      <>
        {showLatexToolbar && (
          <div className="shrink-0">
            <EditorToolbar wysiwyg={wysiwyg} onToggleWysiwyg={toggleWysiwyg} />
          </div>
        )}
        {showMarkdownToolbar && (
          <div className="shrink-0">
            <MarkdownToolbar
              wysiwyg={markdownVisual}
              onToggleWysiwyg={isMarkdownFile ? toggleWysiwyg : undefined}
              mode={isMarkdownFile ? markdownMode : undefined}
              splitLayout={markdownSplitLayout}
              onModeChange={isMarkdownFile ? (mode, layout) => {
                if (markdownVisual) flushWysiwygPendingEdits();
                const visualMode = useVisualModeStore.getState();
                if (layout) visualMode.setMarkdownSplitLayout(layout);
                visualMode.setMarkdownSplit(mode === "both");
                if (mode !== "both") setWysiwyg(mode === "visual");
              } : undefined}
              showProjectInfo={markdownIsEngineSource}
            />
          </div>
        )}
        {showTypstToolbar && (
          <div className="shrink-0">
            <TypstToolbar
              wysiwyg={wysiwyg}
              onToggleWysiwyg={/\.typ$/iu.test(activePath ?? "") ? toggleWysiwyg : undefined}
            />
          </div>
        )}
        {renderFileArea()}
      </>
    );
  };

  return (
    <div
      ref={interactionRoot}
      data-tour="project-editor"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    >
      {!zen && showTabBar && <EditorTabBar diffFocused={diffFocused} />}
      <CollabRemovedFileSlot />
      {!diffFocused ? (
        <ProofreadingNotifications
          path={activePath}
          surface={markdownVisual ? "visual" : "source"}
        />
      ) : null}
      {renderBody()}
    </div>
  );
}

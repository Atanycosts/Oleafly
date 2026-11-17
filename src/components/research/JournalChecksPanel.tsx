import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpenCheck, FileUp, PanelRightOpen, Play, RefreshCw, Sparkles } from "lucide-react";
import { SidebarPanelHeader } from "@/components/layout/SidebarSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ensureAiProviderOrOpenSettings, handoffToAssistant } from "@/features/assistant-handoff";
import { useFilesStore } from "@/store/files";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore, type RailTab } from "@/store/settings";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { getResearchWorkspace } from "@/lib/research-workspace";
import { pickOpenPaths } from "@/lib/tauri";
import type { AnnotationTarget } from "@/lib/task-collaboration";
import {
  capturedJournalFile,
  formatJournalValue as formatGeometry,
  connectJournalWorkbench,
  journalAnalysisPrompt,
  journalCoverageMessage,
  journalMessage,
  journalQuery,
  journalRequest,
  journalInputValue,
  parseJournalInput,
  linkJournalProject,
  loadJournalTarget,
  type JournalAnnotationObject,
  type JournalCheck,
  type JournalConnection,
  type JournalDiff,
  type JournalFinding,
  type JournalFragment,
  type JournalProject,
  type JournalReview,
  type JournalRule,
  type JournalState,
  type JournalWorld,
  type ManuscriptRead,
} from "@/lib/journal-workbench";
import { checkJournalTemplate, importJournalTemplate, startTemplateWorkingCopy } from "@/lib/docx-template-client";
import { JournalAnnotations } from "./JournalAnnotations";
import { JournalTemplatePanel } from "./JournalTemplatePanel";
import { JournalObjectView } from "./JournalObjectView";

const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs";
const panelClass = "space-y-3 rounded-lg border border-sidebar-border p-3";
const fileStem = (file: File) => file.name.replace(/\.[^.]+$/, "").trim() || file.name;
const generatedJournalId = () => `journal-${crypto.randomUUID()}`;
const noopSaved = async () => {};

export function JournalChecksPanel() {
  const projectId = useFilesStore((state) => state.projectId);
  const journalBusy = useWorkspaceSurfaceStore((state) => state.journalBusy);
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  const targetRef = useRef<HTMLDivElement>(null);
  const openJournal = useCallback(() => useWorkspaceSurfaceStore.getState().openJournal(), []);
  const setJournalSidebarTarget = useCallback(
    (target: HTMLElement | null) => useWorkspaceSurfaceStore.getState().setJournalSidebarTarget(target),
    [],
  );

  useEffect(() => {
    setJournalSidebarTarget(targetRef.current);
    openJournal();
    return () => setJournalSidebarTarget(null);
  }, [openJournal, setJournalSidebarTarget]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarPanelHeader icon={BookOpenCheck} title={text.title}>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={text.title}
          onClick={openJournal}
        >
          <PanelRightOpen className="size-3.5" />
        </Button>
      </SidebarPanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="journal-sidebar-content">
        <div ref={targetRef} data-testid="journal-checks-panel" aria-busy={journalBusy} />
        {!projectId && <p className="text-sm text-muted-foreground">{text.openProject}</p>}
      </div>
    </div>
  );
}

export function JournalWorkspaceHost() {
  const projectId = useFilesStore((state) => state.projectId);
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  return (
    <section className="h-full min-h-0 min-w-0 bg-background" data-testid="journal-workspace">
      {projectId ? (
        <JournalProjectPanel key={projectId} projectId={projectId} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          {text.openProject}
        </div>
      )}
    </section>
  );
}

function JournalProjectPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation("researchTools");
  const journalSidebarTarget = useWorkspaceSurfaceStore((state) => state.journalSidebarTarget);
  const openDocxRequest = useDocxWorkspaceStore((state) => state.request);
  const openDocxAppProjectId = useDocxWorkspaceStore((state) => state.request?.appProjectId ?? null);
  const openDocxProjectId = useDocxWorkspaceStore(
    (state) => state.request?.project.project_id ?? null,
  );
  const openDocxWorldVersionId = useDocxWorkspaceStore(
    (state) => state.request?.world?.version_id ?? null,
  );
  const openDocxContextWorldVersionId = useDocxWorkspaceStore(
    (state) => state.context?.world?.version_id ?? null,
  );
  const savedVersion = useDocxWorkspaceStore((state) => state.savedVersion);
  const setJournalBusy = useWorkspaceSurfaceStore((state) => state.setJournalBusy);
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  const detailId = useId();
  const [connection, setConnection] = useState<JournalConnection | null>(null);
  const [python, setPython] = useState("");
  const [snapshot, setSnapshot] = useState<JournalState>({
    projects: [],
    worlds: [],
  });
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const [world, setWorld] = useState<JournalWorld | null>(null);
  const [check, setCheck] = useState<JournalCheck | null>(null);
  const [history, setHistory] = useState<JournalCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"manuscript" | "update" | "world" | "template" | null>(null);
  const [rule, setRule] = useState<JournalRule | null>(null);
  const [review, setReview] = useState<JournalReview | null>(null);
  const [manuscriptRead, setManuscriptRead] = useState<ManuscriptRead | null>(null);
  const [sourcePage, setSourcePage] = useState<{
    png_base64: string;
    width_pt: number;
    height_pt: number;
  } | null>(null);
  const [selectedFragment, setSelectedFragment] = useState<JournalFragment | null>(null);
  const [sourceLibraryOpen, setSourceLibraryOpen] = useState(false);
  const [revisionValue, setRevisionValue] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [dispositionAction, setDispositionAction] = useState<"note" | "defer">("note");
  const [dispositionNote, setDispositionNote] = useState("");
  const [comparison, setComparison] = useState<{ from: string; diff: JournalDiff } | null>(null);
  const [notice, setNotice] = useState<"researchChecked" | "researchAdopted" | "versionCreated" | null>(null);
  const [referencedObject, setReferencedObject] = useState<JournalAnnotationObject | null>(null);
  const templateStart = useRef<{ worldId: string; requestId: string } | null>(null);
  const handledSavedVersion = useRef(savedVersion);
  const handledContextWorld = useRef<string | null>(openDocxContextWorldVersionId);
  const linkedIdRef = useRef<string | null>(linkedId);
  const worldVersionRef = useRef<string | null>(world?.version_id ?? null);
  const fileTreeSync = useRef<string | null>(null);
  const pendingWorldSelection = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const templateRuleLabel = (item: JournalRule) => {
    if (item.property !== "object_format" || !item.expected || typeof item.expected !== "object") {
      return text.properties[item.property as keyof typeof text.properties] ?? text.template.snapshot;
    }
    if (item.expected.kind === "section") return text.template.snapshot;
    return text.template.roles[item.expected.role as keyof typeof text.template.roles] ?? text.template.snapshot;
  };
  const project = snapshot.projects.find((item) => item.project_id === linkedId) ?? null;
  const visibleCheck = check?.world_version_id === world?.version_id ? check : null;
  const bindingCurrent = project?.binding?.baseline_id === project?.baseline_id;
  const annotationReference = (kind: "rule" | "source" | "check" | "world", objectId: string) => ({
    libraryRoot: connection?.libraryRoot ?? "",
    workbenchProjectId: linkedId ?? "",
    kind,
    objectId,
    worldVersionId: world?.version_id ?? "",
    checkId: visibleCheck?.check_id ?? null,
  });
  const openAnnotationTarget = (target: AnnotationTarget) => {
    void perform(async (sequence) => {
      const object = await loadJournalTarget(target);
      if (sequence === loadSequence.current) setReferencedObject(object);
    });
  };

  const beginRequest = useCallback(() => {
    const sequence = ++loadSequence.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    return sequence;
  }, []);

  const finishRequest = useCallback((sequence: number) => {
    if (sequence === loadSequence.current) setBusy(false);
  }, []);

  async function perform(operation: (sequence: number) => Promise<void>) {
    const sequence = beginRequest();
    try {
      await operation(sequence);
    } catch (cause) {
      if (sequence === loadSequence.current) {
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      finishRequest(sequence);
    }
  }

  const load = useCallback(async (
    selectedId: string | null,
    versionId: string | undefined,
    sequence: number,
  ) => {
    const next = await journalRequest<JournalState>("/api/state");
    if (sequence !== loadSequence.current) return;
    const selected = next.projects.find((item) => item.project_id === selectedId);
    const worldId = versionId
      ?? selected?.binding?.world_version_id
      ?? (selected ? worldVersionRef.current : null);
    const [nextWorld, records] = await Promise.all([
      worldId ? journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: worldId })) : null,
      selected
        ? journalRequest<{ checks: JournalCheck[] }>(journalQuery("/api/history", { project_id: selected.project_id }))
        : null,
    ]);
    if (sequence !== loadSequence.current) return;
    setSnapshot(next);
    setLinkedId(selectedId);
    setWorld(nextWorld);
    setCheck(selected?.latest_check ?? null);
    setHistory(records?.checks ?? []);
    setReview(null);
    setRule(null);
    setManuscriptRead(null);
    setSourceLibraryOpen(false);
    setComparison(null);
  }, []);

  useEffect(() => {
    let active = true;
    const sequence = beginRequest();
    void Promise.all([connectJournalWorkbench(), getResearchWorkspace(projectId)])
      .then(async ([connected, workspace]) => {
        if (!active) return;
        setConnection(connected);
        setPython(connected.python);
        const opened = useDocxWorkspaceStore.getState().request;
        const openedHere = opened?.appProjectId === projectId ? opened : null;
        const initialProjectId = openedHere?.project.project_id ?? workspace.journalProjectId ?? null;
        const initialWorldId = openedHere?.world?.version_id;
        if (openedHere) {
          fileTreeSync.current = `${projectId}:${initialProjectId}:${initialWorldId ?? ""}`;
        }
        await load(initialProjectId, initialWorldId, sequence);
      })
      .catch((cause) => {
        if (active && sequence === loadSequence.current) setError(String(cause));
      })
      .finally(() => {
        if (active) finishRequest(sequence);
      });
    return () => {
      active = false;
    };
  }, [beginRequest, finishRequest, projectId, load]);

  useEffect(() => {
    linkedIdRef.current = linkedId;
  }, [linkedId]);

  useEffect(() => {
    setJournalBusy(busy);
  }, [busy, setJournalBusy]);

  useEffect(() => () => setJournalBusy(false), [setJournalBusy]);

  useEffect(() => {
    worldVersionRef.current = world?.version_id ?? null;
  }, [world?.version_id]);

  useEffect(() => {
    if (!openDocxProjectId) {
      fileTreeSync.current = null;
      handledContextWorld.current = null;
      return;
    }
    if (!connection || openDocxAppProjectId !== projectId) {
      return;
    }
    pendingWorldSelection.current = null;
    const signature = `${projectId}:${openDocxProjectId}:${openDocxWorldVersionId ?? ""}`;
    if (fileTreeSync.current === signature) return;
    fileTreeSync.current = signature;
    if (openDocxWorldVersionId) handledContextWorld.current = openDocxWorldVersionId;
    if (
      linkedIdRef.current === openDocxProjectId &&
      (!openDocxWorldVersionId || worldVersionRef.current === openDocxWorldVersionId)
    ) {
      return;
    }
    let active = true;
    const sequence = beginRequest();
    void load(openDocxProjectId, openDocxWorldVersionId ?? undefined, sequence)
      .catch((cause) => {
        if (active && sequence === loadSequence.current) setError(String(cause));
      })
      .finally(() => {
        if (active) finishRequest(sequence);
      });
    return () => {
      active = false;
    };
  }, [
    beginRequest,
    connection,
    finishRequest,
    load,
    openDocxAppProjectId,
    openDocxProjectId,
    openDocxWorldVersionId,
    projectId,
  ]);

  useEffect(() => {
    if (
      !connection ||
      openDocxAppProjectId !== projectId ||
      !openDocxProjectId ||
      !openDocxContextWorldVersionId ||
      handledContextWorld.current === openDocxContextWorldVersionId
    ) {
      return;
    }
    handledContextWorld.current = openDocxContextWorldVersionId;
    if (linkedIdRef.current === openDocxProjectId &&
        worldVersionRef.current === openDocxContextWorldVersionId) {
      return;
    }
    let active = true;
    const sequence = beginRequest();
    void load(openDocxProjectId, openDocxContextWorldVersionId, sequence)
      .catch((cause) => {
        if (active && sequence === loadSequence.current) setError(String(cause));
      })
      .finally(() => {
        if (active) finishRequest(sequence);
      });
    return () => {
      active = false;
    };
  }, [
    beginRequest,
    connection,
    finishRequest,
    load,
    openDocxAppProjectId,
    openDocxContextWorldVersionId,
    openDocxProjectId,
    projectId,
  ]);

  useEffect(() => {
    if (savedVersion === handledSavedVersion.current) return;
    handledSavedVersion.current = savedVersion;
    if (!connection || !linkedId) return;
    const versionId = pendingWorldSelection.current ?? world?.version_id;
    let active = true;
    const sequence = beginRequest();
    void load(linkedId, versionId, sequence)
      .catch((cause) => {
        if (active && sequence === loadSequence.current) setError(String(cause));
      })
      .finally(() => {
        if (active) {
          if (
            sequence === loadSequence.current &&
            pendingWorldSelection.current === versionId
          ) {
            pendingWorldSelection.current = null;
          }
          finishRequest(sequence);
        }
      });
    return () => {
      active = false;
    };
  }, [
    beginRequest,
    connection,
    finishRequest,
    linkedId,
    load,
    savedVersion,
    world?.version_id,
  ]);

  async function chooseWorld(versionId: string, sequence: number) {
    pendingWorldSelection.current = versionId;
    try {
      const next = await journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: versionId }));
      if (sequence !== loadSequence.current) return;
      setWorld(next);
      handledContextWorld.current = next.version_id;
      if (project && openDocxAppProjectId === projectId && openDocxProjectId === project.project_id) {
        const currentContext = useDocxWorkspaceStore.getState().context;
        useDocxWorkspaceStore.getState().updateContext({
          world: next,
          onSaved: currentContext?.onSaved ?? noopSaved,
        });
      }
      setReview(null);
      setRule(null);
      setManuscriptRead(null);
      setComparison(null);
    } finally {
      if (
        sequence === loadSequence.current &&
        pendingWorldSelection.current === versionId
      ) {
        pendingWorldSelection.current = null;
      }
    }
  }

  async function openEvidence(selectedRule: JournalRule | null, sequence: number) {
    if (!world) return;
    const next = await journalRequest<JournalReview>(journalQuery("/api/review", { version_id: world.version_id }));
    if (sequence !== loadSequence.current) return;
    setReview(next);
    setRule(selectedRule);
    setSourceLibraryOpen(selectedRule === null);
    setSourcePage(null);
    setSelectedFragment(null);
    setManuscriptRead(null);
    setRevisionValue(selectedRule ? journalInputValue(selectedRule.expected, selectedRule.unit) : "");
    setRevisionReason("");
    setDispositionAction("note");
    setDispositionNote("");
  }

  async function compareVersions(from: string, to: string, sequence: number) {
    const diff = await journalRequest<JournalDiff>(journalQuery("/api/diff", { from_version: from, to_version: to }));
    if (sequence !== loadSequence.current) return;
    setComparison({ from, diff });
  }

  async function readFinding(finding: JournalFinding) {
    if (!project) return;
    const baselineId = visibleCheck?.baseline_id ?? project.baseline_id;
    const manuscript = await journalRequest<{
      catalog: {
        items: {
          object_id: string;
          object_type: string;
          node_locator: string;
        }[];
      };
    }>(
      journalQuery("/api/manuscript", {
        project_id: project.project_id,
        baseline_id: baselineId,
      }),
    );
    const item = manuscript.catalog.items.find(
      (item) => item.object_type === "section" && item.node_locator === finding.locator,
    );
    if (!item) throw new Error(text.sectionUnavailable);
    setManuscriptRead(
      await journalRequest<ManuscriptRead>("/api/read", {
        project_id: project.project_id,
        baseline_id: baselineId,
        render_bundle_id: null,
        query: {
          region: null,
          object_type: "section",
          object_id: item.object_id,
          page_number: null,
          page_size: 1,
          cursor: null,
        },
      }),
    );
  }

  async function showFragment(fragment: JournalFragment) {
    setSelectedFragment(fragment);
    setSourcePage(null);
    if (fragment.content.page && world && ["pdf_block", "pdf_heading"].includes(fragment.kind)) {
      setSourcePage(
        await journalRequest(
          journalQuery("/api/source-page", {
            version_id: world.version_id,
            source_id: fragment.source_id,
            page: String(fragment.content.page),
          }),
        ),
      );
    }
  }

  const result = visibleCheck?.rule_results.find((item) => item.rule_id === rule?.rule_id);
  const evidenceIds = new Set(
    review?.rule_links.filter((link) => link.rule_id === rule?.rule_id).flatMap((link) => link.fragment_ids),
  );
  const linkedFragments = review?.fragments.filter((fragment) => evidenceIds.has(fragment.fragment_id)) ?? [];
  const fragmentParents = new Set(linkedFragments.map((fragment) => fragment.parent_fragment_id));
  const contextFragments = review?.fragments.filter((fragment) => fragmentParents.has(fragment.fragment_id)) ?? [];
  const latestWorld =
    world &&
    snapshot.worlds
      .filter((item) => item.journal_id === world.journal_id)
      .sort((a, b) => b.version_ordinal - a.version_ordinal)[0];
  const otherVersions = snapshot.worlds
    .filter((item) => item.journal_id === world?.journal_id && item.version_id !== world?.version_id)
    .sort((a, b) => b.version_ordinal - a.version_ordinal);

  const navigation = journalSidebarTarget ? createPortal(
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{text.scope}</p>
      {notice && (
        <p role="status" className="rounded-md bg-muted p-2 text-xs">
          {text[notice]}
        </p>
      )}
      {!connection ? (
        <section className={panelClass}>
          <p className="text-sm font-medium">{text.workspace.connectTitle}</p>
          <p className="text-xs text-muted-foreground">{text.workspace.connectHelp}</p>
          <Button size="sm" onClick={() => useWorkspaceSurfaceStore.getState().openJournal()}>
            {text.workspace.openWorkspace}
          </Button>
        </section>
      ) : (
        <>
          <section className={panelClass}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{text.steps.manuscript}</p>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={busy}
                aria-label={text.refresh}
                onClick={() => void perform((sequence) => load(linkedId, world?.version_id, sequence))}
              >
                <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
              </Button>
            </div>
            <label className="block space-y-1 text-xs font-medium">
              <span>{text.manuscript}</span>
              <select
                className={selectClass}
                value={linkedId ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id) {
                    void perform(async (sequence) => {
                      await linkJournalProject(projectId, id);
                      await load(id, undefined, sequence);
                    });
                  }
                }}
              >
                <option value="">{text.chooseManuscript}</option>
                {snapshot.projects.map((item) => (
                  <option key={item.project_id} value={item.project_id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setForm("manuscript");
                }}
              >
                <FileUp className="mr-1 size-3.5" />
                {text.importManuscript}
              </Button>
              {project && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (openDocxRequest) {
                      if (openDocxProjectId === project.project_id) {
                        useDocxWorkspaceStore.getState().restore();
                      }
                      return;
                    }
                    void perform(async () => {
                      const [current, workspace] = await Promise.all([
                        journalRequest<JournalState>("/api/state"),
                        getResearchWorkspace(projectId),
                      ]);
                      const manuscript = current.projects.find((item) => item.project_id === project.project_id);
                      if (!manuscript) throw new Error(t(($) => $.researchTools.docx.recovery.projectMissing));
                      setSnapshot(current);
                      useDocxWorkspaceStore.getState().open({
                        appProjectId: projectId,
                        project: manuscript,
                        world,
                        sourcePath: workspace.wordDocuments?.find(
                          (item) => item.workbenchProjectId === manuscript.project_id,
                        )?.path,
                        onSaved: noopSaved,
                      });
                    });
                  }}
                >
                  {openDocxRequest
                    ? openDocxProjectId === project.project_id
                      ? text.returnToWorkingCopy
                      : text.returnToOtherWorkingCopy.replace("{{name}}", openDocxRequest.project.name)
                    : t(($) => $.researchTools.docx.open)}
                </Button>
              )}
              {project && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setForm("update");
                  }}
                >
                  {text.updateManuscript}
                </Button>
              )}
            </div>
            {openDocxRequest && openDocxProjectId !== project?.project_id && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {text.otherWorkingCopy.replace("{{name}}", openDocxRequest.project.name)}
              </p>
            )}
          </section>
          <section className={panelClass}>
            <p className="text-sm font-semibold">{text.steps.template}</p>
            <label className="block space-y-1 text-xs font-medium">
              <span>{text.journalVersion}</span>
              <select
                className={selectClass}
                data-testid="journal-world-select"
                value={world?.version_id ?? ""}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value) {
                    void perform((sequence) => chooseWorld(event.target.value, sequence));
                  }
                }}
              >
                <option value="">
                  {snapshot.worlds.length ? text.chooseJournalVersion : text.chooseJournal}
                </option>
                {snapshot.worlds.map((item) => (
                  <option key={item.version_id} value={item.version_id}>
                    {`${item.journal_name} · v${item.version_ordinal}`}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              setError(null);
              setForm("template");
            }}>
              <FileUp className="mr-1 size-3.5" />{text.importTemplate}
            </Button>
            {world?.template && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!openDocxRequest}
                data-testid="journal-start-template"
                onClick={() => void perform(async (sequence) => {
                  if (templateStart.current?.worldId !== world.version_id) {
                    templateStart.current = { worldId: world.version_id, requestId: `template-copy-${crypto.randomUUID()}` };
                  }
                  const created = await startTemplateWorkingCopy(
                    world.version_id,
                    `${world.journal_name} · ${text.templateDraft}`,
                    templateStart.current.requestId,
                  );
                  await linkJournalProject(projectId, created.project.project_id);
                  await load(created.project.project_id, world.version_id, sequence);
                  useDocxWorkspaceStore.getState().open({
                    appProjectId: projectId,
                    project: created.project,
                    world,
                    onSaved: noopSaved,
                  });
                  templateStart.current = null;
                })}
              >
                {text.startTemplate}
              </Button>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {world
                ? `${world.journal_name} · v${world.version_ordinal}`
                : text.workspace.noJournal}
            </p>
          </section>
          <section className={panelClass}>
            <p className="text-sm font-semibold">{text.steps.check}</p>
            <Button
              size="sm"
              disabled={
                busy || !project || !world ||
                (!world.template && (!project.binding || !bindingCurrent || project.binding.world_version_id !== world.version_id))
              }
              onClick={() =>
                void perform(async (sequence) => {
                  if (project && world?.template) await checkJournalTemplate(project, world.version_id);
                  else await journalRequest<JournalCheck>("/api/check", { project_id: project?.project_id });
                  await load(linkedId, world?.version_id, sequence);
                  useWorkspaceSurfaceStore.getState().openJournal();
                })
              }
            >
              <Play className="mr-1 size-3.5" />
              {text.runCheck}
            </Button>
            <p className="text-xs text-muted-foreground">
              {visibleCheck
                ? `${visibleCheck.validity === "CURRENT" ? text.current : text.stale} · ${
                    Object.values(visibleCheck.summary).reduce((total, count) => total + count, 0)
                  }`
                : text.workspace.notChecked}
            </p>
          </section>
        </>
      )}
    </div>,
    journalSidebarTarget,
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={busy}>
      {navigation}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!connection ? (
          <div className="mx-auto max-w-3xl space-y-5 p-6">
            <div>
              <h2 className="text-xl font-semibold">{text.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{text.scope}</p>
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <section className="space-y-3 rounded-xl border p-5">
              <p className="font-medium">{text.connect}</p>
              <p className="text-sm text-muted-foreground">{text.runtimeHelp}</p>
              <Input
                value={python}
                onChange={(event) => setPython(event.target.value)}
                aria-label={text.python}
                placeholder={text.python}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const paths = await pickOpenPaths({ title: text.python });
                      if (paths?.[0]) setPython(paths[0]);
                    })
                  }
                >
                  {text.browse}
                </Button>
                <Button
                  disabled={busy || !python.trim()}
                  onClick={() =>
                    void perform(async (sequence) => {
                      const connected = await connectJournalWorkbench(python.trim());
                      setConnection(connected);
                      const workspace = await getResearchWorkspace(projectId);
                      await load(workspace.journalProjectId ?? null, undefined, sequence);
                    })
                  }
                >
                  {text.connect}
                </Button>
              </div>
            </section>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-6 p-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {text.workspace.eyebrow}
                </p>
                <h2 className="mt-1 text-2xl font-semibold">
                  {world ? world.journal_name : text.title}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {project ? project.name : text.scope}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !visibleCheck}
                onClick={() =>
                  void perform(async () => {
                    if (!visibleCheck || !(await ensureAiProviderOrOpenSettings())) return;
                    const source = await journalRequest<JournalReview>(
                      journalQuery("/api/review", { version_id: visibleCheck.world_version_id }),
                    );
                    handoffToAssistant(
                      journalAnalysisPrompt(visibleCheck, source, i18n.resolvedLanguage ?? i18n.language),
                      { autoSend: false },
                    );
                  })
                }
              >
                <Sparkles className="size-4" />
                {text.askAgent}
              </Button>
            </header>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="rounded-md bg-muted p-3 text-sm">
                {text[notice]}
              </p>
            )}
            {!journalSidebarTarget && (
              <section className="rounded-xl border bg-muted/30 p-4">
                <p className="font-medium">{text.workspace.sidebarMissing}</p>
                <p className="mt-1 text-sm text-muted-foreground">{text.workspace.sidebarMissingHelp}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  onClick={() => {
                    useSettingsStore.getState().setRailTab("journal" as RailTab);
                    useSettingsStore.getState().setShowTree(true);
                    useWorkspaceSurfaceStore.getState().openJournal();
                  }}
                >
                  {text.workspace.openWorkspace}
                </Button>
              </section>
            )}
            {!project || !world ? (
              <>
                <section className="rounded-xl border border-dashed p-8 text-center">
                  <h3 className="font-semibold">{text.workspace.startTitle}</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
                    {text.guide.title} {text.guide.manuscriptHelp} {text.guide.templateHelp}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      setError(null);
                      setForm("manuscript");
                    }}>
                      {text.importManuscript}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      setError(null);
                      setForm("template");
                    }}>
                      {text.importTemplate}
                    </Button>
                  </div>
                </section>
                {world && <JournalTemplateSummary world={world} project={project} check={visibleCheck} />}
              </>
            ) : (
              <>
                {visibleCheck ? (
                  <section className="space-y-4 rounded-xl border p-5" aria-label={text.results}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold">{text.results}</h3>
                      <span className={
                        visibleCheck.validity === "STALE"
                          ? "text-sm font-medium text-amber-600 dark:text-amber-400"
                          : "text-sm font-medium text-emerald-600 dark:text-emerald-400"
                      }>
                        {visibleCheck.validity === "STALE" ? text.stale : text.current}
                      </span>
                    </div>
                    <time className="text-sm text-muted-foreground">
                      {new Date(visibleCheck.created_at).toLocaleString()}
                    </time>
                    {visibleCheck.validity === "STALE" && (
                      <p className="text-sm text-muted-foreground">{text.staleHelp}</p>
                    )}
                    <div className="grid gap-2 sm:grid-cols-3">
                      {Object.entries(visibleCheck.summary)
                        .filter(([, count]) => count > 0)
                        .map(([verdict, count]) => (
                          <div key={verdict} className="rounded-lg bg-muted/60 p-3">
                            <p className="text-xs text-muted-foreground">
                              {text.verdicts[verdict as keyof typeof text.verdicts]}
                            </p>
                            <p className="mt-1 text-xl font-semibold">{count}</p>
                          </div>
                        ))}
                    </div>
                    <JournalAnnotations
                      projectId={projectId}
                      reference={annotationReference("check", visibleCheck.check_id)}
                      onOpenTarget={openAnnotationTarget}
                    />
                  </section>
                ) : (
                  <section className="rounded-xl border border-dashed p-8 text-center">
                    <h3 className="font-semibold">{text.steps.check}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{text.workspace.readyToCheck}</p>
                  </section>
                )}
                <JournalTemplateSummary world={world} project={project} check={visibleCheck} />
                <section className="space-y-3" aria-label={text.rules}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">
                      {text.rules} · {world.rules.length}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                        setError(null);
                        setForm("world");
                      }}>
                        {text.importJournal}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform((sequence) => openEvidence(null, sequence))}>
                        {text.sourceLibrary}
                      </Button>
                      {otherVersions.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void perform((sequence) => compareVersions(otherVersions[0].version_id, world.version_id, sequence))}
                        >
                          {text.compareVersions}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || bindingCurrent && project.binding?.world_version_id === world.version_id}
                        onClick={() =>
                          void perform(async (sequence) => {
                            await journalRequest("/api/bind", {
                              project_id: project.project_id,
                              world_version_id: world.version_id,
                              expected_binding_id: project.binding?.binding_id ?? null,
                            });
                            await load(linkedId, world.version_id, sequence);
                          })
                        }
                      >
                        {bindingCurrent && project.binding?.world_version_id === world.version_id
                          ? text.bound
                          : text.bind}
                      </Button>
                    </div>
                  </div>
                  {latestWorld && latestWorld.version_ordinal > world.version_ordinal && (
                    <p className="text-sm text-amber-600 dark:text-amber-400">{text.newVersion}</p>
                  )}
                  {project.binding && (!bindingCurrent || project.binding.world_version_id !== world.version_id) && (
                    <p className="text-sm text-muted-foreground">
                      {!bindingCurrent ? text.rebindAfterUpdate : text.viewingUnboundVersion}
                    </p>
                  )}
                  {world.rules.length === 0 && <p className="text-sm text-muted-foreground">{text.noRules}</p>}
                  <div className="grid gap-2 md:grid-cols-2">
                    {world.rules.map((item) => {
                      const checkedResult = visibleCheck?.rule_results.find(
                        (record) => record.rule_id === item.rule_id,
                      );
                      return (
                        <button
                          key={item.rule_id}
                          type="button"
                          disabled={busy}
                          onClick={() => void perform((sequence) => openEvidence(item, sequence))}
                          className="rounded-lg border p-3 text-left transition-colors hover:bg-accent disabled:opacity-50"
                        >
                          <span className="flex items-start justify-between gap-3">
                            <strong className="text-sm">
                              {templateRuleLabel(item)}
                            </strong>
                            {item.property === "object_format"
                              ? item.expected && typeof item.expected === "object" && item.expected.kind !== "section" && (
                                  <span className="text-sm">{text.template.snapshot}</span>
                                )
                              : <span className="text-sm">{item.label ?? formatGeometry(item.expected, item.unit)}</span>}
                          </span>
                          <span className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                            <span>{text.bases[item.basis_status]}</span>
                            <span className={checkedResult?.verdict === "violation" && visibleCheck?.validity === "CURRENT" ? "text-destructive" : ""}>
                              {checkedResult ? text.verdicts[checkedResult.verdict] : text.verdicts.not_checked}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
                {(visibleCheck?.coverage_gaps ?? world.coverage_gaps).length > 0 && (
                  <section className="space-y-2 rounded-xl border p-5">
                    <h3 className="font-semibold">{text.coverage}</h3>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {(visibleCheck?.coverage_gaps ?? world.coverage_gaps).map((gap) => (
                        <li key={`${gap.code}-${gap.message}`} className="flex gap-2">
                          <span aria-hidden>•</span>
                          <span>{journalCoverageMessage(gap)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {history.length > 0 && (
                  <section className="space-y-3">
                    <h3 className="font-semibold">{text.history}</h3>
                    <div className="space-y-2">
                      {[...history].reverse().map((record) => (
                        <button
                          type="button"
                          key={record.check_id}
                          disabled={busy}
                          className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left text-sm hover:bg-accent"
                          onClick={() =>
                            void perform(async (sequence) => {
                              await chooseWorld(record.world_version_id, sequence);
                              if (sequence !== loadSequence.current) return;
                              setCheck(record);
                            })
                          }
                        >
                          <span>{`${record.world.journal_name} · v${record.world.version_ordinal}`}</span>
                          <span className="text-muted-foreground">
                            {new Date(record.created_at).toLocaleString()} ·{" "}
                            {record.validity === "CURRENT" ? text.current : text.stale}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <JournalImportDialog
        mode={form}
        project={project}
        world={world}
        busy={busy}
        error={error}
        onClose={() => setForm(null)}
        onSubmit={(operation) =>
          void perform(async (sequence) => {
            const imported = await operation();
            if (form === "manuscript") {
              const manuscript = imported as JournalProject;
              await linkJournalProject(projectId, manuscript.project_id);
              await load(manuscript.project_id, world?.version_id, sequence);
            } else if (form === "world" || form === "template") {
              await load(linkedId, (imported as JournalWorld).version_id, sequence);
            } else {
              await load(linkedId, world?.version_id, sequence);
            }
            setForm(null);
          })
        }
      />
      <Dialog
        open={Boolean(rule) || sourceLibraryOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRule(null);
            setSourceLibraryOpen(false);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {rule ? templateRuleLabel(rule) : text.sourceLibrary}
            </DialogTitle>
            <DialogDescription>{`${world?.journal_name} · v${world?.version_ordinal}`}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {rule && world && (
            <>
              <p className="text-sm">
                {text.bases[rule.basis_status]}
                {rule.property !== "object_format" && ` · ${formatGeometry(rule.expected, rule.unit)}`}
                {" · "}
                {result ? text.verdicts[result.verdict] : text.verdicts.not_checked}
              </p>
              {rule.limitations.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary>{text.ruleContext}</summary>
                  <ul className="mt-2 space-y-1">
                    {rule.limitations.map((limitation) => (
                      <li key={limitation}>{journalMessage(limitation)}</li>
                    ))}
                  </ul>
                </details>
              )}
              {connection && linkedId && <details className="rounded-md border p-3 text-sm">
                <summary>{text.annotations.title}</summary>
                <div className="mt-3"><JournalAnnotations projectId={projectId} reference={annotationReference("rule", rule.rule_id)} onOpenTarget={openAnnotationTarget} /></div>
              </details>}
              {visibleCheck?.validity === "STALE" && (
                <p className="text-sm text-amber-600 dark:text-amber-400">{text.staleHelp}</p>
              )}
              <h3 className="text-sm font-semibold">{text.guideEvidence}</h3>
              {rule.evidence.map((evidence) => (
                <div className="rounded-md border p-3 text-sm" key={`${evidence.source_id}-${evidence.locator}`}>
                  <p className="font-medium">
                    {world?.sources.find((source) => source.source_id === evidence.source_id)?.name}
                  </p>
                  <blockquote className="mt-1 whitespace-pre-wrap border-l-2 pl-3">{evidence.quote}</blockquote>
                </div>
              ))}
              {contextFragments.length > 0 && (
                <details className="text-sm">
                  <summary>{text.context}</summary>
                  {contextFragments.map((fragment) => (
                    <p key={fragment.fragment_id} className="mt-2 whitespace-pre-wrap">
                      {fragment.text}
                    </p>
                  ))}
                </details>
              )}
              {linkedFragments.map((fragment) => (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  key={fragment.fragment_id}
                  onClick={() => void perform(() => showFragment(fragment))}
                >
                  {text.openFragment} · {text.fragmentKinds[fragment.kind as keyof typeof text.fragmentKinds] ?? fragment.kind}
                </Button>
              ))}
              {rule.resolution && (
                <section className="rounded-md bg-muted p-3 text-sm">
                  <h3 className="font-semibold">{text.operatorDecision}</h3>
                  <p>{rule.resolution.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {text.previousValue}: {formatGeometry(rule.resolution.previous_expected, rule.unit)} ·{" "}
                    {text.bases[rule.resolution.previous_basis_status]}
                  </p>
                </section>
              )}
              {rule.unit !== "effective_format" && <details className="rounded-md border p-3 text-sm">
                <summary>{text.reviseRequirement}</summary>
                <p className="my-2 text-xs text-muted-foreground">{text.reviseHelp}</p>
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async (sequence) => {
                      const expected = parseJournalInput(revisionValue, rule.unit);
                      const revised = await journalRequest<JournalWorld>("/api/revise", {
                        version_id: world.version_id,
                        rule_id: rule.rule_id,
                        expected,
                        reason: revisionReason,
                      });
                      await load(linkedId, revised.version_id, sequence);
                      setNotice("versionCreated");
                    });
                  }}
                >
                  <label htmlFor={`${detailId}-expected`} className="block space-y-1">
                    <span>
                      {text.expected}{rule.unit === "font_family" ? "" : ` (${rule.unit === "count" ? text.unitCount : rule.unit === "twips" ? "mm" : "pt"})`}
                    </span>
                    <Input
                      id={`${detailId}-expected`}
                      type={rule.unit === "font_family" ? "text" : "number"}
                      required
                      min={rule.unit === "font_family" ? undefined : rule.property.includes("margin") ? 0 : rule.unit === "count" ? 1 : 0.01}
                      step={rule.unit === "font_family" ? undefined : rule.unit === "count" ? 1 : "any"}
                      value={revisionValue}
                      disabled={busy}
                      onChange={(event) => setRevisionValue(event.target.value)}
                    />
                  </label>
                  <label htmlFor={`${detailId}-reason`} className="block space-y-1">
                    <span>{text.decisionReason}</span>
                    <Textarea
                      id={`${detailId}-reason`}
                      required
                      value={revisionReason}
                      disabled={busy}
                      onChange={(event) => setRevisionReason(event.target.value)}
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={busy || !revisionReason.trim()}>
                    {text.saveRevision}
                  </Button>
                </form>
              </details>}
              {result && visibleCheck && (
                <>
                  <h3 className="text-sm font-semibold">{text.manuscriptEvidence}</h3>
                  {result.findings.map((finding) => (
                    <div className="space-y-2 rounded-md border p-3 text-sm" key={finding.locator}>
                      <p>
                        {text.section} {finding.section_index} · {text.observed}{" "}
                        {formatGeometry(finding.observed, rule.unit)} · {text.expected}{" "}
                        {formatGeometry(finding.expected, rule.unit)}
                        {finding.verdict && (
                          <span className="ml-2 text-xs text-muted-foreground">{text.verdicts[finding.verdict]}</span>
                        )}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void perform(() => readFinding(finding))}
                      >
                        {text.readSection}
                      </Button>
                    </div>
                  ))}
                  <section className="space-y-2 rounded-md border p-3 text-sm">
                    <h3 className="font-semibold">{text.handling}</h3>
                    <p className="text-xs text-muted-foreground">{text.handlingHelp}</p>
                    {visibleCheck?.dispositions
                      .filter((item) => item.rule_id === rule.rule_id)
                      .map((item) => (
                        <div key={`${item.created_at}-${item.note}`} className="border-l-2 pl-2">
                          <p className="text-xs text-muted-foreground">
                            {item.action === "defer" ? text.defer : text.note} ·{" "}
                            {new Date(item.created_at).toLocaleString()}
                          </p>
                          <p className="whitespace-pre-wrap">{item.note}</p>
                        </div>
                      ))}
                    <form
                      className="space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(async () => {
                          const checkId = visibleCheck.check_id;
                          await journalRequest("/api/disposition", {
                            check_id: checkId,
                            rule_id: rule.rule_id,
                            action: dispositionAction,
                            note: dispositionNote,
                          });
                          const saved = await journalRequest<JournalCheck>(
                            journalQuery("/api/check", { check_id: checkId }),
                          );
                          setCheck(saved);
                          setHistory((records) =>
                            records.map((record) => (record.check_id === checkId ? saved : record)),
                          );
                          setDispositionNote("");
                        });
                      }}
                    >
                      <select
                        className={selectClass}
                        aria-label={text.handlingAction}
                        disabled={busy}
                        value={dispositionAction}
                        onChange={(event) => setDispositionAction(event.target.value as "note" | "defer")}
                      >
                        <option value="note">{text.note}</option>
                        <option value="defer">{text.defer}</option>
                      </select>
                      <Textarea
                        aria-label={text.handlingNote}
                        required
                        value={dispositionNote}
                        disabled={busy}
                        onChange={(event) => setDispositionNote(event.target.value)}
                      />
                      <Button type="submit" size="sm" disabled={busy || !dispositionNote.trim()}>
                        {text.saveHandling}
                      </Button>
                    </form>
                  </section>
                </>
              )}
            </>
          )}
          {sourceLibraryOpen &&
            review?.fragments
              .filter((fragment) => fragment.parent_fragment_id === null)
              .map((fragment) => (
                <button
                  type="button"
                  disabled={busy}
                  key={fragment.fragment_id}
                  className="rounded-md border p-3 text-left text-sm hover:bg-accent"
                  onClick={() => void perform(() => showFragment(fragment))}
                >
                  <strong className="block text-xs">
                    {world?.sources.find((source) => source.source_id === fragment.source_id)?.name}
                  </strong>
                  <span className="mt-1 block whitespace-pre-wrap">{fragment.text || text.fragmentKinds[fragment.kind as keyof typeof text.fragmentKinds] || fragment.kind}</span>
                </button>
              ))}
          {selectedFragment && (
            <section className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <h3 className="font-semibold">{text.sourceFragment}</h3>
              <p className="whitespace-pre-wrap">{selectedFragment.text}</p>
              {selectedFragment.content.title && (
                <p className="text-xs text-muted-foreground">
                  {text.declaredReference}: {selectedFragment.content.title}
                </p>
              )}
              {connection && linkedId && <details>
                <summary>{text.annotations.title}</summary>
                <div className="mt-3"><JournalAnnotations projectId={projectId} reference={annotationReference("source", selectedFragment.fragment_id)} onOpenTarget={openAnnotationTarget} /></div>
              </details>}
              {sourcePage && (
                <div className="relative">
                  <img
                    className="w-full"
                    src={`data:image/png;base64,${sourcePage.png_base64}`}
                    alt={text.sourcePage}
                  />
                  {selectedFragment.content.bbox && (
                    <div
                      className="pointer-events-none absolute border-2 border-amber-500 bg-amber-400/20"
                      style={{
                        left: `${(100 * selectedFragment.content.bbox[0]) / sourcePage.width_pt}%`,
                        top: `${(100 * selectedFragment.content.bbox[1]) / sourcePage.height_pt}%`,
                        width: `${(100 * (selectedFragment.content.bbox[2] - selectedFragment.content.bbox[0])) / sourcePage.width_pt}%`,
                        height: `${(100 * (selectedFragment.content.bbox[3] - selectedFragment.content.bbox[1])) / sourcePage.height_pt}%`,
                      }}
                    />
                  )}
                </div>
              )}
            </section>
          )}
          {manuscriptRead && (
            <section className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <h3 className="font-semibold">{text.retainedSection}</h3>
              {manuscriptRead.items.map((item) => (
                <div key={item.object_id}>
                  <dl className="grid grid-cols-2 gap-2">
                    {Object.entries((item.content.declared_values ?? item.content) as Record<string, unknown>)
                      .filter(([key]) => key in text.properties)
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt className="text-xs text-muted-foreground">
                            {text.properties[key as keyof typeof text.properties]}
                          </dt>
                          <dd>
                            {formatGeometry(
                              value as number | null,
                              key === "columns"
                                ? "count"
                                : key === "body_font_size_halfpoints"
                                  ? "half_points"
                                  : key === "body_line_spacing_twips"
                                    ? "spacing_twips"
                                    : "twips",
                            )}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </div>
              ))}
            </section>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={referencedObject !== null} onOpenChange={(open) => { if (!open) setReferencedObject(null); }}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader><DialogTitle>{text.annotations.original}</DialogTitle><DialogDescription>{text.annotations.originalHelp}</DialogDescription></DialogHeader>
          {referencedObject && (
            <section className="space-y-3 text-sm">
              <JournalObjectView object={referencedObject} />
              <Button
                variant="outline"
                onClick={() => {
                  useResearchTasksStore.getState().openTaskDetail(referencedObject.relatedTasks[0]?.id ?? "", "annotations");
                  useWorkspaceSurfaceStore.getState().showFiles();
                }}
                disabled={!referencedObject.relatedTasks[0]}
              >
                {text.annotations.openTask}
              </Button>
            </section>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={comparison !== null}
        onOpenChange={(open) => {
          if (!open) setComparison(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{text.compareVersions}</DialogTitle>
            <DialogDescription>
              {text.compareHelp} · {`${world?.journal_name} v${world?.version_ordinal}`}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {world && (
            <label className="space-y-1 text-sm">
              <span>{text.compareFrom}</span>
              <select
                className={selectClass}
                disabled={busy}
                value={comparison?.from ?? ""}
                onChange={(event) => void perform((sequence) => compareVersions(event.target.value, world.version_id, sequence))}
              >
                {otherVersions.map((item) => (
                  <option key={item.version_id} value={item.version_id}>
                    {`v${item.version_ordinal}`} · {new Date(item.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          )}
          {comparison?.diff.scope_changed && <p className="text-sm">{text.scopeChanged}</p>}
          {comparison?.diff.changes
            .filter((item) => item.status !== "unchanged")
            .map((item) => (
              <section key={item.property} className="space-y-2 rounded-md border p-3 text-sm">
                <h3 className="font-semibold">
                  {text.properties[item.property as keyof typeof text.properties]} · {text.changes[item.status]}
                </h3>
                <p>
                  {item.before
                    ? `${formatGeometry(item.before.expected, item.before.unit)} · ${text.bases[item.before.basis_status]}`
                    : "—"}
                  {" → "}
                  {item.after
                    ? `${formatGeometry(item.after.expected, item.after.unit)} · ${text.bases[item.after.basis_status]}`
                    : "—"}
                </p>
                <details>
                  <summary className="text-xs">{text.changeEvidence}</summary>
                  {[item.before, item.after].map(
                    (value, index) =>
                      value && (
                        <div className="mt-2 space-y-1" key={index === 0 ? "before" : "after"}>
                          <strong className="text-xs">{index === 0 ? text.before : text.after}</strong>
                          <p className="text-xs text-muted-foreground">
                            {text.articleTypes[value.scope.article_type as keyof typeof text.articleTypes]} /{" "}
                            {text.stages[value.scope.stage as keyof typeof text.stages]} / {text.languages[value.scope.language as keyof typeof text.languages] ?? value.scope.language}
                          </p>
                          {value.evidence.map((evidence) => (
                            <blockquote
                              className="border-l-2 pl-2 text-xs"
                              key={`${evidence.source_id}-${evidence.locator}`}
                            >
                              {evidence.quote}
                            </blockquote>
                          ))}
                          {value.resolution && (
                            <p className="text-xs">
                              {text.operatorDecision}: {value.resolution.reason}
                            </p>
                          )}
                        </div>
                      ),
                  )}
                </details>
              </section>
            ))}
          {comparison?.diff.changes.every((item) => item.status === "unchanged") && (
            <p className="text-sm text-muted-foreground">{text.noRuleChanges}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function JournalImportDialog({
  mode,
  project,
  world,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  mode: "manuscript" | "update" | "world" | "template" | null;
  project: JournalProject | null;
  world: JournalWorld | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (operation: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  const formId = useId();
  const [name, setName] = useState("");
  const fallbackJournalId = useRef(generatedJournalId());
  const fallbackJournalContext = useRef("");
  const [files, setFiles] = useState<{ file: File; kind: string }[]>([]);
  const [articleType, setArticleType] = useState("research_article");
  const [stage, setStage] = useState("initial_submission");
  const [language, setLanguage] = useState("en");
  const [reason, setReason] = useState("");
  const isJournal = mode === "world" || mode === "template";
  useEffect(() => {
    const context = `${mode ?? "closed"}:${world?.version_id ?? ""}`;
    if (fallbackJournalContext.current !== context) {
      fallbackJournalId.current = generatedJournalId();
      fallbackJournalContext.current = context;
    }
    setName(mode === "world" || mode === "template" ? (world?.journal_name ?? "") : mode === "update" ? (project?.name ?? "") : "");
    setFiles([]);
    setReason("");
    setArticleType(world?.scope.article_type ?? "research_article");
    setStage(world?.scope.stage ?? "initial_submission");
    setLanguage(world?.scope.language ?? "en");
  }, [mode, project?.name, world]);
  const title =
    mode === "template" ? text.importTemplate : mode === "world" ? text.importJournal : mode === "update" ? text.updateManuscript : text.importManuscript;
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent closeDisabled={busy} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{mode === "template" ? text.templateHelp : mode === "world" ? text.importJournalHelp : text.captureHelp}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(async () => {
              const selectedFile = files[0]?.file;
              const journalName = name.trim() || (selectedFile ? fileStem(selectedFile) : "");
              const resolvedJournalId = fallbackJournalId.current;
              if (mode === "template") {
                if (!selectedFile) throw new Error(text.chooseTemplateFile);
                return importJournalTemplate(selectedFile, {
                  journal_id: resolvedJournalId,
                  journal_name: journalName,
                  article_type: articleType,
                  stage,
                  language,
                });
              }
              if (mode === "world") {
                const templates = files.filter(({ kind }) => kind === "template_docx");
                if (templates.length > 1) throw new Error(text.template.oneTemplate);
                if (templates[0]) return importJournalTemplate(templates[0].file, {
                  journal_id: resolvedJournalId,
                  journal_name: name,
                  article_type: articleType,
                  stage,
                  language,
                }, await Promise.all(files.filter((item) => item !== templates[0]).map(async ({ file, kind }) => ({
                  ...(await capturedJournalFile(file)), kind,
                }))));
                return journalRequest<JournalWorld>("/api/worlds", {
                  journal_id: resolvedJournalId,
                  journal_name: name,
                  article_type: articleType,
                  stage,
                  language,
                  sources: await Promise.all(
                    (files.length ? files : [{
                      file: new File([
                        `Operator research request: ${name}. Article type: ${articleType}. Stage: ${stage}. Language: ${language}. Publisher requirements have not yet been collected.`,
                      ], "research-request.txt", { type: "text/plain" }),
                      kind: "guide_text",
                    }]).map(async ({ file, kind }) => ({
                      ...(await capturedJournalFile(file)),
                      kind,
                    })),
                  ),
                });
              }
              const file = files[0].file;
              const captured = await capturedJournalFile(file);
              if (mode === "update")
                return journalRequest("/api/baseline", {
                  project_id: project?.project_id,
                  expected_baseline_id: project?.baseline_id,
                  filename: file.name,
                  content_base64: captured.content_base64,
                  reason,
                  request_id: `request-${crypto.randomUUID()}`,
                });
              return journalRequest<JournalProject>("/api/projects", {
                name,
                filename: file.name,
                content_base64: captured.content_base64,
              });
            });
          }}
        >
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {mode !== "update" && (
            <label htmlFor={`${formId}-name`} className="block space-y-1 text-sm">
              <span>{mode === "template" ? text.templateName : text.displayName}</span>
              <Input
                id={`${formId}-name`}
                required
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {isJournal && (
            <details className="rounded-md border p-3 text-xs" data-testid="journal-submission-context">
                <summary>{text.submissionContext}</summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs">
                    <span>{text.articleType}</span>
                    <select
                      className={selectClass}
                      value={articleType}
                      disabled={busy}
                      onChange={(event) => setArticleType(event.target.value)}
                    >
                      {Object.entries(text.articleTypes).map(([id, label]) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span>{text.stage}</span>
                    <select
                      className={selectClass}
                      value={stage}
                      disabled={busy}
                      onChange={(event) => setStage(event.target.value)}
                    >
                      {Object.entries(text.stages).map(([id, label]) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span>{text.language}</span>
                    <select
                      className={selectClass}
                      value={language}
                      disabled={busy}
                      onChange={(event) => setLanguage(event.target.value)}
                    >
                      {Object.entries(text.languages).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
            </details>
          )}
          <label className="block space-y-1 text-sm">
            <span>{text.files}</span>
            <input
              aria-label={text.files}
              type="file"
              disabled={busy}
              accept={mode === "template" ? ".doc,.docx" : mode === "world" ? ".txt,.doc,.docx,.pdf" : ".docx"}
              multiple={mode === "world"}
              className="w-full text-xs file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1.5 file:text-foreground"
              onChange={(event) => {
                const chosen = Array.from(event.target.files ?? []).map((file) => {
                  const filename = file.name.toLowerCase();
                  return {
                    file,
                    kind: filename.endsWith(".pdf")
                      ? "guide_pdf"
                      : filename.endsWith(".doc")
                        ? "template_docx"
                        : filename.endsWith(".docx")
                          ? "guide_docx"
                          : "guide_text",
                  };
                });
                setFiles(chosen);
                if (chosen.length && (mode === "template" || !name)) setName(fileStem(chosen[0].file));
              }}
            />
          </label>
          {mode === "world" && files.length > 0 && (
            <details className="rounded-md border p-3 text-xs" data-testid="journal-source-roles">
              <summary>{text.sourceRoles}</summary>
              <div className="mt-3 space-y-2">
                {files.map(({ file, kind }, index) => (
                  <label
                    className="block space-y-1 text-xs"
                    key={`${file.name}-${file.lastModified}-${file.size}`}
                  >
                    <span>{file.name}</span>
                    <select
                      aria-label={`${text.sourceKind}: ${file.name}`}
                      className={selectClass}
                      value={kind}
                      disabled={busy}
                      onChange={(event) =>
                        setFiles(
                          files.map((item, current) =>
                            current === index ? { ...item, kind: event.target.value } : item,
                          ),
                        )
                      }
                    >
                      {Object.entries(text.sourceKinds)
                        .filter(([id]) => id !== "rule_component_json")
                        .map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}
          {mode === "update" && (
            <label htmlFor={`${formId}-reason`} className="block space-y-1 text-sm">
              <span>{text.updateReason}</span>
              <Input
                id={`${formId}-reason`}
                required
                value={reason}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          <Button type="submit" disabled={busy || (mode !== "world" && !files.length)}>
            {busy ? text.working : title}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JournalTemplateSummary({ world, project, check }: {
  world: JournalWorld;
  project: JournalProject | null;
  check: JournalCheck | null;
}) {
  return world.template
    ? <div data-testid="journal-template-summary"><JournalTemplatePanel world={world} project={project} check={check} /></div>
    : null;
}

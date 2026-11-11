import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpenCheck, FileUp, Play, RefreshCw, Sparkles } from "lucide-react";
import { SidebarPanelHeader } from "@/components/layout/SidebarSection";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ensureAiProviderOrOpenSettings, handoffToAssistant } from "@/features/assistant-handoff";
import { useFilesStore } from "@/store/files";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { getResearchWorkspace } from "@/lib/research-workspace";
import { pickOpenPaths } from "@/lib/tauri";
import type { AnnotationTarget } from "@/lib/task-collaboration";
import {
  capturedJournalFile,
  formatJournalValue as formatGeometry,
  connectJournalWorkbench,
  journalAnalysisPrompt,
  journalMessage,
  journalQuery,
  journalRequest,
  journalUnitScale,
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
import { JournalResearchPanel } from "./JournalResearchPanel";
import { JournalAnnotations } from "./JournalAnnotations";
import { JournalObjectView } from "./JournalObjectView";

const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs";
const panelClass = "space-y-3 rounded-lg border border-sidebar-border p-3";

export function JournalChecksPanel() {
  const projectId = useFilesStore((state) => state.projectId);
  const { t } = useTranslation("researchTools");
  return projectId ? (
    <JournalProjectPanel key={projectId} projectId={projectId} />
  ) : (
    <div className="p-4 text-sm text-muted-foreground">{t(($) => $.researchTools.journal.openProject)}</div>
  );
}

function JournalProjectPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation("researchTools");
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
  const [form, setForm] = useState<"manuscript" | "update" | "world" | null>(null);
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
  const [componentOpen, setComponentOpen] = useState(false);
  const [componentJson, setComponentJson] = useState("");
  const [comparison, setComparison] = useState<{ from: string; diff: JournalDiff } | null>(null);
  const [notice, setNotice] = useState<"researchChecked" | "researchAdopted" | "versionCreated" | null>(null);
  const [referencedObject, setReferencedObject] = useState<JournalAnnotationObject | null>(null);
  const project = snapshot.projects.find((item) => item.project_id === linkedId) ?? null;
  const visibleCheck = check?.world_version_id === world?.version_id ? check : null;
  const bindingCurrent = project?.binding?.baseline_id === project?.baseline_id;
  const annotationReference = (kind: "rule" | "source" | "check" | "world", objectId: string) => ({
    libraryRoot: connection?.libraryRoot ?? "", workbenchProjectId: linkedId ?? "", kind, objectId,
    worldVersionId: world?.version_id ?? "", checkId: visibleCheck?.check_id ?? null,
  });
  const openAnnotationTarget = (target: AnnotationTarget) => {
    void perform(async () => { setReferencedObject(await loadJournalTarget(target)); });
  };

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async (selectedId: string | null, versionId?: string) => {
    const next = await journalRequest<JournalState>("/api/state");
    const selected = next.projects.find((item) => item.project_id === selectedId);
    const worldId = versionId ?? selected?.binding?.world_version_id ?? next.worlds[0]?.version_id;
    const [nextWorld, records] = await Promise.all([
      worldId ? journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: worldId })) : null,
      selected
        ? journalRequest<{ checks: JournalCheck[] }>(journalQuery("/api/history", { project_id: selected.project_id }))
        : null,
    ]);
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
    setBusy(true);
    void Promise.all([connectJournalWorkbench(), getResearchWorkspace(projectId)])
      .then(async ([connected, workspace]) => {
        if (!active) return;
        setConnection(connected);
        setPython(connected.python);
        await load(workspace.journalProjectId ?? null);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, load]);

  async function chooseWorld(versionId: string) {
    const next = await journalRequest<JournalWorld>(journalQuery("/api/world", { version_id: versionId }));
    setWorld(next);
    setReview(null);
    setRule(null);
    setManuscriptRead(null);
    setComparison(null);
  }

  async function openEvidence(selectedRule: JournalRule | null) {
    if (!world) return;
    const next = await journalRequest<JournalReview>(journalQuery("/api/review", { version_id: world.version_id }));
    setReview(next);
    setRule(selectedRule);
    setSourceLibraryOpen(selectedRule === null);
    setSourcePage(null);
    setSelectedFragment(null);
    setManuscriptRead(null);
    setRevisionValue(
      selectedRule?.expected == null
        ? ""
        : String(
            Number(
              (selectedRule.expected / journalUnitScale(selectedRule.unit)).toFixed(4),
            ),
          ),
    );
    setRevisionReason("");
    setDispositionAction("note");
    setDispositionNote("");
  }

  async function compareVersions(from: string, to: string) {
    const diff = await journalRequest<JournalDiff>(journalQuery("/api/diff", { from_version: from, to_version: to }));
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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="journal-checks-panel" aria-busy={busy}>
      <SidebarPanelHeader icon={BookOpenCheck} title={text.title}>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={busy || !connection}
          aria-label={text.refresh}
          onClick={() => void perform(() => load(linkedId, world?.version_id))}
        >
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </SidebarPanelHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {error && (
          <p role="alert" className="break-words rounded-md border border-destructive/30 p-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-md bg-muted p-2 text-xs">
            {text[notice]}
          </p>
        )}
        {!connection ? (
          <section className={panelClass}>
            <p className="text-sm font-medium">{text.connect}</p>
            <p className="text-xs text-muted-foreground">{text.runtimeHelp}</p>
            <Input
              value={python}
              onChange={(event) => setPython(event.target.value)}
              aria-label={text.python}
              placeholder={text.python}
              className="text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
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
                size="sm"
                disabled={busy || !python.trim()}
                onClick={() =>
                  void perform(async () => {
                    const connected = await connectJournalWorkbench(python.trim());
                    setConnection(connected);
                    const workspace = await getResearchWorkspace(projectId);
                    await load(workspace.journalProjectId ?? null);
                  })
                }
              >
                {text.connect}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{text.scope}</p>
            <section className={panelClass}>
              <label className="block space-y-1 text-xs font-medium">
                <span>{text.manuscript}</span>
                <select
                  className={selectClass}
                  value={linkedId ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id)
                      void perform(async () => {
                        await linkJournalProject(projectId, id);
                        await load(id);
                      });
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
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => useDocxWorkspaceStore.getState().open({
                    appProjectId: projectId, project, world, onSaved: () => load(linkedId, world?.version_id),
                  })}>
                    {t(($) => $.researchTools.docx.open)}
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
              {project && (
                <details className="text-xs text-muted-foreground">
                  <summary>{text.retainedVersion}</summary>
                  <p className="mt-1 break-all font-mono">{project.baseline_id}</p>
                </details>
              )}
            </section>
            <section className={panelClass}>
              <label className="block space-y-1 text-xs font-medium">
                <span>{text.journalVersion}</span>
                <select
                  className={selectClass}
                  value={world?.version_id ?? ""}
                  disabled={busy}
                  onChange={(event) => void perform(() => chooseWorld(event.target.value))}
                >
                  {!snapshot.worlds.length && <option value="">{text.chooseJournal}</option>}
                  {snapshot.worlds.map((item) => (
                    <option key={item.version_id} value={item.version_id}>
                      {`${item.journal_name} · v${item.version_ordinal}`} ·{" "}
                      {text.articleTypes[item.scope.article_type as keyof typeof text.articleTypes]} /{" "}
                      {text.stages[item.scope.stage as keyof typeof text.stages]} / {text.languages[item.scope.language as keyof typeof text.languages] ?? item.scope.language}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setForm("world");
                }}
              >
                {text.importJournal}
              </Button>
              {world && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setComponentOpen(true);
                      }}
                    >
                      {text.importCandidates}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void perform(() => openEvidence(null))}
                    >
                      {text.sourceLibrary}
                    </Button>
                    {otherVersions.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(() => compareVersions(otherVersions[0].version_id, world.version_id))
                        }
                      >
                        {text.compareVersions}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || !project || (bindingCurrent && project.binding?.world_version_id === world.version_id)
                      }
                      onClick={() =>
                        void perform(async () => {
                          await journalRequest("/api/bind", {
                            project_id: project?.project_id,
                            world_version_id: world.version_id,
                            expected_binding_id: project?.binding?.binding_id ?? null,
                          });
                          await load(linkedId, world.version_id);
                        })
                      }
                    >
                      {bindingCurrent && project?.binding?.world_version_id === world.version_id
                        ? text.bound
                        : text.bind}
                    </Button>
                  </div>
                  {latestWorld && latestWorld.version_ordinal > world.version_ordinal && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">{text.newVersion}</p>
                  )}
                  {project?.binding && (!bindingCurrent || project.binding.world_version_id !== world.version_id) && (
                    <p className="text-xs text-muted-foreground">
                      {!bindingCurrent ? text.rebindAfterUpdate : text.viewingUnboundVersion}
                    </p>
                  )}
                </>
              )}
            </section>
            {world && (
              <JournalResearchPanel
                projectId={projectId}
                world={world}
                check={visibleCheck}
                manuscriptId={linkedId}
                onAdopted={async (next, checked) => {
                  await load(linkedId, next.version_id);
                  setNotice(checked ? "researchChecked" : "researchAdopted");
                }}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={
                  busy || !project?.binding || !bindingCurrent || project.binding.world_version_id !== world?.version_id
                }
                onClick={() =>
                  void perform(async () => {
                    await journalRequest<JournalCheck>("/api/check", {
                      project_id: project?.project_id,
                    });
                    await load(linkedId, world?.version_id);
                  })
                }
              >
                <Play className="mr-1 size-3.5" />
                {text.runCheck}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !visibleCheck}
                onClick={() =>
                  void perform(async () => {
                    if (!visibleCheck || !(await ensureAiProviderOrOpenSettings())) return;
                    const source = await journalRequest<JournalReview>(
                      journalQuery("/api/review", {
                        version_id: visibleCheck.world_version_id,
                      }),
                    );
                    handoffToAssistant(
                      journalAnalysisPrompt(visibleCheck, source, i18n.resolvedLanguage ?? i18n.language),
                      { autoSend: false },
                    );
                  })
                }
              >
                <Sparkles className="mr-1 size-3.5" />
                {text.askAgent}
              </Button>
            </div>
            {visibleCheck && (
              <section className={panelClass} aria-label={text.results}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <strong
                    className={
                      visibleCheck.validity === "STALE"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {visibleCheck.validity === "STALE" ? text.stale : text.current}
                  </strong>
                  <time>{new Date(visibleCheck.created_at).toLocaleString()}</time>
                </div>
                {visibleCheck.validity === "STALE" && <p className="text-xs text-muted-foreground">{text.staleHelp}</p>}
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {Object.entries(visibleCheck.summary)
                    .filter(([, count]) => count > 0)
                    .map(([verdict, count]) => (
                      <span key={verdict}>
                        {text.verdicts[verdict as keyof typeof text.verdicts]} {count}
                      </span>
                    ))}
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary>{text.checkRecord}</summary>
                  <p className="mt-1 break-all font-mono">{visibleCheck.check_id}</p>
                  <p className="break-all font-mono">{visibleCheck.baseline_id}</p>
                </details>
                {connection && linkedId && <details className="text-xs">
                  <summary>{text.annotations.title}</summary>
                  <div className="mt-3"><JournalAnnotations projectId={projectId} reference={annotationReference("check", visibleCheck.check_id)} onOpenTarget={openAnnotationTarget} /></div>
                </details>}
              </section>
            )}
            {world && (
              <section className="space-y-2" aria-label={text.rules}>
                <h3 className="text-xs font-semibold">
                  {text.rules} · {world.rules.length}
                </h3>
                {world.rules.length === 0 && <p className="text-xs text-muted-foreground">{text.noRules}</p>}
                {world.rules.map((item) => {
                  const checked = visibleCheck?.rule_results.find((record) => record.rule_id === item.rule_id);
                  return (
                    <button
                      key={item.rule_id}
                      type="button"
                      disabled={busy}
                      onClick={() => void perform(() => openEvidence(item))}
                      className="w-full rounded-md border border-sidebar-border px-3 py-2 text-left text-xs transition-colors hover:bg-accent disabled:opacity-50"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <strong>{text.properties[item.property as keyof typeof text.properties]}</strong>
                        <span>{formatGeometry(item.expected, item.unit)}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap justify-between gap-1 text-muted-foreground">
                        <span>{text.bases[item.basis_status]}</span>
                        <span
                          className={
                            checked?.verdict === "violation" && visibleCheck?.validity === "CURRENT"
                              ? "text-destructive"
                              : ""
                          }
                        >
                          {checked ? text.verdicts[checked.verdict] : text.verdicts.not_checked}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            )}
            {(visibleCheck?.coverage_gaps ?? world?.coverage_gaps ?? []).length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary>{text.coverage}</summary>
                <ul className="mt-2 space-y-2">
                  {(visibleCheck?.coverage_gaps ?? world?.coverage_gaps ?? []).map((gap) => (
                    <li key={`${gap.code}-${gap.locator}-${gap.message}`}>
                      <span>{journalMessage(gap.message)}</span>
                      {gap.locator && <code className="block break-all text-[0.625rem]">{gap.locator}</code>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {history.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold">{text.history}</h3>
                {[...history].reverse().map((record) => (
                  <button
                    type="button"
                    key={record.check_id}
                    disabled={busy}
                    className="block w-full rounded-md border border-sidebar-border p-2 text-left text-xs hover:bg-accent"
                    onClick={() =>
                      void perform(async () => {
                        await chooseWorld(record.world_version_id);
                        setCheck(record);
                      })
                    }
                  >
                    <span className="block">
                      {new Date(record.created_at).toLocaleString()} ·{" "}
                      {record.validity === "CURRENT" ? text.current : text.stale}
                    </span>
                    <span className="text-muted-foreground">{`${record.world.journal_name} · v${record.world.version_ordinal}`}</span>
                  </button>
                ))}
              </section>
            )}
          </>
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
          void perform(async () => {
            const imported = await operation();
            if (form === "manuscript") {
              const manuscript = imported as JournalProject;
              await linkJournalProject(projectId, manuscript.project_id);
              await load(manuscript.project_id, world?.version_id);
            } else if (form === "world") await load(linkedId, (imported as JournalWorld).version_id);
            else await load(linkedId, world?.version_id);
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
              {rule ? text.properties[rule.property as keyof typeof text.properties] : text.sourceLibrary}
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
                {text.bases[rule.basis_status]} · {formatGeometry(rule.expected, rule.unit)} ·{" "}
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
                  <code className="mt-2 block break-all text-xs text-muted-foreground">{evidence.locator}</code>
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
              <details className="rounded-md border p-3 text-sm">
                <summary>{text.reviseRequirement}</summary>
                <p className="my-2 text-xs text-muted-foreground">{text.reviseHelp}</p>
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async () => {
                      const expected = Math.round(
                        Number(revisionValue) * journalUnitScale(rule.unit),
                      );
                      const revised = await journalRequest<JournalWorld>("/api/revise", {
                        version_id: world.version_id,
                        rule_id: rule.rule_id,
                        expected,
                        reason: revisionReason,
                      });
                      await load(linkedId, revised.version_id);
                      setNotice("versionCreated");
                    });
                  }}
                >
                  <label htmlFor={`${detailId}-expected`} className="block space-y-1">
                    <span>
                      {text.expected} ({rule.unit === "count" ? text.unitCount : rule.unit === "twips" ? "mm" : "pt"})
                    </span>
                    <Input
                      id={`${detailId}-expected`}
                      type="number"
                      required
                      min={rule.property.includes("margin") ? 0 : rule.unit === "count" ? 1 : 0.01}
                      step={rule.unit === "count" ? 1 : "any"}
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
              </details>
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
                      <code className="block break-all text-xs text-muted-foreground">{finding.locator}</code>
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
                  {text.declaredReference}: {selectedFragment.content.title} · {selectedFragment.content.locator}
                </p>
              )}
              <code className="block break-all text-xs">{selectedFragment.locator}</code>
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
                  <details className="mt-2 text-xs">
                    <summary>{text.sourceData}</summary>
                    <CodeBlock code={JSON.stringify(item.content, null, 2)} preClassName="whitespace-pre-wrap break-all" />
                  </details>
                </div>
              ))}
              <p className="break-all text-xs text-muted-foreground">
                {text.readRecord}: {manuscriptRead.read_receipt.read_record_id}
              </p>
            </section>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={referencedObject !== null} onOpenChange={(open) => { if (!open) setReferencedObject(null); }}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader><DialogTitle>{text.annotations.original}</DialogTitle><DialogDescription>{text.annotations.originalHelp}</DialogDescription></DialogHeader>
          {referencedObject && <JournalObjectView object={referencedObject} />}
        </DialogContent>
      </Dialog>
      <Dialog
        open={componentOpen}
        onOpenChange={(open) => {
          if (!busy) setComponentOpen(open);
        }}
      >
        <DialogContent closeDisabled={busy} className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{text.importCandidates}</DialogTitle>
            <DialogDescription>{text.candidatesHelp}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {world && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const captured = await capturedJournalFile(
                    new File([componentJson], "agent-requirements.json", { type: "application/json" }),
                  );
                  const imported = await journalRequest<JournalWorld>("/api/world-component", {
                    version_id: world.version_id,
                    ...captured,
                  });
                  await load(linkedId, imported.version_id);
                  setComponentJson("");
                  setComponentOpen(false);
                  setNotice("versionCreated");
                });
              }}
            >
              <Textarea
                aria-label={text.candidateJson}
                placeholder={text.candidateJson}
                required
                rows={16}
                className="font-mono text-xs"
                value={componentJson}
                disabled={busy}
                onChange={(event) => setComponentJson(event.target.value)}
              />
              <Button type="submit" disabled={busy || !componentJson.trim()}>
                {text.importCandidates}
              </Button>
            </form>
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
                onChange={(event) => void perform(() => compareVersions(event.target.value, world.version_id))}
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
                              <code className="block break-all text-muted-foreground">{evidence.locator}</code>
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
  mode: "manuscript" | "update" | "world" | null;
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
  const [journalId, setJournalId] = useState("");
  const [files, setFiles] = useState<{ file: File; kind: string }[]>([]);
  const [articleType, setArticleType] = useState("research_article");
  const [stage, setStage] = useState("initial_submission");
  const [language, setLanguage] = useState("en");
  const [reason, setReason] = useState("");
  useEffect(() => {
    setName(mode === "world" ? (world?.journal_name ?? "") : mode === "update" ? (project?.name ?? "") : "");
    setJournalId(world?.journal_id ?? "");
    setFiles([]);
    setReason("");
    setArticleType(world?.scope.article_type ?? "research_article");
    setStage(world?.scope.stage ?? "initial_submission");
    setLanguage(world?.scope.language ?? "en");
  }, [mode, project?.name, world]);
  const title =
    mode === "world" ? text.importJournal : mode === "update" ? text.updateManuscript : text.importManuscript;
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
          <DialogDescription>{mode === "world" ? text.importJournalHelp : text.captureHelp}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(async () => {
              if (mode === "world")
                return journalRequest<JournalWorld>("/api/worlds", {
                  journal_id: journalId,
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
              <span>{text.displayName}</span>
              <Input
                id={`${formId}-name`}
                required
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {mode === "world" && (
            <>
              <label htmlFor={`${formId}-journal`} className="block space-y-1 text-sm">
                <span>{text.journalId}</span>
                <Input
                  id={`${formId}-journal`}
                  required
                  value={journalId}
                  disabled={busy}
                  onChange={(event) => setJournalId(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">{text.journalIdHelp}</p>
              <div className="grid grid-cols-2 gap-2">
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
            </>
          )}
          <label className="block space-y-1 text-sm">
            <span>{text.files}</span>
            <input
              aria-label={text.files}
              type="file"
              disabled={busy}
              accept={mode === "world" ? ".txt,.docx,.pdf,.json" : ".docx"}
              multiple={mode === "world"}
              className="w-full text-xs file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1.5 file:text-foreground"
              onChange={(event) => {
                const chosen = Array.from(event.target.files ?? []).map((file) => ({
                  file,
                  kind: file.name.endsWith(".pdf")
                    ? "guide_pdf"
                    : file.name.endsWith(".docx")
                      ? "guide_docx"
                      : file.name.endsWith(".json")
                        ? "rule_component_json"
                        : "guide_text",
                }));
                setFiles(chosen);
                if (!name && chosen.length) setName(chosen[0].file.name.replace(/\.[^.]+$/, ""));
              }}
            />
          </label>
          {mode === "world" &&
            files.map(({ file, kind }, index) => (
              <label className="block space-y-1 text-xs" key={file.name}>
                <span>{file.name}</span>
                <select
                  aria-label={`${text.sourceKind}: ${file.name}`}
                  className={selectClass}
                  value={kind}
                  disabled={busy}
                  onChange={(event) =>
                    setFiles(
                      files.map((item, current) => (current === index ? { ...item, kind: event.target.value } : item)),
                    )
                  }
                >
                  {Object.entries(text.sourceKinds).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
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

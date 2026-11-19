import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { bindDocxTask, loadDocxTaskActivities, subscribeDocxTaskActivity, type DocxActivity } from "@/lib/docx-task-activity";
import { listResearchTasks, type ResearchTask } from "@/lib/research-tasks";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore } from "@/store/settings";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

function resultRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function openDocxTaskSource(projectId: string, taskId: string, tab: "activity" | "group") {
  const store = useResearchTasksStore.getState();
  if (store.projectId !== projectId) await store.bindProject(projectId);
  else if (!store.tasks.some((task) => task.id === taskId)) await store.refresh();
  useResearchTasksStore.getState().openTaskDetail(taskId, tab);
  useSettingsStore.getState().setRailTab("research");
  useDocxWorkspaceStore.getState().minimize();
}

export function DocxActivitySource({ activity }: { activity: DocxActivity }) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.taskActivity, { returnObjects: true });
  const origin = activity.origin;
  return <div className="space-y-1 text-[0.6875rem] text-muted-foreground">
    <button type="button" className="text-primary underline" onClick={() => void openDocxTaskSource(activity.document.appProjectId, origin.taskId, "activity")}>{text.source}</button>
    {origin.groupId && <button type="button" className="block text-primary underline" onClick={() => void openDocxTaskSource(activity.document.appProjectId, origin.taskId, "group")}>{text.group}</button>}
  </div>;
}

export function DocxTaskActivity({ projectId, workbenchProjectId, sessionId }: {
  projectId: string; workbenchProjectId: string; sessionId: string | null;
}) {
  const { t } = useTranslation("researchTools");
  const { t: tEditor } = useTranslation("editor");
  const docxText = t(($) => $.researchTools.docx, { returnObjects: true });
  const text = docxText.taskActivity;
  const editorText = tEditor(($) => $.editor.agentWorkspace, { returnObjects: true });
  const operationLabels: Record<string, string> = {
    read: editorText.read, read_format: editorText.readFormat, replace_range: editorText.edit,
    format: editorText.format,
    format_batch: editorText.format, import_styles: editorText.importStyles,
    apply: editorText.edit, save: editorText.save, check: editorText.check,
    reveal: editorText.reveal, capture: editorText.read, propose: editorText.propose,
    prepare_fonts: editorText.prepare_fonts, export: editorText.export,
  };
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [selected, setSelected] = useState("");
  const [binding, setBinding] = useState(false);
  const [bound, setBound] = useState<{ taskId: string; sessionId: string } | null>(null);
  const [activities, setActivities] = useState<DocxActivity[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const loading = useRef(false);
  const active = useRef(true);
  const refreshTasks = useCallback(async () => {
    try {
      const value = await listResearchTasks(projectId);
      if (active.current) {
        const available = value.filter((task) => task.status === "queued" && task.executionGeneration === 0 && task.startedAt == null);
        setTasks(available);
        setSelected((previous) => available.some((task) => task.id === previous) ? previous : "");
      }
    } catch (cause) { if (active.current) setError(String(cause)); }
  }, [projectId]);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await loadDocxTaskActivities(projectId, workbenchProjectId, cursor.current, 20);
      if (!active.current) return;
      cursor.current = page.nextCursor;
      setActivities((previous) => [...previous, ...page.activities.map((entry) => entry.activity)]);
      setHasMore(page.hasMore);
      setError(null);
    } catch (cause) { if (active.current) setError(String(cause)); }
    finally { loading.current = false; }
  }, [projectId, workbenchProjectId]);
  useEffect(() => {
    active.current = true;
    cursor.current = 0;
    setActivities([]);
    void refreshTasks();
    void refresh();
    const unsubscribe = subscribeDocxTaskActivity(() => { void refresh(); });
    // Task observation streaming follows the selected task. Query this manuscript
    // independently so reads and receipts from other tasks also appear here.
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active.current = false; unsubscribe(); window.clearInterval(timer); };
  }, [refresh, refreshTasks]);
  async function bind() {
    if (!sessionId || !selected) return;
    setBinding(true);
    setError(null);
    try { await bindDocxTask(projectId, selected, sessionId); setBound({ taskId: selected, sessionId }); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setBinding(false); }
  }
  return <section className="space-y-2 rounded border p-3 text-xs" aria-label={text.title}>
    <p className="font-medium">{text.title}</p>
    <label className="block space-y-1"><span>{text.chooseTask}</span>
      <select className="h-9 w-full rounded border bg-background px-2" value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">{text.chooseTask}</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
    </label>
    <Button size="sm" variant="outline" disabled={!sessionId || !selected || binding} onClick={() => void bind()}>{text.bind}</Button>
    {bound && bound.sessionId === sessionId && <button type="button" className="block text-primary underline" onClick={() => void openDocxTaskSource(projectId, bound.taskId, "activity")}>{text.bound}</button>}
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    <div className="max-h-72 space-y-3 overflow-y-auto">
      {activities.map((activity) => {
        if (activity.event.type === "runtime" && activity.event.event.kind === "operationStarted") return (
          <article key={activity.id} className="space-y-1 border-t pt-2" data-testid="docx-task-activity">
            <DocxActivitySource activity={activity} />
            <p data-testid="docx-task-operation" data-operation={activity.event.event.operation} data-outcome="started">
              {operationLabels[activity.event.event.operation] ?? text.events.operation} · {text.events.operationStarted}
            </p>
          </article>
        );
        if (activity.event.type === "runtime" && activity.event.event.kind === "operation") {
          const event = activity.event.event;
          const receipt = resultRecord(event.result);
          const result = resultRecord(receipt.result);
          const document = resultRecord(receipt.document);
          const check = resultRecord(result.check);
          const succeeded = receipt.ok === true;
          let outcome = succeeded ? "succeeded" : "failed";
          let stateLabel = succeeded ? text.operationSucceeded : text.operationFailed;
          if (succeeded && event.operation === "export") {
            const status = resultRecord(result.result).status;
            stateLabel = status === "saved" ? editorText.exportSaved : status === "cancelled" ? editorText.exportCancelled : status === "download_requested" ? editorText.downloadRequested : editorText.receiptAvailable;
            outcome = typeof status === "string" ? status : "available";
          }
          const baselineId = event.operation === "save"
            ? typeof result.baselineId === "string" ? result.baselineId : undefined
            : event.operation === "check"
              ? typeof check.baseline_id === "string" ? check.baseline_id : undefined
              : undefined;
          const revision = event.operation === "save" && typeof result.revision === "number" ? result.revision : undefined;
          const sourceSha256 = event.operation === "save" && typeof result.sourceSha256 === "string" ? result.sourceSha256 : undefined;
          const validity = event.operation === "check" && typeof check.validity === "string" ? check.validity : undefined;
          const checkId = event.operation === "check" && typeof check.check_id === "string" ? check.check_id : undefined;
          const worldVersionId = event.operation === "check" && typeof check.world_version_id === "string" ? check.world_version_id : undefined;
          return <article key={activity.id} className="space-y-1 border-t pt-2" data-testid="docx-task-activity">
            <DocxActivitySource activity={activity} />
            <p data-testid="docx-task-operation" data-operation={event.operation}
              data-outcome={outcome} data-baseline-id={baselineId}
              data-revision={revision} data-source-sha256={sourceSha256} data-validity={validity}
              data-check-id={checkId} data-world-version-id={worldVersionId}
              data-session-revision={typeof document.sessionRevision === "number" ? document.sessionRevision : undefined}>
              {operationLabels[event.operation] ?? text.events.operation} · {stateLabel}
            </p>
            {event.operation === "save" && succeeded && <p>{text.events.saved}{revision === undefined ? "" : `: ${revision}`}</p>}
            {event.operation === "check" && succeeded && <p>
              {docxText.checked}
            </p>}
          </article>;
        }
        return <article key={activity.id} className="space-y-1 border-t pt-2" data-testid="docx-task-activity">
          <DocxActivitySource activity={activity} />
          <p>{activity.event.type === "operationCheckpoint" ? text.events[activity.event.phase]
            : text.events[activity.event.type === "runtime" ? activity.event.event.kind : activity.event.outcome.kind]}</p>
          {activity.event.type === "runtime" && activity.event.event.kind === "proposed" && <>
            <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-muted-foreground">{activity.event.event.target.original}</blockquote>
            <p className="whitespace-pre-wrap">{activity.event.event.proposed}</p>
          </>}
        </article>;
      })}
    </div>
    {!activities.length && <p className="text-muted-foreground">{text.empty}</p>}
    <Button size="sm" variant="ghost" onClick={() => { void refresh(); void refreshTasks(); }}>{hasMore ? text.more : text.refresh}</Button>
  </section>;
}

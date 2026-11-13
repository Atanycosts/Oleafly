import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { bindDocxTask, loadDocxTaskActivities, subscribeDocxTaskActivity, type DocxActivity } from "@/lib/docx-task-activity";
import { listResearchTasks, type ResearchTask } from "@/lib/research-tasks";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore } from "@/store/settings";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";

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
    <button type="button" className="text-primary underline" onClick={() => void openDocxTaskSource(activity.document.appProjectId, origin.taskId, "activity")}>{text.source}: {origin.taskId} · {text.generation} {origin.generation}</button>
    {origin.groupId && <button type="button" className="block text-primary underline" onClick={() => void openDocxTaskSource(activity.document.appProjectId, origin.taskId, "group")}>{text.group}: {origin.groupId}</button>}
    {origin.memberId && <p>{text.member}: {origin.memberId} · {origin.executionId}</p>}
    {origin.workIds.length > 0 && <p>{text.work}: {origin.workIds.join(", ")}</p>}
  </div>;
}

export function DocxTaskActivity({ projectId, workbenchProjectId, sessionId }: {
  projectId: string; workbenchProjectId: string; sessionId: string | null;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.taskActivity, { returnObjects: true });
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
      {activities.map((activity) => <article key={activity.id} className="space-y-1 border-t pt-2" data-testid="docx-task-activity">
        <DocxActivitySource activity={activity} />
        <p>{activity.event.type === "operationCheckpoint" ? text.events[activity.event.phase]
          : activity.event.type === "runtime" && activity.event.event.kind === "operation"
            ? `${text.events.operation} · ${activity.event.event.operation} · ${activity.event.event.result.ok ? text.operationSucceeded : text.operationFailed}`
            : text.events[activity.event.type === "runtime" ? activity.event.event.kind : activity.event.outcome.kind]}{` · r${activity.document.sessionRevision}`}</p>
        {activity.event.type === "operationCheckpoint" && <p className="break-all text-muted-foreground">{activity.event.operationId} · {activity.event.contentSha256}</p>}
        {activity.event.type === "runtime" && activity.event.event.kind === "operation" && <details><summary>{text.source}</summary><CodeBlock code={JSON.stringify(activity.event.event.result, null, 2)} preClassName="whitespace-pre-wrap break-all" /></details>}
        {activity.event.type === "runtime" && activity.event.event.kind === "proposed" && <>
          <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-muted-foreground">{activity.event.event.target.original}</blockquote>
          <p className="whitespace-pre-wrap">{activity.event.event.proposed}</p>
        </>}
        {activity.event.type === "outcome" && activity.event.outcome.kind === "saved" && <p className="break-all text-muted-foreground">{activity.document.baselineId} · {activity.event.outcome.contentSha256}</p>}
      </article>)}
    </div>
    {!activities.length && <p className="text-muted-foreground">{text.empty}</p>}
    <Button size="sm" variant="ghost" onClick={() => { void refresh(); void refreshTasks(); }}>{hasMore ? text.more : text.refresh}</Button>
  </section>;
}

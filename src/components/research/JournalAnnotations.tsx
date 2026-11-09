import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TaskAnnotations } from "@/components/research/tasks/TaskAnnotations";
import { describeError } from "@/lib/app-error";
import { captureAssistantTarget } from "@/lib/assistant-delegation-capture";
import {
  journalAnnotationSource, loadJournalAnnotationObject, requestJournalAnnotation, saveJournalAnnotation,
  type JournalAnnotationObject, type JournalObjectReference,
} from "@/lib/journal-workbench";
import { defaultBrief, type ResearchTask, type ResearchTaskDraft } from "@/lib/research-tasks";
import { loadObjectAnnotations, loadTaskGroup, type AnnotationTarget, type GroupMember, type TaskAnnotation, type TaskAnnotationDraft } from "@/lib/task-collaboration";
import { useResearchTasksStore } from "@/store/research-tasks";
import { researchTasksEnabled, setResearchTasksEnabled, useResearchTasksEnabled } from "@/store/research-tasks-flag";
import { useSettingsStore } from "@/store/settings";

interface Props {
  projectId: string;
  reference: JournalObjectReference;
  onOpenTarget: (target: AnnotationTarget) => void;
}

export function JournalAnnotations(props: Readonly<Props>) {
  const key = JSON.stringify([props.projectId, props.reference.libraryRoot, props.reference.workbenchProjectId, props.reference.kind, props.reference.objectId]);
  return <JournalAnnotationPanel key={key} {...props} />;
}

function JournalAnnotationPanel({ projectId, reference, onOpenTarget }: Readonly<Props>) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal.annotations, { returnObjects: true });
  const enabled = useResearchTasksEnabled();
  const selectId = useId();
  const [object, setObject] = useState<JournalAnnotationObject | null>(null);
  const [reply, setReply] = useState<TaskAnnotation | null>(null);
  const [taskId, setTaskId] = useState("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [pendingStart, setPendingStart] = useState<ResearchTask | null>(null);
  const [activeTask, setActiveTask] = useState<ResearchTask | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retainedRoot = useRef<{ key: string; annotation: TaskAnnotation } | null>(null);
  const replyRequest = useRef(0);
  const [replyReference, setReplyReference] = useState<JournalObjectReference | null>(null);
  const effectiveReference = replyReference ?? reference;
  const referenceKey = JSON.stringify(effectiveReference);
  const stableReference = useMemo(() => JSON.parse(referenceKey) as JournalObjectReference, [referenceKey]);

  useEffect(() => {
    let active = true;
    setError(null);
    void loadJournalAnnotationObject(projectId, stableReference, reply?.id ?? null).then((loaded) => {
      if (!active) return;
      setObject(loaded);
      setTaskId(loaded.continuationTaskId ?? (loaded.relatedTasks.length === 1 ? loaded.relatedTasks[0].id : ""));
    }).catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [projectId, stableReference, reply?.id]);

  useEffect(() => {
    let active = true;
    setMembers([]);
    if (taskId) void loadTaskGroup(projectId, taskId).then((group) => { if (active) setMembers(group?.members ?? []); })
      .catch((cause) => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [projectId, taskId]);

  async function selectReply(annotation: TaskAnnotation | null) {
    const request = ++replyRequest.current;
    setReply(annotation);
    setReplyReference(null);
    if (!annotation) { setReplyReference(null); return; }
    try {
      let original = annotation;
      if (!original.source) {
        const context = await loadObjectAnnotations({ ...original.target, taskId: null });
        original = context.annotations.find((item) => item.target.objectRevision === original.target.objectRevision && item.source?.kind === "journal_object") ?? original;
      }
      if (request === replyRequest.current) setReplyReference(journalAnnotationSource(original).reference);
    } catch (cause) { if (request === replyRequest.current) setError(describeError(cause)); }
  }

  async function start(task: ResearchTask) {
    setStarting(true); setError(null);
    try {
      const started = await useResearchTasksStore.getState().startTask(task.id);
      setActiveTask(started); setPendingStart(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally { setStarting(false); }
  }

  async function submit(draft: TaskAnnotationDraft): Promise<TaskAnnotation> {
    if (reply && !replyReference) throw new Error(text.originalUnavailable);
    const selectedReference = replyReference ?? object?.reference ?? stableReference;
    if (!draft.explicitRequest) {
      return saveJournalAnnotation(projectId, selectedReference, draft.body, draft.parentId, draft.mentions);
    }
    if (!researchTasksEnabled()) throw new Error(text.enableHelp);
    if (pendingStart) throw new Error(text.retryHelp);
    let newDraft: ResearchTaskDraft | null = null;
    if (!taskId) {
      if (object?.relatedTasks.length) throw new Error(text.chooseTask);
      const target = await captureAssistantTarget(projectId);
      const brief = defaultBrief(draft.body.slice(0, 2000));
      brief.permissions = { network: true, commands: "off", desktopApps: false };
      newDraft = {
        projectId, ...target, title: `${text.taskTitle} · ${selectedReference.objectId}`.slice(0, 100),
        prompt: draft.body, brief, skillIds: [], dependencyIds: [],
      };
    }
    let parentId = draft.parentId;
    if (!parentId) {
      const key = JSON.stringify([draft.target, draft.body]);
      if (retainedRoot.current?.key !== key) {
        retainedRoot.current = { key, annotation: await saveJournalAnnotation(projectId, selectedReference, draft.body, null) };
      }
      parentId = retainedRoot.current.annotation.id;
    }
    const result = await requestJournalAnnotation({
      projectId, reference: selectedReference, body: draft.body, parentId,
      mentions: draft.mentions, taskId: taskId || null, draft: newDraft,
    });
    useResearchTasksStore.getState().receiveTask(result.task);
    setActiveTask(result.task);
    if (result.needsStart) {
      // Keep the created ID before attempting start. A failed start is retried
      // from its own button and never repeats annotation/task creation.
      setPendingStart(result.task);
      await start(result.task);
    }
    return result.annotation;
  }

  return <section className="space-y-3" aria-label={text.title} data-testid="journal-annotations">
    <p className="text-xs text-muted-foreground">{text.feedbackHelp}</p>
    {!enabled && <Button variant="outline" size="sm" onClick={() => { void setResearchTasksEnabled(true).catch((cause) => setError(describeError(cause))); }}>{text.enable}</Button>}
    {object && object.relatedTasks.length > 0 && <label htmlFor={selectId} className="block space-y-1 text-xs">
      <span>{text.relatedTask}</span>
      <select id={selectId} className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2" value={taskId}
        disabled={!!object.continuationTaskId || !!pendingStart} onChange={(event) => setTaskId(event.target.value)}>
        <option value="">{text.chooseTask}</option>
        {object.relatedTasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {task.id}</option>)}
      </select>
    </label>}
    {pendingStart && <div className="space-y-2 rounded-md border p-2 text-xs">
      <p>{text.retryHelp}</p>
      <Button size="sm" disabled={starting} onClick={() => void start(pendingStart)}>{text.retryStart}</Button>
    </div>}
    {activeTask && <Button variant="link" size="sm" className="h-auto whitespace-normal px-0 text-left" onClick={() => {
      useResearchTasksStore.getState().openTaskDetail(activeTask.id, "annotations");
      useSettingsStore.getState().setRailTab("research");
    }}>{text.openTask} · {activeTask.title}</Button>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    {object && <TaskAnnotations contextScope="object" objectTarget={object.target} source={object.source} members={members}
      submitAnnotation={submit} onReplyChange={(annotation) => { void selectReply(annotation); }} onOpenTarget={onOpenTarget} requestHint={text.feedbackHelp} />}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { describeError } from "@/lib/app-error";
import { loadResearchTaskObservationCall, type ResearchTask, type TaskTranscriptEvent } from "@/lib/research-tasks";
import type { ResearchTaskAgentOption } from "./ResearchTasksPanel";
import { TaskSourceRead } from "./TaskObservations";
import { TaskGroupWorkView } from "./TaskGroupWorkView";
import { createTaskGroup, loadTaskAnnotations, loadTaskGroup, loadTaskGroupEvent, loadTaskGroupEventsAfter, loadTaskGroupEventsPage, loadTaskGroupExecution, loadTaskGroupExecutionsAfter, loadTaskGroupExecutionsPage, loadTaskGroupMessage, loadTaskGroupMessages, sendGroupMessage, setTaskGroupStatus, setGroupMemberPaused, setGroupMemberInterest, type AnnotationHandling, type GroupEvent, type GroupEventPage, type GroupExecutionPage, type GroupMessage, type GroupObject, type GroupSnapshot, type GroupWork, type MemberDraft, type MemberExecution, type MemberInterest, type TaskAnnotation, type WorkReason } from "@/lib/task-collaboration";

const objectLabel = (object: GroupObject) => `${object.kind} ${object.path ?? object.id}${object.revision ? ` · v${object.revision}` : ""}`;
const humanizeKind = (kind: string) => kind.replaceAll("_", " ");
const reasonKey = (reason: WorkReason) => [reason.kind, reason.sourceId, reason.executionId, reason.object?.kind, reason.object?.id, reason.object?.revision, reason.object?.path].join("\0");
const sourceReadKey = (workId: string, reason: WorkReason) => `${workId}\0${reasonKey(reason)}`;

type SourceReadState =
  | { status: "loading" }
  | { status: "observation"; execution: MemberExecution; row: TaskTranscriptEvent }
  | { status: "annotation"; annotation?: TaskAnnotation; handling?: AnnotationHandling }
  | { status: "unavailable"; source: "execution" | "record" }
  | { status: "error"; message: string };

const mergeById = <T extends { id: string }>(current: T[], incoming: T[]) => {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
};

const mergeEvents = (current: GroupEvent[], incoming: GroupEvent[]) =>
  mergeById(current, incoming).sort((left, right) => left.sequence - right.sequence);

const mergeExecutions = (current: MemberExecution[], incoming: MemberExecution[]) =>
  mergeById(current, incoming).sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id));

const latestExecution = (executions: MemberExecution[]) =>
  executions.reduce<MemberExecution | undefined>((latest, execution) =>
    !latest || execution.startedAt > latest.startedAt || (execution.startedAt === latest.startedAt && execution.id > latest.id) ? execution : latest, undefined);

export function TaskGroupPanel({ task, agents, onSnapshot, onAnnotate, onOpenResult }: { task: ResearchTask; agents: ResearchTaskAgentOption[]; onSnapshot?: (snapshot: GroupSnapshot | null) => void; onAnnotate?: (message: GroupMessage) => void; onOpenResult?: (target: import("@/lib/task-collaboration").AnnotationTarget) => void }) {
  const { t } = useTranslation("researchTools");
  const eligibleAgents = agents.filter(agent => agent.runtimeId === "builtin" && agent.available !== false && agent.agentId.trim() && agent.modelId.trim());
  const callbackRef = useRef(onSnapshot);
  callbackRef.current = onSnapshot;
  const snapshotRef = useRef<GroupSnapshot | null>(null);
  const scope = `${task.projectId}\0${task.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [snapshot, setSnapshot] = useState<GroupSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<(MemberDraft & { draftId: string })[]>([]);
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [requestWork, setRequestWork] = useState(false);
  const [interestMember, setInterestMember] = useState("");
  const [interestKind, setInterestKind] = useState<MemberInterest["kind"]>("path");
  const [interestValue, setInterestValue] = useState("");
  const [sourceReads, setSourceReads] = useState<Record<string, SourceReadState>>({});
  const [resolvedEvents, setResolvedEvents] = useState<Record<string, GroupEvent | null>>({});
  const [resolvingEvents, setResolvingEvents] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState<"events" | "executions" | "">("");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastUpdatedAtRef = useRef(task.updatedAt);
  const sourceReadVersionRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Bootstrap once per project/task scope so polling updates never reset editable member drafts.
  useEffect(() => {
    let active = true;
    refreshQueueRef.current = Promise.resolve();
    sourceReadVersionRef.current += 1;
    snapshotRef.current = null;
    callbackRef.current?.(null);
    setSnapshot(null); setLoaded(false); setError(""); setBusy(false);
    setBody(""); setRecipients([]); setReplyTo(null); setRequestWork(false);
    setInterestMember(""); setInterestValue(""); setSourceReads({}); setHistoryLoading(""); setResolvedEvents({}); setResolvingEvents([]);
    setMembers([{ draftId: "coordinator", name: task.title, responsibility: task.brief.goal, runtimeId: task.runtimeId, agentId: task.agentId, modelId: task.modelId, skillIds: task.skillIds, coordinator: true }]);
    const refresh = async () => {
      const operation = refreshQueueRef.current.then(async () => {
        const previous = snapshotRef.current;
        const result = previous
          ? await loadTaskGroupMessages(task.projectId, task.id, previous.group.id, previous.nextSequence)
          : await loadTaskGroup(task.projectId, task.id);
        if (!active) return;
        if (!result) {
          if (!previous) {
            callbackRef.current?.(null);
            setSnapshot(null); setLoaded(true); setError("");
          }
          return;
        }
        const current = snapshotRef.current;
        if (!previous) {
          snapshotRef.current = result;
          callbackRef.current?.(result);
          setSnapshot(result); setLoaded(true); setError("");
          return;
        }
        if (!current || current.group.id !== result.group.id) return;
        let events = current.events ?? [];
        const eventsHasMore = current.eventsHasMore;
        let eventCursor = events.at(-1)?.sequence ?? 0;
        while (active) {
          const page = await loadTaskGroupEventsAfter(task.projectId, task.id, current.group.id, eventCursor);
          events = mergeEvents(events, page.events);
          eventCursor = page.events.at(-1)?.sequence ?? eventCursor;
          if (!page.hasMore) break;
        }
        const executionCursorBeforeRefresh = latestExecution(current.executions);
        let executions = mergeExecutions(current.executions, result.executions);
        const executionsHasMore = current.executionsHasMore;
        let executionCursor = executionCursorBeforeRefresh;
        while (active) {
          const page = executionCursor
            ? await loadTaskGroupExecutionsAfter(task.projectId, task.id, current.group.id, executionCursor.startedAt, executionCursor.id)
            : await loadTaskGroupExecutionsAfter(task.projectId, task.id, current.group.id, 0, "");
          executions = mergeExecutions(executions, page.executions);
          executionCursor = latestExecution(page.executions) ?? executionCursor;
          if (!page.hasMore) break;
        }
        if (!active || scopeRef.current !== scope) return;
        const latest = snapshotRef.current;
        if (!latest || latest.group.id !== result.group.id) return;
        const merged: GroupSnapshot = {
          ...result,
          messages: mergeById(latest.messages, result.messages),
          events: mergeEvents(latest.events ?? [], events),
          executions: mergeExecutions(latest.executions, executions),
          eventsHasMore: latest.eventsHasMore ?? eventsHasMore,
          executionsHasMore: latest.executionsHasMore ?? executionsHasMore,
        };
        snapshotRef.current = merged;
        callbackRef.current?.(merged);
        setSnapshot(merged); setLoaded(true); setError("");
      }).catch(cause => {
        if (active) setError(describeError(cause));
      });
      refreshQueueRef.current = operation;
      await operation;
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { active = false; sourceReadVersionRef.current += 1; window.clearInterval(timer); };
  }, [scope]);
  useEffect(() => {
    if (lastUpdatedAtRef.current === task.updatedAt) return;
    lastUpdatedAtRef.current = task.updatedAt;
    void refreshRef.current();
  }, [task.updatedAt]);
  const act = async (operation: () => Promise<unknown>, done?: () => void) => {
    const original = scope;
    setBusy(true); setError("");
    try {
      await operation();
      if (scopeRef.current !== original) return;
      done?.();
      await refreshRef.current();
    } catch (cause) { if (scopeRef.current === original) setError(describeError(cause)); }
    finally { if (scopeRef.current === original) setBusy(false); }
  };
  const update = (index: number, patch: Partial<MemberDraft>) => setMembers(current => current.map((member, i) => i === index ? { ...member, ...patch } : member));
  const group = snapshot?.group;
  const memberName = (id: string) => snapshot?.members.find(member => member.id === id)?.name ?? id;
  const eventById = (id: string | undefined): GroupEvent | undefined => id ? snapshot?.events?.find(event => event.id === id) ?? (resolvedEvents[id] || undefined) : undefined;
  const loadOlderEvents = async () => {
    const current = snapshotRef.current;
    const first = current?.events?.[0];
    if (!current || !first || !current.eventsHasMore || historyLoading) return;
    const requestScope = scope;
    setHistoryLoading("events");
    try {
      const page: GroupEventPage = await loadTaskGroupEventsPage(task.projectId, task.id, current.group.id, first.sequence);
      if (scopeRef.current !== requestScope) return;
      setSnapshot(latest => {
        if (!latest) return latest;
        const merged = {
          ...latest,
          events: mergeEvents(latest.events ?? [], page.events),
          eventsHasMore: page.hasMore,
        };
        snapshotRef.current = merged;
        callbackRef.current?.(merged);
        return merged;
      });
    } catch (cause) {
      if (scopeRef.current === requestScope) setError(describeError(cause));
    } finally {
      if (scopeRef.current === requestScope) setHistoryLoading("");
    }
  };
  const loadOlderExecutions = async () => {
    const current = snapshotRef.current;
    const last = current?.executions.at(-1);
    if (!current || !last || !current.executionsHasMore || historyLoading) return;
    const requestScope = scope;
    setHistoryLoading("executions");
    try {
      const page: GroupExecutionPage = await loadTaskGroupExecutionsPage(task.projectId, task.id, current.group.id, last.startedAt, last.id);
      if (scopeRef.current !== requestScope) return;
      setSnapshot(latest => {
        if (!latest) return latest;
        const merged = {
          ...latest,
          executions: mergeExecutions(latest.executions, page.executions),
          executionsHasMore: page.hasMore,
        };
        snapshotRef.current = merged;
        callbackRef.current?.(merged);
        return merged;
      });
    } catch (cause) {
      if (scopeRef.current === requestScope) setError(describeError(cause));
    } finally {
      if (scopeRef.current === requestScope) setHistoryLoading("");
    }
  };
  const inspectEvent = async (id: string) => {
    if (!group) return null;
    if (resolvedEvents[id] !== undefined) return resolvedEvents[id];
    if (resolvingEvents.includes(id)) return null;
    const requestScope = scope;
    setResolvingEvents(current => [...current, id]);
    try {
      const event = await loadTaskGroupEvent(task.projectId, task.id, group.id, id);
      if (scopeRef.current === requestScope) setResolvedEvents(current => ({ ...current, [id]: event }));
      return event;
    } catch (cause) {
      if (scopeRef.current === requestScope) setError(describeError(cause));
      throw cause;
    } finally {
      if (scopeRef.current === requestScope) setResolvingEvents(current => current.filter(candidate => candidate !== id));
    }
  };
  const loadMessage = async (messageId: string) => {
    const current = snapshotRef.current;
    if (!current) return null;
    const requestScope = scope;
    const requestGroup = current.group.id;
    const message = await loadTaskGroupMessage(task.projectId, task.id, current.group.id, messageId);
    if (
      !message ||
      scopeRef.current !== requestScope ||
      snapshotRef.current?.group.id !== requestGroup
    ) return null;
    setSnapshot(currentSnapshot => {
      if (
        !currentSnapshot ||
        currentSnapshot.group.id !== requestGroup ||
        currentSnapshot.messages.some(candidate => candidate.id === message.id)
      ) return currentSnapshot;
      const nextSnapshot = {
        ...currentSnapshot,
        messages: mergeById(currentSnapshot.messages, [message]),
      };
      snapshotRef.current = nextSnapshot;
      callbackRef.current?.(nextSnapshot);
      return nextSnapshot;
    });
    return message;
  };
  const loadAnnotation = async (id: string) => {
    const context = await loadTaskAnnotations(task.projectId, task.id);
    return context.annotations.find(candidate => candidate.id === id) ?? null;
  };
  const reasonLabel = (reason: WorkReason) => {
    switch (reason.kind) {
      case "explicit_recipient": return t($ => $.researchTools.tasks.group.reasonExplicitRecipient);
      case "reply": return t($ => $.researchTools.tasks.group.reasonReply);
      case "mention": return t($ => $.researchTools.tasks.group.reasonMention);
      case "interest_path": return t($ => $.researchTools.tasks.group.reasonInterestPath);
      case "interest_object": return t($ => $.researchTools.tasks.group.reasonInterestObject);
      case "interest_event": return t($ => $.researchTools.tasks.group.reasonInterestEvent);
      case "read": return t($ => $.researchTools.tasks.group.reasonRead);
      case "wrote": return t($ => $.researchTools.tasks.group.reasonWrote);
      case "handled": return t($ => $.researchTools.tasks.group.reasonHandled);
      case "parent_handling": return t($ => $.researchTools.tasks.group.reasonParentHandling);
      case "coordinator": return t($ => $.researchTools.tasks.group.reasonCoordinator);
      case "responsibility": return t($ => $.researchTools.tasks.group.reasonResponsibility);
      default: return t($ => $.researchTools.tasks.group.reasonOther, { kind: humanizeKind(reason.kind) });
    }
  };
  const relationLabel = (relation: NonNullable<GroupSnapshot["attentions"]>[number]["relation"]) => relation === "read"
    ? t($ => $.researchTools.tasks.group.attentionRead)
    : relation === "wrote"
      ? t($ => $.researchTools.tasks.group.attentionWrote)
      : t($ => $.researchTools.tasks.group.attentionHandled);
  const reasonSource = (reason: WorkReason) => {
    const event = eventById(reason.sourceId);
    const message = snapshot?.messages.find(candidate => candidate.id === reason.sourceId);
    return <>{event ? <><p><strong>{t($ => $.researchTools.tasks.group.eventChange)}</strong>: {humanizeKind(event.kind)} · {objectLabel(event.object)}</p><p className="whitespace-pre-wrap"><strong>{t($ => $.researchTools.tasks.group.eventDetail)}</strong>: {event.detail}</p>{event.evidence ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(event.evidence, null, 2)}</pre> : null}</> : message ? <p className="whitespace-pre-wrap">{t($ => $.researchTools.tasks.group.messageSource, { body: message.body })}</p> : reason.sourceId ? <p>{t($ => $.researchTools.tasks.group.sourceLabel, { id: reason.sourceId })}</p> : null}</>;
  };
  const annotationSourceReason = (work: GroupWork, reason: WorkReason) =>
    reason.kind === "handled"
    || reason.kind === "parent_handling"
    || (work.causeKind === "annotation" && reason.kind === "mention");
  const canReadSource = (work: GroupWork, reason: WorkReason) =>
    Boolean(reason.sourceId && (reason.kind === "read" || reason.kind === "wrote" || annotationSourceReason(work, reason)));
  const inspectSource = async (work: GroupWork, reason: WorkReason) => {
    const key = sourceReadKey(work.id, reason);
    const requestScope = scope;
    const requestVersion = sourceReadVersionRef.current;
    const update = (state: SourceReadState) => {
      if (scopeRef.current === requestScope && sourceReadVersionRef.current === requestVersion) {
        setSourceReads(current => ({ ...current, [key]: state }));
      }
    };
    update({ status: "loading" });
    try {
      if (reason.kind === "read" || reason.kind === "wrote") {
        const execution = snapshot?.executions.find(candidate => candidate.id === reason.executionId)
          ?? (group && reason.executionId ? await loadTaskGroupExecution(task.projectId, task.id, group.id, reason.executionId) : null);
        if (!execution) {
          update({ status: "unavailable", source: "execution" });
          return;
        }
        const callId = reason.sourceId;
        if (!callId) {
          update({ status: "unavailable", source: "record" });
          return;
        }
        const row = await loadResearchTaskObservationCall(task.id, execution.taskGeneration, callId);
        if (scopeRef.current !== requestScope || sourceReadVersionRef.current !== requestVersion) return;
        update(row ? { status: "observation", execution, row } : { status: "unavailable", source: "record" });
        return;
      }
      const context = await loadTaskAnnotations(task.projectId, task.id);
      if (scopeRef.current !== requestScope || sourceReadVersionRef.current !== requestVersion) return;
      const handling = reason.kind === "handled" || reason.kind === "parent_handling"
        ? context.handlings.find(candidate => candidate.id === reason.sourceId)
        : undefined;
      const annotation = handling
        ? context.annotations.find(candidate => candidate.id === handling.annotationId)
        : context.annotations.find(candidate => candidate.id === reason.sourceId);
      if (!handling && !annotation) {
        update({ status: "unavailable", source: "record" });
        return;
      }
      update({ status: "annotation", annotation, handling });
    } catch (cause) {
      update({ status: "error", message: describeError(cause) });
    }
  };
  const renderSourceRead = (state: SourceReadState | undefined) => {
    if (!state) return null;
    if (state.status === "loading") return <p role="status">{t($ => $.researchTools.tasks.group.sourceLoading)}</p>;
    if (state.status === "unavailable") return <p role="alert">{state.source === "execution" ? t($ => $.researchTools.tasks.group.sourceExecutionUnavailable) : t($ => $.researchTools.tasks.group.sourceRecordUnavailable)}</p>;
    if (state.status === "error") return <p role="alert" className="text-destructive">{state.message}</p>;
    if (state.status === "observation") return <div className="space-y-1">
      <p>{t($ => $.researchTools.tasks.group.sourceGeneration, { generation: state.execution.taskGeneration })} · <code>{state.execution.id}</code></p>
      <CodeBlock code={JSON.stringify(state.row, null, 2)} preClassName="max-h-72 whitespace-pre-wrap break-all" />
      {state.row.event.kind === "observation" && state.row.event.observation.type === "toolExecution" && state.row.event.observation.source
        ? <TaskSourceRead key={`${state.execution.id}:${state.row.sequence}`} taskId={task.id} generation={state.execution.taskGeneration} row={state.row} source={state.row.event.observation.source} />
        : <p className="text-muted-foreground">{t($ => $.researchTools.tasks.group.sourceMetadataOnly)}</p>}
    </div>;
    return <div className="space-y-2">
      {state.annotation ? <div>
        <p><strong>{t($ => $.researchTools.tasks.group.annotationSource)}</strong> · <code>{state.annotation.id}</code></p>
        <p className="break-all text-muted-foreground">{state.annotation.author.kind}: {state.annotation.author.id}</p>
        <p className="whitespace-pre-wrap break-words">{state.annotation.body}</p>
      </div> : <p role="alert">{t($ => $.researchTools.tasks.group.sourceRecordUnavailable)}</p>}
      {state.handling ? <div>
        <p><strong>{t($ => $.researchTools.tasks.group.handlingSource)}</strong> · <code>{state.handling.id}</code></p>
        <p className="break-all text-muted-foreground">{state.handling.author.kind}: {state.handling.author.id}</p>
        <p className="whitespace-pre-wrap break-words">{state.handling.summary}</p>
        {state.handling.resultRefs.length > 0 ? <div>
          <p>{t($ => $.researchTools.tasks.annotations.resultRefs)}</p>
          <ul className="list-disc pl-4">{state.handling.resultRefs.map(result => <li className="break-all" key={`${result.objectKind}:${result.objectId}:${result.objectRevision}:${result.path}`}>{objectLabel({ kind: result.objectKind, id: result.objectId, revision: result.objectRevision, path: result.path })}</li>)}</ul>
        </div> : null}
      </div> : null}
    </div>;
  };
  return <section className="space-y-3" aria-label={t($ => $.researchTools.tasks.group.title)}>
    <h3 className="text-sm font-medium">{t($ => $.researchTools.tasks.group.title)}</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void refreshRef.current()}>{t($ => $.researchTools.tasks.group.refresh)}</Button>
    {!loaded ? <p>{t($ => $.researchTools.tasks.group.loading)}</p> : !group ? task.runtimeId !== "builtin" ? <p>{t($ => $.researchTools.tasks.group.acpUnsupported)}</p> : <div className="space-y-3">
      {members.map((member, index) => <fieldset key={member.draftId} className="space-y-2 rounded border p-2" disabled={busy}>
        <legend>{member.coordinator ? t($ => $.researchTools.tasks.group.coordinator) : t($ => $.researchTools.tasks.group.member)}</legend>
        <Input className="w-full rounded border p-2" aria-label={t($ => $.researchTools.tasks.group.name)} placeholder={t($ => $.researchTools.tasks.group.name)} value={member.name} onChange={event => update(index, { name: event.target.value })} />
        <Input className="w-full rounded border p-2" aria-label={t($ => $.researchTools.tasks.group.responsibility)} placeholder={t($ => $.researchTools.tasks.group.responsibility)} value={member.responsibility} onChange={event => update(index, { responsibility: event.target.value })} />
        {member.coordinator ? <p className="text-xs">{member.runtimeId} / {member.agentId} / {member.modelId}</p> : <select aria-label={t($ => $.researchTools.tasks.group.model)} className="w-full rounded border p-2" value={eligibleAgents.findIndex(agent => agent.runtimeId === member.runtimeId && agent.agentId === member.agentId && agent.modelId === member.modelId)} onChange={event => { const agent = eligibleAgents[Number(event.target.value)]; if (agent) update(index, { runtimeId: agent.runtimeId, agentId: agent.agentId, modelId: agent.modelId }); }}>
          <option value={-1}>{t($ => $.researchTools.tasks.group.chooseModel)}</option>{eligibleAgents.map((agent, i) => <option key={`${agent.runtimeId}:${agent.agentId}:${agent.modelId}`} value={i} disabled={agent.available === false}>{agent.label}</option>)}
        </select>}
        {!member.coordinator && <Button size="xs" variant="outline" onClick={() => setMembers(current => current.filter((_, i) => i !== index))}>{t($ => $.researchTools.tasks.group.remove)}</Button>}
      </fieldset>)}
      <Button size="xs" variant="outline" disabled={busy || members.length >= 8} onClick={() => setMembers(current => [...current, { draftId: crypto.randomUUID(), name: "", responsibility: "", runtimeId: "", agentId: "", modelId: "", skillIds: [], coordinator: false }])}>{t($ => $.researchTools.tasks.group.addMember)}</Button>
      <Button size="xs" disabled={busy || !members.every(member => member.name.trim() && member.responsibility.trim() && member.agentId && member.modelId)} onClick={() => void act(() => createTaskGroup(task.projectId, task.id, members.map(({ draftId: _draftId, ...member }) => member)))}>{t($ => $.researchTools.tasks.group.create)}</Button>
    </div> : snapshot && <div className="space-y-3">
      <label>{t($ => $.researchTools.tasks.group.status)} <select disabled={busy} value={group.status} onChange={event => void act(() => setTaskGroupStatus(task.projectId, group.id, event.target.value as GroupSnapshot["group"]["status"]))}>{["open", "paused", "closed"].map(status => <option key={status} value={status}>{status}</option>)}</select></label>
      <TaskGroupWorkView
        key={`${task.projectId}\0${task.id}\0${group.id}`}
        snapshot={snapshot}
        busy={busy}
        loadMessage={loadMessage}
        loadEvent={inspectEvent}
        loadAnnotation={loadAnnotation}
        onReply={message => setReplyTo(message.id)}
        onAnnotate={onAnnotate}
        onOpenResult={onOpenResult}
        renderDiagnostics={work => {
        const reasons = work.reasons ?? [];
        const causeEvent = work.causeKind === "event" ? eventById(work.causeId) : undefined;
        const hasReasonDetails = reasons.some(reason => reason.sourceId || reason.executionId);
        return <div className="space-y-2 text-xs">
          {causeEvent ? <div className="rounded bg-muted/40 p-2">
            <p><strong>{t($ => $.researchTools.tasks.group.eventChange)}</strong>: {humanizeKind(causeEvent.kind)} · {objectLabel(causeEvent.object)}</p>
            <p className="whitespace-pre-wrap"><strong>{t($ => $.researchTools.tasks.group.eventDetail)}</strong>: {causeEvent.detail}</p>
            {causeEvent.evidence ? <details><summary>{t($ => $.researchTools.tasks.group.sourceAndExecution)}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(causeEvent.evidence, null, 2)}</pre></details> : null}
          </div> : work.causeKind === "event" ? <p>{t($ => $.researchTools.tasks.group.eventUnavailable, { id: work.causeId })} <Button size="xs" variant="ghost" disabled={resolvingEvents.includes(work.causeId)} onClick={() => void inspectEvent(work.causeId)}>{t($ => $.researchTools.tasks.group.sourceInspect)}</Button></p> : <p>{work.causeKind}: {work.causeId}</p>}
          <div>
            <p className="font-medium">{t($ => $.researchTools.tasks.group.wakeReasons)}</p>
            {reasons.length > 0 ? <ul className="list-disc space-y-1 pl-4">{reasons.map(reason => <li key={reasonKey(reason)}>
              {reasonLabel(reason)}{reason.object ? ` · ${objectLabel(reason.object)}` : ""}{reason.detail ? <p className="whitespace-pre-wrap">{reason.detail}</p> : null}
            </li>)}</ul> : <p role="status">{t($ => $.researchTools.tasks.group.noWakeReasons)}</p>}
          </div>
          <details>
            <summary>{t($ => $.researchTools.tasks.group.sourceAndExecution)}</summary>
            <div className="mt-1 space-y-1">
              {reasons.map(reason => {
                if (!reason.sourceId && !reason.executionId) return null;
                const state = sourceReads[sourceReadKey(work.id, reason)];
                return <div key={`${reasonKey(reason)}:source`}>
                  {reasonSource(reason)}
                  {reason.executionId && <p>{t($ => $.researchTools.tasks.group.execution)}: {reason.executionId}</p>}
                  {canReadSource(work, reason) ? <div className="space-y-1">
                    <Button size="xs" variant="outline" disabled={state?.status === "loading"} data-testid={`source-${work.id}-${reason.kind}`} onClick={() => void inspectSource(work, reason)}>{t($ => $.researchTools.tasks.group.sourceInspect)}</Button>
                    {renderSourceRead(state)}
                  </div> : null}
                </div>;
              })}
              {work.executionId && <p>{t($ => $.researchTools.tasks.group.execution)}: {work.executionId}</p>}
              {causeEvent && <p>{t($ => $.researchTools.tasks.group.sourceLabel, { id: causeEvent.id })}</p>}
              {!hasReasonDetails && !work.executionId && !causeEvent && <p>{t($ => $.researchTools.tasks.group.noCauseDetails)}</p>}
            </div>
          </details>
        </div>;
        }}
      />
      {snapshot.members.map(member => <div key={member.id} className="rounded border p-2 text-sm"><strong>{member.name}</strong> · {member.responsibility}<p className="text-xs">{member.runtimeId} / {member.agentId} / {member.modelId}</p><label><input type="checkbox" disabled={busy} checked={member.paused} onChange={event => void act(() => setGroupMemberPaused(task.projectId, group.id, member.id, event.target.checked))} /> {t($ => $.researchTools.tasks.group.paused)}</label></div>)}
      <fieldset className="space-y-2 rounded border p-2" disabled={busy}><legend>{t($ => $.researchTools.tasks.group.explicitInterests)}</legend>
        {snapshot.interests.map(interest => <div key={`${interest.memberId}:${interest.kind}:${interest.value}`}>{memberName(interest.memberId)} · {interest.kind}: {interest.value} <Button size="xs" variant="ghost" onClick={() => void act(() => setGroupMemberInterest(task.projectId, group.id, interest, false))}>{t($ => $.researchTools.tasks.group.remove)}</Button></div>)}
        <select aria-label={t($ => $.researchTools.tasks.group.member)} value={interestMember} onChange={event => setInterestMember(event.target.value)}><option value="">{t($ => $.researchTools.tasks.group.member)}</option>{snapshot.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
        <select aria-label={t($ => $.researchTools.tasks.group.interestKind)} value={interestKind} onChange={event => setInterestKind(event.target.value as MemberInterest["kind"])}>{["path", "object", "event"].map(kind => <option key={kind}>{kind}</option>)}</select>
        <Input aria-label={t($ => $.researchTools.tasks.group.interestValue)} value={interestValue} onChange={event => setInterestValue(event.target.value)} />
        <Button size="xs" disabled={!interestMember || !interestValue.trim()} onClick={() => void act(() => setGroupMemberInterest(task.projectId, group.id, { memberId: interestMember, kind: interestKind, value: interestValue.trim() }, true), () => setInterestValue(""))}>{t($ => $.researchTools.tasks.group.addInterest)}</Button>
      </fieldset>
      <details className="rounded border p-2 text-sm">
        <summary>{t($ => $.researchTools.tasks.group.actualAttention)}</summary>
        <p className="mt-2 text-xs">{t($ => $.researchTools.tasks.group.actualAttentionHelp)}</p>
        {snapshot.attentions === undefined ? <p className="mt-2 text-xs">{t($ => $.researchTools.tasks.group.attentionUnavailable)}</p> : snapshot.attentions.length === 0 ? <p className="mt-2 text-xs">{t($ => $.researchTools.tasks.group.attentionEmpty)}</p> : snapshot.members.map(member => {
          const attentions = (snapshot.attentions ?? []).filter(attention => attention.memberId === member.id);
          return attentions.length > 0 ? <details className="mt-2 text-xs" data-testid={`attention-${member.id}`} key={member.id}>
            <summary>{member.name} · {attentions.length}</summary>
            <ul className="mt-1 space-y-1">{attentions.map(attention => <li key={`${attention.memberId}:${attention.object.kind}:${attention.object.id}:${attention.relation}`}>
              <strong>{relationLabel(attention.relation)}</strong> · {objectLabel(attention.object)}
              <p>{t($ => $.researchTools.tasks.group.sourceLabel, { id: attention.sourceId })}{attention.executionId ? ` · ${t($ => $.researchTools.tasks.group.execution)}: ${attention.executionId}` : ""}</p>
              <time dateTime={new Date(attention.updatedAt).toISOString()}>{new Date(attention.updatedAt).toLocaleString()}</time>
            </li>)}</ul>
          </details> : null;
        })}
      </details>
      {snapshot.eventsHasMore && <Button size="xs" variant="outline" disabled={historyLoading !== ""} onClick={() => void loadOlderEvents()}>{t($ => $.researchTools.tasks.group.loadEarlierEvents)}</Button>}
      <ol className="space-y-2">{snapshot.messages.map(message => <li id={`group-message-${message.id}`} key={message.id} className="rounded border p-2 text-sm"><p>{message.author.kind === "member" ? memberName(message.author.id) : message.author.kind}{message.replyTo && ` ↩ ${message.replyTo}`}{message.recipients.map(memberName).map(name => ` @${name}`).join("")}</p><p className="whitespace-pre-wrap">{message.body}</p><Button size="xs" variant="ghost" onClick={() => setReplyTo(message.id)}>{t($ => $.researchTools.tasks.group.reply)}</Button>{onAnnotate ? <Button size="xs" variant="ghost" onClick={() => onAnnotate(message)}>{t($ => $.researchTools.tasks.annotations.annotate)}</Button> : null}</li>)}</ol>
      <fieldset className="space-y-2" disabled={busy}>
        {replyTo && <p>{t($ => $.researchTools.tasks.group.reply)}: {replyTo} <Button size="xs" variant="ghost" onClick={() => setReplyTo(null)}>{t($ => $.researchTools.tasks.group.remove)}</Button></p>}
        <div>{snapshot.members.map(member => <label className="mr-2" key={member.id}><input type="checkbox" checked={recipients.includes(member.id)} onChange={event => setRecipients(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} /> {`@${member.name}`}</label>)}</div>
        <Textarea className="w-full rounded border p-2" aria-label={t($ => $.researchTools.tasks.group.message)} value={body} onChange={event => setBody(event.target.value)} />
        <label><input type="checkbox" checked={requestWork} onChange={event => setRequestWork(event.target.checked)} /> {t($ => $.researchTools.tasks.group.requestWork)}</label>
        <Button size="xs" disabled={!body.trim()} onClick={() => void act(() => sendGroupMessage(task.projectId, group.id, { body: body.trim(), recipients, replyTo, requestWork, object: null }), () => { setBody(""); setReplyTo(null); setRequestWork(false); })}>{t($ => $.researchTools.tasks.group.send)}</Button>
      </fieldset>
      {snapshot.executionsHasMore && <Button size="xs" variant="outline" disabled={historyLoading !== ""} onClick={() => void loadOlderExecutions()}>{t($ => $.researchTools.tasks.group.loadEarlierExecutions)}</Button>}
      {snapshot.executions.map(execution => <p key={execution.id} className="text-xs">{execution.id} · {memberName(execution.memberId)} · {execution.runtimeId}/{execution.agentId}/{execution.modelId} · {execution.status} · {execution.inputTokens ?? "?"}/{execution.outputTokens ?? "?"}</p>)}
    </div>}
  </section>;
}

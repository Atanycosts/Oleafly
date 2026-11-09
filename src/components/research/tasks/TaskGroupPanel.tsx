import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { describeError } from "@/lib/app-error";
import { loadResearchTaskObservationCall, type ResearchTask, type TaskTranscriptEvent } from "@/lib/research-tasks";
import type { ResearchTaskAgentOption } from "./ResearchTasksPanel";
import { createTaskGroup, loadTaskAnnotations, loadTaskGroup, loadTaskGroupMessages, sendGroupMessage, setTaskGroupStatus, setGroupMemberPaused, setGroupMemberInterest, type AnnotationHandling, type GroupEvent, type GroupMessage, type GroupObject, type GroupSnapshot, type GroupWork, type MemberDraft, type MemberExecution, type MemberInterest, type TaskAnnotation, type WorkReason } from "@/lib/task-collaboration";

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

export function TaskGroupPanel({ task, agents, onSnapshot, onAnnotate }: { task: ResearchTask; agents: ResearchTaskAgentOption[]; onSnapshot?: (snapshot: GroupSnapshot | null) => void; onAnnotate?: (message: GroupMessage) => void }) {
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
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const sourceReadVersionRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Bootstrap once per project/task scope so polling updates never reset editable member drafts.
  useEffect(() => {
    let active = true;
    let loading = false;
    sourceReadVersionRef.current += 1;
    snapshotRef.current = null;
    callbackRef.current?.(null);
    setSnapshot(null); setLoaded(false); setError(""); setBusy(false);
    setBody(""); setRecipients([]); setReplyTo(null); setRequestWork(false);
    setInterestMember(""); setInterestValue(""); setSourceReads({});
    setMembers([{ draftId: "coordinator", name: task.title, responsibility: task.brief.goal, runtimeId: task.runtimeId, agentId: task.agentId, modelId: task.modelId, skillIds: task.skillIds, coordinator: true }]);
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const previous = snapshotRef.current;
        const result = previous ? await loadTaskGroupMessages(task.projectId, previous.group.id, previous.nextSequence) : await loadTaskGroup(task.projectId, task.id);
        if (active) {
          const merged = result && previous ? {
            ...result,
            messages: [...previous.messages, ...result.messages.filter(message => !previous.messages.some(old => old.id === message.id))],
            events: previous.events || result.events ? [...(previous.events ?? []), ...(result.events ?? []).filter(event => !(previous.events ?? []).some(old => old.id === event.id))] : undefined,
          } : result;
          snapshotRef.current = merged;
          callbackRef.current?.(merged);
          setSnapshot(merged); setLoaded(true); setError("");
        }
      } catch (cause) { if (active) { setError(describeError(cause)); } }
      finally { loading = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { active = false; sourceReadVersionRef.current += 1; window.clearInterval(timer); };
  }, [scope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt deliberately triggers the current scope-bound refresh without rebuilding its subscription.
  useEffect(() => { void refreshRef.current(); }, [task.updatedAt]);
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
  const eventById = (id: string | undefined): GroupEvent | undefined => id ? snapshot?.events?.find(event => event.id === id) : undefined;
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
    return <>{event ? <><p><strong>{t($ => $.researchTools.tasks.group.eventChange)}</strong>: {humanizeKind(event.kind)} · {objectLabel(event.object)}</p><p className="whitespace-pre-wrap"><strong>{t($ => $.researchTools.tasks.group.eventDetail)}</strong>: {event.detail}</p></> : message ? <p className="whitespace-pre-wrap">{t($ => $.researchTools.tasks.group.messageSource, { body: message.body })}</p> : reason.sourceId ? <p>{t($ => $.researchTools.tasks.group.sourceLabel, { id: reason.sourceId })}</p> : null}</>;
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
        const execution = snapshot?.executions.find(candidate => candidate.id === reason.executionId);
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
      <p className="text-muted-foreground">{t($ => $.researchTools.tasks.group.sourceMetadataOnly)}</p>
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
      <ol className="space-y-2">{snapshot.messages.map(message => <li id={`group-message-${message.id}`} key={message.id} className="rounded border p-2 text-sm"><p>{message.author.kind === "member" ? memberName(message.author.id) : message.author.kind}{message.replyTo && ` ↩ ${message.replyTo}`}{message.recipients.map(memberName).map(name => ` @${name}`).join("")}</p><p className="whitespace-pre-wrap">{message.body}</p><Button size="xs" variant="ghost" onClick={() => setReplyTo(message.id)}>{t($ => $.researchTools.tasks.group.reply)}</Button>{onAnnotate ? <Button size="xs" variant="ghost" onClick={() => onAnnotate(message)}>{t($ => $.researchTools.tasks.annotations.annotate)}</Button> : null}</li>)}</ol>
      <fieldset className="space-y-2" disabled={busy}>
        {replyTo && <p>{t($ => $.researchTools.tasks.group.reply)}: {replyTo} <Button size="xs" variant="ghost" onClick={() => setReplyTo(null)}>{t($ => $.researchTools.tasks.group.remove)}</Button></p>}
        <div>{snapshot.members.map(member => <label className="mr-2" key={member.id}><input type="checkbox" checked={recipients.includes(member.id)} onChange={event => setRecipients(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} /> {`@${member.name}`}</label>)}</div>
        <Textarea className="w-full rounded border p-2" aria-label={t($ => $.researchTools.tasks.group.message)} value={body} onChange={event => setBody(event.target.value)} />
        <label><input type="checkbox" checked={requestWork} onChange={event => setRequestWork(event.target.checked)} /> {t($ => $.researchTools.tasks.group.requestWork)}</label>
        <Button size="xs" disabled={!body.trim()} onClick={() => void act(() => sendGroupMessage(task.projectId, group.id, { body: body.trim(), recipients, replyTo, requestWork, object: null }), () => { setBody(""); setReplyTo(null); setRequestWork(false); })}>{t($ => $.researchTools.tasks.group.send)}</Button>
      </fieldset>
      <h4 className="text-sm font-medium">{t($ => $.researchTools.tasks.group.work)}</h4>
      {snapshot.work.map(work => {
        const reasons = work.reasons ?? [];
        const causeEvent = work.causeKind === "event" ? eventById(work.causeId) : undefined;
        const hasReasonDetails = reasons.some(reason => reason.sourceId || reason.executionId);
        return <div className="space-y-2 rounded border p-2 text-xs" data-testid={`work-${work.id}`} key={work.id}>
          <p><strong>{memberName(work.memberId)}</strong> · {work.status}</p>
          {causeEvent ? <div className="rounded bg-muted/40 p-2">
            <p><strong>{t($ => $.researchTools.tasks.group.eventChange)}</strong>: {humanizeKind(causeEvent.kind)} · {objectLabel(causeEvent.object)}</p>
            <p className="whitespace-pre-wrap"><strong>{t($ => $.researchTools.tasks.group.eventDetail)}</strong>: {causeEvent.detail}</p>
          </div> : work.causeKind === "event" ? <p>{t($ => $.researchTools.tasks.group.eventUnavailable, { id: work.causeId })}</p> : <p>{work.causeKind}: {work.causeId}</p>}
          <div>
            <p className="font-medium">{t($ => $.researchTools.tasks.group.wakeReasons)}</p>
            {reasons.length > 0 ? <ul className="list-disc space-y-1 pl-4">{reasons.map(reason => <li key={reasonKey(reason)}>
              {reasonLabel(reason)}{reason.object ? ` · ${objectLabel(reason.object)}` : ""}
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
          {work.resultMessageId && <a className="underline" href={`#group-message-${work.resultMessageId}`}>{snapshot.messages.find(message => message.id === work.resultMessageId)?.body ?? work.resultMessageId}</a>}
        </div>;
      })}
      {snapshot.executions.map(execution => <p key={execution.id} className="text-xs">{execution.id} · {memberName(execution.memberId)} · {execution.runtimeId}/{execution.agentId}/{execution.modelId} · {execution.status} · {execution.inputTokens ?? "?"}/{execution.outputTokens ?? "?"}</p>)}
    </div>}
  </section>;
}

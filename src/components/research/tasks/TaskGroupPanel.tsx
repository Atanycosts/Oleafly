import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/app-error";
import type { ResearchTask } from "@/lib/research-tasks";
import type { ResearchTaskAgentOption } from "./ResearchTasksPanel";
import { createTaskGroup, loadTaskGroup, loadTaskGroupMessages, sendGroupMessage, setTaskGroupStatus, setGroupMemberPaused, setGroupMemberInterest, type GroupMessage, type GroupSnapshot, type MemberDraft, type MemberInterest } from "@/lib/task-collaboration";

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
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Bootstrap once per project/task scope so polling updates never reset editable member drafts.
  useEffect(() => {
    let active = true;
    let loading = false;
    snapshotRef.current = null;
    callbackRef.current?.(null);
    setSnapshot(null); setLoaded(false); setError(""); setBusy(false);
    setBody(""); setRecipients([]); setReplyTo(null); setRequestWork(false);
    setInterestMember(""); setInterestValue("");
    setMembers([{ draftId: "coordinator", name: task.title, responsibility: task.brief.goal, runtimeId: task.runtimeId, agentId: task.agentId, modelId: task.modelId, skillIds: task.skillIds, coordinator: true }]);
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const previous = snapshotRef.current;
        const result = previous ? await loadTaskGroupMessages(task.projectId, previous.group.id, previous.nextSequence) : await loadTaskGroup(task.projectId, task.id);
        if (active) {
          const merged = result && previous ? { ...result, messages: [...previous.messages, ...result.messages.filter(message => !previous.messages.some(old => old.id === message.id))] } : result;
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
    return () => { active = false; window.clearInterval(timer); };
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
      <fieldset className="space-y-2 rounded border p-2" disabled={busy}><legend>{t($ => $.researchTools.tasks.group.interests)}</legend>
        {snapshot.interests.map(interest => <div key={`${interest.memberId}:${interest.kind}:${interest.value}`}>{memberName(interest.memberId)} · {interest.kind}: {interest.value} <Button size="xs" variant="ghost" onClick={() => void act(() => setGroupMemberInterest(task.projectId, group.id, interest, false))}>{t($ => $.researchTools.tasks.group.remove)}</Button></div>)}
        <select aria-label={t($ => $.researchTools.tasks.group.member)} value={interestMember} onChange={event => setInterestMember(event.target.value)}><option value="">{t($ => $.researchTools.tasks.group.member)}</option>{snapshot.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
        <select aria-label={t($ => $.researchTools.tasks.group.interestKind)} value={interestKind} onChange={event => setInterestKind(event.target.value as MemberInterest["kind"])}>{["path", "object", "event"].map(kind => <option key={kind}>{kind}</option>)}</select>
        <Input aria-label={t($ => $.researchTools.tasks.group.interestValue)} value={interestValue} onChange={event => setInterestValue(event.target.value)} />
        <Button size="xs" disabled={!interestMember || !interestValue.trim()} onClick={() => void act(() => setGroupMemberInterest(task.projectId, group.id, { memberId: interestMember, kind: interestKind, value: interestValue.trim() }, true), () => setInterestValue(""))}>{t($ => $.researchTools.tasks.group.addInterest)}</Button>
      </fieldset>
      <ol className="space-y-2">{snapshot.messages.map(message => <li id={`group-message-${message.id}`} key={message.id} className="rounded border p-2 text-sm"><p>{message.author.kind === "member" ? memberName(message.author.id) : message.author.kind}{message.replyTo && ` ↩ ${message.replyTo}`}{message.recipients.map(memberName).map(name => ` @${name}`).join("")}</p><p className="whitespace-pre-wrap">{message.body}</p><Button size="xs" variant="ghost" onClick={() => setReplyTo(message.id)}>{t($ => $.researchTools.tasks.group.reply)}</Button>{onAnnotate ? <Button size="xs" variant="ghost" onClick={() => onAnnotate(message)}>{t($ => $.researchTools.tasks.annotations.annotate)}</Button> : null}</li>)}</ol>
      <fieldset className="space-y-2" disabled={busy}>
        {replyTo && <p>{t($ => $.researchTools.tasks.group.reply)}: {replyTo} <Button size="xs" variant="ghost" onClick={() => setReplyTo(null)}>{t($ => $.researchTools.tasks.group.remove)}</Button></p>}
        <div>{snapshot.members.map(member => <label className="mr-2" key={member.id}><input type="checkbox" checked={recipients.includes(member.id)} onChange={event => setRecipients(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} /> {`@${member.name}`}</label>)}</div>
        <Textarea className="w-full rounded border p-2" aria-label={t($ => $.researchTools.tasks.group.message)} value={body} onChange={event => setBody(event.target.value)} />
        <label><input type="checkbox" checked={requestWork} onChange={event => setRequestWork(event.target.checked)} /> {t($ => $.researchTools.tasks.group.requestWork)}</label>
        <Button size="xs" disabled={!body.trim()} onClick={() => void act(() => sendGroupMessage(task.projectId, group.id, { body: body.trim(), recipients, replyTo, requestWork, object: null }), () => { setBody(""); setReplyTo(null); setRequestWork(false); })}>{t($ => $.researchTools.tasks.group.send)}</Button>
      </fieldset>
      <h4 className="text-sm font-medium">{t($ => $.researchTools.tasks.group.work)}</h4>
      {snapshot.work.map(work => <div className="rounded border p-2 text-xs" key={work.id}>{memberName(work.memberId)} · {work.status}<p>{work.causeKind}: {work.causeId}</p>{work.executionId && <p>{t($ => $.researchTools.tasks.group.execution)}: {work.executionId}</p>}{work.resultMessageId && <a className="underline" href={`#group-message-${work.resultMessageId}`}>{snapshot.messages.find(message => message.id === work.resultMessageId)?.body ?? work.resultMessageId}</a>}</div>)}
      {snapshot.executions.map(execution => <p key={execution.id} className="text-xs">{execution.id} · {memberName(execution.memberId)} · {execution.runtimeId}/{execution.agentId}/{execution.modelId} · {execution.status} · {execution.inputTokens ?? "?"}/{execution.outputTokens ?? "?"}</p>)}
    </div>}
  </section>;
}

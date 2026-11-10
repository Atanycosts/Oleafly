import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/app-error";
import { formatDateTime } from "@/lib/intl";
import type { ResearchTask } from "@/lib/research-tasks";
import {
  loadObjectAnnotations, loadTaskAnnotations, submitTaskAnnotation,
  type AnnotationAuthor, type AnnotationContext, type AnnotationSourceDraft, type AnnotationTarget, type GroupMember, type TaskAnnotation, type TaskAnnotationDraft,
} from "@/lib/task-collaboration";

interface AnnotationPanelOptions {
  members?: GroupMember[];
  revision?: number;
  onOpenTarget?: (target: AnnotationTarget) => void;
  onSaved?: (annotation: TaskAnnotation) => void;
  onExplicitRequest?: (body: string) => Promise<void>;
  submitAnnotation?: (draft: TaskAnnotationDraft) => Promise<TaskAnnotation>;
  onReplyChange?: (annotation: TaskAnnotation | null) => void;
  requestHint?: string;
  source?: AnnotationSourceDraft;
  loadSource?: (target: AnnotationTarget) => Promise<AnnotationSourceDraft | undefined>;
}

export type TaskAnnotationsProps = AnnotationPanelOptions & (
  | { task: ResearchTask; target: AnnotationTarget | null; contextScope?: "task"; objectTarget?: never }
  | { contextScope: "object"; objectTarget: AnnotationTarget; task?: never; target?: never }
);

function TargetReference({ target, onOpen }: Readonly<{ target: AnnotationTarget; onOpen?: (target: AnnotationTarget) => void }>) {
  const { t } = useTranslation("researchTools");
  const label = `${target.objectKind}:${target.objectId} · ${target.objectRevision ?? t(($) => $.researchTools.tasks.annotations.unversioned)}${target.path ? ` · ${target.path}` : ""}`;
  return onOpen
    ? <Button type="button" variant="link" size="xs" className="h-auto max-w-full whitespace-normal break-all px-0 text-left" onClick={() => onOpen(target)}>{label}</Button>
    : <p className="break-all font-mono text-xs">{label}</p>;
}

export function TaskAnnotations(props: Readonly<TaskAnnotationsProps>) {
  const scopeKey = props.contextScope === "object"
    ? JSON.stringify(["object", props.objectTarget.projectId, props.objectTarget.taskId, props.objectTarget.objectKind, props.objectTarget.objectId, props.objectTarget.path])
    : `${props.task.projectId}:${props.task.id}`;
  return <TaskAnnotationPanel key={scopeKey} {...props} />;
}

function TaskAnnotationPanel(props: Readonly<TaskAnnotationsProps>) {
  const { members = [], revision, onOpenTarget, onSaved } = props;
  const task = props.contextScope === "object" ? null : props.task;
  const taskProjectId = task?.projectId;
  const taskIdForQuery = task?.id;
  const defaultTarget: AnnotationTarget = props.contextScope === "object" ? props.objectTarget : props.target ?? {
    projectId: props.task.projectId, taskId: props.task.id, objectKind: "task", objectId: props.task.id,
    objectRevision: `generation:${props.task.executionGeneration}`, path: null,
  };
  const source = props.source;
  const { projectId, taskId, objectKind, objectId, objectRevision, path } = defaultTarget;
  const queryTarget = useMemo(() => ({ projectId, taskId, objectKind, objectId, objectRevision, path }), [projectId, taskId, objectKind, objectId, objectRevision, path]);
  const { t } = useTranslation(["common", "researchTools"]);
  const formId = useId();
  const [context, setContext] = useState<AnnotationContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [reply, setReply] = useState<TaskAnnotation | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [explicitRequest, setExplicitRequest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current++; };
  }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setLoadError(null);
    try {
      const result = taskProjectId && taskIdForQuery ? await loadTaskAnnotations(taskProjectId, taskIdForQuery) : await loadObjectAnnotations(queryTarget);
      if (version === requestVersion.current) setContext(result);
    } catch (error) {
      if (version === requestVersion.current) setLoadError(describeError(error));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [taskProjectId, taskIdForQuery, queryTarget]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: task revisions refresh retained handling and delivery receipts.
  useEffect(() => { void refresh(); }, [refresh, revision, task?.updatedAt]);
  const currentTarget: AnnotationTarget = reply?.target ?? defaultTarget;
  const authorLabel = (author: AnnotationAuthor) => {
    const kind = author.kind === "user" ? t(($) => $.researchTools.tasks.annotations.authorUser)
      : author.kind === "member" ? t(($) => $.researchTools.tasks.annotations.authorMember)
      : author.kind === "model" ? t(($) => $.researchTools.tasks.annotations.authorModel)
      : t(($) => $.researchTools.tasks.annotations.authorSystem);
    const name = author.kind === "member" ? members.find((member) => member.id === author.id)?.name : null;
    return `${kind} · ${name ? `${name} · ` : ""}${author.id}`;
  };
  const anchorPrefix = task ? `task-${encodeURIComponent(task.id)}` : `object-${encodeURIComponent(projectId)}-${encodeURIComponent(objectKind)}-${encodeURIComponent(objectId)}`;
  const anchor = (kind: string, id: string) => `${anchorPrefix}-${kind}-${encodeURIComponent(id)}`;
  const reference = (kind: "annotation" | "handling" | "requirement", id: string) => {
    const present = kind === "annotation" ? context?.annotations.some((item) => item.id === id)
      : kind === "handling" ? context?.handlings.some((item) => item.id === id)
      : context?.requirements.some((item) => item.id === id);
    return present ? <a className="break-all text-primary underline underline-offset-2" href={`#${anchor(kind, id)}`}>{id}</a> : <code className="break-all">{id}</code>;
  };
  const save = async () => {
    if (!body.trim() || saving) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      if (explicitRequest && props.onExplicitRequest) {
        await props.onExplicitRequest(body);
        if (!mounted.current) return;
        setBody(""); setReply(null); setMentions([]); setExplicitRequest(false);
        props.onReplyChange?.(null);
        return;
      }
      const selectedSource = !reply ? source ?? await props.loadSource?.(currentTarget).catch(() => undefined) : undefined;
      const sourceSnapshot = selectedSource && new TextEncoder().encode(selectedSource.content).byteLength <= 256 * 1024 ? selectedSource : undefined;
      const annotation = await (props.submitAnnotation ?? submitTaskAnnotation)({
        target: currentTarget, body, ...(sourceSnapshot ? { source: sourceSnapshot } : {}),
        parentId: reply?.id ?? null, mentions, explicitRequest,
      });
      if (!mounted.current) return;
      setContext((previous) => ({
        annotations: [...(previous?.annotations ?? []), annotation], deliveries: previous?.deliveries ?? [],
        requirements: previous?.requirements ?? [], handlings: previous?.handlings ?? [], distillations: previous?.distillations ?? [],
      }));
      setBody(""); setReply(null); setMentions([]); setExplicitRequest(false); setSaved(true);
      props.onReplyChange?.(null);
      onSaved?.(annotation);
      await refresh();
    } catch (error) {
      if (mounted.current) setSaveError(describeError(error));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const replyTo = (annotation: TaskAnnotation) => {
    setReply(annotation); setSaveError(null); setSaved(false);
    props.onReplyChange?.(annotation);
    document.getElementById(`${formId}-body`)?.focus();
  };
  return <section data-testid="task-annotations" className="space-y-3 rounded-lg border p-3" aria-label={t(($) => $.researchTools.tasks.annotations.title)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium">{t(($) => $.researchTools.tasks.annotations.title)}</h4>
      <Button type="button" variant="outline" size="xs" disabled={loading || saving} onClick={() => void refresh()}>{t(($) => $.researchTools.tasks.annotations.refresh)}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.annotations.scope)}</p>
    {loading ? <p role="status" className="text-xs">{t(($) => $.researchTools.tasks.annotations.loading)}</p> : null}
    {loadError ? <p role="alert" className="break-words text-xs text-destructive">{loadError}</p> : null}
    {context?.annotations.length === 0 ? <p className="text-xs">{t(($) => $.researchTools.tasks.annotations.empty)}</p> : null}
    <ol className="space-y-3">{context?.annotations.map((annotation) => {
      const delivery = context.deliveries.find((item) => item.annotationId === annotation.id);
      const handlings = context.handlings.filter((item) => item.annotationId === annotation.id);
      const distillations = context.distillations.filter((item) => item.sourceAnnotationId === annotation.id);
      return <li key={annotation.id} id={anchor("annotation", annotation.id)} data-testid="task-annotation" className="min-w-0 space-y-2 rounded-md border p-3">
        <p className="break-all text-xs text-muted-foreground">{authorLabel(annotation.author)} · {formatDateTime(annotation.createdAt)}</p>
        <p className="break-all font-mono text-xs">{annotation.id}</p>
        <TargetReference target={annotation.target} onOpen={onOpenTarget} />
        {annotation.parentId ? <p className="text-xs">{t(($) => $.researchTools.tasks.annotations.replyTo)}: {reference("annotation", annotation.parentId)}</p> : null}
        <CopyableBlock source={annotation.body}><p className="whitespace-pre-wrap break-words text-sm">{annotation.body}</p></CopyableBlock>
        {annotation.source ? <details className="text-xs"><summary>{t(($) => $.researchTools.tasks.annotations.recordedObject)}</summary>
          <p className="mt-1 break-all font-mono">{t(($) => $.researchTools.tasks.annotations.sourceSha256, { sha256: annotation.source.sha256 })}</p>
          <CopyableBlock source={annotation.source.content}><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{annotation.source.content}</pre></CopyableBlock>
        </details> : null}
        {annotation.mentions.length > 0 ? <p className="break-all text-xs">{annotation.mentions.map((id) => `@${members.find((member) => member.id === id)?.name ?? id}`).join(" · ")}</p> : null}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span>{t(($) => $.researchTools.tasks.annotations.saved)}</span>
          <span>{annotation.explicitRequest ? t(($) => $.researchTools.tasks.annotations.requested) : t(($) => $.researchTools.tasks.annotations.feedback)}</span>
          {delivery ? <span>{delivery.deliveredGeneration !== null ? t(($) => $.researchTools.tasks.annotations.delivered, { generation: delivery.deliveredGeneration }) : delivery.preparedGeneration !== null ? t(($) => $.researchTools.tasks.annotations.prepared, { generation: delivery.preparedGeneration }) : t(($) => $.researchTools.tasks.annotations.queued)}{delivery.deliveredAt !== null ? ` · ${formatDateTime(delivery.deliveredAt)}` : ""}</span> : null}
          {annotation.status === "dismissed" ? <span>{t(($) => $.researchTools.tasks.annotations.dismissed)}</span> : null}
          {annotation.status === "handled" && handlings.length > 0 ? <span>{t(($) => $.researchTools.tasks.annotations.handled)}</span> : null}
        </div>
        {handlings.map((handling) => <div key={handling.id} id={anchor("handling", handling.id)} data-testid="annotation-handling" className="space-y-1 border-l-2 pl-3 text-xs">
          <p>{t(($) => $.researchTools.tasks.annotations.handling)} · <code>{handling.id}</code></p>
          <p className="break-all text-muted-foreground">{authorLabel(handling.author)} · {formatDateTime(handling.createdAt)}</p>
          <p className="whitespace-pre-wrap break-words">{handling.summary}</p>
          {handling.resultRefs.length > 0 ? <div className="space-y-1"><p>{t(($) => $.researchTools.tasks.annotations.resultRefs)}</p>{handling.resultRefs.map((result) => <TargetReference key={`${result.objectKind}:${result.objectId}:${result.objectRevision}:${result.path}`} target={result} onOpen={onOpenTarget} />)}</div> : null}
        </div>)}
        {distillations.map((distillation) => <div key={distillation.id} className="space-y-1 border-l-2 pl-3 text-xs">
          <p>{t(($) => $.researchTools.tasks.annotations.distillation)} · <code>{distillation.id}</code> · {distillation.outcome === "promoted" ? t(($) => $.researchTools.tasks.annotations.promoted) : distillation.outcome === "candidate" ? t(($) => $.researchTools.tasks.annotations.candidate) : distillation.outcome === "needs_review" ? t(($) => $.researchTools.tasks.annotations.needsReview) : t(($) => $.researchTools.tasks.annotations.noEnduringRequirement)}</p>
          <p className="break-all text-muted-foreground">{authorLabel(distillation.author)} · {formatDateTime(distillation.createdAt)}</p>
          <p className="whitespace-pre-wrap break-words">{distillation.rationale}</p>
          <p>{t(($) => $.researchTools.tasks.annotations.handling)}: {reference("handling", distillation.handlingId)}</p>
          {distillation.requirementId ? <p>{t(($) => $.researchTools.tasks.annotations.requirement)}: {reference("requirement", distillation.requirementId)}</p> : null}
          {distillation.promotedFromRequirementId ? <p>{t(($) => $.researchTools.tasks.annotations.candidate)}: {reference("requirement", distillation.promotedFromRequirementId)}</p> : null}
          {distillation.replacedRequirementId ? <p>{t(($) => $.researchTools.tasks.annotations.replaces)}: {reference("requirement", distillation.replacedRequirementId)}</p> : null}
        </div>)}
        <Button type="button" variant="outline" size="xs" disabled={saving} onClick={() => replyTo(annotation)}>{t(($) => $.researchTools.tasks.annotations.reply)}</Button>
      </li>;
    })}</ol>
    {context && context.requirements.length > 0 ? <details><summary className="text-sm">{t(($) => $.researchTools.tasks.annotations.requirements)}</summary>
      <ul className="mt-2 space-y-2">{context.requirements.map((requirement) => <li key={requirement.id} id={anchor("requirement", requirement.id)} className="space-y-1 rounded-md border p-2 text-xs">
        <p className="break-all"><code>{requirement.id}</code> · {requirement.kind === "enduring" ? t(($) => $.researchTools.tasks.annotations.enduring) : t(($) => $.researchTools.tasks.annotations.candidate)} · {requirement.status === "active" ? t(($) => $.researchTools.tasks.annotations.active) : requirement.status === "withdrawn" ? t(($) => $.researchTools.tasks.annotations.withdrawn) : t(($) => $.researchTools.tasks.annotations.superseded)}</p>
        <p className="break-all text-muted-foreground">{authorLabel(requirement.author)} · {formatDateTime(requirement.createdAt)}</p>
        <p className="whitespace-pre-wrap break-words">{requirement.text}</p>
        <p className="break-all font-mono">{[requirement.scope.projectId, requirement.scope.taskId, requirement.scope.objectKind, requirement.scope.objectId, requirement.scope.objectRevision, requirement.scope.path].filter(Boolean).join(" · ")}</p>
        {requirement.sourceAnnotationId ? <p>{t(($) => $.researchTools.tasks.annotations.sourceAnnotation)}: {reference("annotation", requirement.sourceAnnotationId)}</p> : null}
        {requirement.replacedBy ? <p>{t(($) => $.researchTools.tasks.annotations.replacedBy)}: {reference("requirement", requirement.replacedBy)}</p> : null}
      </li>)}</ul>
    </details> : null}
    <form className="space-y-2 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.annotations.target)}</p>
      <TargetReference target={currentTarget} onOpen={onOpenTarget} />
      {reply ? <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t(($) => $.researchTools.tasks.annotations.replyTo)}: {reference("annotation", reply.id)}</span><Button type="button" variant="ghost" size="xs" disabled={saving} onClick={() => { setReply(null); props.onReplyChange?.(null); }}>{t(($) => $.researchTools.tasks.annotations.cancelReply)}</Button></div> : null}
      <label htmlFor={`${formId}-body`} className="block text-xs">{t(($) => $.researchTools.tasks.annotations.body)}</label>
      <Textarea id={`${formId}-body`} value={body} onChange={(event) => { setBody(event.target.value); setSaved(false); }} rows={3} maxLength={64000} disabled={saving} />
      {members.length > 0 ? <fieldset disabled={saving} className="space-y-1"><legend className="text-xs">{t(($) => $.researchTools.tasks.annotations.mentions)}</legend>
        <div className="flex flex-wrap gap-3">{members.map((member) => <label key={member.id} htmlFor={`${formId}-mention-${member.id}`} className="flex items-center gap-1.5 text-xs"><Checkbox id={`${formId}-mention-${member.id}`} checked={mentions.includes(member.id)} onCheckedChange={(checked) => setMentions((previous) => checked === true ? [...previous, member.id] : previous.filter((id) => id !== member.id))} /><span>{`@${member.name}`}</span></label>)}</div>
      </fieldset> : null}
      <label htmlFor={`${formId}-request`} className="flex items-start gap-2 text-xs"><Checkbox id={`${formId}-request`} checked={explicitRequest} disabled={saving} onCheckedChange={(checked) => setExplicitRequest(checked === true)} /><span>{t(($) => $.researchTools.tasks.annotations.explicitRequest)}</span></label>
      <p className="text-xs text-muted-foreground">{props.requestHint ?? (props.contextScope === "object" ? t(($) => $.researchTools.tasks.annotations.chatRequestHint) : t(($) => $.researchTools.tasks.annotations.requestHint))}</p>
      <Button type="submit" size="sm" disabled={saving || !body.trim()}>{saving ? t(($) => $.researchTools.tasks.annotations.saving) : t(($) => $.researchTools.tasks.annotations.save)}</Button>
      {saveError ? <p role="alert" className="break-words text-xs text-destructive">{saveError}</p> : null}
      {saved ? <p role="status" className="text-xs">{t(($) => $.researchTools.tasks.annotations.saved)}</p> : null}
    </form>
  </section>;
}

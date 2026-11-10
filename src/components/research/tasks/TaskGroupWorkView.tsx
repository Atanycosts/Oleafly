import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, CircleDot, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/app-error";
import type {
  AnnotationTarget,
  GroupEvent,
  GroupMessage,
  GroupSnapshot,
  GroupWork,
  TaskAnnotation,
} from "@/lib/task-collaboration";
import {
  countOpenWork,
  partitionWork,
  replyThread,
  type WorkFilter,
  workObject,
} from "./task-group-work";

type WorkStatus = GroupWork["status"];

interface TaskGroupWorkViewProps {
  snapshot: GroupSnapshot;
  busy: boolean;
  loadMessage: (messageId: string) => Promise<GroupMessage | null>;
  loadEvent: (eventId: string) => Promise<GroupEvent | null>;
  loadAnnotation: (annotationId: string) => Promise<TaskAnnotation | null>;
  renderDiagnostics: (work: GroupWork) => ReactNode;
  onReply: (message: GroupMessage) => void;
  onAnnotate?: (message: GroupMessage) => void;
  onOpenResult?: (target: AnnotationTarget) => void | Promise<void>;
}

function statusKey(status: WorkStatus, waits?: GroupWork["waits"]) {
  switch (status) {
    case "pending":
      return "statusPending";
    case "running":
      return "statusRunning";
    case "waiting":
      return waits?.length ? "statusWaiting" : "statusWaitingFollowUp";
    case "checkpointed":
      return "statusCheckpointed";
    case "completed":
      return "statusCompleted";
    case "failed":
      return "statusFailed";
  }
}

function StatusIcon({ status }: Readonly<{ status: WorkStatus }>) {
  if (status === "failed") return <AlertTriangle aria-hidden className="size-4 text-destructive" />;
  if (status === "completed") return <CheckCircle2 aria-hidden className="size-4 text-primary" />;
  if (status === "waiting" || status === "checkpointed")
    return <Clock3 aria-hidden className="size-4 text-amber-600 dark:text-amber-400" />;
  return <CircleDot aria-hidden className="size-4 text-muted-foreground" />;
}

function sourceMessageId(work: GroupWork): string | null {
  if (work.causeKind === "message") return work.causeId;
  return work.reasons?.find((reason) => reason.object?.kind === "message")?.object?.id ?? null;
}

function isHistoricalEventTarget(target: AnnotationTarget, taskId: string | null) {
  if (!taskId || !target.objectId.startsWith(`${taskId}:`)) return false;
  const identity = target.objectId.slice(taskId.length + 1).split(":").map(Number);
  const [generation, sequence] = identity;
  return identity.length === 2
    && Number.isSafeInteger(generation)
    && Number.isSafeInteger(sequence)
    && generation >= 1
    && sequence >= 1
    && target.objectRevision === `generation:${generation}`;
}

export function TaskGroupWorkView({
  snapshot,
  busy,
  loadMessage,
  loadEvent,
  loadAnnotation,
  renderDiagnostics,
  onReply,
  onAnnotate,
  onOpenResult,
}: Readonly<TaskGroupWorkViewProps>) {
  const { t } = useTranslation(["common", "researchTools"]);
  const scope = `${snapshot.group.projectId}\0${snapshot.group.taskId ?? ""}\0${snapshot.group.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [resolvedMessages, setResolvedMessages] = useState<Record<string, GroupMessage | null>>({});
  const [events, setEvents] = useState<Record<string, GroupEvent | null>>({});
  const [annotations, setAnnotations] = useState<Record<string, TaskAnnotation | null>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [threadRoot, setThreadRoot] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const sections = partitionWork(snapshot.work, filter);
  const memberName = (id: string) =>
    snapshot.members.find((member) => member.id === id)?.name ?? id;
  const memberResponsibility = (id: string) =>
    snapshot.members.find((member) => member.id === id)?.responsibility ?? "";
  const memberPaused = (id: string) =>
    snapshot.members.find((member) => member.id === id)?.paused ?? false;
  const messageIndex = useMemo(
    () => new Map([
      ...Object.values(resolvedMessages).filter((message): message is GroupMessage => Boolean(message)).map((message) => [message.id, message] as const),
      ...snapshot.messages.map((message) => [message.id, message] as const),
    ]),
    [resolvedMessages, snapshot.messages],
  );
  const findMessage = (id: string | null) => (id ? messageIndex.get(id) ?? null : null);
  const ensureMessage = async (id: string): Promise<GroupMessage | null> => {
    const requestScope = scopeRef.current;
    const loaded = findMessage(id);
    if (loaded) return loaded;
    if (Object.hasOwn(resolvedMessages, id) || loadingKey === `message:${id}`) return null;
    setLoadingKey(`message:${id}`);
    try {
      const message = await loadMessage(id);
      if (scopeRef.current !== requestScope) return null;
      setResolvedMessages((current) => ({ ...current, [id]: message }));
      return message;
    } catch (cause) {
      if (scopeRef.current !== requestScope) return null;
      setLoadErrors((current) => ({ ...current, [`message:${id}`]: errorText(cause) }));
      return null;
    } finally {
      if (scopeRef.current === requestScope) setLoadingKey(null);
    }
  };
  const ensureThread = async (messageId: string) => {
    const requestScope = scopeRef.current;
    const loaded = new Map(messageIndex);
    const visited = new Set<string>();
    let current = loaded.get(messageId) ?? (await ensureMessage(messageId));
    if (scopeRef.current !== requestScope) return [];
    while (current) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      if (!current.replyTo) break;
      const parent = loaded.get(current.replyTo) ?? (await ensureMessage(current.replyTo));
      if (scopeRef.current !== requestScope || !parent) break;
      loaded.set(parent.id, parent);
      current = parent;
    }
    return [...loaded.values()];
  };
  const ensureEvent = async (id: string) => {
    if (Object.hasOwn(events, id) || loadingKey === `event:${id}`) return;
    setLoadingKey(`event:${id}`);
    try {
      const event = await loadEvent(id);
      setEvents((current) => ({ ...current, [id]: event }));
    } catch (cause) {
      setLoadErrors((current) => ({ ...current, [`event:${id}`]: errorText(cause) }));
    } finally {
      setLoadingKey(null);
    }
  };
  const ensureAnnotation = async (id: string) => {
    if (Object.hasOwn(annotations, id) || loadingKey === `annotation:${id}`) return;
    setLoadingKey(`annotation:${id}`);
    try {
      const annotation = await loadAnnotation(id);
      setAnnotations((current) => ({ ...current, [id]: annotation }));
    } catch (cause) {
      setLoadErrors((current) => ({ ...current, [`annotation:${id}`]: errorText(cause) }));
    } finally {
      setLoadingKey(null);
    }
  };
  const showThread = async (messageId: string) => {
    const requestScope = scopeRef.current;
    await ensureThread(messageId);
    if (scopeRef.current === requestScope) setThreadRoot(messageId);
  };
  const openResult = async (messageId: string | null) => {
    if (!messageId) return;
    const requestScope = scopeRef.current;
    await ensureThread(messageId);
    if (scopeRef.current !== requestScope) return;
    document.getElementById(`group-message-${messageId}`)?.scrollIntoView({ block: "center" });
    setThreadRoot(messageId);
  };
  const thread = threadRoot ? replyThread(messageIndex.size ? [...messageIndex.values()] : [], threadRoot) : [];

  const source = (work: GroupWork) => {
    const object = workObject(work);
    if (work.causeKind === "message") {
      const message = findMessage(work.causeId);
      return (
        <div className="space-y-1" data-testid={`source-question-${work.id}`}>
          <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workSourceQuestion)}</p>
          {message ? (
            <>
              <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
              <Button
                size="xs"
                variant="link"
                className="h-auto p-0"
                onClick={() => void showThread(message.id)}
              >
                {t(($) => $.researchTools.tasks.group.workViewThread)}
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || loadingKey === `message:${work.causeId}`}
              onClick={() => void ensureMessage(work.causeId)}
            >
              {loadingKey === `message:${work.causeId}`
                ? t(($) => $.researchTools.tasks.group.workLoadingSource)
                : t(($) => $.researchTools.tasks.group.workReadSource)}
            </Button>
          )}
          <details className="text-xs text-muted-foreground">
            <summary>{t(($) => $.researchTools.tasks.group.workTechnicalDetails)}</summary>
            <code className="break-all">{work.causeId}</code>
          </details>
          {loadErrors[`message:${work.causeId}`] ? (
            <p role="alert" className="text-xs text-destructive">
              {loadErrors[`message:${work.causeId}`]}
            </p>
          ) : null}
        </div>
      );
    }
    if (work.causeKind === "annotation") {
      const annotation = annotations[work.causeId];
      return (
        <div className="space-y-1" data-testid={`source-annotation-${work.id}`}>
          <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workSourceAnnotation)}</p>
          {annotation === undefined ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || loadingKey === `annotation:${work.causeId}`}
              onClick={() => void ensureAnnotation(work.causeId)}
            >
              {t(($) => $.researchTools.tasks.group.workReadSource)}
            </Button>
          ) : annotation ? (
            <p className="whitespace-pre-wrap break-words text-sm">{annotation.body}</p>
          ) : (
            <p role="alert" className="text-xs text-destructive">
              {loadErrors[`annotation:${work.causeId}`] ??
                t(($) => $.researchTools.tasks.group.workSourceUnavailable)}
            </p>
          )}
          {annotation ? (
            <p className="break-words text-xs text-muted-foreground">
              {annotation.target.path ?? annotation.target.objectId}
            </p>
          ) : null}
        </div>
      );
    }
    if (work.causeKind === "event") {
      const event = events[work.causeId] ?? snapshot.events?.find((item) => item.id === work.causeId);
      return (
        <div className="space-y-1" data-testid={`source-event-${work.id}`}>
          <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workSourceObject)}</p>
          {object ? (
            <p className="break-words text-sm">
              {event ? `${event.kind} · ` : ""}
              {object.path ?? object.id}
            </p>
          ) : null}
          {event === undefined ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || loadingKey === `event:${work.causeId}`}
              onClick={() => void ensureEvent(work.causeId)}
            >
              {t(($) => $.researchTools.tasks.group.workReadSource)}
            </Button>
          ) : event ? null : (
            <p role="alert" className="text-xs text-destructive">
              {loadErrors[`event:${work.causeId}`] ??
                t(($) => $.researchTools.tasks.group.workSourceUnavailable)}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workSourceObject)}</p>
        <p className="break-words text-sm">
          {object?.path ?? object?.id ?? t(($) => $.researchTools.tasks.group.workSourceUnavailable)}
        </p>
      </div>
    );
  };

  const waits = (work: GroupWork) => {
    if (!work.waits?.length) return null;
    return (
      <div className="space-y-2" data-testid={`waits-${work.id}`}>
        <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workWaitingFor)}</p>
        {work.waits.map((wait) => {
          const request = findMessage(wait.requestMessageId);
          return (
            <div key={wait.requestMessageId} className="rounded-md border border-amber-500/30 p-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-xs text-muted-foreground">
                    {request?.body ?? t(($) => $.researchTools.tasks.group.workWaitingRequest)}
                  </p>
                  {!request ? (
                    <Button
                      size="xs"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => void ensureMessage(wait.requestMessageId)}
                    >
                      {t(($) => $.researchTools.tasks.group.workReadRequest)}
                    </Button>
                  ) : null}
                </div>
                {request ? (
                  <Button size="xs" variant="ghost" onClick={() => void showThread(request.id)}>
                    {t(($) => $.researchTools.tasks.group.workViewThread)}
                  </Button>
                ) : null}
              </div>
              <ul className="mt-2 space-y-1">
                {wait.work.map((dependency) => {
                  const currentWork = snapshot.work.find((item) => item.id === dependency.workId);
                  const status = currentWork?.status ?? dependency.status;
                  return (
                    <li key={dependency.workId} className="flex flex-wrap items-center gap-2 text-xs">
                      <StatusIcon status={status} />
                      <strong>{memberName(dependency.memberId)}</strong>
                      <span>
                        {t(($) =>
                          $.researchTools.tasks.group[
                            statusKey(status, currentWork?.waits)
                          ]
                        )}
                      </span>
                      {memberPaused(dependency.memberId) ? (
                        <span className="rounded-full border border-amber-500/40 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                          {t(($) => $.researchTools.tasks.group.paused)}
                        </span>
                      ) : null}
                      {dependency.resultMessageId
                        && (status === "completed" || status === "failed") ? (
                        <Button
                          size="xs"
                          variant="link"
                          className="h-auto p-0"
                          onClick={() => void openResult(dependency.resultMessageId)}
                        >
                          {t(($) => $.researchTools.tasks.group.workOpenResult)}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    );
  };

  const resultRef = (target: AnnotationTarget) => {
    const label = target.path ?? target.objectId;
    const revision = target.objectRevision ? ` · ${target.objectRevision}` : "";
    const openable =
      ["task_pdf", "pdf_selection", "group_message", "journal_rule", "journal_source", "journal_check", "journal_world"].includes(target.objectKind)
      || (["message", "tool_call"].includes(target.objectKind)
        && isHistoricalEventTarget(target, snapshot.group.taskId ?? null));
    return openable && onOpenResult ? (
      <Button
        size="xs"
        variant="link"
        className="h-auto max-w-full whitespace-normal break-all p-0 text-left"
        onClick={() => void onOpenResult(target)}
      >
        {label}{revision}
      </Button>
    ) : (
      <div className="space-y-1">
        <span className="break-all text-xs text-muted-foreground">{label}{revision}</span>
        <p className="text-xs text-muted-foreground">
          {target.objectKind === "file"
            ? t(($) => $.researchTools.tasks.group.workFileReferenceUnavailable)
            : t(($) => $.researchTools.tasks.group.workResultUnavailable)}
        </p>
      </div>
    );
  };

  const card = (work: GroupWork) => {
    const terminal = work.status === "completed" || work.status === "failed";
    const resolution = terminal ? work.resolution?.summary.trim() : "";
    const resultMessage = findMessage(work.resultMessageId);
    const questionId = sourceMessageId(work);
    return (
      <article
        key={work.id}
        data-testid={`work-${work.id}`}
        className={`space-y-3 rounded-lg border p-3 ${
          work.status === "failed"
            ? "border-destructive/60 bg-destructive/5"
            : work.status === "waiting" || work.status === "checkpointed"
              ? "border-amber-500/40"
              : ""
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{memberName(work.memberId)}</p>
            <p className="break-words text-xs text-muted-foreground">
              {memberResponsibility(work.memberId)}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${
              work.status === "failed"
                ? "border-destructive/50 text-destructive"
                : work.status === "completed"
                  ? "border-primary/40 text-primary"
                  : ""
            }`}
          >
            <StatusIcon status={work.status} />
            {t(($) => $.researchTools.tasks.group[statusKey(work.status, work.waits)])}
          </span>
        </div>

        {source(work)}
        {waits(work)}

        {terminal ? (
          <div className="space-y-1" data-testid={`resolution-${work.id}`}>
            <p className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workOutcome)}</p>
            {resolution ? (
              <p className="whitespace-pre-wrap break-words text-sm">{resolution}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {work.status === "completed"
                  ? t(($) => $.researchTools.tasks.group.workCompletedWithoutOutcome)
                  : t(($) => $.researchTools.tasks.group.workNoOutcome)}
              </p>
            )}
            {resultMessage && resultMessage.id !== work.causeId ? (
              <Button
                size="xs"
                variant="link"
                className="h-auto max-w-full whitespace-normal break-words p-0 text-left"
                aria-label={t(($) => $.researchTools.tasks.group.workOpenResult)}
                onClick={() => void openResult(resultMessage.id)}
              >
                {resolution ? t(($) => $.researchTools.tasks.group.workOpenResult) : resultMessage.body}
              </Button>
            ) : work.resultMessageId && work.resultMessageId !== work.causeId && !resultMessage ? (
              <Button
                size="xs"
                variant="link"
                className="h-auto p-0"
                onClick={() => {
                  if (work.resultMessageId) void ensureMessage(work.resultMessageId);
                }}
              >
                {t(($) => $.researchTools.tasks.group.workReadResult)}
              </Button>
            ) : null}
            {work.resolution?.resultRefs.length ? (
              <ul className="space-y-1">
                {work.resolution.resultRefs.map((target) => (
                  <li key={`${target.objectKind}:${target.objectId}:${target.objectRevision}:${target.path}`}>
                    {resultRef(target)}
                  </li>
                ))}
              </ul>
            ) : null}
            {resolution ? (
              <p className="text-xs text-muted-foreground">
                {t(($) => $.researchTools.tasks.group.workOutcomeRecorded)}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {questionId && findMessage(questionId) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const question = findMessage(questionId);
                if (question) onReply(question);
              }}
            >
              {t(($) => $.researchTools.tasks.group.workFollowUp)}
            </Button>
          ) : null}
        </div>

        <details className="rounded-md border bg-muted/20 p-2 text-xs">
          <summary>{t(($) => $.researchTools.tasks.group.workDiagnostics)}</summary>
          <div className="mt-2">{renderDiagnostics(work)}</div>
        </details>
      </article>
    );
  };

  return (
    <section className="space-y-3" aria-labelledby="research-group-work">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 id="research-group-work" className="text-sm font-medium">
            {t(($) => $.researchTools.tasks.group.work)}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(($) => $.researchTools.tasks.group.workSummary, {
              open: countOpenWork(snapshot.work),
              handled: snapshot.work.filter((item) => item.status === "completed").length,
            })}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          {t(($) => $.researchTools.tasks.group.workFilter)}
          <select
            className="rounded border bg-background px-2 py-1"
            value={filter}
            onChange={(event) => setFilter(event.target.value as WorkFilter)}
          >
            <option value="open">{t(($) => $.researchTools.tasks.group.workFilterOpen)}</option>
            <option value="completed">
              {t(($) => $.researchTools.tasks.group.workFilterCompleted)}
            </option>
            <option value="all">{t(($) => $.researchTools.tasks.group.workFilterAll)}</option>
          </select>
        </label>
      </div>

      {threadRoot ? (
        <section
          className="space-y-2 rounded-md border bg-muted/20 p-2"
          aria-label={t(($) => $.researchTools.tasks.group.workThread)}
        >
          <div className="flex items-center justify-between gap-2">
            <h5 className="text-xs font-medium">{t(($) => $.researchTools.tasks.group.workThread)}</h5>
            <Button size="xs" variant="ghost" onClick={() => setThreadRoot(null)}>
              {t(($) => $.common.actions.close)}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(($) => $.researchTools.tasks.group.workThreadScope)}
          </p>
          {thread.length ? (
            <ol className="space-y-2">
              {thread.map((message) => (
                <li
                  key={message.id}
                  id={`group-message-${message.id}`}
                  className={`rounded border p-2 text-xs ${
                    message.id === threadRoot ? "border-primary/50" : ""
                  }`}
                >
                  <p className="font-medium">
                    {message.author.kind === "member"
                      ? memberName(message.author.id)
                      : message.author.kind}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{message.body}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Button size="xs" variant="link" className="h-auto p-0" onClick={() => onReply(message)}>
                      {t(($) => $.researchTools.tasks.group.reply)}
                    </Button>
                    {onAnnotate ? (
                      <Button
                        size="xs"
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => onAnnotate(message)}
                      >
                        {t(($) => $.researchTools.tasks.annotations.annotate)}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(($) => $.researchTools.tasks.group.workThreadUnavailable)}
            </p>
          )}
        </section>
      ) : null}

      {snapshot.work.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t(($) => $.researchTools.tasks.group.workEmpty)}
        </p>
      ) : null}
      {sections.needsFollowUp.length ? (
        <section className="space-y-2" aria-labelledby="research-group-work-follow-up">
          <h5 id="research-group-work-follow-up" className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {t(($) => $.researchTools.tasks.group.workNeedsFollowUp)}
          </h5>
          {sections.needsFollowUp.map(card)}
        </section>
      ) : null}
      {sections.active.length ? (
        <section className="space-y-2" aria-labelledby="research-group-work-active">
          <h5 id="research-group-work-active" className="text-xs font-medium">
            {t(($) => $.researchTools.tasks.group.workInProgress)}
          </h5>
          {sections.active.map(card)}
        </section>
      ) : null}
      {sections.completed.length ? (
        <section className="space-y-2" aria-labelledby="research-group-work-completed">
          <h5 id="research-group-work-completed" className="text-xs font-medium">
            {t(($) => $.researchTools.tasks.group.workHandled)}
          </h5>
          {sections.completed.map(card)}
        </section>
      ) : null}
    </section>
  );
}

function errorText(cause: unknown): string {
  return describeError(cause);
}

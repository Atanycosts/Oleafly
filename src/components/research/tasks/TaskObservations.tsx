import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { describeError } from "@/lib/app-error";
import { loadResearchTaskObservations, previewResearchTaskSource, type TaskObservation, type TaskObservationView, type TaskTranscriptEvent } from "@/lib/research-tasks";

type Execution = Extract<TaskObservation, { type: "toolExecution" }>;

function SourceRead({ taskId, generation, row, source }: Readonly<{ taskId: string; generation: number; row: TaskTranscriptEvent; source: NonNullable<Execution["source"]> }>) {
  const { t } = useTranslation(["common", "researchTools"]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const retention = source.snapshotRetained === true
    ? t(($) => $.researchTools.tasks.observations.sourceRetained)
    : source.snapshotRetained === false
      ? t(($) => $.researchTools.tasks.observations.sourceNotArchived)
      : t(($) => $.researchTools.tasks.observations.sourceRetentionUnknown);
  const preview = async () => {
    setLoading(true);
    setError(null);
    setText(null);
    try { setText((await previewResearchTaskSource(taskId, generation, row.sequence)).text); }
    catch (failure) { setError(describeError(failure)); }
    finally { setLoading(false); }
  };
  return <div className="space-y-1">
    <p className="break-all">{t(($) => $.researchTools.tasks.observations.sourceRange, { path: source.path, start: source.offset, end: source.endOffset })}{source.truncated ? ` · ${t(($) => $.researchTools.tasks.observations.partial)}` : ""}</p>
    <p className="text-xs text-muted-foreground">{retention}</p>
    <Button variant="outline" size="xs" disabled={loading} onClick={() => void preview()}>{t(($) => $.researchTools.tasks.observations.openSource)}</Button>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {text !== null ? <CopyableBlock source={text}><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">{text}</pre></CopyableBlock> : null}
    <p className="break-all font-mono text-muted-foreground">{`SHA-256 ${source.fileSha256}`}</p>
  </div>;
}

export function TaskObservations({ taskId, generation, revision, availableCalls, onOpenCall, onReview, onChecks }: Readonly<{
  taskId: string; generation: number; revision: number; availableCalls: ReadonlySet<string>;
  onOpenCall: (id: string) => void; onReview: () => void; onChecks: () => void;
}>) {
  const { t } = useTranslation(["common", "researchTools"]);
  const [view, setView] = useState<TaskObservationView | null>(null);
  const [events, setEvents] = useState<TaskTranscriptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  const currentView = useRef<TaskObservationView | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: task revisions and explicit retries refresh the persisted snapshot.
  useEffect(() => {
    const version = ++requestVersion.current;
    setError(null);
    setLoading(true);
    void loadResearchTaskObservations(taskId, generation, currentView.current?.page.nextSequence ?? 0).then((result) => {
      if (version === requestVersion.current) {
        currentView.current = result;
        setView(result);
        setEvents((previous) => [...previous, ...result.page.events]);
      }
    }).catch((failure) => { if (version === requestVersion.current) setError(describeError(failure)); })
      .finally(() => { if (version === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [taskId, generation, revision, reload]);

  const loadMore = async () => {
    if (!view) return;
    const version = requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loadResearchTaskObservations(taskId, generation, view.page.nextSequence);
      if (version !== requestVersion.current) return;
      currentView.current = result;
      setView(result);
      setEvents((previous) => [...previous, ...result.page.events]);
    } catch (failure) { if (version === requestVersion.current) setError(describeError(failure)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  };
  const runtimeEvent = view?.summary.runtime;
  const runtime = runtimeEvent?.event.kind === "observation" && runtimeEvent.event.observation.type === "runtime"
    ? runtimeEvent.event.observation : null;
  const usageEvent = view?.summary.usage;
  const usage = usageEvent?.event.kind === "observation" && usageEvent.event.observation.type === "usage"
    ? usageEvent.event.observation : null;
  const unknown = t(($) => $.researchTools.tasks.observations.unknown);
  const members: { row: TaskTranscriptEvent; observation: Extract<TaskObservation, { type: "member" }> }[] = [];
  const requests: { row: TaskTranscriptEvent; observation: Extract<TaskObservation, { type: "requestContext" }> }[] = [];
  const calls = new Map<string, { request: TaskTranscriptEvent; name: string; inputSha256: string; actor?: string | null; result?: TaskTranscriptEvent }>();
  for (const row of events) {
    if (row.event.kind !== "observation") continue;
    const event = row.event.observation;
    if (event.type === "member") {
      members.push({ row, observation: event });
    } else if (event.type === "requestContext") {
      requests.push({ row, observation: event });
    } else if (event.type === "toolRequested") {
      calls.set(event.callId, { request: row, name: event.name, inputSha256: event.inputSha256, actor: event.actor });
    } else if (event.type === "toolExecution") {
      const call = calls.get(event.callId) ?? { request: row, name: event.name, inputSha256: event.inputSha256, actor: event.actor };
      calls.set(event.callId, { ...call, result: row });
    }
  }
  const gitStatus = view?.summary.baseline?.initialGitStatus?.join("\n") || (view?.summary.baseline?.initialGitStatusComplete === true ? t(($) => $.researchTools.tasks.observations.clean) : unknown);
  return <section data-testid="task-observations" className="mb-4 min-w-0 space-y-3 rounded-lg border p-3 text-sm">
    <h4 className="font-medium">{t(($) => $.researchTools.tasks.observations.title)}</h4>
    {loading ? <p role="status">{t(($) => $.researchTools.tasks.observations.loading)}</p> : null}
    {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
    {view ? <>
      {runtime ? <>
        <p className="break-words text-xs">{`${runtime.providerId} / ${runtime.modelId} · ${runtime.runtimeId}`}</p>
        <p>{t(($) => $.researchTools.tasks.observations.usage)}: {usage?.inputTokens ?? unknown} / {usage?.outputTokens ?? unknown}</p>
        <details><summary>{t(($) => $.researchTools.tasks.observations.provided, { count: runtime.tools.length })}</summary>
          <ul className="max-h-52 overflow-y-auto break-all text-xs">{runtime.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code> · {tool.source}<details><summary>{"SHA-256"}</summary><code>{tool.schemaSha256}</code></details></li>)}</ul>
        </details>
        <details><summary>{t(($) => $.researchTools.tasks.observations.skills)}</summary>
          <p>{t(($) => $.researchTools.tasks.observations.declared)}: {runtime.declaredSkills.join(", ") || "—"}</p>
          <ul className="break-all text-xs">{runtime.injectedSkills.map((skill) => <li key={skill.id}>{skill.id}<details><summary>{"SHA-256"}</summary><code>{skill.sectionSha256}</code></details></li>)}</ul>
        </details>
        {runtime.unavailable.length > 0 ? <p className="break-words text-xs">{t(($) => $.researchTools.tasks.observations.unavailable)}: {runtime.unavailable.map((reason) => {
          if (reason === "commands:disabled") return t(($) => $.researchTools.tasks.observations.commandsOff);
          if (reason === "desktop_apps:disabled") return t(($) => $.researchTools.tasks.observations.desktopOff);
          if (reason === "web_tools:unavailable") return t(($) => $.researchTools.tasks.observations.webUnavailable);
          return reason;
        }).join(" · ")}</p> : null}
      </> : <p>{t(($) => $.researchTools.tasks.observations.notCollected)}</p>}
      {members.length > 0 ? <details><summary>{t(($) => $.researchTools.tasks.observations.memberExecutions)}</summary>
        <ol className="max-h-52 space-y-2 overflow-auto break-all text-xs">{members.map(({ row, observation }) => <li key={row.sequence} className="border-t pt-2">
          <p>{`#${row.sequence} · ${observation.memberId} · ${observation.status}`}</p>
          <p>{t(($) => $.researchTools.tasks.observations.execution)}: {observation.executionId}</p>
          <p>{t(($) => $.researchTools.tasks.observations.triggers)}: {observation.triggerIds.join(", ") || "—"}</p>
        </li>)}</ol>
      </details> : null}
      {requests.length > 0 ? <details><summary>{t(($) => $.researchTools.tasks.observations.requestContexts)}</summary>
        <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.catalogBoundary)}</p>
        <ol className="max-h-96 space-y-3 overflow-auto break-all text-xs">{requests.map(({ row, observation }) => <li key={row.sequence} className="space-y-1 border-t pt-2">
          <p>{`#${row.sequence} · ${observation.sessionId}`}</p>
          <p>{t(($) => $.researchTools.tasks.observations.requestBytes, { schema: observation.schemaBytes, catalog: observation.catalogBytes, skill: observation.skillBytes })}</p>
          <p>{t(($) => $.researchTools.tasks.observations.requirements)}: {observation.requirementIds.join(", ") || "—"}</p>
          <details><summary>{t(($) => $.researchTools.tasks.observations.provided, { count: observation.tools.length })}</summary>
            <ul>{observation.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code> · {tool.source}<details><summary>{"SHA-256"}</summary><code>{tool.schemaSha256}</code></details></li>)}</ul>
          </details>
        </li>)}</ol>
      </details> : null}
      {view.summary.baseline ? <details><summary>{t(($) => $.researchTools.tasks.observations.baseline)}</summary>
        <p className="break-all font-mono text-xs">{view.summary.baseline.sourceRevision}</p>
        <p className="break-all font-mono text-xs">{`SHA-256 ${view.summary.baseline.baselineHash}`}</p>
        <CopyableBlock source={gitStatus}><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{gitStatus}</pre></CopyableBlock>
        <Button variant="outline" size="xs" onClick={onReview}>{t(($) => $.researchTools.tasks.observations.changes, { count: view.summary.changedFileCount })}</Button>
      </details> : null}
      {view.summary.evidence ? <Button variant="outline" size="xs" onClick={onChecks}>{t(($) => $.researchTools.tasks.observations.checks, { count: view.summary.evidence.checks.length })}</Button> : null}
      <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.limits)}</p>
      {view.summary.coverageGaps.includes("observations.git_status_not_collected") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.gitUnknown)}</p> : null}
      {view.summary.coverageGaps.includes("observations.git_status_shortened") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.gitShortened)}</p> : null}
      {view.summary.coverageGaps.includes("observations.git_status_completeness_unknown") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.gitCompletenessUnknown)}</p> : null}
      {view.summary.coverageGaps.includes("observations.baseline_has_skipped_files") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.skippedFiles)}</p> : null}
      {view.summary.coverageGaps.includes("observations.file_list_shortened") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.filesShortened)}</p> : null}
      {view.summary.coverageGaps.includes("observations.check_items_shortened") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.checksShortened)}</p> : null}
      {view.summary.coverageGaps.includes("observations.source_snapshot_not_retained") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.sourceRetentionLimit)}</p> : null}
      <details><summary>{t(($) => $.researchTools.tasks.observations.records)}</summary>
        <ol className="max-h-96 space-y-3 overflow-auto">{[...calls].map(([callId, { request, name, inputSha256, actor, result: row }]) => {
          const result = row?.event.kind === "observation" && row.event.observation.type === "toolExecution" ? row.event.observation : null;
          return <li key={callId} className="space-y-1 break-words border-t pt-2 text-xs">
            <p><code>{name}</code> · {result ? (result.status === "done" ? t(($) => $.researchTools.tasks.observations.returned) : t(($) => $.researchTools.tasks.observations.failed)) : t(($) => $.researchTools.tasks.observations.pending)}</p>
            {actor ? <p>{t(($) => $.researchTools.tasks.observations.execution)}: <code>{actor}</code></p> : null}
            <p className="break-all text-muted-foreground">#{request.sequence}{row && row.sequence !== request.sequence ? ` → #${row.sequence}` : ""} · {callId}</p>
            <Button variant="outline" size="xs" disabled={!availableCalls.has(callId)} onClick={() => onOpenCall(callId)}>{t(($) => $.researchTools.tasks.observations.openCall)}</Button>
            {result?.skillId ? <p>{t(($) => $.researchTools.tasks.observations.loadedSkill)}: {result.skillId} · {result.skillInstructionsSha256 ? t(($) => $.researchTools.tasks.observations.returned) : t(($) => $.researchTools.tasks.observations.noSkillBody)}</p> : null}
            {result?.source && row ? <SourceRead key={`${row.executionGeneration}:${row.sequence}`} taskId={taskId} generation={generation} row={row} source={result.source} /> : null}
            <details><summary>{"SHA-256"}</summary><p className="break-all">{inputSha256}</p>{result ? <p className="break-all">{result.outputSha256}</p> : null}{result?.skillInstructionsSha256 ? <p className="break-all">{result.skillInstructionsSha256}</p> : null}</details>
          </li>;
        })}</ol>
        {calls.size === 0 ? <p className="text-xs">{t(($) => $.researchTools.tasks.observations.noCalls)}</p> : null}
      </details>
      <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.tasks.observations.cursor, { sequence: view.page.throughSequence })}</p>
      {view.page.hasMore ? <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>{t(($) => $.researchTools.tasks.observations.more)}</Button> : null}
    </> : null}
    {error ? <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((value) => value + 1)}>{t(($) => $.researchTools.tasks.observations.retry)}</Button> : null}
  </section>;
}

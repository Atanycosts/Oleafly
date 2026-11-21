import { Check, CircleAlert, Navigation, Pause } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { agentExecutionFlowKey, useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useFilesStore } from "@/store/files";
import { useResearchTasksStore } from "@/store/research-tasks";

function resultRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function AgentWorkspaceFeedback({ compact = false, inline = false }: { compact?: boolean; inline?: boolean }) {
  const { t } = useTranslation("editor");
  const { t: tResearch } = useTranslation("researchTools");
  const projectId = useFilesStore((state) => state.projectId);
  const operations = useAgentWorkspaceStore((state) => state.operations);
  const following = useAgentWorkspaceStore((state) => state.following);
  const paused = useAgentWorkspaceStore((state) => state.paused);
  const tasks = useResearchTasksStore((state) => state.tasks);
  const view = useAgentWorkspaceStore((state) => state.views[projectId ?? ""]);
  const relevant = operations.filter((item) => item.projectId === projectId);
  const operation = [...relevant].reverse().find((item) => following?.projectId === projectId && agentExecutionFlowKey(item.origin) === following.flowKey) ?? relevant.at(-1);
  if (!operation) return null;
  const text = t(($) => $.editor.agentWorkspace, { returnObjects: true });
  const docxText = tResearch(($) => $.researchTools.docx, { returnObjects: true });
  const journalText = tResearch(($) => $.researchTools.journal, { returnObjects: true });
  const actions: Record<string, string> = {
    read: text.read, read_format: text.readFormat, replace_range: text.edit,
    format: text.format, format_batch: text.format,
    import_styles: text.importStyles, apply: text.edit, save: text.save, check: text.check,
    reveal: text.reveal, capture: text.read, propose: text.propose,
    prepare_fonts: text.prepare_fonts, export: text.export,
  };
  const matching = following?.projectId === projectId && following.flowKey === agentExecutionFlowKey(operation.origin);
  const origin = operation.origin;
  const task = origin.kind === "task" ? tasks.find((item) => item.id === origin.taskId && item.projectId === projectId) : null;
  const label = task?.title ?? operation.title ?? text.agent;
  const output = resultRecord(operation.result);
  const receipt = output.operation === operation.operation ? resultRecord(output.result) : output;
  let stateLabel = text[operation.phase];
  let attention = operation.phase === "failed";
  let receiptState = operation.phase === "succeeded" ? "completed" : operation.phase;
  let baselineId: string | undefined;
  let revision: number | undefined;
  let validity: string | undefined;
  let sourceSha256: string | undefined;
  let checkId: string | undefined;
  let worldVersionId: string | undefined;
  if (operation.phase === "succeeded" && operation.operation === "save") {
    stateLabel = docxText.taskActivity.events.saved;
    receiptState = "saved";
    baselineId = typeof receipt.baselineId === "string" ? receipt.baselineId : undefined;
    revision = typeof receipt.revision === "number" ? receipt.revision : undefined;
    sourceSha256 = typeof receipt.sourceSha256 === "string" ? receipt.sourceSha256 : undefined;
  }
  if (operation.phase === "succeeded" && operation.operation === "check") {
    const check = resultRecord(receipt.check);
    validity = typeof check.validity === "string" ? check.validity : undefined;
    baselineId = typeof check.baseline_id === "string" ? check.baseline_id : undefined;
    checkId = typeof check.check_id === "string" ? check.check_id : undefined;
    worldVersionId = typeof check.world_version_id === "string" ? check.world_version_id : undefined;
    const checkedRevision = operation.target?.sessionRevision;
    const currentRevision = view?.role === "working" && view.sessionId === operation.sessionId
      ? view.sessionRevision : undefined;
    const verifiedCurrent = validity === "CURRENT" && checkedRevision !== undefined &&
      currentRevision === checkedRevision && view?.dirty !== true;
    const drifted = validity === "STALE" || (checkedRevision !== undefined && currentRevision !== undefined &&
      (currentRevision !== checkedRevision || view?.dirty === true));
    validity = drifted ? "STALE" : verifiedCurrent ? "CURRENT" : undefined;
    attention = drifted;
    receiptState = drifted ? "stale" : verifiedCurrent ? "current" : "checked";
    stateLabel = drifted ? journalText.stale : verifiedCurrent ? journalText.current : text.receiptAvailable;
  }
  if (operation.phase === "succeeded" && operation.operation === "export") {
    const status = resultRecord(receipt.result).status;
    stateLabel = status === "saved" ? text.exportSaved : status === "cancelled" ? text.exportCancelled : status === "download_requested" ? text.downloadRequested : text.receiptAvailable;
    receiptState = typeof status === "string" ? status : "available";
  }
  if (operation.phase === "succeeded" && operation.operation === "prepare_fonts") {
    const acquisition = resultRecord(receipt.acquisition);
    const families = Array.isArray(acquisition.families) ? acquisition.families.map(resultRecord) : [];
    const status = resultRecord(receipt.status);
    const measurement = resultRecord(receipt.measurement);
    const missing = (Array.isArray(status.missing) && status.missing.length > 0)
      || families.some((family) => family.state === "noSource" || family.state === "failed" || family.state === "stillMissing");
    const resolving = measurement.resolving === true
      || families.some((family) => family.state === "checking" || family.state === "downloading");
    const resolved = Array.isArray(acquisition.families) && families.every((family) => family.state === "available")
      && status.probed === true && Array.isArray(status.missing) && status.missing.length === 0
      && measurement.measurer === "shaped" && measurement.resolving === false;
    attention = missing;
    stateLabel = missing ? text.fontsMissing : resolving ? text.fontsResolving : resolved ? text.fontsReady : text.receiptAvailable;
    receiptState = missing ? "missing" : resolving ? "resolving" : resolved ? "ready" : "available";
  }
  const activity = `${actions[operation.operation] ?? text.process} · ${stateLabel}`;
  const statusIcon = operation.phase === "started"
    ? <Spinner size="xs" />
    : attention
      ? <CircleAlert className="size-3.5 shrink-0 text-destructive" />
      : <Check className="size-3.5 shrink-0 text-muted-foreground" />;
  const testIdPrefix = inline ? "workspace-agent" : compact ? "sidebar-agent" : "workspace-agent";
  const followLabel = matching ? paused ? text.resume : text.pause : text.follow;
  const feedbackData = {
    "data-operation": operation.operation,
    "data-phase": operation.phase,
    "data-receipt-state": receiptState,
    "data-baseline-id": baselineId,
    "data-revision": revision,
    "data-validity": validity,
    "data-source-sha256": sourceSha256,
    "data-check-id": checkId,
    "data-world-version-id": worldVersionId,
    "data-origin-kind": operation.origin.kind,
    "data-flow-key": agentExecutionFlowKey(operation.origin),
    "data-session-id": operation.sessionId,
    "data-session-revision": operation.target?.sessionRevision,
    "data-follow-state": matching ? paused ? "paused" : "following" : "idle",
  };
  const followControl = (iconOnly: boolean) => <Button type="button" variant="ghost" size="xs"
    className={iconOnly ? "size-6 shrink-0 p-0" : "shrink-0"} data-agent-follow-control
    data-testid={`${testIdPrefix}-follow`} aria-label={followLabel} onClick={() => {
      const store = useAgentWorkspaceStore.getState();
      if (!matching) store.beginFollow(operation.projectId, operation.origin);
      else if (paused) store.resume();
      else store.pause();
    }}>
    {matching && !paused ? <Pause className="size-3.5" /> : <Navigation className="size-3.5" />}
    {!iconOnly && (matching ? paused ? text.resume : !compact && text.following : text.follow)}
  </Button>;
  if (inline) {
    const details = [label, activity, operation.error].filter(Boolean).join(" · ");
    const hasDetails = Boolean(operation.error || task?.title || operation.title);
    return <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden text-xs"
      data-testid={`${testIdPrefix}-operation`} {...feedbackData}>
      <Tooltip label={details} className="min-w-0 flex-1">
        <span role="status" aria-live="polite" tabIndex={hasDetails ? 0 : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-visible:bg-accent/60">
          {statusIcon}
          <span className="truncate text-muted-foreground">{activity}</span>
        </span>
      </Tooltip>
      <Tooltip label={followLabel} className="shrink-0">{followControl(true)}</Tooltip>
    </div>;
  }
  return <div className={`flex min-w-0 items-center gap-2 border-b px-3 py-2 text-xs ${compact ? "border-sidebar-border" : "bg-muted/20"}`}
    data-testid={`${testIdPrefix}-operation`} {...feedbackData}>
    {statusIcon}
    <div className="min-w-0 flex-1" role="status" aria-live="polite">
      <p className="truncate font-medium">{label}</p>
      <p className="truncate text-muted-foreground"><Tooltip label={operation.error} suppressed={!operation.error}><span>{activity}</span></Tooltip></p>
    </div>
    {followControl(false)}
  </div>;
}

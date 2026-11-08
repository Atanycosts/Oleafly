import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Textarea } from "@/components/ui/textarea";
import { i18n } from "@/i18n";
import { describeError } from "@/lib/app-error";
import { formatDateTime } from "@/lib/intl";
import {
  decideResearchTaskFinding, loadResearchTaskFindings, previewResearchTaskFindingSource,
  type FindingDisposition, type FindingPage, type FindingSource, type FindingView,
} from "@/lib/research-tasks";
import { evidenceItemText } from "./EvidenceChecklist";

function dispositionLabel(value: FindingDisposition) {
  switch (value) {
    case "open": return i18n.t(($) => $.researchTools.findings.open);
    case "accepted": return i18n.t(($) => $.researchTools.findings.accepted);
    case "rejected": return i18n.t(($) => $.researchTools.findings.rejected);
    case "deferred": return i18n.t(($) => $.researchTools.findings.deferred);
  }
}

function FindingCard({ taskId, generation, view, onSaved }: Readonly<{
  taskId: string; generation: number; view: FindingView; onSaved: () => void;
}>) {
  const { t } = useTranslation("researchTools");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<FindingSource | null>(null);
  const finding = view.finding;
  const basis = finding.item.provenance;
  const decide = async (disposition: FindingDisposition) => {
    setBusy(true); setError(null);
    try {
      await decideResearchTaskFinding(taskId, generation, finding.id, disposition, rationale.trim());
      setRationale(""); onSaved();
    } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    setBusy(true); setError(null);
    try { setSource(await previewResearchTaskFindingSource(taskId, generation, finding.id)); }
    catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  };
  const validity = view.validity === "current" ? t(($) => $.researchTools.findings.current)
    : view.validity === "stale" ? t(($) => $.researchTools.findings.stale) : t(($) => $.researchTools.findings.unknown);
  return <li className="min-w-0 space-y-2 rounded-md border p-3" data-testid="task-finding" data-finding-id={finding.id}>
    <p className="text-sm font-medium">{evidenceItemText(finding.item)}</p>
    <p className="break-all text-xs font-mono">{finding.item.file}:{finding.item.line} · {finding.item.code} · {basis?.ruleVersion}</p>
    <p className="text-xs">{t(($) => $.researchTools.findings.recordedWarning)} · {validity} · {dispositionLabel(view.disposition)}</p>
    <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.findings.deterministic)} · {formatDateTime(finding.createdAt)}</p>
    {view.changedDependencies.length > 0 ? <div className="space-y-1 text-xs">
      <p>{t(($) => $.researchTools.findings.changed)}</p>
      <ul>{view.changedDependencies.map((change) => <li key={change.dependency} className="break-all font-mono">{change.dependency}: {change.expected} → {change.actual ?? t(($) => $.researchTools.findings.missing)}</li>)}</ul>
    </div> : null}
    {view.unavailable.length > 0 ? <p className="break-words text-xs">{t(($) => $.researchTools.findings.unavailable)}: {view.unavailable.join(" · ")}</p> : null}
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void preview()}>{t(($) => $.researchTools.findings.source)}</Button>
    {source ? <div className="space-y-1 text-xs" data-testid="finding-source">
      <p>{t(($) => $.researchTools.findings.retainedQuote)} · {`${source.path}:${source.lineStart}–${source.lineEnd}`}</p>
      <CodeBlock code={source.quote} preClassName="max-h-48 whitespace-pre-wrap break-words" />
      <p className="break-all font-mono">{`SHA-256 ${source.fileSha256}`}</p>
      <p className="break-all font-mono">{t(($) => $.researchTools.findings.quoteHash)}: {source.quoteSha256}</p>
    </div> : null}
    {basis ? <details className="text-xs"><summary>{t(($) => $.researchTools.findings.dependencies)}</summary>
      <p className="break-all font-mono">{basis.source.path}: {basis.source.fileSha256}</p>
      <p className="break-all font-mono">{`run:${basis.runId}: ${basis.runSha256}`}</p>
      <p>{t(($) => $.researchTools.findings.ledgerBasis, { run: basis.runId, present: basis.ledgerContainsRun ? t(($) => $.researchTools.findings.present) : t(($) => $.researchTools.findings.missing) })}</p>
    </details> : null}
    <label htmlFor={`finding-reason-${finding.id}`} className="block space-y-1 text-xs">
      <span>{t(($) => $.researchTools.findings.reason)}</span>
      <Textarea id={`finding-reason-${finding.id}`} value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={2000} rows={2} disabled={busy} />
    </label>
    <div className="flex flex-wrap gap-2">
      {(["accepted", "rejected", "deferred", "open"] as const).map((disposition) => <Button key={disposition} size="xs" variant="outline" disabled={busy || !rationale.trim()} onClick={() => void decide(disposition)}>
        {disposition === "accepted" ? t(($) => $.researchTools.findings.accept) : disposition === "rejected" ? t(($) => $.researchTools.findings.reject) : disposition === "deferred" ? t(($) => $.researchTools.findings.defer) : t(($) => $.researchTools.findings.reopen)}
      </Button>)}
    </div>
    {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
    {view.historyCount > 0 ? <details className="text-xs"><summary>{t(($) => $.researchTools.findings.history, { count: view.historyCount })}</summary>
      {view.historyCount > view.history.length ? <p>{t(($) => $.researchTools.findings.historyShortened, { count: view.history.length })}</p> : null}
      <ol className="max-h-48 space-y-1 overflow-auto">{view.history.map((record) => <li key={record.sequence} className="break-words">
        #{record.sequence} · {dispositionLabel(record.disposition)} · {formatDateTime(record.createdAt)} · {record.actor}/{record.source}<p>{record.rationale}</p>
      </li>)}</ol>
    </details> : null}
  </li>;
}

export function TaskFindings({ taskId, generation, revision }: Readonly<{ taskId: string; generation: number; revision: number }>) {
  const { t } = useTranslation("researchTools");
  const [page, setPage] = useState<FindingPage | null>(null);
  const [rows, setRows] = useState<FindingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: task revisions and explicit refreshes recompute dependency validity from the current workspace.
  useEffect(() => {
    const version = ++requestVersion.current;
    setLoading(true); setError(null); setPage(null); setRows([]);
    void loadResearchTaskFindings(taskId, generation).then((result) => {
      if (version === requestVersion.current) { setPage(result); setRows(result.findings); }
    }).catch((failure) => { if (version === requestVersion.current) setError(describeError(failure)); })
      .finally(() => { if (version === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [taskId, generation, revision, reload]);
  const more = async () => {
    if (!page) return;
    const version = requestVersion.current;
    setLoading(true); setError(null);
    try {
      const result = await loadResearchTaskFindings(taskId, generation, page.nextSequence);
      if (version === requestVersion.current) { setPage(result); setRows((previous) => [...previous, ...result.findings]); }
    } catch (failure) { if (version === requestVersion.current) setError(describeError(failure)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  };
  return <section className="space-y-2" data-testid="task-findings" aria-label={t(($) => $.researchTools.findings.title)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-sm font-medium">{t(($) => $.researchTools.findings.title)}</h5>
      <Button size="xs" variant="outline" disabled={loading} onClick={() => setReload((value) => value + 1)}>{t(($) => $.researchTools.findings.refresh)}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.findings.scope)}</p>
    <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.findings.independent)}</p>
    {page?.coverageGaps.includes("findings.numeric_items_without_source") ? <p className="text-xs text-muted-foreground">{t(($) => $.researchTools.findings.unretained)}</p> : null}
    {loading ? <p role="status" className="text-xs">{t(($) => $.researchTools.findings.loading)}</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {page && rows.length === 0 ? <p className="text-xs">{t(($) => $.researchTools.findings.empty)}</p> : null}
    <ul className="space-y-2">{rows.map((view) => <FindingCard key={view.finding.id} taskId={taskId} generation={generation} view={view} onSaved={() => setReload((value) => value + 1)} />)}</ul>
    {page?.hasMore ? <Button size="xs" variant="outline" disabled={loading} onClick={() => void more()}>{t(($) => $.researchTools.findings.more)}</Button> : null}
  </section>;
}

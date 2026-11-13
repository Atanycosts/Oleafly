import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeBlock } from "@/components/ui/code-block";
import { journalRequest, type JournalCheck, type JournalProject, type JournalWorld } from "@/lib/journal-workbench";

interface TemplateFinding {
  case_id: string; object_id: string; kind: string; role: string; part: string; path: number[];
  property_path: string; observed: unknown; expected: unknown; template_object_ids: string[];
  verdict: string; role_basis?: unknown[]; template_role_basis?: unknown[];
  region?: unknown; reason?: string;
}
interface FindingPage { findings: TemplateFinding[]; total: number; next_offset: number | null }
const PAGE_SIZE = 20;
const showValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const hasXmlPath = (objectId: string) => /^.+#\d+(?:\.\d+)*$/.test(objectId);

export function JournalTemplatePanel({ world, project, check }: {
  world: JournalWorld; project: JournalProject | null; check: JournalCheck | null;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal.template, { returnObjects: true });
  const verdicts = t(($) => $.researchTools.journal.verdicts, { returnObjects: true });
  const [target, setTarget] = useState<"template" | "manuscript">("template");
  const [operation, setOperation] = useState<"snapshot" | "part" | "nodes" | "relationships">("snapshot");
  const [part, setPart] = useState("/word/document.xml");
  const [localName, setLocalName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState("observed_difference");
  const [findingPosition, setFindingPosition] = useState({ checkId: "", verdict: "", offset: 0 });
  const [findings, setFindings] = useState<FindingPage | null>(null);
  const [findingBusy, setFindingBusy] = useState(false);
  const [findingError, setFindingError] = useState<string | null>(null);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const readSequence = useRef(0);
  const checkId = check?.check_id;
  const hasComparison = !!check?.template_comparison;
  const findingOffset = findingPosition.checkId === checkId && findingPosition.verdict === verdict ? findingPosition.offset : 0;
  const setFindingOffset = (offset: number) => setFindingPosition({ checkId: checkId ?? "", verdict, offset });

  // biome-ignore lint/correctness/useExhaustiveDependencies: A change of retained context invalidates pending reads and their displayed evidence.
  useEffect(() => {
    readSequence.current++;
    setResult(null); setOffset(0); setNextOffset(null); setBusy(false); setError(null);
    return () => { readSequence.current++; };
  }, [world.version_id, project?.project_id, project?.baseline_id, checkId, check?.baseline_id]);

  useEffect(() => {
    setFindings(null);
    if (!checkId || !hasComparison) { setFindingBusy(false); setFindingError(null); return; }
    let active = true;
    setFindingBusy(true); setFindingError(null);
    void journalRequest<FindingPage>("/api/docx-query", {
      target: { check_id: checkId }, operation: "findings", verdict,
      offset: findingOffset, limit: PAGE_SIZE,
    }).then((page) => { if (active) setFindings(page); })
      .catch((cause) => { if (active) setFindingError(String(cause)); })
      .finally(() => { if (active) setFindingBusy(false); });
    return () => { active = false; };
  }, [checkId, hasComparison, findingOffset, verdict]);

  if (!world.template) return null;

  async function read(pageOffset = 0) {
    const sequence = ++readSequence.current;
    setBusy(true); setError(null);
    try {
      const response = await journalRequest<Record<string, unknown>>("/api/docx-query", {
        target: target === "template" ? { world_version_id: world.version_id } : {
          project_id: project?.project_id, baseline_id: check?.baseline_id ?? project?.baseline_id,
        }, operation,
        ...(operation === "part" || operation === "nodes" ? { part } : {}),
        ...(operation === "nodes" ? {
          ...(localName ? { local_name: localName } : {}), ...(namespace ? { namespace_uri: namespace } : {}),
          ...(path.trim() ? { path: JSON.parse(path) } : {}),
        } : {}),
        ...(operation !== "part" ? { offset: pageOffset, limit: PAGE_SIZE } : {}),
      });
      if (sequence !== readSequence.current) return;
      if (operation === "snapshot") {
        const next = response.snapshot as Record<string, unknown>;
        if (!next) throw new Error(text.noSnapshot);
      }
      setResult(response); setOffset(pageOffset);
      setNextOffset(typeof response.next_offset === "number" ? response.next_offset : null);
    } catch (cause) { if (sequence === readSequence.current) setError(String(cause)); }
    finally { if (sequence === readSequence.current) setBusy(false); }
  }

  async function inspectObject(from: "template" | "manuscript", objectId: string) {
    const separator = objectId.lastIndexOf("#");
    const objectPart = objectId.slice(0, separator);
    const objectPath = objectId.slice(separator + 1).split(".").map(Number);
    setTarget(from); setOperation("nodes"); setPart(objectPart); setPath(JSON.stringify(objectPath));
    setLocalName(""); setNamespace(""); setInspectionOpen(true);
    const sequence = ++readSequence.current;
    setBusy(true); setError(null);
    try {
      const response = await journalRequest<Record<string, unknown>>("/api/docx-query", {
        target: from === "template" ? { world_version_id: world.version_id } : {
          project_id: project?.project_id, baseline_id: check?.baseline_id ?? project?.baseline_id,
        }, operation: "nodes", part: objectPart, path: objectPath, offset: 0, limit: PAGE_SIZE,
      });
      if (sequence === readSequence.current) {
        setResult(response); setOffset(0); setNextOffset(typeof response.next_offset === "number" ? response.next_offset : null);
      }
    } catch (cause) { if (sequence === readSequence.current) setError(String(cause)); }
    finally { if (sequence === readSequence.current) setBusy(false); }
  }

  function resetInspection() { readSequence.current++; setResult(null); setBusy(false); setError(null); }

  return <section className="space-y-3 rounded-lg border border-sidebar-border p-3 text-xs" data-testid="journal-template-facts">
    <p className="font-semibold">{text.title}</p>
    <p className="text-muted-foreground">{text.adopted}</p>
    <details><summary>{text.identity}</summary>
      <p className="mt-1 break-all font-mono">{world.template.original_sha256}</p>
      <p className="break-all font-mono">{world.template.source_sha256}</p>
      {world.template.provenance && <p>{world.template.provenance.engine} · {world.template.provenance.version}</p>}
    </details>
    {hasComparison && <div className="space-y-2">
      <label className="flex items-center gap-2 font-medium">{text.differences}
        <select aria-label={text.filter} className="rounded border bg-background p-1" value={verdict} onChange={(event) => setVerdict(event.target.value)}>
          {["observed_difference", "cannot_determine", "observed_match"].map((value) => <option key={value} value={value}>{verdicts[value as keyof typeof verdicts]}</option>)}
        </select>
      </label>
      {findingError && <p role="alert" className="text-destructive">{findingError}</p>}
      {findings && <>
        <p className="text-muted-foreground">{findings.total} {text.cases}</p>
        <div className="max-h-96 space-y-2 overflow-auto" aria-busy={findingBusy}>
          {findings.findings.map((finding) => <article key={finding.case_id} className="space-y-1 rounded border p-2">
            <p className="font-medium">{finding.role} · {finding.kind} · {finding.property_path}</p>
            <p className="break-words">{text.observed}: {showValue(finding.observed)}</p>
            <p className="break-words">{text.expected}: {showValue(finding.expected)}</p>
            {finding.reason && <p className="text-muted-foreground">{finding.reason}</p>}
            <code className="block break-all text-muted-foreground">{finding.object_id}</code>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" disabled={busy || !hasXmlPath(finding.object_id)} onClick={() => void inspectObject("manuscript", finding.object_id)}>{text.readObject}</Button>
              {finding.template_object_ids?.filter(hasXmlPath).slice(0, 1).map((id) => <Button key={id} size="sm" variant="ghost" disabled={busy} onClick={() => void inspectObject("template", id)}>{text.readExpected}</Button>)}
            </div>
            <details><summary>{text.roleBasis}</summary><CodeBlock code={JSON.stringify({ role_basis: finding.role_basis, template_role_basis: finding.template_role_basis, region: finding.region }, null, 2)} preClassName="whitespace-pre-wrap break-all" /></details>
          </article>)}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={findingBusy || findingOffset === 0} onClick={() => setFindingOffset(Math.max(0, findingOffset - PAGE_SIZE))}>{text.previous}</Button>
          <Button size="sm" variant="ghost" disabled={findingBusy || findings.next_offset === null} onClick={() => setFindingOffset(findings.next_offset ?? 0)}>{text.next}</Button>
        </div>
      </>}
    </div>}
    <details open={inspectionOpen} onToggle={(event) => setInspectionOpen(event.currentTarget.open)}><summary>{text.inspect}</summary>
      <div className="mt-2 space-y-2">
        <label className="block">{text.target}<select className="ml-2 rounded border bg-background p-1" value={target} onChange={(event) => { setTarget(event.target.value as typeof target); resetInspection(); }}>
          <option value="template">{text.template}</option><option value="manuscript" disabled={!project}>{text.manuscript}</option>
        </select></label>
        <label className="block">{text.operation}<select className="ml-2 rounded border bg-background p-1" value={operation} onChange={(event) => { setOperation(event.target.value as typeof operation); resetInspection(); }}>
          <option value="snapshot">{text.snapshot}</option><option value="part">{text.part}</option><option value="nodes">{text.nodes}</option><option value="relationships">{text.relationships}</option>
        </select></label>
        {(operation === "part" || operation === "nodes") && <Input aria-label={text.partPath} className="text-xs" value={part} onChange={(event) => { setPart(event.target.value); resetInspection(); }} />}
        {operation === "nodes" && <>
          <Input aria-label={text.localName} placeholder={text.localName} value={localName} onChange={(event) => { setLocalName(event.target.value); resetInspection(); }} />
          <Input aria-label={text.namespace} placeholder={text.namespace} value={namespace} onChange={(event) => { setNamespace(event.target.value); resetInspection(); }} />
          <Input aria-label={text.nodePath} placeholder={text.nodePath} value={path} onChange={(event) => { setPath(event.target.value); resetInspection(); }} />
        </>}
        <Button size="sm" variant="outline" disabled={busy || (target === "manuscript" && !project)} onClick={() => void read()}>{text.read}</Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {result !== null && <>
          <div className="max-h-96 overflow-auto"><CodeBlock code={JSON.stringify(result, null, 2)} preClassName="whitespace-pre-wrap break-all" /></div>
          {operation !== "part" && <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy || offset === 0} onClick={() => void read(Math.max(0, offset - PAGE_SIZE))}>{text.previous}</Button>
            <Button size="sm" variant="ghost" disabled={busy || nextOffset === null} onClick={() => void read(nextOffset ?? 0)}>{text.next}</Button>
          </div>}
        </>}
      </div>
    </details>
  </section>;
}

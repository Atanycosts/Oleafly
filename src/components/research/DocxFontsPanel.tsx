import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { hasExactDocxFont, type DocxFontStatus } from "@/lib/docx-fonts";
import type { JournalWorld } from "@/lib/journal-workbench";
import { useFontPacksStore } from "@/store/font-packs";

type Acquisition = "checking" | "available" | "downloading" | "noSource" | "failed" | "stillMissing";
const familyKey = (family: string) => family.trim().toLowerCase();

export function DocxFontsPanel({ world, status, ready, onRefresh }: {
  world: JournalWorld | null;
  status: DocxFontStatus;
  ready: boolean;
  onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.fonts, { returnObjects: true });
  const [acquisition, setAcquisition] = useState<Record<string, Acquisition>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retryRef = useRef<() => Promise<void>>(async () => {});
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const rules = world?.rules?.filter((rule) => rule.property === "body_font_family" && typeof rule.expected === "string") ?? [];
  const inScope = (rule: NonNullable<JournalWorld["rules"]>[number]) => !!world && rule.scope.article_type === world.scope.article_type && rule.scope.stage === world.scope.stage && rule.scope.language === world.scope.language;

  useEffect(() => {
    let active = true;
    const required = new Set(world?.rules?.filter((rule) => rule.property === "body_font_family" && rule.unit === "font_family" && rule.basis_status === "confirmed" && typeof rule.expected === "string" && rule.scope.article_type === world.scope.article_type && rule.scope.stage === world.scope.stage && rule.scope.language === world.scope.language).map((rule) => String(rule.expected).trim()));
    const check = async () => {
      setAcquisition({});
      setError(null);
      setBusy(false);
      if (!ready || !status.probed || !required.size) return;
      setBusy(true);
      try {
      await useFontPacksStore.getState().load();
      for (const family of required) {
        if (!active) return;
        const update = (value: Acquisition) => { if (active) setAcquisition((current) => ({ ...current, [family]: value })); };
        update("checking");
        const available = await hasExactDocxFont(family);
        if (!active) return;
        if (available) { update("available"); continue; }
        const catalog = useFontPacksStore.getState();
        if (catalog.status !== "ready") { update("failed"); continue; }
        const pack = catalog.packs.find((item) => item.families?.some((name) => familyKey(name) === familyKey(family)));
        if (!pack) { update("noSource"); continue; }
        update("downloading");
        if (!await catalog.install(pack.id)) { update("failed"); continue; }
        if (!active) return;
        await refreshRef.current();
        update(await hasExactDocxFont(family) ? "available" : "stillMissing");
      }
      } catch (cause) { if (active) setError(String(cause)); }
      finally { if (active) setBusy(false); }
    };
    retryRef.current = check;
    void check();
    return () => { active = false; };
  }, [world, ready, status.probed]);

  async function refresh() {
    setBusy(true);
    setError(null);
    try { await onRefresh(); await retryRef.current(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return <section className="space-y-2 rounded border p-2 text-xs" data-testid="docx-fonts-panel">
    <p className="font-medium">{text.title}</p>
    <p>{text.journalRequirements}</p>
    {world && <p className="break-all text-muted-foreground" data-testid="docx-font-world">{world.journal_name} · {world.version_id}</p>}
    {rules.length === 0 && <p className="text-muted-foreground">{text.noRequirements}</p>}
    {rules.map((rule) => <div key={rule.rule_id} className="space-y-1" data-testid="docx-journal-font" data-basis={rule.basis_status}>
      <p>{String(rule.expected)} · {rule.basis_status === "confirmed" ? text.confirmed : text.unconfirmed}</p>
      {useFontPacksStore.getState().packs.filter((pack) => pack.families?.some((family) => familyKey(family) === familyKey(String(rule.expected)))).map((pack) => <p key={pack.id} className="text-muted-foreground">{pack.description}{pack.license?.url && <> · <a href={pack.license.url} target="_blank" rel="noreferrer" className="underline">{pack.license.spdx}</a></>}</p>)}
      {rule.basis_status === "confirmed" && (inScope(rule) ? <p data-testid="docx-font-acquisition" data-state={acquisition[String(rule.expected)] ?? "checking"}>{text[acquisition[String(rule.expected)] ?? "checking"]}</p> : <p>{text.outsideScope}</p>)}
      {rule.evidence.map((evidence) => <p key={`${evidence.source_id}:${evidence.locator}`} className="text-muted-foreground">{evidence.source_id} · {evidence.locator} · {evidence.quote}</p>)}
    </div>)}
    <p className="text-muted-foreground">{text.acquisitionOnly}</p>
    <p>{text.documentMissing}</p>
    <p className="text-muted-foreground">{text.probeScope}</p>
    {!status.probed ? <p>{text.notProbed}</p> : status.missing.length > 0 ? <p className="break-words" data-testid="docx-font-missing">{status.missing.map((face) => `${face.family} (${face.weight}, ${face.style})`).join(", ")}</p> : <p>{text.noneMissing}</p>}
    {status.aliases.length > 0 && <p data-testid="docx-font-aliases">{text.aliases}: {status.aliases.map((item) => `${item.from} → ${item.to}`).join(", ")}</p>}
    {status.loaded && <ul className="break-all text-muted-foreground" data-testid="docx-font-versions">{[...new Map(status.loaded.map((face) => [face.sha256, face])).values()].map((face) => <li key={face.sha256}>{`${face.family} · ${face.version ?? "—"} · SHA-256 ${face.sha256}`}</li>)}</ul>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button size="sm" variant="outline" disabled={busy || !ready} onClick={() => void refresh()} data-testid="docx-font-refresh">{text.refresh}</Button>
  </section>;
}

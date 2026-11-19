import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DocxFontStatus } from "@/lib/docx-fonts";
import { ensureDocxFonts, requiredDocxFontFamilies, type DocxFontAcquisition } from "@/lib/docx-prepare-fonts";
import type { JournalWorld } from "@/lib/journal-workbench";
import { useFontPacksStore } from "@/store/font-packs";

const familyKey = (family: string) => family.trim().toLowerCase();

export function DocxFontsPanel({ world, status, ready, onRefresh }: {
  world: JournalWorld | null;
  status: DocxFontStatus;
  ready: boolean;
  onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.docx.fonts, { returnObjects: true });
  const workspace = t(($) => $.researchTools.workspace, { returnObjects: true });
  const packs = useFontPacksStore((state) => state.packs);
  const catalogStatus = useFontPacksStore((state) => state.status);
  const catalogRevision = useFontPacksStore((state) => state.revision);
  const installing = useFontPacksStore((state) => state.installing);
  const [acquisition, setAcquisition] = useState<Record<string, DocxFontAcquisition>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const retryRef = useRef<() => Promise<void>>(async () => {});
  const acquisitionInFlight = useRef<Promise<unknown> | null>(null);
  const refreshInFlight = useRef(false);
  const refreshPending = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const observedRevision = useRef(catalogRevision);
  const attemptedPacks = useRef({
    worldVersionId: world?.version_id ?? null,
    ids: new Set<string>(),
  });
  const rules = world?.rules?.filter((rule) => rule.property === "body_font_family" && typeof rule.expected === "string") ?? [];
  const templateFonts = world?.template?.font_requirements ?? [];
  const sourceNames = new Map(world?.sources?.map((source) => [source.source_id, source.name]) ?? []);
  const missingFamilies = [...status.missing.reduce((families, face) => {
    const key = familyKey(face.family);
    if (!families.has(key)) families.set(key, face.family);
    return families;
  }, new Map<string, string>()).values()];
  const inScope = (rule: NonNullable<JournalWorld["rules"]>[number]) => !!world && rule.scope.article_type === world.scope.article_type && rule.scope.stage === world.scope.stage && rule.scope.language === world.scope.language;

  useEffect(() => {
    let active = true;
    let run = 0;
    const worldVersionId = world?.version_id ?? null;
    const check = async () => {
      const currentRun = ++run;
      setAcquisition({});
      setError(null);
      if (!ready || !status.probed || !requiredDocxFontFamilies(world).length) return;
      try {
      if (attemptedPacks.current.worldVersionId !== worldVersionId) {
        attemptedPacks.current = { worldVersionId, ids: new Set<string>() };
      }
      const preparing = ensureDocxFonts(world, {
        attemptedPacks: attemptedPacks.current.ids,
        isActive: () => active && currentRun === run,
        onState: (family, value) => { if (active && currentRun === run) setAcquisition((current) => ({ ...current, [familyKey(family)]: value })); },
      });
      acquisitionInFlight.current = preparing;
      try { await preparing; }
      finally { if (acquisitionInFlight.current === preparing) acquisitionInFlight.current = null; }
      } catch (cause) { if (active) setError(String(cause)); }
    };
    retryRef.current = check;
    void check();
    return () => { active = false; };
  }, [world, ready, status.probed]);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshPending.current = true;
      return;
    }
    refreshInFlight.current = true;
    setRefreshing(true);
    setError(null);
    try {
      do {
        refreshPending.current = false;
        const preparing = acquisitionInFlight.current;
        await onRefresh();
        if (preparing) await preparing;
        else await retryRef.current();
      } while (refreshPending.current);
    } catch (cause) { setError(String(cause)); }
    finally {
      refreshPending.current = false;
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    if (catalogRevision === observedRevision.current || !ready) return;
    observedRevision.current = catalogRevision;
    void refresh();
  }, [catalogRevision, ready, refresh]);

  const catalogDetails = (family: string) => packs
    .filter((pack) => pack.families?.some((name) => familyKey(name) === familyKey(family)))
    .map((pack) => <div key={pack.id} className="space-y-1 text-muted-foreground">
      <p>{pack.description || pack.label}</p>
      <p>{pack.installed ? workspace.docxFonts.installedPack : workspace.docxFonts.notInstalledPack}</p>
      {pack.license?.url && <a href={pack.license.url} target="_blank" rel="noreferrer" className="underline">
        {workspace.docxFonts.license}
      </a>}
    </div>);
  const roleLabel = (role: string) => {
    const labels: Record<string, string> = {
      body: workspace.docxFonts.roles.body,
      heading: workspace.docxFonts.roles.heading,
      document_title: workspace.docxFonts.roles.documentTitle,
      caption: workspace.docxFonts.roles.caption,
      header: workspace.docxFonts.roles.header,
      footer: workspace.docxFonts.roles.footer,
    };
    return labels[role] ?? workspace.docxFonts.roles.other;
  };
  const scriptLabel = (script: string) => {
    const labels: Record<string, string> = {
      latin: workspace.docxFonts.scripts.latin,
      east_asian: workspace.docxFonts.scripts.eastAsian,
      complex: workspace.docxFonts.scripts.complex,
      other: workspace.docxFonts.scripts.other,
    };
    return labels[script] ?? workspace.docxFonts.scripts.other;
  };
  const versionDetails = (family: string) => [...new Map((status.loaded ?? [])
    .filter((face) => familyKey(face.family) === familyKey(family))
    .map((face) => [face.version ?? "", face])).values()]
    .map((face) => face.version
      ? t(($) => $.researchTools.workspace.docxFonts.installedVersion, { version: face.version })
      : workspace.docxFonts.installed);
  const acquisitionState = (family: string) => {
    const state = acquisition[familyKey(family)] ?? "checking";
    return state === "checking" && catalogStatus === "error" ? "failed" : state;
  };

  return <section className="space-y-2 rounded border p-2 text-xs" data-testid="docx-fonts-panel">
    <p className="font-medium">{text.title}</p>
    <p>{text.journalRequirements}</p>
    {rules.length === 0 && templateFonts.length === 0 && <p className="text-muted-foreground">{text.noRequirements}</p>}
    {rules.map((rule) => <div key={rule.rule_id} className="space-y-1" data-testid="docx-journal-font" data-basis={rule.basis_status}>
      <p className="font-medium">{String(rule.expected)}</p>
      <p className="text-muted-foreground">{rule.basis_status === "confirmed" ? text.confirmed : text.unconfirmed}</p>
      {rule.basis_status === "confirmed" && (inScope(rule) ? <p data-testid="docx-font-acquisition" data-state={acquisitionState(String(rule.expected))}>{text[acquisitionState(String(rule.expected))]}</p> : <p>{text.outsideScope}</p>)}
      {versionDetails(String(rule.expected)).map((version) => <p key={version} className="text-muted-foreground">{version}</p>)}
      {rule.evidence.map((evidence) => <div key={`${evidence.source_id}:${evidence.locator}`} className="text-muted-foreground">
        <blockquote className="border-l-2 pl-2 italic">{evidence.quote}</blockquote>
        <p>{sourceNames.get(evidence.source_id) ?? workspace.docxFonts.journalGuide}</p>
      </div>)}
      {catalogDetails(String(rule.expected))}
    </div>)}
    {templateFonts.length > 0 && <p className="text-muted-foreground">{text.templateFonts}</p>}
    {templateFonts.map((font) => <div key={font.family} className="space-y-1" data-testid="docx-template-font">
      <p className="font-medium">{font.family}</p>
      <p data-testid="docx-font-acquisition" data-state={acquisitionState(font.family)}>{text[acquisitionState(font.family)]}</p>
      {versionDetails(font.family).map((version) => <p key={version} className="text-muted-foreground">{version}</p>)}
      <p className="text-muted-foreground">
        {t(($) => $.researchTools.workspace.docxFonts.usedFor, { roles: font.roles.map(roleLabel).join("、") })}
        {" · "}{font.scripts.map(scriptLabel).join("、")}
      </p>
      {catalogDetails(font.family)}
    </div>)}
    <p className="text-muted-foreground">{text.acquisitionOnly}</p>
    {!status.probed
      ? <p>{text.notProbed}</p>
      : missingFamilies.length > 0
        ? <div className="space-y-1">
          <p className="font-medium">{text.documentMissing}</p>
          <p className="break-words" data-testid="docx-font-missing-families">{missingFamilies.join(", ")}</p>
        </div>
        : <p>{text.noneMissing}</p>}
    <p className="text-muted-foreground">{text.probeScope}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button size="sm" variant="outline" disabled={refreshing || installing !== null || !ready} onClick={() => void refresh()} data-testid="docx-font-refresh">{text.refresh}</Button>
  </section>;
}

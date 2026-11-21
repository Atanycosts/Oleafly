import { useId, useMemo, useRef, useState } from "react";
import type { OoxmlPackage } from "@docx-editor.dev/core/store";
import { Check, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { docxDoiFromUrl } from "@/lib/docx-citation-doi";
import { searchDocxCitationArticles } from "@/lib/docx-citation-search";
import {
  filterDocxCitationSources,
  listDocxCitationSources,
  planDocxCitationSource,
  type DocxCitationArticle,
  type DocxCitationInsertRequest,
} from "@/lib/docx-citation-write";
import { useSettingsStore } from "@/store/settings";

export type DocxCitationPickerRefusal = "position" | "source" | "metadata";

function CitationChoice({ title, details, selected, onPick }: {
  title: string;
  details: string;
  selected: boolean;
  onPick(): void;
}) {
  const detailId = useId();
  return <Button type="button" variant="ghost"
    className="h-auto w-full justify-start rounded-none px-3 py-2 text-left text-xs whitespace-normal aria-pressed:bg-accent aria-pressed:text-accent-foreground"
    aria-label={title} aria-describedby={details ? detailId : undefined} aria-pressed={selected} onClick={(event) => {
      event.currentTarget.focus({ preventScroll: true });
      onPick();
    }}>
    <span className="min-w-0 flex-1 break-words">{title}
      {details && <span id={detailId} className="block [overflow-wrap:anywhere] font-normal text-muted-foreground">{details}</span>}
    </span>
    <Check aria-hidden="true" className={selected ? "text-primary" : "invisible"} />
  </Button>;
}

export function DocxCitationPicker({ pkg, insert, onClose }: {
  pkg: OoxmlPackage;
  insert(source: DocxCitationInsertRequest["source"]): DocxCitationPickerRefusal | null;
  onClose(): void;
}) {
  const { t } = useTranslation(["researchTools", "common"]);
  const offline = useSettingsStore((state) => state.offline);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<readonly DocxCitationArticle[] | "loading" | "error" | null>(null);
  const [refused, setRefused] = useState<DocxCitationPickerRefusal | null>(null);
  const [picked, setPicked] = useState<DocxCitationInsertRequest["source"] | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const statusId = useId();
  const typed = query.trim();
  const documentSources = t(($) => $.researchTools.docx.fieldTools.documentSources);
  const crossrefResults = t(($) => $.researchTools.docx.fieldTools.crossrefResults);
  const sources = useMemo(() => listDocxCitationSources(pkg), [pkg]);
  const local = filterDocxCitationSources(sources, query);
  const external: readonly DocxCitationArticle[] = Array.isArray(result) ? result : [];
  const plan = picked ? planDocxCitationSource(pkg, picked) : null;
  const sourceConflict = plan?.kind === "refused" && plan.code === "ambiguous-citation-source";
  const invalidMetadata = plan?.kind === "refused" && plan.code === "unsupported-citation-metadata";
  const error = refused === "source" || sourceConflict ? t(($) => $.researchTools.docx.fieldTools.ambiguousSource)
    : refused === "metadata" || invalidMetadata ? t(($) => $.researchTools.docx.fieldTools.unsupportedSourceMetadata)
    : plan?.kind === "refused" ? t(($) => $.researchTools.docx.fieldTools.sourceUnavailable)
    : refused ? t(($) => $.researchTools.docx.fieldTools.insertRefused) : null;
  const titleCounts = new Map<string, number>();
  for (const source of local) titleCounts.set(source.title, (titleCounts.get(source.title) ?? 0) + 1);
  const searchCrossref = async () => {
    if (useSettingsStore.getState().offline || !typed || result === "loading") return;
    const ticket = ++request.current;
    setPicked(null);
    setRefused(null);
    setResult("loading");
    try {
      const found = await searchDocxCitationArticles(typed);
      if (ticket === request.current) setResult(found);
    } catch {
      if (ticket === request.current) setResult("error");
    }
  };

  return <div className="flex max-h-[inherit] flex-col text-xs">
    <form className="flex shrink-0 gap-1.5 border-b p-2" onSubmit={(event) => {
      event.preventDefault();
      searchInput.current?.focus({ preventScroll: true });
      void searchCrossref();
    }}>
      <Input ref={searchInput} type="search" data-docx-history="field" className="h-7 min-w-0 text-xs" aria-label={t(($) => $.researchTools.docx.fieldTools.searchSources)}
        placeholder={t(($) => $.researchTools.docx.fieldTools.searchSources)} value={query}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
            event.preventDefault();
          }
        }}
        onChange={(event) => {
          request.current++;
          setQuery(event.target.value);
          setPicked(null);
          setRefused(null);
          setResult(null);
        }} />
      <Button type="submit" size="icon" variant="ghost" className="size-7 shrink-0" disabled={offline || !typed || result === "loading"}
        aria-label={t(($) => $.researchTools.docx.fieldTools.searchCrossref)} title={t(($) => $.researchTools.docx.fieldTools.searchCrossref)}>
        <Search className="size-3.5" />
      </Button>
      <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0"
        onClick={onClose}
        aria-label={t(($) => $.common.actions.close)} title={t(($) => $.common.actions.close)}>
        <X className="size-3.5" />
      </Button>
    </form>
    <div className="min-h-12 flex-1 overflow-y-auto">
      {local.length > 0 && <section aria-label={documentSources}>
        <h3 className="px-3 pt-2 font-medium text-muted-foreground">{documentSources}</h3>
        {local.map(({ tag, title, doi }) => <CitationChoice key={tag}
          title={(titleCounts.get(title) ?? 0) > 1 ? `${title} (${tag})` : title} details={doi ?? ""}
          selected={picked !== null && "existingTag" in picked && picked.existingTag === tag}
          onPick={() => { setPicked({ existingTag: tag }); setRefused(null); }} />)}
      </section>}
      {result === "loading" && <p role="status" className="px-3 py-2 text-muted-foreground">{t(($) => $.researchTools.docx.fieldTools.searching)}</p>}
      {result === "error" && <p role="alert" className="px-3 py-2 text-destructive">{t(($) => $.researchTools.docx.fieldTools.searchFailed)}</p>}
      {external.length > 0 && <section aria-label={crossrefResults} className={local.length > 0 ? "border-t" : undefined}>
        <h3 className="px-3 pt-2 font-medium text-muted-foreground">{crossrefResults}</h3>
        {external.map((article, index) => <CitationChoice key={`${index}:${article.title}`} title={article.title}
          details={[article.journal, article.year, article.url && docxDoiFromUrl(article.url)].filter(Boolean).join(" · ")}
          selected={picked !== null && "article" in picked && picked.article === article}
          onPick={() => { setPicked({ article }); setRefused(null); }} />)}
      </section>}
      {local.length === 0 && ((Array.isArray(result) && result.length === 0) || (offline && result === null)) &&
        <p role="status" className="px-3 py-2 text-muted-foreground">{t(($) => $.researchTools.docx.fieldTools.noSources)}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2 border-t p-2">
      <div className="min-w-0 flex-1">
        {error ? <p role="alert" className="break-words text-destructive">{error}</p> :
          <p id={statusId} role="status" className="line-clamp-2 break-words text-muted-foreground">
            {plan?.kind === "reuse" ? t(($) => $.researchTools.docx.fieldTools.reuseSource, { title: plan.title })
              : plan?.kind === "add" ? t(($) => $.researchTools.docx.fieldTools.addSource) : null}
          </p>}
      </div>
      <Button type="button" size="sm" className="h-7 shrink-0 text-xs" disabled={!plan || plan.kind === "refused"}
        aria-describedby={plan && !error ? statusId : undefined}
        onClick={() => { if (picked) setRefused(insert(picked)); }}>
        {t(($) => $.researchTools.docx.fieldTools.insertCitation)}
      </Button>
    </div>
  </div>;
}

import { Check, ChevronDown, ChevronRight, Crosshair, Download, Square, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { CandidateReviewItem } from "@/lib/docx-format-candidate-flow";
import type { DocxCandidateReviewRecord, DocxCandidateReviewView } from "@/lib/docx-format-candidate-review";
import type { DocxSource } from "@/lib/docx-workbench";
import type {
  DocxFindingGroup,
  DocxFindingLocation,
  DocxFindingVerdict,
} from "@/lib/docx-finding-review";
import { DOCX_FINDING_CATEGORY_ORDER, DocxFindingBrowser } from "./DocxFindingBrowser";

interface FormatCandidateAdoption {
  captured: DocxSource;
  sessionId: string;
  revision: number;
  record: DocxCandidateReviewRecord;
}

export type FormatCandidateState =
  | { phase: "running" }
  | { phase: "failed"; error: string }
  | { phase: "ready"; review: DocxCandidateReviewView; adoption: FormatCandidateAdoption }
  | { phase: "unchanged" | "adopted"; review: DocxCandidateReviewView }
  | { phase: "conflict"; review: DocxCandidateReviewView; reason?: string };

const CANDIDATE_VERDICTS: readonly DocxFindingVerdict[] = [
  "observed_difference",
  "cannot_determine",
];

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface ChangeLocationGroup {
  key: string;
  paraId?: string;
  location?: string;
  role: string;
  headingLevel?: number;
  objectNumber?: number;
  tableArea?: TableArea;
  actions: Map<string, CandidateReviewItem[]>;
}

type TableArea = "whole" | "header" | "body" | "exception";

interface TableChangeBlock {
  key: string;
  objectNumber?: number;
  areas: ChangeLocationGroup[];
}

const TABLE_AREA_ORDER: readonly TableArea[] = ["whole", "header", "body", "exception"];

function groupChanges(changes: readonly CandidateReviewItem[]) {
  const sections = new Map<DocxFindingGroup["category"], Map<string, ChangeLocationGroup>>();
  for (const change of changes) {
    const category = change.group.category;
    const key = category === "table"
      ? ["table", change.group.object_number ?? "unspecified", change.group.table_area ?? "whole"].join(":")
      : change.paraId ?? change.location ?? change.id;
    const section = sections.get(category) ?? new Map<string, ChangeLocationGroup>();
    sections.set(category, section);
    const location = section.get(key) ?? {
      key,
      paraId: change.paraId,
      location: change.location,
      role: change.role,
      headingLevel: change.group.heading_level,
      objectNumber: category === "table" ? change.group.object_number : undefined,
      tableArea: category === "table" ? change.group.table_area ?? "whole" : undefined,
      actions: new Map<string, CandidateReviewItem[]>(),
    };
    section.set(key, location);
    const action = change.group.action;
    const entries = location.actions.get(action) ?? [];
    entries.push(change);
    location.actions.set(action, entries);
  }
  return [...sections].sort(([left], [right]) =>
    DOCX_FINDING_CATEGORY_ORDER.indexOf(left) - DOCX_FINDING_CATEGORY_ORDER.indexOf(right));
}

function groupTableChanges(locations: readonly ChangeLocationGroup[]): TableChangeBlock[] {
  const blocks = new Map<string, TableChangeBlock>();
  for (const location of locations) {
    const key = location.objectNumber === undefined ? "unspecified" : String(location.objectNumber);
    const block = blocks.get(key) ?? { key, objectNumber: location.objectNumber, areas: [] };
    block.areas.push(location);
    blocks.set(key, block);
  }
  return [...blocks.values()]
    .map((block) => ({
      ...block,
      areas: block.areas.sort((left, right) =>
        TABLE_AREA_ORDER.indexOf(left.tableArea ?? "whole") - TABLE_AREA_ORDER.indexOf(right.tableArea ?? "whole")),
    }))
    .sort((left, right) => (left.objectNumber ?? Number.MAX_SAFE_INTEGER)
      - (right.objectNumber ?? Number.MAX_SAFE_INTEGER));
}

export function DocxFormatCandidatePanel({ state, adopting, adoptDisabled, onJump, onAdopt, onDownload, onStop, onClose, onReformat }: {
  state: FormatCandidateState;
  adopting: boolean;
  adoptDisabled?: boolean;
  onJump(paraId: string): void;
  onAdopt(): void;
  onDownload(): void;
  onStop(): void;
  onClose(): void;
  onReformat(): void;
}) {
  const { t } = useTranslation("researchTools");
  const [expandedActions, setExpandedActions] = useState<Set<string>>(() => new Set());
  const text = t(($) => $.researchTools.docx.formatCandidate, { returnObjects: true });
  const findingText = t(($) => $.researchTools.docx.findingReview, { returnObjects: true });
  const template = t(($) => $.researchTools.journal.template, { returnObjects: true });
  const review = "review" in state ? state.review : null;
  const roleLabel = (role: string) => template.roles[role as keyof typeof template.roles]
    ?? role.replaceAll("_", " ");
  const humanizeIdentifier = (value: string) => value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
  const formatLabel = (property: string) => findingText.actions[property as keyof typeof findingText.actions]
    ?? text.properties[property as keyof typeof text.properties]
    ?? template.formats[property as keyof typeof template.formats]
  const propertyLabel = (property: string) => formatLabel(property) ?? humanizeIdentifier(property);
  const tableAreaLabel = (area: TableArea) => {
    const labels: Record<TableArea, string> = {
      whole: findingText.wholeTable,
      header: findingText.tableHeader,
      body: findingText.tableBody,
      exception: findingText.tableException,
    };
    return labels[area];
  };

  const changeSections = groupChanges(review?.changes ?? []);
  const unconfirmedSections = groupChanges(review?.unconfirmedChanges ?? []);
  const actionKey = (unconfirmed: boolean, category: string, locationKey: string, action: string) =>
    [unconfirmed ? "unconfirmed" : "confirmed", category, locationKey, action].join("\u0000");
  const toggleAction = (key: string) => {
    setExpandedActions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const jumpToLocation = (location: DocxFindingLocation) => {
    if (location.para_id) onJump(location.para_id);
  };
  const renderChangeGroups = (
    sections: ReturnType<typeof groupChanges>,
    unconfirmed = false,
  ) => {
    const renderJump = (paraId: string) => <Tooltip label={findingText.openLocation}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        data-testid="docx-format-candidate-change-location"
        aria-label={findingText.openLocation}
        onClick={() => onJump(paraId)}
      >
        <Crosshair aria-hidden="true" className="size-3.5" />
      </Button>
    </Tooltip>;
    const renderActions = (category: DocxFindingGroup["category"], location: ChangeLocationGroup) =>
      <div className={`space-y-2 bg-muted/20 p-2 ${category === "table" ? "" : "border-t"}`}>
        {[...location.actions]
          .sort(([left], [right]) => propertyLabel(left).localeCompare(propertyLabel(right)))
          .map(([action, entries]) => {
            const key = actionKey(unconfirmed, category, location.key, action);
            const expanded = expandedActions.has(key);
            const scalar = entries.length === 1
              && (typeof entries[0].before !== "object" || entries[0].before === null)
              && (typeof entries[0].expected !== "object" || entries[0].expected === null)
              ? [displayValue(entries[0].before), displayValue(entries[0].expected)]
              : null;
            const orderedEntries = category === "table"
              ? [...entries].sort((left, right) => (left.row ?? Number.MAX_SAFE_INTEGER)
                - (right.row ?? Number.MAX_SAFE_INTEGER))
              : entries;
            return <div key={action} className="space-y-1.5">
              <button
                type="button"
                className={`flex w-full items-center gap-2 text-start ${unconfirmed ? "text-amber-800 dark:text-amber-200" : ""}`}
                aria-expanded={expanded}
                onClick={() => toggleAction(key)}
              >
                {expanded
                  ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                  : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{propertyLabel(action)}</span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
                    <span>{unconfirmed
                      ? t(($) => $.researchTools.docx.formatCandidate.attemptedWriteCount, { count: entries.length })
                      : t(($) => $.researchTools.docx.formatCandidate.changeCount, { count: entries.length })}</span>
                    {scalar && <>
                      <span>{scalar[0]}</span>
                      <span aria-hidden="true">→</span>
                      <strong className="font-medium">{scalar[1]}</strong>
                    </>}
                  </span>
                </span>
              </button>
              {expanded && <div className="space-y-1.5">
                {orderedEntries.map((entry) => <div
                  key={entry.id}
                  data-testid={unconfirmed ? "docx-format-candidate-unconfirmed" : "docx-format-candidate-change"}
                  className={unconfirmed ? "rounded bg-amber-500/10 p-1.5" : ""}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      {(entry.row !== undefined || (category === "table" && entry.location)) && <p
                        data-testid="docx-format-candidate-change-row"
                        className="flex flex-wrap gap-x-1.5 text-muted-foreground"
                      >
                        {entry.row !== undefined && <span>{t(($) => $.researchTools.docx.findingReview.row, { row: entry.row })}</span>}
                        {category === "table" && entry.location && <span className="line-clamp-2 [overflow-wrap:anywhere]">{entry.location}</span>}
                      </p>}
                      {entry.group.action !== entry.property && <p className="text-muted-foreground">{propertyLabel(entry.property)}</p>}
                      <p className="flex flex-wrap items-baseline gap-x-1.5 [overflow-wrap:anywhere]">
                        <span className="text-muted-foreground">{displayValue(entry.before)}</span>
                        <span aria-hidden="true">→</span>
                        <strong className="font-medium">{displayValue(entry.expected)}</strong>
                      </p>
                      {entry.templateLocation && <p className="text-muted-foreground [overflow-wrap:anywhere]">
                        {text.templateBasis.replace("{{location}}", entry.templateLocation)}
                      </p>}
                    </div>
                    {category === "table" && entry.paraId && renderJump(entry.paraId)}
                  </div>
                </div>)}
              </div>}
            </div>;
          })}
      </div>;
    return <div className={unconfirmed ? "space-y-3 bg-amber-500/5 px-3 py-2" : "space-y-3 px-3 py-2"}>
      {sections.map(([category, locations]) => <section key={category}>
        <h5 className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {findingText.categories[category]}
        </h5>
        {category === "table"
          ? <div className="space-y-2">
            {groupTableChanges([...locations.values()]).map((block) => <section
              key={block.key}
              data-testid={`docx-format-candidate-table-${block.key}`}
              className="overflow-hidden rounded-md border bg-muted/10"
            >
              <p className="px-2.5 py-1.5 font-medium">
                {block.objectNumber === undefined
                  ? findingText.tableUnspecified
                  : t(($) => $.researchTools.docx.findingReview.table, { number: block.objectNumber })}
              </p>
              <div className="space-y-2 border-t p-2">
                {block.areas.map((location) => <section
                  key={location.key}
                  data-testid={`docx-format-candidate-table-${block.key}-${location.tableArea ?? "whole"}`}
                  className="space-y-1"
                >
                  <h6 className="text-[0.6875rem] font-medium text-muted-foreground">
                    {tableAreaLabel(location.tableArea ?? "whole")}
                  </h6>
                  <div className="overflow-hidden rounded border">
                    {renderActions(category, location)}
                  </div>
                </section>)}
              </div>
            </section>)}
          </div>
          : <ul className="space-y-1">
            {[...locations.values()].map((location) => {
              const paraId = location.paraId;
              return <li key={location.key} className="overflow-hidden rounded border">
                <div className="flex items-start gap-2 px-2.5 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{location.location || roleLabel(location.role)}</span>
                    {location.headingLevel !== undefined && <span className="mt-0.5 block text-muted-foreground">
                      {t(($) => $.researchTools.docx.findingReview.headingLevel, { level: location.headingLevel })}
                    </span>}
                  </span>
                  {paraId && renderJump(paraId)}
                </div>
                {renderActions(category, location)}
              </li>;
            })}
          </ul>}
      </section>)}
    </div>;
  };
  const closeLabel = state.phase === "running" ? text.stop : text.close;
  return <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background text-xs" data-testid="docx-format-candidate" data-phase={state.phase} data-confirmed-count={review?.changes.length} aria-label={text.title}>
    <div className="flex min-w-0 shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{text.title}</h3>
        {review && <p className="text-muted-foreground [overflow-wrap:anywhere]">
          {t(($) => $.researchTools.docx.formatCandidate.journalVersion, {
            journal: review.world.journal_name,
            version: review.world.version_ordinal,
          })}
        </p>}
      </div>
      <Tooltip label={closeLabel} className="shrink-0">
        <Button size="icon" variant="ghost" className="size-6" disabled={adopting} aria-label={closeLabel} onClick={state.phase === "running" ? onStop : onClose}>
          {state.phase === "running" ? <Square className="size-3.5" /> : <X className="size-3.5" />}
        </Button>
      </Tooltip>
    </div>
    {state.phase === "running" && <p role="status" className="flex items-center gap-2 p-3 text-muted-foreground"><Spinner size="sm" />{text.running}</p>}
    {state.phase === "failed" && <p role="alert" className="p-3 text-destructive [overflow-wrap:anywhere]">{state.error}</p>}
    {review && <>
      {review.refreshed && <p className="border-b px-3 py-2 text-muted-foreground">{text.templateRefreshed}</p>}
      {state.phase === "conflict" && <p role="alert" className="border-b bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">{state.reason ?? text.conflict}</p>}
      {state.phase === "unchanged" && <p role="status" className="border-b p-3 text-muted-foreground">{text.unchanged}</p>}
      {state.phase === "adopted" && <p role="status" data-testid="docx-format-candidate-adopted" className="flex gap-1.5 border-b p-3"><Check className="size-3.5" />{text.adopted}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto" data-docx-history="field">
        {review.changes.length > 0 && <section data-testid="docx-format-candidate-changes">
          <h4 className="sticky top-0 z-10 border-b bg-muted px-3 py-1.5 font-medium">{text.changes} · {review.changes.length}</h4>
          {renderChangeGroups(changeSections)}
        </section>}
        {review.unconfirmedChanges.length > 0 && <section data-testid="docx-format-candidate-unconfirmed-section">
          <h4 className="sticky top-0 z-10 border-b bg-amber-500/10 px-3 py-1.5 font-medium text-amber-900 dark:text-amber-200">
            {text.unconfirmedChanges} · {review.unconfirmedChanges.length}
          </h4>
          <p className="bg-amber-500/5 px-3 pt-2 text-amber-800 dark:text-amber-200">{text.unconfirmedHelp}</p>
          {renderChangeGroups(unconfirmedSections, true)}
        </section>}
        {review.findingReview.groups.length > 0
          ? <section>
            <h4 className="sticky top-0 z-10 border-b bg-muted px-3 py-1.5 font-medium">{text.unresolved}</h4>
            <DocxFindingBrowser
              checkId={review.findingReview.checkId}
              groups={review.findingReview.groups}
              verdicts={CANDIDATE_VERDICTS}
              onJump={jumpToLocation}
            formatAction={formatLabel}
              className="px-3 py-2"
            />
          </section>
          : <p data-testid="docx-format-candidate-language-scope" className="border-t px-3 py-2 text-muted-foreground">
            {findingText.languageScope}
          </p>}
      </div>
      {(state.phase === "ready" || state.phase === "conflict" || state.phase === "adopted") && <div className="flex shrink-0 flex-wrap gap-2 border-t p-3">
        {state.phase === "ready" && <Button size="sm" data-testid="docx-adopt-format-candidate" disabled={adopting || adoptDisabled} onClick={onAdopt}>
          {adopting ? <Spinner size="sm" /> : <Check className="size-3.5" />}{text.adopt}
        </Button>}
        {state.phase === "conflict" && <Button size="sm" disabled={adopting} onClick={onReformat}>{text.reformat}</Button>}
        <Button size="sm" variant="outline" disabled={adopting} onClick={onDownload}><Download className="size-3.5" />{state.phase === "adopted" ? text.export : text.download}</Button>
      </div>}
    </>}
  </aside>;
}

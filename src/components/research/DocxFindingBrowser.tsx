import { ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  fetchDocxFindingDetails,
  fetchDocxFindingLocations,
  type DocxFindingDetail,
  type DocxFindingGroup,
  type DocxFindingLocation,
  type DocxFindingVerdict,
} from "@/lib/docx-finding-review";

export const DOCX_FINDING_CATEGORY_ORDER: readonly DocxFindingGroup["category"][] = [
  "title",
  "heading",
  "body",
  "table",
  "table_caption",
  "formula",
  "figure",
  "figure_caption",
  "references",
  "other",
];
const DEFAULT_VERDICTS: readonly DocxFindingVerdict[] = [
  "observed_difference",
  "cannot_determine",
  "observed_match",
];
const humanizeIdentifier = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[._-]+/g, " ")
  .trim()
  .replace(/^./, (letter) => letter.toUpperCase());

interface LocationPage {
  locations: DocxFindingLocation[];
  total: number;
  next_offset: number | null;
}

interface DetailsPage {
  findings: DocxFindingDetail[];
  total: number;
  next_offset: number | null;
}

type TableArea = "whole" | NonNullable<DocxFindingGroup["table_area"]>;

interface TableBlock {
  key: string;
  objectNumber?: number;
  areas: { area: TableArea; groups: DocxFindingGroup[] }[];
}

interface HeadingBlock {
  key: string;
  level?: number;
  groups: DocxFindingGroup[];
}

const TABLE_AREA_ORDER: readonly TableArea[] = ["whole", "header", "body", "exception"];
const byAction = (left: DocxFindingGroup, right: DocxFindingGroup) =>
  left.action.localeCompare(right.action);

export interface DocxFindingBrowserProps {
  checkId: string;
  groups: readonly DocxFindingGroup[];
  verdicts?: readonly DocxFindingVerdict[];
  initialVerdict?: DocxFindingVerdict;
  title?: string;
  onJump?: (location: DocxFindingLocation) => void;
  formatAction?: (property: string) => string | undefined;
  className?: string;
}

export function DocxFindingBrowser({
  checkId,
  groups,
  verdicts = DEFAULT_VERDICTS,
  initialVerdict = verdicts[0] ?? "observed_difference",
  title,
  onJump,
  formatAction,
  className = "",
}: DocxFindingBrowserProps) {
  const { t } = useTranslation("researchTools");
  const review = t(($) => $.researchTools.docx.findingReview, { returnObjects: true });
  const template = t(($) => $.researchTools.journal.template, { returnObjects: true });
  const verdictLabels = t(($) => $.researchTools.journal.verdicts, { returnObjects: true });
  const workspace = t(($) => $.researchTools.workspace, { returnObjects: true });
  const [verdict, setVerdict] = useState<DocxFindingVerdict>(initialVerdict);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [locationOffset, setLocationOffset] = useState(0);
  const [locationPage, setLocationPage] = useState<{ key: string; page: LocationPage } | null>(null);
  const [locationsBusy, setLocationsBusy] = useState(false);
  const [locationsFailed, setLocationsFailed] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<DocxFindingLocation | null>(null);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [detailsPage, setDetailsPage] = useState<{ key: string; page: DetailsPage } | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsFailed, setDetailsFailed] = useState(false);

  const roleLabel = (role: string) => template.roles[role as keyof typeof template.roles]
    ?? workspace.journalTemplate.roles.other;
  const actionLabel = (propertyPath: string) => {
    if (!propertyPath) return template.retainedFormat;
    return review.actions[propertyPath as keyof typeof review.actions]
      ?? formatAction?.(propertyPath)
      ?? template.formats[propertyPath as keyof typeof template.formats]
      ?? workspace.journalTemplate.formats.other;
  };
  const attributeLabel = (key: string) => {
    const labels: Record<string, string> = {
      alignment: workspace.journalTemplate.attributes.alignment,
      color: workspace.journalTemplate.attributes.color,
      count: workspace.journalTemplate.attributes.count,
      height: workspace.journalTemplate.attributes.height,
      level: workspace.journalTemplate.attributes.level,
      name: workspace.journalTemplate.attributes.name,
      position: workspace.journalTemplate.attributes.position,
      size: workspace.journalTemplate.attributes.size,
      style: workspace.journalTemplate.attributes.style,
      text: workspace.journalTemplate.attributes.text,
      type: workspace.journalTemplate.attributes.type,
      value: workspace.journalTemplate.attributes.value,
      width: workspace.journalTemplate.attributes.width,
    };
    return labels[key] ?? null;
  };
  const lineSpacingLabel = (
    value: number,
    finding: DocxFindingDetail,
    side: "observed" | "expected",
  ): string => {
    const rule = finding.line_spacing_rule?.[side];
    if (rule === "auto") {
      return value === 240
        ? workspace.journalTemplate.value.lineSpacingSingle
        : t(($) => $.researchTools.workspace.journalTemplate.value.lineSpacingMultiple, {
          multiple: String(Number((value / 240).toFixed(2))),
          value,
        });
    }
    if (rule === "exact") {
      return t(($) => $.researchTools.workspace.journalTemplate.value.lineSpacingExact, { value });
    }
    if (rule === "atLeast") {
      return t(($) => $.researchTools.workspace.journalTemplate.value.lineSpacingAtLeast, { value });
    }
    return t(($) => $.researchTools.workspace.journalTemplate.value.lineSpacingRaw, { value });
  };
  const scalarLabel = (
    value: string | number | boolean,
    propertyPath: string,
    finding: DocxFindingDetail,
    side: "observed" | "expected",
  ): string => {
    if (typeof value === "boolean") return value ? template.yes : template.no;
    if (typeof value === "number") {
      if (propertyPath === "paragraph.lineSpacing.value") {
        return lineSpacingLabel(value, finding, side);
      }
      if (/Pt$/.test(propertyPath)) {
        return t(($) => $.researchTools.workspace.journalTemplate.value.points, { value });
      }
      if (/Twips$/.test(propertyPath)) {
        return t(($) => $.researchTools.workspace.journalTemplate.value.twips, { value });
      }
      if (/Percent$/.test(propertyPath)) {
        return t(($) => $.researchTools.workspace.journalTemplate.value.percent, { value });
      }
      if (/outlineLevel$/i.test(propertyPath)) {
        return value === 9
          ? workspace.journalTemplate.value.bodyText
          : t(($) => $.researchTools.workspace.journalTemplate.value.level, { level: value + 1 });
      }
      if (/listItem\.ilvl$/i.test(propertyPath)) {
        return t(($) => $.researchTools.workspace.journalTemplate.value.level, { level: value + 1 });
      }
      return String(value);
    }
    if (propertyPath === "paragraph.lineSpacing.rule" || propertyPath === "row.height.rule") {
      const rules: Record<string, string> = {
        auto: workspace.journalTemplate.value.ruleAuto,
        exact: workspace.journalTemplate.value.ruleExact,
        atLeast: workspace.journalTemplate.value.ruleAtLeast,
      };
      return rules[value] ?? value;
    }
    if (propertyPath === "run.verticalAlign" || propertyPath === "section.verticalAlign") {
      const positions: Record<string, string> = {
        baseline: workspace.journalTemplate.value.verticalBaseline,
        superscript: workspace.journalTemplate.value.verticalSuperscript,
        subscript: workspace.journalTemplate.value.verticalSubscript,
        top: workspace.journalTemplate.value.verticalTop,
        center: workspace.journalTemplate.value.verticalCenter,
        bottom: workspace.journalTemplate.value.verticalBottom,
        both: workspace.journalTemplate.value.verticalBoth,
      };
      return positions[value] ?? value;
    }
    if (propertyPath === "section.breakType") {
      const breaks: Record<string, string> = {
        nextPage: workspace.journalTemplate.value.breakNextPage,
        continuous: workspace.journalTemplate.value.breakContinuous,
        evenPage: workspace.journalTemplate.value.breakEvenPage,
        oddPage: workspace.journalTemplate.value.breakOddPage,
        nextColumn: workspace.journalTemplate.value.breakNextColumn,
      };
      return breaks[value] ?? value;
    }
    if (propertyPath === "cell.textDirection") {
      const directions: Record<string, string> = {
        horizontal: workspace.journalTemplate.value.textHorizontal,
        btLr: workspace.journalTemplate.value.textBottomToTop,
      };
      return directions[value] ?? value;
    }
    const values: Record<string, string> = {
      left: workspace.journalTemplate.value.alignmentLeft,
      center: workspace.journalTemplate.value.alignmentCenter,
      right: workspace.journalTemplate.value.alignmentRight,
      both: workspace.journalTemplate.value.alignmentJustified,
      justify: workspace.journalTemplate.value.alignmentJustified,
      distribute: workspace.journalTemplate.value.alignmentDistributed,
      decimal: workspace.journalTemplate.value.numberingDecimal,
      bullet: workspace.journalTemplate.value.numberingBullet,
      lowerLetter: workspace.journalTemplate.value.numberingLowerLetter,
      upperLetter: workspace.journalTemplate.value.numberingUpperLetter,
      lowerRoman: workspace.journalTemplate.value.numberingLowerRoman,
      upperRoman: workspace.journalTemplate.value.numberingUpperRoman,
      none: workspace.journalTemplate.value.numberingNone,
      tab: workspace.journalTemplate.value.suffixTab,
      space: workspace.journalTemplate.value.suffixSpace,
      nothing: workspace.journalTemplate.value.suffixNothing,
      single: workspace.journalTemplate.value.borderSingle,
      double: workspace.journalTemplate.value.borderDouble,
      dotted: workspace.journalTemplate.value.borderDotted,
      dashed: workspace.journalTemplate.value.borderDashed,
      thick: workspace.journalTemplate.value.borderThick,
      triple: workspace.journalTemplate.value.borderTriple,
      dotDash: workspace.journalTemplate.value.borderDotDash,
      dotDotDash: workspace.journalTemplate.value.borderDotDotDash,
      wave: workspace.journalTemplate.value.borderWave,
      auto: workspace.journalTemplate.value.automatic,
      page: workspace.journalTemplate.value.anchorPage,
      margin: workspace.journalTemplate.value.anchorMargin,
      text: workspace.journalTemplate.value.anchorText,
      around: workspace.journalTemplate.value.wrapAround,
      tight: workspace.journalTemplate.value.wrapTight,
      through: workspace.journalTemplate.value.wrapThrough,
      horizontal: workspace.journalTemplate.value.textHorizontal,
      btLr: workspace.journalTemplate.value.textBottomToTop,
    };
    return values[value] ?? value;
  };
  const valueLabel = (
    value: unknown,
    propertyPath: string,
    finding: DocxFindingDetail,
    side: "observed" | "expected",
  ): string => {
    if (value === null || value === undefined) return template.notRetained;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return scalarLabel(value, propertyPath, finding, side);
    }
    if (Array.isArray(value)) {
      if (!value.length) return workspace.journalTemplate.value.complex;
      if (propertyPath === "paragraph.tabStops.stops") {
        return value.map((item) => {
          if (!item || typeof item !== "object") return workspace.journalTemplate.value.complex;
          const stop = item as Record<string, unknown>;
          const alignment = typeof stop.alignment === "string"
            ? scalarLabel(stop.alignment, "paragraph.alignment", finding, side)
            : workspace.journalTemplate.value.unknown;
          return typeof stop.positionPt === "number"
            ? t(($) => $.researchTools.workspace.journalTemplate.value.tabStop, {
              alignment,
              position: stop.positionPt,
            })
            : workspace.journalTemplate.value.complex;
        }).join("、");
      }
      return value.map((item) => valueLabel(item, propertyPath, finding, side)).join("、");
    }
    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (propertyPath === "run.underline" && typeof object.variant === "string") {
        const variants: Record<string, string> = {
          none: workspace.journalTemplate.value.underlineNone,
          single: workspace.journalTemplate.value.underlineSingle,
          double: workspace.journalTemplate.value.underlineDouble,
          dotted: workspace.journalTemplate.value.underlineDotted,
          dashed: workspace.journalTemplate.value.underlineDashed,
          wave: workspace.journalTemplate.value.underlineWave,
        };
        return variants[object.variant] ?? humanizeIdentifier(object.variant);
      }
      const entries = Object.entries(object).flatMap(([key, item]) => {
        const label = attributeLabel(key);
        if (!label || typeof item === "object") return [];
        return [`${label}：${valueLabel(item, propertyPath, finding, side)}`];
      });
      return entries.length
        ? entries.join("；")
        : workspace.journalTemplate.value.complex;
    }
    return workspace.journalTemplate.value.unknown;
  };
  const limitationLabels = (finding: DocxFindingDetail, group: DocxFindingGroup) => {
    const labels = new Set<string>();
    if (finding.reason === "No corresponding template profile") {
      labels.add(review.limitations.noProfile);
    } else if (finding.reason?.includes("band sizes other than one")) {
      labels.add(review.limitations.tableBands);
    } else if (finding.reason) {
      labels.add(review.limitations.genericReason);
    }
    if (finding.expected_value_count > 1) {
      labels.add(review.limitations.expectedValuesDiffer);
    }
    if (group.action === "page_flow") {
      labels.add(review.limitations.pageFlow);
    } else if (group.action === "layout") {
      labels.add(review.limitations.layout);
    }
    if (group.action === "coverage" || !finding.property_path) {
      labels.add(review.limitations.coverage);
    }
    if (!labels.size && finding.verdict === "cannot_determine") {
      labels.add(review.limitations.cannotDetermine);
    }
    return [...labels];
  };

  const visibleGroups = useMemo(
    () => groups.filter((group) => group.counts[verdict] > 0),
    [groups, verdict],
  );
  const grouped = useMemo(() => {
    const sections = new Map<DocxFindingGroup["category"], DocxFindingGroup[]>();
    for (const category of DOCX_FINDING_CATEGORY_ORDER) {
      const entries = visibleGroups
        .filter((group) => group.category === category)
        .sort((left, right) => {
          if (category === "table") {
            return (left.object_number ?? Number.MAX_SAFE_INTEGER)
              - (right.object_number ?? Number.MAX_SAFE_INTEGER)
              || TABLE_AREA_ORDER.indexOf(left.table_area ?? "whole")
              - TABLE_AREA_ORDER.indexOf(right.table_area ?? "whole")
              || byAction(left, right);
          }
          if (category === "heading") {
            return (left.heading_level ?? Number.MAX_SAFE_INTEGER)
              - (right.heading_level ?? Number.MAX_SAFE_INTEGER)
              || byAction(left, right);
          }
          return byAction(left, right)
            || (left.object_number ?? Number.MAX_SAFE_INTEGER)
            - (right.object_number ?? Number.MAX_SAFE_INTEGER);
        });
      if (entries.length) sections.set(category, entries);
    }
    return sections;
  }, [visibleGroups]);
  const tableBlocks = useMemo(() => {
    const blocks = new Map<string, TableBlock>();
    for (const group of visibleGroups.filter((entry) => entry.category === "table")) {
      const key = group.object_number === undefined ? "unspecified" : String(group.object_number);
      const block = blocks.get(key) ?? {
        key,
        objectNumber: group.object_number,
        areas: [],
      };
      const area = group.table_area ?? "whole";
      let areaBlock = block.areas.find((entry) => entry.area === area);
      if (!areaBlock) {
        areaBlock = { area, groups: [] };
        block.areas.push(areaBlock);
      }
      areaBlock.groups.push(group);
      blocks.set(key, block);
    }
    return [...blocks.values()]
      .map((block) => ({
        ...block,
        areas: block.areas
          .sort((left, right) => TABLE_AREA_ORDER.indexOf(left.area) - TABLE_AREA_ORDER.indexOf(right.area))
          .map((area) => ({ ...area, groups: area.groups.sort(byAction) })),
      }))
      .sort((left, right) => (left.objectNumber ?? Number.MAX_SAFE_INTEGER)
        - (right.objectNumber ?? Number.MAX_SAFE_INTEGER));
  }, [visibleGroups]);
  const headingBlocks = useMemo(() => {
    const blocks = new Map<string, HeadingBlock>();
    for (const group of visibleGroups.filter((entry) => entry.category === "heading")) {
      const key = group.heading_level === undefined ? "unspecified" : String(group.heading_level);
      const block = blocks.get(key) ?? { key, level: group.heading_level, groups: [] };
      block.groups.push(group);
      blocks.set(key, block);
    }
    return [...blocks.values()]
      .map((block) => ({ ...block, groups: block.groups.sort(byAction) }))
      .sort((left, right) => (left.level ?? Number.MAX_SAFE_INTEGER)
        - (right.level ?? Number.MAX_SAFE_INTEGER));
  }, [visibleGroups]);
  const summary = useMemo(() => ({
    checks: visibleGroups.reduce((sum, group) => sum + group.counts[verdict], 0),
    locations: groups.reduce((sum, group) => sum + group.location_count, 0),
  }), [groups, verdict, visibleGroups]);

  const locationKey = expandedGroupId
    ? [checkId, expandedGroupId, verdict, locationOffset].join("\u0000")
    : "";
  const locations = locationPage?.key === locationKey ? locationPage.page : null;
  const detailKey = expandedGroupId && selectedLocation
    ? [checkId, expandedGroupId, selectedLocation.id, verdict, detailsOffset].join("\u0000")
    : "";
  const details = detailsPage?.key === detailKey ? detailsPage.page : null;

  useEffect(() => {
    if (!expandedGroupId) {
      setLocationPage(null);
      setLocationsBusy(false);
      setLocationsFailed(false);
      return;
    }
    let active = true;
    setLocationPage(null);
    setLocationsBusy(true);
    setLocationsFailed(false);
    void fetchDocxFindingLocations(checkId, expandedGroupId, verdict, locationOffset)
      .then((page) => {
        if (active) setLocationPage({ key: locationKey, page });
      })
      .catch(() => {
        if (active) setLocationsFailed(true);
      })
      .finally(() => {
        if (active) setLocationsBusy(false);
      });
    return () => { active = false; };
  }, [checkId, expandedGroupId, locationKey, locationOffset, verdict]);

  useEffect(() => {
    if (!expandedGroupId || !selectedLocation) {
      setDetailsPage(null);
      setDetailsBusy(false);
      setDetailsFailed(false);
      return;
    }
    let active = true;
    setDetailsPage(null);
    setDetailsBusy(true);
    setDetailsFailed(false);
    void fetchDocxFindingDetails(checkId, expandedGroupId, selectedLocation.id, verdict, detailsOffset)
      .then((page) => {
        if (active) setDetailsPage({ key: detailKey, page });
      })
      .catch(() => {
        if (active) setDetailsFailed(true);
      })
      .finally(() => {
        if (active) setDetailsBusy(false);
      });
    return () => { active = false; };
  }, [checkId, detailKey, detailsOffset, expandedGroupId, selectedLocation, verdict]);

  const changeVerdict = (next: DocxFindingVerdict) => {
    setVerdict(next);
    setExpandedGroupId(null);
    setLocationOffset(0);
    setSelectedLocation(null);
    setDetailsOffset(0);
  };
  const toggleGroup = (groupId: string) => {
    setExpandedGroupId((current) => current === groupId ? null : groupId);
    setLocationOffset(0);
    setSelectedLocation(null);
    setDetailsOffset(0);
  };
  const selectLocation = (location: DocxFindingLocation) => {
    setSelectedLocation(location);
    setDetailsOffset(0);
  };
  const tableAreaLabel = (area: TableArea) => {
    const labels: Record<TableArea, string> = {
      whole: review.wholeTable,
      header: review.tableHeader,
      body: review.tableBody,
      exception: review.tableException,
    };
    return labels[area];
  };
  const contextParts = (
    group: DocxFindingGroup,
    location?: DocxFindingLocation,
    includeGroupContext = true,
  ): string[] => {
    const parts: string[] = [];
    if (includeGroupContext && group.heading_level !== undefined) {
      parts.push(t(($) => $.researchTools.docx.findingReview.headingLevel, { level: group.heading_level }));
    }
    const objectNumber = location?.object_number ?? group.object_number;
    if (includeGroupContext && objectNumber !== undefined) {
      if (group.category === "table" || group.category === "table_caption") {
        parts.push(t(($) => $.researchTools.docx.findingReview.table, { number: objectNumber }));
      } else if (group.category === "formula") {
        parts.push(t(($) => $.researchTools.docx.findingReview.equation, { number: objectNumber }));
      } else if (group.category === "figure" || group.category === "figure_caption") {
        parts.push(t(($) => $.researchTools.docx.findingReview.figure, { number: objectNumber }));
      }
    }
    if (includeGroupContext && group.table_area) {
      parts.push(tableAreaLabel(group.table_area));
    }
    if (location?.row !== undefined && location.column !== undefined) {
      parts.push(t(($) => $.researchTools.docx.findingReview.rowColumn, {
        row: location.row,
        column: location.column,
      }));
    } else if (location?.row !== undefined) {
      parts.push(t(($) => $.researchTools.docx.findingReview.row, { row: location.row }));
    } else if (location?.column !== undefined) {
      parts.push(t(($) => $.researchTools.docx.findingReview.column, { column: location.column }));
    }
    return parts;
  };

  const renderGroup = (group: DocxFindingGroup, nested = false) => {
    const expanded = group.id === expandedGroupId;
    return <li key={group.id} className="overflow-hidden rounded border">
      <button
        type="button"
        data-testid={`docx-finding-group-${group.id}`}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-start hover:bg-accent/60"
        aria-expanded={expanded}
        aria-controls={`docx-finding-locations-${group.id}`}
        onClick={() => toggleGroup(group.id)}
      >
        {expanded
          ? <ChevronDown aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          : <ChevronRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{actionLabel(group.action)}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-muted-foreground">
            {contextParts(group, undefined, !nested).map((part) => <span key={part}>{part}</span>)}
          </span>
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
          {t(($) => $.researchTools.docx.findingReview.groupCount, {
            count: group.counts[verdict],
            locations: group.location_count,
          })}
        </span>
      </button>
      {expanded && <div id={`docx-finding-locations-${group.id}`} data-testid="docx-finding-locations" className="border-t">
        {locationsFailed && <p role="alert" className="p-2 text-destructive">{review.locationsFailed}</p>}
        {!locationsFailed && <div aria-busy={locationsBusy}>
          {locationsBusy && <p role="status" className="p-2 text-muted-foreground">{review.loadingLocations}</p>}
          {locations && <>
            {locations.locations.length
              ? <ul className="divide-y">
                {locations.locations.map((location) => <li key={location.id}>
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      data-testid={`docx-finding-location-${location.id}`}
                      className={`min-w-0 flex-1 px-2.5 py-2 text-start hover:bg-accent/60 ${selectedLocation?.id === location.id ? "bg-accent/70" : ""}`}
                      aria-expanded={selectedLocation?.id === location.id}
                      onClick={() => selectLocation(location)}
                    >
                      <span className="flex flex-wrap gap-x-1.5 text-muted-foreground">
                        {contextParts(group, location, !nested).map((part) => <span key={part}>{part}</span>)}
                      </span>
                      {location.label && <span className="mt-0.5 line-clamp-2 break-words">{location.label}</span>}
                    </button>
                    {onJump && location.para_id && <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="m-1 size-7 shrink-0"
                      aria-label={review.openLocation}
                      title={review.openLocation}
                      onClick={() => onJump(location)}
                    >
                      <Crosshair aria-hidden="true" className="size-3.5" />
                    </Button>}
                  </div>
                </li>)}
              </ul>
              : <p className="p-2 text-muted-foreground">{review.noLocations}</p>}
            <div className="flex gap-2 border-t px-2 py-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={locationsBusy || locationOffset === 0}
                onClick={() => setLocationOffset(Math.max(0, locationOffset - 20))}
              >{review.previous}</Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locationsBusy || locations.next_offset === null}
                onClick={() => setLocationOffset(locations.next_offset ?? 0)}
              >{review.next}</Button>
            </div>
          </>}
        </div>}
      </div>}
      {expanded && selectedLocation && <div data-testid="docx-finding-details" className="border-t bg-muted/20 p-2.5">
        {detailsFailed && <p role="alert" className="text-destructive">{review.detailsFailed}</p>}
        <div className="space-y-2" aria-busy={detailsBusy}>
          {detailsBusy && <p role="status" className="text-muted-foreground">{review.loadingDetails}</p>}
          {details && <>
            {details.findings.length
              ? <div className="space-y-2">
                {details.findings.map((finding) => <article key={finding.case_id} className="space-y-1 rounded border bg-background p-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium">
                      {roleLabel(finding.role)} · {actionLabel(finding.property_path)}
                    </p>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                      {verdictLabels[finding.verdict as keyof typeof verdictLabels]
                        ?? humanizeIdentifier(finding.verdict)}
                    </span>
                  </div>
                  <p className="break-words">
                    {template.observed}: {valueLabel(finding.observed, finding.property_path, finding, "observed")}
                  </p>
                  <p className="break-words">
                    {template.expected}: {valueLabel(finding.expected, finding.property_path, finding, "expected")}
                  </p>
                  {limitationLabels(finding, group).map((label) => <p
                    key={label}
                    data-testid="docx-finding-limitation"
                    className="text-muted-foreground"
                  >{label}</p>)}
                </article>)}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={detailsBusy || detailsOffset === 0}
                    onClick={() => setDetailsOffset(Math.max(0, detailsOffset - 20))}
                  >{review.previous}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={detailsBusy || details.next_offset === null}
                    onClick={() => setDetailsOffset(details.next_offset ?? 0)}
                  >{review.next}</Button>
                </div>
              </div>
              : <p className="text-muted-foreground">{review.noDetails}</p>}
          </>}
        </div>
      </div>}
    </li>;
  };
  const renderGroupList = (entries: readonly DocxFindingGroup[], nested = false) =>
    <ul className="space-y-1">{entries.map((group) => renderGroup(group, nested))}</ul>;

  return <section className={`space-y-2 ${className}`} data-testid="docx-finding-browser">
    {title && <p className="font-medium">{title}</p>}
    <label className="flex items-center gap-2 font-medium">
      {template.filter}
      <select
        aria-label={template.filter}
        className="rounded border bg-background p-1"
        value={verdict}
        onChange={(event) => changeVerdict(event.target.value as DocxFindingVerdict)}
      >
        {verdicts.map((value) => <option key={value} value={value}>{verdictLabels[value]}</option>)}
      </select>
    </label>
    <div className="space-y-0.5 text-muted-foreground">
      <p>{t(($) => $.researchTools.docx.findingReview.summaryChecks, { count: summary.checks })}</p>
      <p>{t(($) => $.researchTools.docx.findingReview.summaryLocations, { locations: summary.locations })}</p>
      <p className="text-[0.6875rem]">{t(($) => $.researchTools.docx.findingReview.summaryNote)}</p>
    </div>
    <p className="rounded bg-muted/50 p-2 text-muted-foreground">
      {t(($) => $.researchTools.docx.findingReview.languageScope)}
    </p>
    {grouped.size === 0
      ? <p className="text-muted-foreground">{t(($) => $.researchTools.docx.findingReview.noGroups)}</p>
      : <div className="space-y-3">
        {[...grouped.keys()].map((category) => <section key={category} className="space-y-1.5">
          <h5 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {review.categories[category]}
          </h5>
          {category === "table"
            ? <div className="space-y-2">
              {tableBlocks.map((block) => <section
                key={block.key}
                data-testid={`docx-finding-table-${block.key}`}
                className="rounded-md border bg-muted/10 p-2"
              >
                <p className="font-medium">
                  {block.objectNumber === undefined
                    ? review.tableUnspecified
                    : t(($) => $.researchTools.docx.findingReview.table, { number: block.objectNumber })}
                </p>
                <div className="mt-1.5 space-y-2">
                  {block.areas.map((area) => <section
                    key={area.area}
                    data-testid={`docx-finding-table-${block.key}-${area.area}`}
                    className="space-y-1"
                  >
                    <h6 className="text-[0.6875rem] font-medium text-muted-foreground">
                      {tableAreaLabel(area.area)}
                    </h6>
                    {renderGroupList(area.groups, true)}
                  </section>)}
                </div>
              </section>)}
            </div>
            : category === "heading"
              ? <div className="space-y-2">
                {headingBlocks.map((block) => <section
                  key={block.key}
                  data-testid={`docx-finding-heading-${block.key}`}
                  className="space-y-1 rounded-md border bg-muted/10 p-2"
                >
                  <h6 className="font-medium text-muted-foreground">
                    {block.level === undefined
                      ? review.unspecifiedHeadingLevel
                      : t(($) => $.researchTools.docx.findingReview.headingLevel, { level: block.level })}
                  </h6>
                  {renderGroupList(block.groups, true)}
                </section>)}
              </div>
              : renderGroupList(grouped.get(category) ?? [])}
        </section>)}
      </div>}
  </section>;
}

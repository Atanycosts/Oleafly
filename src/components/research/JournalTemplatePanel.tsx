import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { journalRequest, type JournalCheck, type JournalProject, type JournalWorld } from "@/lib/journal-workbench";

interface TemplateFinding {
  case_id: string; object_id: string; kind: string; role: string; part: string; path: number[];
  property_path: string; observed: unknown; expected: unknown; template_object_ids: string[];
  template_object_count?: number; expected_value_count?: number;
  verdict: string; role_basis?: unknown[]; template_role_basis?: unknown[];
  region?: unknown; table_context?: unknown; reason?: string;
}
interface FindingPage { findings: TemplateFinding[]; total: number; next_offset: number | null }
const PAGE_SIZE = 20;
const humanizeIdentifier = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[._-]+/g, " ")
  .trim()
  .replace(/^./, (letter) => letter.toUpperCase());

export function JournalTemplatePanel({ world, project, check }: {
  world: JournalWorld; project: JournalProject | null; check: JournalCheck | null;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal.template, { returnObjects: true });
  const verdicts = t(($) => $.researchTools.journal.verdicts, { returnObjects: true });
  const workspace = t(($) => $.researchTools.workspace, { returnObjects: true });
  const [verdict, setVerdict] = useState("observed_difference");
  const [findingPosition, setFindingPosition] = useState({ checkId: "", verdict: "", offset: 0 });
  const [findingPage, setFindingPage] = useState<{ contextKey: string; page: FindingPage } | null>(null);
  const [findingBusy, setFindingBusy] = useState(false);
  const [findingFailed, setFindingFailed] = useState(false);
  const lineSpacingRules = useRef(new Map<string, { observed: unknown; expected: unknown }>());
  const lineSpacingContext = useRef("");
  const checkId = check?.check_id;
  const hasComparison = !!check?.template_comparison;
  const contextKey = [
    world.version_id,
    project?.project_id ?? "",
    project?.baseline_id ?? "",
    checkId ?? "",
    check?.baseline_id ?? "",
  ].join("\u0000");
  const findings = findingPage?.contextKey === contextKey ? findingPage.page : null;
  const findingOffset = findingPosition.checkId === checkId && findingPosition.verdict === verdict ? findingPosition.offset : 0;
  const setFindingOffset = (offset: number) => setFindingPosition({ checkId: checkId ?? "", verdict, offset });
  const roleLabel = (role: string) => text.roles[role as keyof typeof text.roles]
    ?? workspace.journalTemplate.roles.other;
  const formatLabel = (propertyPath: string) => {
    if (!propertyPath) return text.retainedFormat;
    return text.formats[propertyPath as keyof typeof text.formats]
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
  const lineSpacingRule = (finding: TemplateFinding, side: "observed" | "expected"): unknown => {
    const ruleFinding = findings?.findings.find((item) =>
      item.object_id === finding.object_id && item.property_path === "paragraph.lineSpacing.rule");
    return ruleFinding?.[side] ?? lineSpacingRules.current.get(finding.object_id)?.[side];
  };
  const lineSpacingLabel = (
    value: unknown,
    finding: TemplateFinding,
    side: "observed" | "expected",
  ): string | null => {
    if (typeof value !== "number") return null;
    const rule = lineSpacingRule(finding, side);
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
    finding: TemplateFinding,
    side: "observed" | "expected",
  ): string => {
    if (typeof value === "boolean") return value ? text.yes : text.no;
    if (typeof value === "number") {
      if (propertyPath === "paragraph.lineSpacing.value") {
        return lineSpacingLabel(value, finding, side) ?? String(value);
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
    finding: TemplateFinding,
    side: "observed" | "expected",
  ): string => {
    if (value === null || value === undefined) return text.notRetained;
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
      const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
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
  const reasonLabel = (reason: string | undefined) => {
    if (reason === "No corresponding template profile") {
      return workspace.journalTemplate.reason.noProfile;
    }
    if (reason?.includes("band sizes other than one")) {
      return workspace.journalTemplate.reason.tableBands;
    }
    return workspace.journalTemplate.reason.generic;
  };

  const requestedFindingPage = useCallback((offset: number) => {
    if (!checkId) return Promise.resolve(null);
    return journalRequest<FindingPage>("/api/docx-query", {
      target: { check_id: checkId }, operation: "findings", verdict,
      offset, limit: PAGE_SIZE,
    });
  }, [checkId, verdict]);

  useEffect(() => {
    const ruleContext = `${contextKey}\u0000${verdict}`;
    if (lineSpacingContext.current !== ruleContext) {
      lineSpacingRules.current.clear();
      lineSpacingContext.current = ruleContext;
    }
    setFindingPage(null);
    if (!hasComparison) { setFindingBusy(false); setFindingFailed(false); return; }
    let active = true;
    setFindingBusy(true); setFindingFailed(false);
    setFindingPosition((current) => current.checkId === checkId ? current : { checkId: checkId ?? "", verdict, offset: 0 });
    void requestedFindingPage(findingOffset).then((page) => {
      if (active && page) {
        for (const item of page.findings) {
          if (item.property_path === "paragraph.lineSpacing.rule") {
            lineSpacingRules.current.set(item.object_id, {
              observed: item.observed,
              expected: item.expected,
            });
          }
        }
        setFindingPage({ contextKey, page });
      }
    })
      .catch(() => {
        if (active) setFindingFailed(true);
      })
      .finally(() => { if (active) setFindingBusy(false); });
    return () => { active = false; };
  }, [checkId, contextKey, hasComparison, findingOffset, requestedFindingPage, verdict]);

  if (!world.template) return null;

  return <section className="space-y-3 rounded-lg border border-sidebar-border p-3 text-xs" data-testid="journal-template-facts">
    <p className="font-semibold">{text.title}</p>
    <p className="text-muted-foreground">{text.adopted}</p>
    {hasComparison && <div className="space-y-2">
      <label className="flex items-center gap-2 font-medium">{text.differences}
        <select aria-label={text.filter} className="rounded border bg-background p-1" value={verdict} onChange={(event) => setVerdict(event.target.value)}>
          {["observed_difference", "cannot_determine", "observed_match"].map((value) => <option key={value} value={value}>{verdicts[value as keyof typeof verdicts]}</option>)}
        </select>
      </label>
      {findingFailed && <p role="alert" className="text-destructive">{workspace.journalTemplate.loadFailed}</p>}
      {findings && <>
        <p className="text-muted-foreground">{findings.total} {text.cases}</p>
        <div className="max-h-96 space-y-2 overflow-auto" aria-busy={findingBusy}>
          {findings.findings.map((finding) => <article key={finding.case_id} className="space-y-1 rounded border p-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium">{roleLabel(finding.role)} · {formatLabel(finding.property_path)}</p>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                {verdicts[finding.verdict as keyof typeof verdicts] ?? humanizeIdentifier(finding.verdict)}
              </span>
            </div>
            <p className="break-words">{text.observed}: {valueLabel(finding.observed, finding.property_path, finding, "observed")}</p>
            <p className="break-words">{text.expected}: {valueLabel(finding.expected, finding.property_path, finding, "expected")}</p>
            {finding.reason && <p className="text-muted-foreground">{reasonLabel(finding.reason)}</p>}
          </article>)}
          {!findingBusy && findings.findings.length === 0 && <p className="text-muted-foreground">{workspace.journalTemplate.noFindings}</p>}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={findingBusy || findingOffset === 0} onClick={() => setFindingOffset(Math.max(0, findingOffset - PAGE_SIZE))}>{text.previous}</Button>
          <Button size="sm" variant="ghost" disabled={findingBusy || findings.next_offset === null} onClick={() => setFindingOffset(findings.next_offset ?? 0)}>{text.next}</Button>
        </div>
      </>}
    </div>}
  </section>;
}

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json";
import common from "@/i18n/locales/en/common.json";
import type { JournalCheck, JournalProject, JournalWorld } from "@/lib/journal-workbench";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/journal-workbench", () => ({ journalRequest: api.request }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (
    key: (value: { researchTools: typeof en; common: typeof common }) => unknown,
    options?: Record<string, unknown>,
  ) => {
    const value = key({ researchTools: en, common });
    return typeof value === "string"
      ? value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""))
      : value;
  },
}) }));
import { JournalTemplatePanel } from "./JournalTemplatePanel";

const text = en.journal.template;
const world = { version_id: "template-v1", template: { original_sha256: "original", source_sha256: "normalized", provenance: null } } as JournalWorld;
const project = { project_id: "paper", baseline_id: "current-baseline" } as JournalProject;
const check = { check_id: "check-one", baseline_id: "checked-baseline", template_comparison: {} } as JournalCheck;
const finding = { case_id: "case", object_id: "/word/document.xml#0.1.2", kind: "run", role: "body",
  part: "/word/document.xml", path: [0, 1, 2], property_path: "run.fontSizePt", observed: 10, expected: 12,
  template_object_ids: ["/word/document.xml#0.2.1"], verdict: "observed_difference",
  role_basis: [{ source: "style_name", value: "Body", certainty: "inferred" }] };

beforeEach(() => {
  api.request.mockReset().mockImplementation(async (_path, input) => {
    if (input.operation === "findings") return { findings: [finding], total: 21, next_offset: input.offset === 0 ? 20 : null };
    if (input.operation === "snapshot") return { snapshot: { objects: [{ object_id: "first" }] }, total: 21, next_offset: 20 };
    return { nodes: [], total: 0, next_offset: null };
  });
});
afterEach(cleanup);

it("shows readable format facts and exposes no XML, JSON, hash, or internal object UI", async () => {
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await screen.findByText("Body text · Font size");
  expect(screen.getByText("Manuscript: 10 pt")).toBeInTheDocument();
  expect(screen.getByText("Template: 12 pt")).toBeInTheDocument();
  expect(screen.queryByText(text.diagnostics)).not.toBeInTheDocument();
  expect(screen.queryByText(text.inspect)).not.toBeInTheDocument();
  expect(screen.queryByText("run.fontSizePt")).not.toBeInTheDocument();
  expect(screen.queryByText("/word/document.xml#0.1.2")).not.toBeInTheDocument();
  expect(screen.queryByText("role_basis")).not.toBeInTheDocument();
  expect(screen.queryByText("original")).not.toBeInTheDocument();
  expect(screen.queryByText("normalized")).not.toBeInTheDocument();
  expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { check_id: "check-one" }, operation: "findings", verdict: "observed_difference", offset: 0, limit: 20,
  });
  fireEvent.click(screen.getAllByRole("button", { name: text.next })[0]);
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", expect.objectContaining({ operation: "findings", offset: 20 })));
  fireEvent.change(screen.getByRole("combobox", { name: text.filter }), { target: { value: "cannot_determine" } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", expect.objectContaining({ verdict: "cannot_determine", offset: 0 })));
});

it("does not query raw retained content when there is no comparison", async () => {
  render(<JournalTemplatePanel world={world} project={project} check={null} />);
  expect(api.request).not.toHaveBeenCalled();
  expect(screen.getByTestId("journal-template-facts")).toHaveTextContent(text.adopted);
});

it("shows a missing observation as not retained without turning it into a conclusion", async () => {
  api.request.mockImplementation(async (_path, input) => input.operation === "findings"
    ? {
        findings: [{
          ...finding,
          property_path: "paragraph.spacing.line",
          observed: null,
          expected: 18,
          verdict: "cannot_determine",
        }],
        total: 1,
        next_offset: null,
      }
    : { nodes: [], total: 0, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  fireEvent.change(await screen.findByRole("combobox", { name: text.filter }), {
    target: { value: "cannot_determine" },
  });
  expect(await screen.findByText("Body text · Line spacing")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Not retained")).toBeInTheDocument();
  const result = screen.getByText("Body text · Line spacing").closest("article");
  expect(result).toHaveTextContent(en.journal.verdicts.cannot_determine);
});

it("shows common format values in human terms and hides unknown raw structure", async () => {
  api.request.mockImplementation(async (_path, input) => input.operation === "findings"
    ? {
        findings: [
          { ...finding, case_id: "alignment", property_path: "paragraph.alignment", observed: "center", expected: "left" },
          { ...finding, case_id: "tabs", property_path: "paragraph.tabStops.stops",
            observed: [{ positionPt: 72, alignment: "left" }], expected: { internalToken: "opaque" } },
        ],
        total: 2,
        next_offset: null,
      }
    : { nodes: [], total: 0, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText("Body text · Paragraph alignment")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Centered")).toBeInTheDocument();
  expect(screen.getByText("Template: Left aligned")).toBeInTheDocument();
  expect(screen.getByText("Body text · Tab stops")).toBeInTheDocument();
  expect(screen.queryByText(/internalToken/)).not.toBeInTheDocument();
  expect(screen.getByText("Template: Multiple format settings")).toBeInTheDocument();
});

it("explains line spacing from its Word rule and formats common run properties", async () => {
  api.request.mockImplementation(async (_path, input) => input.operation === "findings"
    ? {
        findings: [
          { ...finding, case_id: "line-rule", property_path: "paragraph.lineSpacing.rule",
            observed: "exact", expected: "auto" },
          { ...finding, case_id: "line-value", property_path: "paragraph.lineSpacing.value",
            observed: 20, expected: 240 },
          { ...finding, case_id: "vertical", kind: "run", property_path: "run.verticalAlign",
            observed: "superscript", expected: "baseline" },
          { ...finding, case_id: "bold", kind: "run", property_path: "run.bold",
            observed: true, expected: false },
        ],
        total: 4,
        next_offset: null,
      }
    : { nodes: [], total: 0, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText("Body text · Line spacing rule")).toBeInTheDocument();
  expect(screen.getByText("Body text · Line spacing value")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Exactly 20 pt")).toBeInTheDocument();
  expect(screen.getByText("Template: Single line spacing")).toBeInTheDocument();
  expect(screen.getByText("Body text · Vertical position")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Superscript")).toBeInTheDocument();
  expect(screen.getByText("Body text · Bold")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Yes")).toBeInTheDocument();
});

it("translates retained comparison reasons into user-readable explanations", async () => {
  api.request.mockImplementation(async (_path, input) => input.operation === "findings"
    ? {
        findings: [{ ...finding, verdict: "cannot_determine", reason: "No corresponding template profile" }],
        total: 1,
        next_offset: null,
      }
    : { nodes: [], total: 0, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText("No matching template format was found.")).toBeInTheDocument();
});

it("renders Word's zero-based outline levels and body sentinel as readable levels", async () => {
  api.request.mockResolvedValue({
    findings: [
      { ...finding, case_id: "first-second", kind: "paragraph", role: "heading",
        property_path: "paragraph.outlineLevel", observed: 0, expected: 1 },
      { ...finding, case_id: "ninth-body", kind: "paragraph", role: "heading",
        property_path: "paragraph.outlineLevel", observed: 8, expected: 9 },
    ],
    total: 2,
    next_offset: null,
  });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText("Manuscript: Level 1")).toBeInTheDocument();
  expect(screen.getByText("Template: Level 2")).toBeInTheDocument();
  expect(screen.getByText("Manuscript: Level 9")).toBeInTheDocument();
  expect(screen.getByText("Template: Body text")).toBeInTheDocument();
});

it.each([
  ["world", { version_id: "template-v2" }],
  ["project", { baseline_id: "project-v2" }],
  ["check", { check_id: "check-two", baseline_id: "checked-v2" }],
] as const)("clears an in-flight finding page when the %s context changes", async (context, change) => {
  let finish!: (page: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ findings: [], total: 0, next_offset: null });
  const view = render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<JournalTemplatePanel
    world={context === "world" ? { ...world, ...change } : world}
    project={context === "project" ? { ...project, ...change } : project}
    check={context === "check" ? { ...check, ...change } : check}
  />);
  await act(async () => finish({
    findings: [{ ...finding, case_id: "old", observed: "OLD_CONTEXT_VALUE" }],
    total: 1,
    next_offset: null,
  }));
  expect(screen.queryByText(/OLD_CONTEXT_VALUE/)).not.toBeInTheDocument();
});

it("recovers a failed comparison by selecting another verdict and shows the empty result explicitly", async () => {
  api.request.mockRejectedValueOnce(new Error("Comparison query failed"))
    .mockResolvedValue({ findings: [], total: 0, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(en.workspace.journalTemplate.loadFailed);
  fireEvent.change(screen.getByRole("combobox", { name: text.filter }), { target: { value: "observed_match" } });
  expect(await screen.findByText(en.workspace.journalTemplate.noFindings)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: text.previous })).toBeDisabled();
  expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
  expect(api.request).toHaveBeenLastCalledWith("/api/docx-query", {
    target: { check_id: check.check_id }, operation: "findings", verdict: "observed_match", offset: 0, limit: 20,
  });
});

it("uses the retained line-spacing rule across pages and returns to the previous page", async () => {
  api.request.mockImplementation(async (_path, input) => input.offset === 0
    ? { findings: [{ ...finding, property_path: "paragraph.lineSpacing.rule", observed: "atLeast", expected: "auto" }], total: 21, next_offset: 20 }
    : { findings: [{ ...finding, property_path: "paragraph.lineSpacing.value", observed: 18, expected: 360 }], total: 21, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await screen.findByText("Manuscript: At least");
  fireEvent.click(screen.getByRole("button", { name: text.next }));
  expect(await screen.findByText("Manuscript: At least 18 pt")).toBeInTheDocument();
  expect(screen.getByText("Template: 1.5× line spacing")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: text.previous }));
  expect(await screen.findByText("Manuscript: At least")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: text.previous })).toBeDisabled();
  expect(api.request.mock.calls.map(([, input]) => input.offset)).toEqual([0, 20, 0]);
});

it("does not reuse a previous verdict's spacing rule for a newly filtered finding", async () => {
  api.request.mockImplementation(async (_path, input) => input.verdict === "observed_difference"
    ? { findings: [{ ...finding, property_path: "paragraph.lineSpacing.rule", observed: "exact", expected: "auto" }], total: 1, next_offset: null }
    : { findings: [{ ...finding, property_path: "paragraph.lineSpacing.value", observed: 360, expected: null, verdict: "cannot_determine" }], total: 1, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await screen.findByText("Manuscript: Exact");
  fireEvent.change(screen.getByRole("combobox", { name: text.filter }), { target: { value: "cannot_determine" } });
  expect(await screen.findByText("Manuscript: Word line spacing value: 360")).toBeInTheDocument();
  expect(screen.getByText("Template: Not retained")).toBeInTheDocument();
  expect(screen.queryByText("Manuscript: Exactly 360 pt")).not.toBeInTheDocument();
});

it("shows table, section and list formats using their units and readable Word values", async () => {
  const formats = [
    { case_id: "width", property_path: "run.horizontalScalePercent", observed: 80, expected: 100, observedText: "80%", expectedText: "100%" },
    { case_id: "indent", property_path: "section.margins.leftTwips", observed: 720, expected: 0, observedText: "720 twips", expectedText: "0 twips" },
    { case_id: "height", property_path: "row.height.rule", observed: "atLeast", expected: "exact", observedText: "At least", expectedText: "Exact" },
    { case_id: "break", property_path: "section.breakType", observed: "continuous", expected: "nextPage", observedText: "Continuous", expectedText: "Next page" },
    { case_id: "direction", property_path: "cell.textDirection", observed: "btLr", expected: "horizontal", observedText: "Bottom to top", expectedText: "Horizontal" },
    { case_id: "list", property_path: "paragraph.listItem.ilvl", observed: 0, expected: 2, observedText: "Level 1", expectedText: "Level 3" },
    { case_id: "underline", property_path: "run.underline", observed: { variant: "double" }, expected: { variant: "single" }, observedText: "Double underline", expectedText: "Single underline" },
    { case_id: "size", property_path: "table.tableWidth", observed: { type: "pct", value: 4000 }, expected: { type: "pct", value: 5000 }, observedText: "Type：pct；Value：4000", expectedText: "Type：pct；Value：5000" },
    { case_id: "tab", property_path: "paragraph.tabStops.stops", observed: [{ alignment: "decimal", positionPt: 72 }], expected: [{ alignment: "right", positionPt: 144 }], observedText: "Decimal numbering at 72 pt", expectedText: "Right aligned at 144 pt" },
    { case_id: "font", property_path: "run.fontFamilyEastAsia", observed: "SimSun", expected: "Source Han Serif SC", observedText: "SimSun", expectedText: "Source Han Serif SC" },
    { case_id: "columns", property_path: "table.columnWidthsPt", observed: [25, 40], expected: [30, 50], observedText: "25 pt、40 pt", expectedText: "30 pt、50 pt" },
  ];
  api.request.mockResolvedValue({ findings: formats.map((format) => ({ ...finding, ...format })), total: formats.length, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(formats.length));
  const articles = screen.getAllByRole("article");
  formats.forEach((format, index) => {
    expect(articles[index]).toHaveTextContent(`Manuscript: ${format.observedText}`);
    expect(articles[index]).toHaveTextContent(`Template: ${format.expectedText}`);
  });
  expect(screen.queryByText("run.fontFamilyEastAsia")).not.toBeInTheDocument();
});

it("explains unsupported template profiles without exposing backend diagnostics", async () => {
  api.request.mockResolvedValue({ findings: [
    { ...finding, case_id: "bands", role: "custom-table-role", property_path: "", reason: "Cannot compare band sizes other than one", verdict: "cannot_determine" },
    { ...finding, case_id: "unresolved", reason: "Unsupported private backend detail", verdict: "cannot_determine" },
  ], total: 2, next_offset: null });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText(en.workspace.journalTemplate.reason.tableBands)).toBeInTheDocument();
  expect(screen.getByText(en.workspace.journalTemplate.reason.generic)).toBeInTheDocument();
  expect(screen.getByText(`Other text · ${text.retainedFormat}`)).toBeInTheDocument();
  expect(screen.queryByText("Unsupported private backend detail")).not.toBeInTheDocument();
});

it("renders unfamiliar retained values as readable fallbacks without exposing raw object keys", async () => {
  api.request.mockResolvedValue({
    findings: [
      {
        ...finding,
        case_id: "unknown-role-format",
        role: "custom-role",
        property_path: "custom.property",
        observed: { privateToken: "opaque" },
        expected: [],
      },
      {
        ...finding,
        case_id: "line-value-text",
        object_id: "non-numeric-line",
        property_path: "paragraph.lineSpacing.value",
        observed: "unresolved",
        expected: 240,
      },
      {
        ...finding,
        case_id: "unknown-line-rule",
        property_path: "paragraph.lineSpacing.rule",
        observed: "customRule",
        expected: "exact",
      },
      {
        ...finding,
        case_id: "unknown-vertical-position",
        property_path: "run.verticalAlign",
        observed: "phoneticGuide",
        expected: "top",
      },
      {
        ...finding,
        case_id: "unknown-section-break",
        property_path: "section.breakType",
        observed: "oddColumn",
        expected: "nextColumn",
      },
      {
        ...finding,
        case_id: "unknown-text-direction",
        property_path: "cell.textDirection",
        observed: "tbRl",
        expected: "horizontal",
      },
      {
        ...finding,
        case_id: "empty-list",
        property_path: "paragraph.tabStops.stops",
        observed: [],
        expected: [],
      },
      {
        ...finding,
        case_id: "partial-tabs",
        property_path: "paragraph.tabStops.stops",
        observed: [null, { alignment: "left" }, { positionPt: 72 }],
        expected: "not-an-array",
      },
      {
        ...finding,
        case_id: "unknown-underline",
        property_path: "run.underline",
        observed: { variant: "dashDot" },
        expected: { variant: "wave" },
      },
      {
        ...finding,
        case_id: "complex-object",
        property_path: "table.tableWidth",
        observed: { unknownDimension: 10, nested: { value: 20 } },
        expected: { type: "pct", value: 5000 },
      },
    ],
    total: 10,
    next_offset: null,
  });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);

  const articles = await screen.findAllByRole("article");
  expect(articles).toHaveLength(10);
  expect(articles[0]).toHaveTextContent("Other text · Other retained format");
  expect(articles[0]).toHaveTextContent("Multiple format settings");
  expect(articles[1]).toHaveTextContent("Manuscript: unresolved");
  expect(articles[1]).toHaveTextContent("Template: Word line spacing value: 240");
  expect(articles[2]).toHaveTextContent("Manuscript: customRule");
  expect(articles[2]).toHaveTextContent("Template: Exact");
  expect(articles[3]).toHaveTextContent("Manuscript: phoneticGuide");
  expect(articles[4]).toHaveTextContent("Manuscript: oddColumn");
  expect(articles[5]).toHaveTextContent("Manuscript: tbRl");
  expect(articles[6]).toHaveTextContent("Manuscript: Multiple format settings");
  expect(articles[7]).toHaveTextContent(
    "Manuscript: Multiple format settings、Multiple format settings、This value cannot be shown at 72 pt",
  );
  expect(articles[8]).toHaveTextContent("Manuscript: Dash Dot");
  expect(articles[9]).toHaveTextContent("Manuscript: Multiple format settings");
  expect(screen.queryByText(/privateToken|unknownDimension|nested/)).not.toBeInTheDocument();
});

it("renders no template facts when the selected world has no adopted template", () => {
  const { container } = render(
    <JournalTemplatePanel
      world={{ ...world, template: undefined }}
      project={project}
      check={{ ...check, template_comparison: null }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(api.request).not.toHaveBeenCalled();
});

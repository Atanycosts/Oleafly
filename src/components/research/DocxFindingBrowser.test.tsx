// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json";
import common from "@/i18n/locales/en/common.json";
import type { DocxFindingDetail, DocxFindingGroup, DocxFindingLocation } from "@/lib/docx-finding-review";

const api = vi.hoisted(() => ({
  groups: vi.fn(),
  locations: vi.fn(),
  details: vi.fn(),
}));
vi.mock("@/lib/docx-finding-review", () => ({
  fetchDocxFindingGroups: api.groups,
  fetchDocxFindingLocations: api.locations,
  fetchDocxFindingDetails: api.details,
}));
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
import { DocxFindingBrowser } from "./DocxFindingBrowser";

const counts = (difference = 1, undetermined = 0, match = 0) => ({
  observed_difference: difference,
  cannot_determine: undetermined,
  observed_match: match,
});
const group = (value: Partial<DocxFindingGroup> & Pick<DocxFindingGroup, "id" | "category" | "action">): DocxFindingGroup => ({
  counts: counts(),
  location_count: 1,
  ...value,
});
const location = (value: Partial<DocxFindingLocation> & Pick<DocxFindingLocation, "id">): DocxFindingLocation => ({
  para_id: `para-${value.id}`,
  counts: counts(),
  ...value,
});
const finding = (value: Partial<DocxFindingDetail> = {}): DocxFindingDetail => ({
  case_id: "case-one",
  object_id: "/word/document.xml#0.1",
  kind: "run",
  role: "body",
  part: "/word/document.xml",
  path: [0, 1],
  property_path: "run.fontSizePt",
  observed: 10,
  expected: 12,
  expected_value_count: 1,
  template_object_ids: ["/word/document.xml#0.2"],
  verdict: "observed_difference",
  ...value,
});

beforeEach(() => {
  api.groups.mockReset();
  api.locations.mockReset();
  api.details.mockReset();
  api.locations.mockResolvedValue({ locations: [location({ id: "loc-one", label: "Opening paragraph" })], total: 1, next_offset: null });
  api.details.mockResolvedValue({ findings: [finding()], total: 1, next_offset: null });
});
afterEach(cleanup);

it("groups by document section and loads locations then exact checks only when opened", async () => {
  const groups = [
    group({ id: "heading", category: "heading", action: "paragraph.alignment", heading_level: 2, counts: counts(2, 1), location_count: 3 }),
    group({ id: "table", category: "table", action: "cell.vAlign", object_number: 2, table_area: "header", counts: counts(1) }),
    group({ id: "formula", category: "formula", action: "run.fontSizePt", object_number: 3, counts: counts(0, 1) }),
  ];
  const onJump = vi.fn();
  render(<DocxFindingBrowser checkId="check-one" groups={groups} onJump={onJump} />);

  expect(screen.getByText(en.docx.findingReview.categories.heading)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.categories.table)).toBeInTheDocument();
  expect(screen.getByText("Heading 2")).toBeInTheDocument();
  expect(screen.getByText("Table 2")).toBeInTheDocument();
  expect(screen.getByText("Header rows")).toBeInTheDocument();
  expect(screen.getByText("Matching checks: 3")).toBeInTheDocument();
  expect(screen.getByText("Locations across all comparison results: 5")).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.summaryNote)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.languageScope)).toBeInTheDocument();
  expect(api.locations).not.toHaveBeenCalled();
  expect(api.details).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("docx-finding-group-heading"));
  await waitFor(() => expect(api.locations).toHaveBeenCalledWith("check-one", "heading", "observed_difference", 0));
  expect(await screen.findByText("Opening paragraph")).toBeInTheDocument();
  expect(api.details).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("docx-finding-location-loc-one"));
  await waitFor(() => expect(api.details).toHaveBeenCalledWith("check-one", "heading", "loc-one", "observed_difference", 0));
  expect(await within(screen.getByTestId("docx-finding-details")).findByText("Manuscript: 10 pt")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: en.docx.findingReview.openLocation }));
  expect(onJump).toHaveBeenCalledWith(expect.objectContaining({
    id: "loc-one",
    para_id: "para-loc-one",
    label: "Opening paragraph",
  }));
});

it("pages locations and uses the retained line spacing rule even when not on the same page", async () => {
  const groups = [group({
    id: "line",
    category: "body",
    action: "paragraph.lineSpacing.value",
    counts: counts(1, 1),
    location_count: 2,
  })];
  api.locations
    .mockResolvedValueOnce({
      locations: [location({ id: "line-one", label: "First paragraph" })],
      total: 2,
      next_offset: 20,
    })
    .mockResolvedValueOnce({
      locations: [location({ id: "line-two", label: "Second paragraph" })],
      total: 2,
      next_offset: null,
    });
  api.details
    .mockResolvedValueOnce({
      findings: [finding({ case_id: "rule", property_path: "paragraph.lineSpacing.rule", observed: "atLeast", expected: "exact" })],
      total: 2,
      next_offset: 20,
    })
    .mockResolvedValueOnce({
      findings: [finding({
        case_id: "value",
        property_path: "paragraph.lineSpacing.value",
        observed: null,
        expected: 240,
        line_spacing_rule: { observed: null, expected: "auto" },
        verdict: "cannot_determine",
      })],
      total: 2,
      next_offset: null,
    });
  render(<DocxFindingBrowser checkId="check-one" groups={groups} initialVerdict="cannot_determine" />);

  fireEvent.click(screen.getByTestId("docx-finding-group-line"));
  await screen.findByText("First paragraph");
  expect(api.locations).toHaveBeenLastCalledWith("check-one", "line", "cannot_determine", 0);
  fireEvent.click(within(screen.getByTestId("docx-finding-locations")).getByRole("button", { name: en.docx.findingReview.next }));
  await screen.findByText("Second paragraph");
  expect(api.locations).toHaveBeenLastCalledWith("check-one", "line", "cannot_determine", 20);

  fireEvent.click(screen.getByTestId("docx-finding-location-line-two"));
  await screen.findByText("Manuscript: At least");
  fireEvent.click(within(screen.getByTestId("docx-finding-details")).getByRole("button", { name: en.docx.findingReview.next }));
  expect(await screen.findByText("Manuscript: Not retained")).toBeInTheDocument();
  expect(screen.getByText("Template: Single line spacing")).toBeInTheDocument();
  expect(within(screen.getByTestId("docx-finding-details")).getByText(en.journal.verdicts.cannot_determine))
    .toBeInTheDocument();
});

it("offers only requested comparison results and reports failures without stale details", async () => {
  const groups = [group({ id: "body", category: "body", action: "run.fontSizePt" })];
  api.locations.mockRejectedValueOnce(new Error("locations failed"));
  const view = render(
    <DocxFindingBrowser
      checkId="check-one"
      groups={groups}
      verdicts={["observed_difference", "cannot_determine"]}
    />,
  );
  const options = within(screen.getByRole("combobox")).getAllByRole("option");
  expect(options.map((option) => option.getAttribute("value"))).toEqual(["observed_difference", "cannot_determine"]);
  fireEvent.click(screen.getByTestId("docx-finding-group-body"));
  expect(await screen.findByRole("alert")).toHaveTextContent(en.docx.findingReview.locationsFailed);

  api.locations.mockResolvedValue({ locations: [], total: 0, next_offset: null });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "cannot_determine" } });
  view.rerender(<DocxFindingBrowser checkId="check-one" groups={[]} verdicts={["observed_difference", "cannot_determine"]} />);
  expect(screen.getByText(en.docx.findingReview.noGroups)).toBeInTheDocument();
});

it("keeps retained formatting values human-readable and hides raw structures", async () => {
  const groups = [group({
    id: "formats",
    category: "other",
    action: "custom.property",
    counts: counts(8),
  })];
  api.details.mockResolvedValue({
    findings: [
      finding({ case_id: "alignment", property_path: "paragraph.alignment", observed: "center", expected: "left" }),
      finding({
        case_id: "tabs",
        property_path: "paragraph.tabStops.stops",
        observed: [{ positionPt: 72, alignment: "left" }],
        expected: { internalToken: "opaque" },
      }),
      finding({ case_id: "first-heading", property_path: "paragraph.outlineLevel", observed: 0, expected: 1 }),
      finding({ case_id: "body-level", property_path: "paragraph.outlineLevel", observed: 9, expected: 9 }),
      finding({ case_id: "width", property_path: "run.horizontalScalePercent", observed: 80, expected: 100 }),
      finding({
        case_id: "underline",
        property_path: "run.underline",
        observed: { variant: "double" },
        expected: { variant: "single" },
      }),
      finding({
        case_id: "private",
        role: "custom-role",
        property_path: "custom.property",
        observed: { privateToken: "opaque" },
        expected: [],
      }),
      finding({
        case_id: "reason",
        property_path: "",
        reason: "No corresponding template profile",
        expected_value_count: 2,
        verdict: "cannot_determine",
      }),
    ],
    total: 8,
    next_offset: null,
  });
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);
  fireEvent.click(screen.getByTestId("docx-finding-group-formats"));
  fireEvent.click(await screen.findByTestId("docx-finding-location-loc-one"));

  const articles = await screen.findAllByRole("article");
  expect(articles).toHaveLength(8);
  expect(articles[0]).toHaveTextContent("Manuscript: Centered");
  expect(articles[0]).toHaveTextContent("Template: Left aligned");
  expect(articles[1]).toHaveTextContent("Manuscript: Left aligned at 72 pt");
  expect(articles[1]).toHaveTextContent("Template: Multiple format settings");
  expect(articles[2]).toHaveTextContent("Manuscript: Level 1");
  expect(articles[3]).toHaveTextContent("Manuscript: Body text");
  expect(articles[4]).toHaveTextContent("Manuscript: 80%");
  expect(articles[5]).toHaveTextContent("Manuscript: Double underline");
  expect(articles[6]).toHaveTextContent("Other text · Other retained format");
  expect(articles[6]).toHaveTextContent("Multiple format settings");
  expect(articles[7]).toHaveTextContent(en.docx.findingReview.limitations.noProfile);
  expect(articles[7]).toHaveTextContent(en.docx.findingReview.limitations.expectedValuesDiffer);
  expect(articles[7]).toHaveTextContent(en.docx.findingReview.limitations.coverage);
  expect(screen.queryByText(/privateToken|internalToken|opaque/)).not.toBeInTheDocument();
  expect(screen.queryByText("run.horizontalScalePercent")).not.toBeInTheDocument();
});

it("orders tables by table, table area, and action instead of interleaving actions", () => {
  const groups = [
    group({ id: "table-1-body", category: "table", action: "cell.vAlign", object_number: 1, table_area: "body" }),
    group({ id: "table-2", category: "table", action: "row.height", object_number: 2 }),
    group({ id: "table-1-whole", category: "table", action: "row.height", object_number: 1 }),
    group({ id: "table-1-header", category: "table", action: "cell.margins", object_number: 1, table_area: "header" }),
  ];
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);

  const follows = (left: HTMLElement, right: HTMLElement) =>
    Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
  const tableOne = screen.getByTestId("docx-finding-table-1");
  const tableTwo = screen.getByTestId("docx-finding-table-2");
  const whole = screen.getByTestId("docx-finding-table-1-whole");
  const header = screen.getByTestId("docx-finding-table-1-header");
  const body = screen.getByTestId("docx-finding-table-1-body");
  expect(follows(tableOne, tableTwo)).toBe(true);
  expect(follows(whole, header)).toBe(true);
  expect(follows(header, body)).toBe(true);
  expect(within(tableOne).getByText(en.docx.findingReview.wholeTable)).toBeInTheDocument();
  expect(within(header).getByText(en.docx.findingReview.tableHeader)).toBeInTheDocument();
  expect(within(body).getByText(en.docx.findingReview.tableBody)).toBeInTheDocument();
});

it("nests headings by level and keeps an unspecified level separate", () => {
  const groups = [
    group({ id: "level-2", category: "heading", action: "run.fontSizePt", heading_level: 2 }),
    group({ id: "level-1", category: "heading", action: "paragraph.alignment", heading_level: 1 }),
    group({ id: "level-unknown", category: "heading", action: "run.bold" }),
  ];
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);

  const follows = (left: HTMLElement, right: HTMLElement) =>
    Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
  const levelOne = screen.getByTestId("docx-finding-heading-1");
  const levelTwo = screen.getByTestId("docx-finding-heading-2");
  const unknown = screen.getByTestId("docx-finding-heading-unspecified");
  expect(follows(levelOne, levelTwo)).toBe(true);
  expect(follows(levelTwo, unknown)).toBe(true);
  expect(within(levelOne).getByTestId("docx-finding-group-level-1")).toBeInTheDocument();
  expect(within(levelTwo).getByTestId("docx-finding-group-level-2")).toBeInTheDocument();
  expect(within(unknown).getByTestId("docx-finding-group-level-unknown")).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.unspecifiedHeadingLevel)).toBeInTheDocument();
});

it("labels matching checks separately from locations counted across all verdicts", () => {
  const groups = [group({
    id: "counted",
    category: "body",
    action: "run.fontSizePt",
    counts: counts(1, 2),
    location_count: 9,
  })];
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);

  expect(screen.getByText("Matching checks: 1")).toBeInTheDocument();
  expect(screen.getByText("Locations across all comparison results: 9")).toBeInTheDocument();
  expect(screen.getByText("Checks: 1 · locations across all results: 9")).toBeInTheDocument();

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "cannot_determine" } });
  expect(screen.getByText("Matching checks: 2")).toBeInTheDocument();
  expect(screen.getByText("Locations across all comparison results: 9")).toBeInTheDocument();
  expect(screen.getByText("Checks: 2 · locations across all results: 9")).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.summaryNote)).toBeInTheDocument();
});

it("keeps the language scope visible when the current result has no groups", () => {
  render(<DocxFindingBrowser checkId="check-one" groups={[]} />);
  expect(screen.getByText(en.docx.findingReview.noGroups)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.languageScope)).toBeInTheDocument();
});

it("marks page-flow and layout limits without presenting them as passes", async () => {
  const groups = [
    group({ id: "page-flow", category: "body", action: "page_flow" }),
    group({ id: "layout", category: "body", action: "layout" }),
  ];
  api.details.mockImplementation((_checkId, groupId: string) => Promise.resolve({
    findings: [finding({
      case_id: groupId,
      property_path: groupId === "page-flow" ? "section.breakType" : "section.pageWidthTwips",
      observed: null,
      expected: 1,
      verdict: "cannot_determine",
    })],
    total: 1,
    next_offset: null,
  }));
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);

  fireEvent.click(screen.getByTestId("docx-finding-group-page-flow"));
  fireEvent.click(await screen.findByTestId("docx-finding-location-loc-one"));
  expect(await screen.findByText(en.docx.findingReview.limitations.pageFlow)).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("docx-finding-group-layout"));
  fireEvent.click(await screen.findByTestId("docx-finding-location-loc-one"));
  expect(await screen.findByText(en.docx.findingReview.limitations.layout)).toBeInTheDocument();
});

it("labels table-band and generic undetermined checks as limits rather than passes", async () => {
  const groups = [group({
    id: "table-bands",
    category: "table",
    action: "borders",
    object_number: 1,
    table_area: "body",
  })];
  api.details.mockResolvedValue({
    findings: [
      finding({
        case_id: "bands",
        property_path: "table.borders.top",
        observed: null,
        expected: { size: 4 },
        verdict: "cannot_determine",
        reason: "Table bands use band sizes other than one",
      }),
      finding({
        case_id: "unknown",
        property_path: "run.customValue",
        observed: null,
        expected: 1,
        verdict: "cannot_determine",
      }),
    ],
    total: 2,
    next_offset: null,
  });
  render(<DocxFindingBrowser checkId="check-one" groups={groups} />);
  expect(screen.getByText(en.docx.findingReview.actions.borders)).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("docx-finding-group-table-bands"));
  fireEvent.click(await screen.findByTestId("docx-finding-location-loc-one"));

  expect(await screen.findByText(en.docx.findingReview.limitations.tableBands)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.limitations.cannotDetermine)).toBeInTheDocument();
});

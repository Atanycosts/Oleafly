// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json";
import common from "@/i18n/locales/en/common.json";
import type { CandidateReviewItem } from "@/lib/docx-format-candidate-flow";
import type { DocxFormatTemplateFinding } from "@/lib/docx-format-candidate-plan";
import type { DocxFindingGroup } from "@/lib/docx-finding-review";
import type { DocxCandidateReviewView } from "@/lib/docx-format-candidate-review";
import type { FormatCandidateState } from "./DocxFormatCandidatePanel";

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
import { DocxFormatCandidatePanel } from "./DocxFormatCandidatePanel";

const change = (value: Partial<CandidateReviewItem> & Pick<CandidateReviewItem, "id" | "property" | "group">): CandidateReviewItem => ({
  role: "body",
  paraId: "paragraph-one",
  location: "Opening paragraph",
  before: "before",
  expected: "after",
  ...value,
});
const findingGroup: DocxFindingGroup = {
  id: "table-cell",
  category: "table",
  action: "cell.vAlign",
  object_number: 2,
  table_area: "header",
  counts: { observed_match: 0, observed_difference: 1, cannot_determine: 1 },
  location_count: 1,
};
const tableLocation = {
  id: "table-location",
  para_id: "table-paragraph",
  label: "Header cell",
  object_number: 2,
  row: 1,
  column: 2,
  counts: { observed_match: 0, observed_difference: 1, cannot_determine: 0 },
};
const tableFinding: DocxFormatTemplateFinding = {
  case_id: "table-case",
  object_id: "/word/document.xml#0.table",
  kind: "table_cell",
  role: "table",
  part: "/word/document.xml",
  path: [0, 1],
  property_path: "cell.vAlign",
  observed: "top",
  expected: "center",
  expected_value_count: 1,
  template_object_ids: ["/word/document.xml#0.template"],
  verdict: "observed_difference",
};

function review(overrides: Partial<DocxCandidateReviewView> = {}): DocxCandidateReviewView {
  return {
    filename: "candidate.docx",
    bytes: new Uint8Array(),
    world: {
      journal_name: "Test Journal",
      version_ordinal: 2,
    } as DocxCandidateReviewView["world"],
    refreshed: false,
    changes: [],
    unconfirmedChanges: [],
    findingReview: { checkId: "check-one", groups: [] },
    ...overrides,
  };
}

function renderCandidate(state: FormatCandidateState | { phase: "ready"; review: DocxCandidateReviewView }, onJump = vi.fn()) {
  const controls = {
    onAdopt: vi.fn(),
    onDownload: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onReformat: vi.fn(),
  };
  render(<DocxFormatCandidatePanel
    state={state.phase === "ready" && !("adoption" in state)
      ? { ...state, adoption: {} as Extract<FormatCandidateState, { phase: "ready" }>["adoption"] }
      : state}
    adopting={false}
    onJump={onJump}
    {...controls}
  />);
  return { onJump, ...controls };
}

afterEach(cleanup);

it("groups confirmed writes by paragraph and action and keeps unconfirmed writes separate", () => {
  const onJump = vi.fn();
  renderCandidate({
    phase: "ready",
    review: review({
      changes: [
        change({
          id: "alignment",
          property: "paragraph.alignment",
          group: { category: "body", action: "paragraph.alignment" },
        }),
        change({
          id: "spacing",
          property: "paragraph.spacing.line",
          group: { category: "body", action: "paragraph.spacing.line" },
        }),
      ],
      unconfirmedChanges: [
        change({
          id: "font",
          property: "run.fontSizePt",
          group: { category: "body", action: "run.fontSizePt" },
        }),
      ],
    }),
  }, onJump);

  const confirmed = screen.getByTestId("docx-format-candidate-changes");
  expect(within(confirmed).getAllByText("Opening paragraph")).toHaveLength(1);
  expect(within(confirmed).getByText("Alignment")).toBeInTheDocument();
  expect(within(confirmed).getByText("Line spacing")).toBeInTheDocument();
  expect(within(confirmed).queryAllByTestId("docx-format-candidate-change")).toHaveLength(0);
  expect(within(confirmed).queryByTestId("docx-format-candidate-unconfirmed")).not.toBeInTheDocument();

  fireEvent.click(within(confirmed).getByText("Alignment").closest("button") as HTMLElement);
  expect(within(confirmed).getAllByTestId("docx-format-candidate-change")).toHaveLength(1);
  fireEvent.click(within(confirmed).getByText("Line spacing").closest("button") as HTMLElement);
  expect(within(confirmed).getAllByTestId("docx-format-candidate-change")).toHaveLength(2);
  fireEvent.click(within(confirmed).getByTestId("docx-format-candidate-change-location"));
  expect(onJump).toHaveBeenCalledWith("paragraph-one");

  const unconfirmed = screen.getByTestId("docx-format-candidate-unconfirmed-section");
  expect(unconfirmed).toHaveTextContent(en.docx.formatCandidate.unconfirmedChanges);
  expect(unconfirmed).toHaveTextContent(en.docx.formatCandidate.unconfirmedHelp);
  expect(within(unconfirmed).queryAllByTestId("docx-format-candidate-unconfirmed")).toHaveLength(0);
  expect(screen.getByTestId("docx-format-candidate")).toHaveAttribute("data-confirmed-count", "2");

  fireEvent.click(within(unconfirmed).getByText("Font size (pt)").closest("button") as HTMLElement);
  expect(within(unconfirmed).getAllByTestId("docx-format-candidate-unconfirmed")).toHaveLength(1);
});

it("offers a paragraph jump only when the confirmed location has an editor id", () => {
  renderCandidate({
    phase: "ready",
    review: review({
      changes: [change({
        id: "without-para",
        paraId: undefined,
        location: "Unlinked paragraph",
        property: "paragraph.alignment",
        group: { category: "body", action: "paragraph.alignment" },
      })],
    }),
  });

  expect(screen.queryByTestId("docx-format-candidate-change-location")).not.toBeInTheDocument();
  expect(screen.getByText("Unlinked paragraph")).toBeInTheDocument();
});

it("groups table row audits by table and area and jumps from each expanded row", () => {
  const onJump = vi.fn();
  renderCandidate({
    phase: "ready",
    review: review({
      changes: [
        change({
          id: "table-two-header",
          paraId: "header-row",
          location: "Level | Visible data",
          row: 1,
          before: true,
          expected: true,
          property: "row.isHeader",
          group: { category: "table", action: "page_flow", object_number: 2, table_area: "header" },
        }),
        change({
          id: "table-two-row-three",
          paraId: "row-three",
          location: "L3 | L2 + member-action commitment",
          row: 3,
          before: false,
          expected: true,
          templateLocation: "Template row 2",
          property: "row.cantSplit",
          group: { category: "table", action: "page_flow", object_number: 2, table_area: "body" },
        }),
        change({
          id: "table-two-row-four",
          paraId: "row-four",
          location: "L4 | Active member",
          row: 4,
          before: false,
          expected: true,
          property: "row.cantSplit",
          group: { category: "table", action: "page_flow", object_number: 2, table_area: "body" },
        }),
        change({
          id: "table-two-row-five",
          paraId: undefined,
          location: "L5 | Revision",
          row: 5,
          before: false,
          expected: true,
          property: "row.cantSplit",
          group: { category: "table", action: "page_flow", object_number: 2, table_area: "body" },
        }),
        change({
          id: "table-one-row-two",
          paraId: "table-one-row",
          location: "Table 1 body row",
          row: 2,
          property: "cell.vAlign",
          group: { category: "table", action: "cell.vAlign", object_number: 1, table_area: "body" },
        }),
      ],
    }),
  }, onJump);

  const confirmed = screen.getByTestId("docx-format-candidate-changes");
  const follows = (left: HTMLElement, right: HTMLElement) =>
    Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
  const tableOne = within(confirmed).getByTestId("docx-format-candidate-table-1");
  const tableTwo = within(confirmed).getByTestId("docx-format-candidate-table-2");
  const header = within(tableTwo).getByTestId("docx-format-candidate-table-2-header");
  const body = within(tableTwo).getByTestId("docx-format-candidate-table-2-body");
  expect(follows(tableOne, tableTwo)).toBe(true);
  expect(follows(header, body)).toBe(true);
  expect(within(confirmed).getAllByText("Table 2")).toHaveLength(1);
  expect(within(body).getAllByText("Body rows")).toHaveLength(1);
  expect(within(body).getByText("Page flow")).toBeInTheDocument();
  expect(within(body).queryByText("Row 3")).not.toBeInTheDocument();

  fireEvent.click(within(body).getByText("Page flow").closest("button") as HTMLElement);
  expect(within(body).getAllByTestId("docx-format-candidate-change")).toHaveLength(3);
  expect(within(body).getByText("Row 3")).toBeInTheDocument();
  expect(within(body).getByText("Row 4")).toBeInTheDocument();
  expect(within(body).getByText("Row 5")).toBeInTheDocument();
  expect(within(body).getByText("Template: Template row 2")).toBeInTheDocument();

  const jumps = within(body).getAllByRole("button", { name: en.docx.findingReview.openLocation });
  expect(jumps).toHaveLength(2);
  fireEvent.click(jumps[0]);
  fireEvent.click(jumps[1]);
  expect(onJump).toHaveBeenNthCalledWith(1, "row-three");
  expect(onJump).toHaveBeenNthCalledWith(2, "row-four");
});

it("keeps the language scope visible when no unresolved finding group is rendered", () => {
  renderCandidate({ phase: "ready", review: review() });
  expect(screen.getByTestId("docx-format-candidate-language-scope"))
    .toHaveTextContent(en.docx.findingReview.languageScope);
});

it("shows difference and undetermined evidence in the same lazy browser, never matches", async () => {
  api.locations.mockResolvedValue({
    locations: [tableLocation],
    total: 1,
    next_offset: null,
  });
  api.details.mockResolvedValue({
    findings: [tableFinding],
    total: 1,
    next_offset: null,
  });
  const onJump = vi.fn();
  renderCandidate({
    phase: "ready",
    review: review({ findingReview: { checkId: "check-one", groups: [findingGroup] } }),
  }, onJump);

  const options = within(screen.getByRole("combobox")).getAllByRole("option");
  expect(options.map((option) => option.getAttribute("value"))).toEqual([
    "observed_difference",
    "cannot_determine",
  ]);
  expect(screen.getByText("Table 2")).toBeInTheDocument();
  expect(screen.getByText("Header rows")).toBeInTheDocument();
  expect(api.locations).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("docx-finding-group-table-cell"));
  await waitFor(() => expect(api.locations).toHaveBeenCalledWith(
    "check-one",
    "table-cell",
    "observed_difference",
    0,
  ));
  expect(await screen.findByText("Header cell")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("docx-finding-location-table-location"));
  expect(await screen.findByText("Manuscript: top")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: en.docx.findingReview.openLocation }));
  expect(onJump).toHaveBeenCalledWith("table-paragraph");
});

it("keeps adopt, reformat, export, download, stop, and close controls distinct", () => {
  const ready = renderCandidate({ phase: "ready", review: review() });
  fireEvent.click(screen.getByTestId("docx-adopt-format-candidate"));
  fireEvent.click(screen.getByRole("button", { name: en.docx.formatCandidate.download }));
  expect(ready.onAdopt).toHaveBeenCalledOnce();
  expect(ready.onDownload).toHaveBeenCalledOnce();

  cleanup();
  const conflict = renderCandidate({ phase: "conflict", review: review() });
  fireEvent.click(screen.getByRole("button", { name: en.docx.formatCandidate.reformat }));
  expect(conflict.onReformat).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent(en.docx.formatCandidate.conflict);

  cleanup();
  renderCandidate({ phase: "adopted", review: review() });
  expect(screen.getByRole("button", { name: en.docx.formatCandidate.export })).toBeInTheDocument();

  cleanup();
  const running = renderCandidate({ phase: "running" });
  fireEvent.click(screen.getByRole("button", { name: en.docx.formatCandidate.stop }));
  expect(running.onStop).toHaveBeenCalledOnce();

  cleanup();
  const idle = renderCandidate({ phase: "ready", review: review() });
  fireEvent.click(screen.getByRole("button", { name: en.docx.formatCandidate.close }));
  expect(idle.onClose).toHaveBeenCalledOnce();
});

it("keeps unnamed table areas, heading context, and compound values understandable", () => {
  renderCandidate({
    phase: "ready",
    review: review({
      refreshed: true,
      changes: [
        change({
          id: "unspecified-table",
          paraId: undefined,
          location: undefined,
          row: undefined,
          before: { alignment: "left", count: 2 },
          expected: { alignment: "center", count: 3 },
          property: "row.isHeader",
          group: { category: "table", action: "page_flow", table_area: "exception" },
        }),
        change({
          id: "custom-heading",
          role: "custom_role",
          paraId: undefined,
          location: undefined,
          before: null,
          expected: "ready",
          property: "custom.property",
          group: { category: "body", action: "custom.action", heading_level: 2 },
        }),
      ],
    }),
  });

  expect(screen.getByText(en.docx.formatCandidate.templateRefreshed)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.tableUnspecified)).toBeInTheDocument();
  expect(screen.getByTestId("docx-format-candidate-table-unspecified-exception")).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.tableException)).toBeInTheDocument();
  expect(screen.getByText("custom role")).toBeInTheDocument();
  expect(screen.getByText("Heading 2")).toBeInTheDocument();

  const pageFlow = screen.getByText(en.docx.findingReview.actions.page_flow).closest("button") as HTMLElement;
  expect(pageFlow).toHaveTextContent("Changes: 1");
  expect(screen.queryByText(/alignment|count/)).not.toBeInTheDocument();
  fireEvent.click(pageFlow);
  expect(screen.getByText('{"alignment":"left","count":2}')).toBeInTheDocument();
  expect(screen.getByText('{"alignment":"center","count":3}')).toBeInTheDocument();
  fireEvent.click(pageFlow);
  expect(screen.queryByText('{"alignment":"left","count":2}')).not.toBeInTheDocument();

  const custom = screen.getByText("Custom action").closest("button") as HTMLElement;
  fireEvent.click(custom);
  expect(screen.getByText("Custom property")).toBeInTheDocument();
  expect(screen.getAllByText("—")).toHaveLength(2);
  expect(screen.getAllByText("ready")).toHaveLength(2);
});

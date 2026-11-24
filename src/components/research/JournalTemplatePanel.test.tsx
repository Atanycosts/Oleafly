// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json";
import common from "@/i18n/locales/en/common.json";
import type { JournalCheck, JournalProject, JournalWorld } from "@/lib/journal-workbench";

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
import { JournalTemplatePanel } from "./JournalTemplatePanel";

const world = {
  version_id: "template-v1",
  template: { original_sha256: "original", source_sha256: "normalized", provenance: null },
} as JournalWorld;
const project = { project_id: "paper", baseline_id: "current-baseline" } as JournalProject;
const check = {
  check_id: "check-one",
  baseline_id: "checked-baseline",
  template_comparison: {},
} as JournalCheck;
const group = {
  id: "body-font",
  category: "body" as const,
  action: "run.fontSizePt",
  counts: { observed_match: 0, observed_difference: 2, cannot_determine: 1 },
  location_count: 2,
};
const location = {
  id: "paragraph-one",
  para_id: "paragraph-island",
  label: "Opening paragraph",
  counts: { observed_match: 0, observed_difference: 1, cannot_determine: 0 },
};
const detail = {
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
};

beforeEach(() => {
  api.groups.mockReset().mockResolvedValue({ groups: [group], summary: {} });
  api.locations.mockReset().mockResolvedValue({ locations: [location], total: 1, next_offset: null });
  api.details.mockReset().mockResolvedValue({ findings: [detail], total: 1, next_offset: null });
});
afterEach(cleanup);

it("loads grouped comparison facts and keeps raw template diagnostics out of the panel", async () => {
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText(en.docx.findingReview.categories.body)).toBeInTheDocument();
  expect(screen.getByText("Font size")).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.languageScope)).toBeInTheDocument();
  expect(api.groups).toHaveBeenCalledWith("check-one");
  expect(screen.queryByText("run.fontSizePt")).not.toBeInTheDocument();
  expect(screen.queryByText("/word/document.xml#0.1")).not.toBeInTheDocument();
  expect(screen.queryByText("original")).not.toBeInTheDocument();
  expect(screen.queryByText("normalized")).not.toBeInTheDocument();
});

it("passes the exact retained location to navigation instead of only a paragraph id", async () => {
  const onJump = vi.fn();
  render(<JournalTemplatePanel world={world} project={project} check={check} onJump={onJump} />);
  fireEvent.click(await screen.findByTestId("docx-finding-group-body-font"));
  fireEvent.click(await screen.findByTestId("docx-finding-location-paragraph-one"));
  await screen.findByText("Manuscript: 10 pt");
  fireEvent.click(screen.getByRole("button", { name: en.docx.findingReview.openLocation }));
  expect(onJump).toHaveBeenCalledWith(location);
});

it("does not query retained findings without a comparison or an adopted template", () => {
  const { container } = render(<JournalTemplatePanel world={world} project={project} check={null} />);
  expect(api.groups).not.toHaveBeenCalled();
  expect(screen.getByTestId("journal-template-facts")).toHaveTextContent(en.journal.template.adopted);
  expect(container).not.toBeEmptyDOMElement();

  cleanup();
  render(<JournalTemplatePanel
    world={{ ...world, template: undefined }}
    project={project}
    check={{ ...check, template_comparison: null }}
  />);
  expect(api.groups).not.toHaveBeenCalled();
});

it("keeps the language scope visible when the comparison has no groups", async () => {
  api.groups.mockResolvedValueOnce({ groups: [], summary: {} });
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByText(en.docx.findingReview.noGroups)).toBeInTheDocument();
  expect(screen.getByText(en.docx.findingReview.languageScope)).toBeInTheDocument();
});

it("ignores a late group response after the selected check changes", async () => {
  let finish!: (value: unknown) => void;
  api.groups
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ groups: [], summary: {} });
  const view = render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<JournalTemplatePanel
    world={world}
    project={project}
    check={{ ...check, check_id: "check-two" }}
  />);
  await waitFor(() => expect(api.groups).toHaveBeenLastCalledWith("check-two"));
  await act(async () => finish({
    groups: [{ ...group, id: "old" }],
    summary: {},
  }));
  expect(screen.queryByText(en.docx.findingReview.categories.body)).not.toBeInTheDocument();
});

it("shows a retryable group-load failure without an empty-result claim", async () => {
  api.groups.mockRejectedValueOnce(new Error("comparison failed"));
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(en.workspace.journalTemplate.loadFailed);
  expect(screen.queryByTestId("docx-finding-browser")).not.toBeInTheDocument();
});

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

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/researchTools.json";
import common from "@/i18n/locales/en/common.json";
import type { JournalCheck, JournalProject, JournalWorld } from "@/lib/journal-workbench";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/journal-workbench", () => ({ journalRequest: api.request }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: (value: { researchTools: typeof en; common: typeof common }) => unknown) => key({ researchTools: en, common }),
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

it("pages actual differences and resolves objects against the checked baseline and original template", async () => {
  render(<JournalTemplatePanel world={world} project={project} check={check} />);
  await screen.findByText("body · run · run.fontSizePt");
  expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { check_id: "check-one" }, operation: "findings", verdict: "observed_difference", offset: 0, limit: 20,
  });
  fireEvent.click(screen.getAllByRole("button", { name: text.next })[0]);
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", expect.objectContaining({ operation: "findings", offset: 20 })));
  fireEvent.click(screen.getByRole("button", { name: text.readObject }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { project_id: "paper", baseline_id: "checked-baseline" }, operation: "nodes",
    part: "/word/document.xml", path: [0, 1, 2], offset: 0, limit: 20,
  }));
  fireEvent.click(screen.getByRole("button", { name: text.readExpected }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { world_version_id: "template-v1" }, operation: "nodes", part: "/word/document.xml", path: [0, 2, 1], offset: 0, limit: 20,
  }));
  fireEvent.change(screen.getByRole("combobox", { name: text.filter }), { target: { value: "cannot_determine" } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", expect.objectContaining({ verdict: "cannot_determine", offset: 0 })));
});

it("keeps snapshot reads bounded and sends no pagination fields for exact raw part reads", async () => {
  const view = render(<JournalTemplatePanel world={world} project={project} check={null} />);
  const section = within(view.getByTestId("journal-template-facts"));
  fireEvent.click(section.getByText(text.inspect));
  fireEvent.click(section.getByRole("button", { name: text.read }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { world_version_id: "template-v1" }, operation: "snapshot", offset: 0, limit: 20,
  }));
  fireEvent.change(section.getByRole("combobox", { name: text.operation }), { target: { value: "part" } });
  fireEvent.click(section.getByRole("button", { name: text.read }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/docx-query", {
    target: { world_version_id: "template-v1" }, operation: "part", part: "/word/document.xml",
  }));
});

it.each(["world", "project", "check"] as const)("invalidates an in-flight XML read when the %s context changes", async (context) => {
  let finish!: (result: unknown) => void;
  api.request.mockImplementation((_path, input) => input.operation === "nodes"
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ findings: [finding], total: 1, next_offset: null }));
  const view = render(<JournalTemplatePanel world={world} project={project} check={check} />);
  fireEvent.click(await screen.findByRole("button", { name: text.readObject }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<JournalTemplatePanel
    world={context === "world" ? { ...world, version_id: "template-v2" } : world}
    project={context === "project" ? { ...project, baseline_id: "new-baseline" } : project}
    check={context === "check" ? { ...check, check_id: "check-two", baseline_id: "new-baseline" } : check}
  />);
  await act(async () => finish({ nodes: ["OLD_CONTEXT_XML"], total: 21, next_offset: 20 }));
  expect(screen.queryByText(/OLD_CONTEXT_XML/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: text.read })).toBeEnabled();
});

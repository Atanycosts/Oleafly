// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalCheck, JournalFragment, JournalObjectReference, JournalRule, JournalWorld } from "@/lib/journal-workbench";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useFilesStore } from "@/store/files";

const api = vi.hoisted(() => ({ request: vi.fn(), workspace: vi.fn(), connect: vi.fn(), target: vi.fn(), references: [] as JournalObjectReference[] }));
vi.mock("@/lib/journal-workbench", async (original) => ({
  ...await original<typeof import("@/lib/journal-workbench")>(), journalRequest: api.request,
  connectJournalWorkbench: api.connect, loadJournalTarget: api.target,
}));
vi.mock("@/lib/research-workspace", () => ({ getResearchWorkspace: api.workspace }));
vi.mock("./JournalResearchPanel", () => ({ JournalResearchPanel: () => null }));
vi.mock("./JournalAnnotations", () => ({ JournalAnnotations: ({ reference }: { reference: JournalObjectReference }) => {
  api.references.push(reference); return <div data-testid="journal-object-entry">{reference.kind}:{reference.worldVersionId}:{reference.objectId}</div>;
} }));
import { JournalChecksPanel } from "./JournalChecksPanel";

const text = en.journal;
const rule: JournalRule = { rule_id: "columns-rule", property: "columns", expected: 2, unit: "count", basis_status: "candidate", scope: { article_type: "research_article", stage: "initial", language: "en", section_scope: "all" }, evidence: [{ source_id: "guide", locator: "guide:line:1", quote: "Use two columns" }], limitations: [], confirmation_method: "provided_source" };
const world: JournalWorld = { version_id: "world-current", journal_id: "journal", journal_name: "Example Journal", version_ordinal: 2, created_at: "2026-11-09T00:00:00Z", scope: rule.scope, sources: [{ source_id: "guide", kind: "guide_text", name: "Author guide" }], rules: [rule], coverage_gaps: [], limitations: [] };
const fragment: JournalFragment = { fragment_id: "guide-fragment", source_id: "guide", kind: "text_block", locator: "guide:line:1", parent_fragment_id: null, text: "Use two columns", content: {} };
const checked = (version: string, id: string): JournalCheck => ({ check_id: id, project_id: "manuscript", baseline_id: "baseline", world_version_id: version, world: { ...world, version_id: version, version_ordinal: version === "world-old" ? 1 : 2 }, created_at: "2026-11-09T00:00:00Z", validity: "CURRENT", stale_reasons: [], update_available: true, summary: { compliant: 0, violation: 0, observed_match: 1, observed_difference: 0, cannot_determine: 0, not_checked: 0 }, rule_results: [], dispositions: [], coverage_gaps: [], limitations: [] });

beforeEach(() => {
  vi.clearAllMocks(); api.references.length = 0;
  useFilesStore.setState({ projectId: "paper" });
  api.workspace.mockResolvedValue({ journalProjectId: "manuscript" });
  api.connect.mockResolvedValue({ python: "/python", libraryRoot: "/retained/library" });
  api.request.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") return { worlds: [world, { ...world, version_id: "world-old", version_ordinal: 1 }], projects: [{ project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline", binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" }, latest_check: checked("world-current", "check-current") }] };
    if (url.pathname === "/api/world") return { ...world, version_id: url.searchParams.get("version_id"), version_ordinal: url.searchParams.get("version_id") === "world-old" ? 1 : 2 };
    if (url.pathname === "/api/history") return { checks: [checked("world-old", "check-old"), checked("world-current", "check-current")] };
    if (url.pathname === "/api/review") return { world_version_id: url.searchParams.get("version_id"), fragments: [fragment], rule_links: [{ rule_id: rule.rule_id, evidence_index: 0, fragment_ids: [fragment.fragment_id], link_status: "linked" }] };
    throw new Error(`Unexpected request ${path}`);
  });
});

it("anchors a historical check entry to its original library, manuscript and world", async () => {
  render(<JournalChecksPanel />);
  await screen.findByRole("button", { name: text.runCheck });
  fireEvent.click(screen.getByRole("button", { name: /Example Journal · v1/ }));
  await waitFor(() => expect(screen.getByTestId("journal-object-entry")).toHaveTextContent("check:world-old:check-old"));
  expect(api.references.at(-1)).toEqual({ libraryRoot: "/retained/library", workbenchProjectId: "manuscript", kind: "check", objectId: "check-old", worldVersionId: "world-old", checkId: "check-old" });
});

it("offers rule and retained source fragment discussion inside the existing evidence dialog", async () => {
  render(<JournalChecksPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByTestId("journal-object-entry")).toHaveTextContent("rule:world-current:columns-rule"));
  fireEvent.click(within(dialog).getByRole("button", { name: /Open source fragment/ }));
  await waitFor(() => expect(within(dialog).getAllByTestId("journal-object-entry").some((node) => node.textContent === "source:world-current:guide-fragment")).toBe(true));
  expect(api.references).toContainEqual({ libraryRoot: "/retained/library", workbenchProjectId: "manuscript", kind: "source", objectId: "guide-fragment", worldVersionId: "world-current", checkId: "check-current" });
});

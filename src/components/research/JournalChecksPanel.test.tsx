// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalAnnotationObject, JournalCheck, JournalDiff, JournalFragment, JournalObjectReference, JournalProject, JournalReview, JournalRule, JournalState, JournalWorld } from "@/lib/journal-workbench";
import type { AnnotationTarget } from "@/lib/task-collaboration";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };
import { useFilesStore } from "@/store/files";
import { useDocxWorkspaceStore } from "@/store/docx-workspace";
import { useResearchTasksStore } from "@/store/research-tasks";
import { useSettingsStore } from "@/store/settings";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  invoke: vi.fn(),
  workspace: vi.fn(),
  connect: vi.fn(),
  target: vi.fn(),
  templateImport: vi.fn(),
  templateCheck: vi.fn(),
  references: [] as JournalObjectReference[],
  openTargets: [] as Array<(target: AnnotationTarget) => void>,
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: api.invoke,
}));
vi.mock("@/lib/journal-workbench", async (original) => ({
  ...await original<typeof import("@/lib/journal-workbench")>(), journalRequest: api.request,
  connectJournalWorkbench: api.connect, loadJournalTarget: api.target,
}));
vi.mock("@/lib/research-workspace", () => ({ getResearchWorkspace: api.workspace }));
vi.mock("@/lib/docx-template-client", async (original) => ({
  ...await original<typeof import("@/lib/docx-template-client")>(),
  importJournalTemplate: api.templateImport,
  checkJournalTemplate: api.templateCheck,
}));
vi.mock("./JournalAnnotations", () => ({ JournalAnnotations: ({ reference, onOpenTarget }: {
  reference: JournalObjectReference;
  onOpenTarget?: (target: AnnotationTarget) => void;
}) => {
  api.references.push(reference);
  if (onOpenTarget) api.openTargets.push(onOpenTarget);
  return <div data-testid="journal-object-entry">{reference.kind}:{reference.worldVersionId}:{reference.objectId}</div>;
} }));
import { JournalChecksPanel, JournalWorkspaceHost } from "./JournalChecksPanel";

const text = en.journal;
const rule: JournalRule = { rule_id: "columns-rule", property: "columns", expected: 2, unit: "count", basis_status: "candidate", scope: { article_type: "research_article", stage: "initial", language: "en", section_scope: "all" }, evidence: [{ source_id: "guide", locator: "guide:line:1", quote: "Use two columns" }], limitations: [], confirmation_method: "provided_source" };
const world: JournalWorld = { version_id: "world-current", journal_id: "journal", journal_name: "Example Journal", version_ordinal: 2, created_at: "2026-11-09T00:00:00Z", scope: rule.scope, sources: [{ source_id: "guide", kind: "guide_text", name: "Author guide" }], rules: [rule], coverage_gaps: [], limitations: [] };
const fragment: JournalFragment = { fragment_id: "guide-fragment", source_id: "guide", kind: "text_block", locator: "guide:line:1", parent_fragment_id: null, text: "Use two columns", content: {} };
const checked = (version: string, id: string): JournalCheck => ({ check_id: id, project_id: "manuscript", baseline_id: "baseline", world_version_id: version, world: { ...world, version_id: version, version_ordinal: version === "world-old" ? 1 : 2 }, created_at: "2026-11-09T00:00:00Z", validity: "CURRENT", stale_reasons: [], update_available: true, summary: { compliant: 0, violation: 0, observed_match: 1, observed_difference: 0, cannot_determine: 0, not_checked: 0 }, rule_results: [], dispositions: [], coverage_gaps: [], limitations: [] });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function retainedSource(
  target: AnnotationTarget,
  sourceText: string,
  relatedTaskId = "task-related",
): JournalAnnotationObject {
  return {
    reference: {
      libraryRoot: "/retained/library",
      workbenchProjectId: "manuscript",
      kind: "source",
      objectId: "guide-fragment",
      worldVersionId: "world-current",
      checkId: "check-current",
    },
    target,
    source: {
      kind: "journal_object",
      content: JSON.stringify({ object: { ...fragment, text: sourceText } }),
    },
    relatedTasks: [{
      id: relatedTaskId,
      title: "Related handling task",
    } as JournalAnnotationObject["relatedTasks"][number]],
    continuationTaskId: null,
  };
}

function sourceTarget(suffix: string): AnnotationTarget {
  return {
    projectId: "paper",
    taskId: "task-related",
    objectKind: "journal_source",
    objectId: JSON.stringify({
      libraryRoot: "/retained/library",
      manuscriptId: "manuscript",
      id: suffix,
    }),
    objectRevision: "world-current",
    path: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks(); api.references.length = 0; api.openTargets.length = 0;
  api.target.mockReset();
  useFilesStore.setState({ projectId: "paper" });
  useDocxWorkspaceStore.getState().close();
  useDocxWorkspaceStore.setState({ savedVersion: 0 });
  useWorkspaceSurfaceStore.setState({
    active: "files",
    journalOpen: false,
    journalSidebarTarget: null,
    journalBusy: false,
  });
  useSettingsStore.setState({ railTab: "files", showTree: false });
  api.workspace.mockResolvedValue({
    journalProjectId: "manuscript",
    wordDocuments: [{ path: "manuscripts/paper.docx", workbenchProjectId: "manuscript" }],
  });
  api.connect.mockResolvedValue({ python: "/python", libraryRoot: "/retained/library" });
  api.invoke.mockResolvedValue({ journalProjectId: "template-draft" });
  api.templateImport.mockResolvedValue(world);
  api.templateCheck.mockResolvedValue(checked("world-current", "check-template"));
  api.request.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") return { worlds: [world, { ...world, version_id: "world-old", version_ordinal: 1 }], projects: [{ project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline", binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" }, latest_check: checked("world-current", "check-current") }] };
    if (url.pathname === "/api/world") return { ...world, version_id: url.searchParams.get("version_id"), version_ordinal: url.searchParams.get("version_id") === "world-old" ? 1 : 2 };
    if (url.pathname === "/api/history") return { checks: [checked("world-old", "check-old"), checked("world-current", "check-current")] };
    if (url.pathname === "/api/review") return { world_version_id: url.searchParams.get("version_id"), fragments: [fragment], rule_links: [{ rule_id: rule.rule_id, evidence_index: 0, fragment_ids: [fragment.fragment_id], link_status: "linked" }] };
    throw new Error(`Unexpected request ${path}`);
  });
});

function JournalWorkspaceHarness() {
  return (
    <>
      <JournalChecksPanel />
      <JournalWorkspaceHost />
    </>
  );
}

const sidebar = () => within(screen.getByTestId("journal-checks-panel"));

function templateWithoutManuscript() {
  const templateWorld: JournalWorld = { ...world, template: {
    source_id: "original-template", normalized_source_id: "normalized-template", snapshot_source_id: "template-facts",
    source_sha256: "a".repeat(64), original_sha256: "b".repeat(64), provenance: null,
  } };
  const draft: JournalProject = { project_id: "template-draft", name: "Example Journal draft", baseline_id: "template-baseline",
    binding: { binding_id: "template-binding", baseline_id: "template-baseline", world_version_id: templateWorld.version_id }, latest_check: null };
  const copies = new Map<string, JournalProject>();
  api.workspace.mockResolvedValue({ journalProjectId: null });
  api.request.mockImplementation(async (path: string, payload?: Record<string, unknown>) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") return { worlds: [templateWorld], projects: [...copies.values()] };
    if (url.pathname === "/api/world") return templateWorld;
    if (url.pathname === "/api/history") return { checks: [] };
    if (url.pathname === "/api/template-copy") {
      if (payload?.world_version_id !== templateWorld.version_id || typeof payload.request_id !== "string") throw new Error("Invalid template creation request");
      if (!copies.has(payload.request_id)) copies.set(payload.request_id, draft);
      return { project: copies.get(payload.request_id), origin: { request_id: payload.request_id,
        world_version_id: templateWorld.version_id, baseline_id: draft.baseline_id, source_sha256: templateWorld.template?.source_sha256 } };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  return { templateWorld, draft, copies };
}

async function chooseTemplateWorld(templateWorld: JournalWorld) {
  const select = await screen.findByTestId("journal-world-select");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: templateWorld.version_id } });
  await screen.findByTestId("journal-start-template");
}

it("puts the three setup steps in the sidebar and readable results in the center", async () => {
  render(<JournalWorkspaceHarness />);
  const panel = await screen.findByTestId("journal-checks-panel");
  expect(panel.parentElement).toBe(screen.getByTestId("journal-sidebar-content"));
  await waitFor(() => expect(panel).toHaveAttribute("aria-busy", "false"));
  expect(sidebar().getByText(text.steps.manuscript)).toBeInTheDocument();
  expect(sidebar().getByText(text.steps.template)).toBeInTheDocument();
  expect(sidebar().getByText(text.steps.check)).toBeInTheDocument();
  expect(sidebar().getByRole("button", { name: text.importTemplate })).toBeInTheDocument();
  expect(sidebar().getByRole("button", { name: text.runCheck })).toBeInTheDocument();
  expect(sidebar().queryByText(text.importCandidates)).not.toBeInTheDocument();
  expect(screen.queryByText("journal-research.json")).not.toBeInTheDocument();

  const workspace = screen.getByTestId("journal-workspace");
  expect(within(workspace).getByRole("heading", { name: "Example Journal" })).toBeInTheDocument();
  expect(within(workspace).getByLabelText(text.results)).toBeInTheDocument();
  expect(within(workspace).queryByRole("button", { name: text.runCheck })).not.toBeInTheDocument();
});

it("reopens the Journal rail from the center when the sidebar is not mounted", async () => {
  render(<JournalWorkspaceHost />);
  const workspace = screen.getByTestId("journal-workspace");
  const open = await within(workspace).findByRole("button", { name: text.workspace.openWorkspace });
  act(() => open.click());
  expect(useSettingsStore.getState()).toMatchObject({ railTab: "journal", showTree: true });
  expect(useWorkspaceSurfaceStore.getState()).toMatchObject({ active: "journal", journalOpen: true });
});

it("keeps the sidebar busy state while another surface is shown and releases it on unmount", async () => {
  const state = deferred<JournalState>();
  api.request.mockImplementation(async (path: string) => {
    if (path === "/api/state") return state.promise;
    throw new Error(`Unexpected request ${path}`);
  });
  const view = render(<JournalWorkspaceHarness />);
  const panel = await screen.findByTestId("journal-checks-panel");
  await waitFor(() => expect(panel).toHaveAttribute("aria-busy", "true"));

  act(() => useWorkspaceSurfaceStore.getState().showFiles());
  expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "true");

  view.unmount();
  expect(useWorkspaceSurfaceStore.getState().journalBusy).toBe(false);
  state.resolve({ worlds: [], projects: [] });
});

it("recovers from a failed Journal runtime connection with the entered Python path", async () => {
  api.connect.mockRejectedValueOnce(new Error("Journal runtime is unavailable"));
  render(<JournalWorkspaceHarness />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Journal runtime is unavailable");
  const runtime = screen.getByLabelText(text.python);
  expect(runtime).toHaveValue("");
  fireEvent.change(runtime, { target: { value: "/opt/oleafly/python" } });
  fireEvent.click(screen.getByRole("button", { name: text.connect }));

  expect(await screen.findByRole("heading", { name: "Example Journal" })).toBeInTheDocument();
  expect(api.connect).toHaveBeenLastCalledWith("/opt/oleafly/python");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(sidebar().getByRole("combobox", { name: text.manuscript })).toHaveValue("manuscript");
});

it("shows readable template comparison details in the center", async () => {
  const templateWorld: JournalWorld = { ...world, template: {
    source_id: "original-template",
    normalized_source_id: "normalized-template",
    snapshot_source_id: "template-facts",
    source_sha256: "a".repeat(64),
    original_sha256: "b".repeat(64),
    provenance: null,
  } };
  const templateCheck = {
    ...checked(templateWorld.version_id, "template-check"),
    template_comparison: {},
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/docx-query") {
      return {
        findings: [{
          case_id: "case-font",
          role: "body",
          property_path: "run.fontSizePt",
          observed: 10,
          expected: 12,
          verdict: "observed_difference",
        }],
        total: 1,
        next_offset: null,
      };
    }
    const response = await originalRequest(path, payload);
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      return {
        ...response,
        worlds: [templateWorld],
        projects: response.projects.map((project: JournalProject) => ({
          ...project,
          latest_check: templateCheck,
        })),
      };
    }
    if (url.pathname === "/api/world") return templateWorld;
    if (url.pathname === "/api/history") return { checks: [templateCheck] };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  const workspace = screen.getByTestId("journal-workspace");
  expect(await within(workspace).findByText("Manuscript: 10 pt")).toBeInTheDocument();
  expect(within(workspace).getByText("Template: 12 pt")).toBeInTheDocument();
  expect(within(workspace).queryByText("case-font")).not.toBeInTheDocument();
  expect(within(workspace).queryByText("run.fontSizePt")).not.toBeInTheDocument();
});

it("keeps an explicit manuscript binding without selecting another journal world", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (new URL(path, "http://workbench").pathname === "/api/state") {
      return {
        worlds: [{ ...world, version_id: "world-old", version_ordinal: 1 }, world],
        projects: [{
          project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline",
          binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
          latest_check: checked("world-current", "check-current"),
        }],
      };
    }
    return originalRequest(path, payload);
  });
  render(<JournalWorkspaceHarness />);
  await waitFor(() => expect(screen.getByTestId("journal-world-select")).toHaveValue("world-current"));
  expect(api.request).toHaveBeenCalledWith("/api/world?version_id=world-current");
});

it("leaves an unbound manuscript on the empty journal choice until the user selects a world", async () => {
  api.workspace.mockResolvedValue({ journalProjectId: null });
  render(<JournalWorkspaceHarness />);
  const select = await screen.findByTestId("journal-world-select");
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue("");
  expect(api.request.mock.calls.some(([path]) => String(path).startsWith("/api/world?"))).toBe(false);
  fireEvent.change(select, { target: { value: "world-old" } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/world?version_id=world-old"));
  expect(select).toHaveValue("world-old");
});

it("derives the template name and an internal journal ID when importing a Word template", async () => {
  api.workspace.mockResolvedValue({ journalProjectId: null });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await sidebar().findByRole("button", { name: text.importTemplate }));
  const dialog = await screen.findByRole("dialog");
  const template = new File(["template"], "springer-nature-template.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  fireEvent.change(within(dialog).getByLabelText(text.files), { target: { files: [template] } });
  const templateName = within(dialog).getByLabelText(text.templateName);
  expect(templateName).toHaveValue("springer-nature-template");
  fireEvent.change(templateName, { target: { value: "Springer Nature template" } });
  const advanced = within(dialog).getByText(text.submissionContext).closest("details");
  expect(advanced).not.toHaveAttribute("open");
  expect(within(dialog).queryByLabelText(text.journalId)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: text.importTemplate }));
  await waitFor(() => expect(api.templateImport).toHaveBeenCalledWith(
    template,
    {
      journal_id: expect.stringMatching(/^journal-/),
      journal_name: "Springer Nature template",
      article_type: "research_article",
      stage: "initial_submission",
      language: "en",
    },
  ));
});

it("starts from a selected template without a manuscript, links the new draft and opens its managed editor", async () => {
  const { templateWorld, draft } = templateWithoutManuscript();
  render(<JournalWorkspaceHarness />);
  await chooseTemplateWorld(templateWorld);
  const start = await screen.findByTestId("journal-start-template");
  await waitFor(() => expect(start).toBeEnabled());
  const workspace = screen.getByTestId("journal-workspace");
  expect(screen.getByTestId("journal-template-facts")).toHaveTextContent(text.template.title);
  expect(within(workspace).getByRole("button", { name: text.importManuscript })).toBeInTheDocument();
  expect(within(workspace).getByRole("button", { name: text.importTemplate })).toBeInTheDocument();
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  fireEvent.click(start);
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request).toMatchObject({
    appProjectId: "paper", project: draft, world: templateWorld,
  }));
  expect(api.request).toHaveBeenCalledWith("/api/template-copy", {
    world_version_id: templateWorld.version_id, name: `${templateWorld.journal_name} · ${text.templateDraft}`,
    request_id: expect.stringMatching(/^template-copy-/),
  });
  expect(api.invoke).toHaveBeenCalledWith("journal_workbench_link", { projectId: "paper", workbenchProjectId: draft.project_id });
  expect(api.request).toHaveBeenCalledWith(`/api/history?project_id=${draft.project_id}`);
  expect(start).toBeDisabled();
});

it("retries an interrupted link with the same template-copy request and recovers the single retained draft", async () => {
  const { templateWorld, draft, copies } = templateWithoutManuscript();
  api.invoke.mockRejectedValueOnce(new Error("Link temporarily unavailable"));
  render(<JournalWorkspaceHarness />);
  await chooseTemplateWorld(templateWorld);
  const start = await screen.findByTestId("journal-start-template");
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByText("Link temporarily unavailable");
  expect(copies.size).toBe(1);
  expect(useDocxWorkspaceStore.getState().request).toBeNull();
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.project).toEqual(draft));
  const creations = api.request.mock.calls.filter(([path]) => path === "/api/template-copy");
  expect(creations).toHaveLength(2);
  expect(creations[1][1]).toEqual(creations[0][1]);
  expect(copies.size).toBe(1);
  expect(api.invoke).toHaveBeenCalledTimes(2);
});

it("keeps an existing DOCX workspace and disables starting another template draft", async () => {
  const { templateWorld, draft } = templateWithoutManuscript();
  useDocxWorkspaceStore.getState().open({ appProjectId: "other-project", project: draft, world: null, onSaved: async () => {} });
  const existing = useDocxWorkspaceStore.getState().request;
  render(<JournalWorkspaceHarness />);
  await chooseTemplateWorld(templateWorld);
  const start = await screen.findByTestId("journal-start-template");
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(api.request.mock.calls.some(([path]) => path === "/api/template-copy")).toBe(false);
  expect(api.invoke).not.toHaveBeenCalled();
  expect(useDocxWorkspaceStore.getState().request).toBe(existing);
});

it("does not replace another open Word manuscript from the Journal sidebar", async () => {
  const other: JournalProject = {
    project_id: "other-manuscript",
    name: "Other manuscript",
    baseline_id: "other-baseline",
    binding: { binding_id: "other-binding", baseline_id: "other-baseline", world_version_id: "world-current" },
    latest_check: null,
  };
  const selected: JournalProject = {
    project_id: "selected-manuscript",
    name: "Selected manuscript",
    baseline_id: "selected-baseline",
    binding: { binding_id: "selected-binding", baseline_id: "selected-baseline", world_version_id: "world-current" },
    latest_check: checked("world-current", "selected-check"),
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const response = await originalRequest(path, payload);
    if (new URL(path, "http://workbench").pathname === "/api/state") {
      return { ...response, projects: [...response.projects, selected] };
    }
    return response;
  });
  useDocxWorkspaceStore.getState().open({
    appProjectId: "paper",
    project: other,
    world,
    onSaved: async () => {},
  });
  const existing = useDocxWorkspaceStore.getState().request;
  render(<JournalWorkspaceHarness />);
  fireEvent.change(await sidebar().findByRole("combobox", { name: text.manuscript }), {
    target: { value: selected.project_id },
  });
  const button = await sidebar().findByRole("button", { name: text.returnToOtherWorkingCopy });
  fireEvent.click(button);
  expect(useDocxWorkspaceStore.getState().request).toBe(existing);
  expect(sidebar().getByText(new RegExp(other.name))).toBeInTheDocument();
});

it("accepts guide documents but no JSON source in the journal import", async () => {
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await within(screen.getByTestId("journal-workspace")).findByRole("button", { name: text.importJournal }));
  const dialog = await screen.findByRole("dialog");
  const file = within(dialog).getByLabelText(text.files);
  expect(file).toHaveAttribute("accept", ".txt,.doc,.docx,.pdf");
  const guide = new File(["Guidance"], "author-guide.txt", { type: "text/plain" });
  fireEvent.change(file, { target: { files: [guide] } });
  fireEvent.click(within(dialog).getByText(text.sourceRoles));
  const roles = within(dialog).getByLabelText(`${text.sourceKind}: ${guide.name}`);
  expect(within(roles).queryByRole("option", { name: text.sourceKinds.rule_component_json })).not.toBeInTheDocument();
});

it("opens a retained working copy in the app host so leaving the rail keeps the request", async () => {
  const view = render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: en.docx.open }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request).toMatchObject({
    appProjectId: "paper", project: { project_id: "manuscript", baseline_id: "baseline" },
    world: { version_id: "world-current" }, sourcePath: "manuscripts/paper.docx",
  }));
  view.unmount();
  expect(useDocxWorkspaceStore.getState().request?.project.baseline_id).toBe("baseline");
  useDocxWorkspaceStore.getState().close();
});

it("uses the current workspace source mapping when opening a retained working copy", async () => {
  api.workspace
    .mockResolvedValueOnce({
      journalProjectId: "manuscript",
      wordDocuments: [{ path: "manuscripts/original.docx", workbenchProjectId: "manuscript" }],
    })
    .mockResolvedValueOnce({
      journalProjectId: "manuscript",
      wordDocuments: [{ path: "renamed/final-paper.docx", workbenchProjectId: "manuscript" }],
    });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: en.docx.open }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.sourcePath).toBe(
    "renamed/final-paper.docx",
  ));
  expect(api.workspace).toHaveBeenCalledTimes(2);
});

it("updates the open copy context when the rail selects another journal world", async () => {
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: en.docx.open }));
  await waitFor(() => expect(useDocxWorkspaceStore.getState().request?.world?.version_id).toBe("world-current"));
  const opened = useDocxWorkspaceStore.getState().request;
  const onSaved = useDocxWorkspaceStore.getState().context?.onSaved;
  fireEvent.change(screen.getByTestId("journal-world-select"), { target: { value: "world-old" } });
  await waitFor(() => expect(useDocxWorkspaceStore.getState().context?.world?.version_id).toBe("world-old"));
  expect(useDocxWorkspaceStore.getState().request).toBe(opened);
  expect(useDocxWorkspaceStore.getState().context?.onSaved).toBe(onSaved);
  expect(screen.getByTestId("journal-world-select")).toHaveValue("world-old");
});

it("shows a template body rule by its readable role", async () => {
  const bodyRule: JournalRule = {
    ...rule,
    rule_id: "body-format-rule",
    property: "object_format",
    label: "body (paragraph)",
    expected: { kind: "paragraph", role: "body" },
    unit: "effective_format",
    basis_status: "confirmed",
  };
  const objectWorld = { ...world, rules: [bodyRule] };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      return {
        ...await originalRequest(path, payload),
        worlds: [objectWorld],
      };
    }
    if (url.pathname === "/api/world") return objectWorld;
    return originalRequest(path, payload);
  });

  render(<JournalWorkspaceHarness />);
  const workspace = screen.getByTestId("journal-workspace");
  const button = await within(workspace).findByRole("button", { name: /Body text/ });
  expect(within(workspace).queryByText("body (paragraph)")).not.toBeInTheDocument();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Body text")).toBeInTheDocument();
  expect(within(dialog).queryByText("body (paragraph)")).not.toBeInTheDocument();
});

it("shows section template rules as effective formatting", async () => {
  const sectionRule: JournalRule = {
    ...rule,
    rule_id: "section-format-rule",
    property: "object_format",
    label: "unknown (section)",
    expected: { kind: "section", role: "unknown" },
    unit: "effective_format",
    basis_status: "confirmed",
  };
  const objectWorld = { ...world, rules: [sectionRule] };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      return {
        ...await originalRequest(path, payload),
        worlds: [objectWorld],
      };
    }
    if (url.pathname === "/api/world") return objectWorld;
    return originalRequest(path, payload);
  });

  render(<JournalWorkspaceHarness />);
  const workspace = screen.getByTestId("journal-workspace");
  const button = await within(workspace).findByRole("button", { name: /Effective formatting/ });
  expect(within(workspace).queryByText("unknown (section)")).not.toBeInTheDocument();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Effective formatting")).toBeInTheDocument();
  expect(within(dialog).queryByText("unknown (section)")).not.toBeInTheDocument();
});

it("follows a Word document opened from the file tree in the same app project", async () => {
  const second: JournalProject = {
    project_id: "second-manuscript",
    name: "Second manuscript",
    baseline_id: "second-baseline",
    binding: { binding_id: "second-binding", baseline_id: "second-baseline", world_version_id: "world-old" },
    latest_check: null,
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      return {
        worlds: [world, { ...world, version_id: "world-old", version_ordinal: 1 }],
        projects: [{
          project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline",
          binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
          latest_check: checked("world-current", "check-current"),
        }, second],
      };
    }
    if (url.pathname === "/api/history") return { checks: [] };
    return originalRequest(path, payload);
  });
  render(<JournalWorkspaceHarness />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: text.manuscript })).toHaveValue("manuscript"));
  act(() => {
    useDocxWorkspaceStore.getState().open({
      appProjectId: "paper", project: second, world: { ...world, version_id: "world-old", version_ordinal: 1 },
      onSaved: async () => {},
    });
  });
  await waitFor(() => expect(screen.getByRole("combobox", { name: text.manuscript })).toHaveValue("second-manuscript"));
  expect(screen.getByTestId("journal-world-select")).toHaveValue("world-old");
  expect(api.request).toHaveBeenCalledWith("/api/history?project_id=second-manuscript");
});

it("keeps a newer file-tree load in control when the initial load finishes late", async () => {
  const second: JournalProject = {
    project_id: "second-manuscript",
    name: "Second manuscript",
    baseline_id: "second-baseline",
    binding: { binding_id: "second-binding", baseline_id: "second-baseline", world_version_id: "world-old" },
    latest_check: null,
  };
  const manuscript: JournalProject = {
    project_id: "manuscript",
    name: "Retained manuscript",
    baseline_id: "baseline",
    binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
    latest_check: checked("world-current", "check-current"),
  };
  const worlds = [world, { ...world, version_id: "world-old", version_ordinal: 1 }];
  const initialState = deferred<JournalState>();
  const secondWorld = deferred<JournalWorld>();
  let stateReads = 0;
  api.request.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      stateReads += 1;
      if (stateReads === 1) return initialState.promise;
      return { worlds, projects: [manuscript, second] };
    }
    if (url.pathname === "/api/world") {
      if (url.searchParams.get("version_id") === "world-old") return secondWorld.promise;
      return world;
    }
    if (url.pathname === "/api/history") return { checks: [] };
    throw new Error(`Unexpected request ${path}`);
  });

  render(<JournalWorkspaceHarness />);
  await waitFor(() => expect(stateReads).toBe(1));
  act(() => {
    useDocxWorkspaceStore.getState().open({
      appProjectId: "paper",
      project: second,
      world: worlds[1],
      onSaved: async () => {},
    });
  });
  await waitFor(() => expect(stateReads).toBe(2));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/world?version_id=world-old"));

  await act(async () => {
    initialState.resolve({ worlds, projects: [manuscript] });
    await Promise.resolve();
  });

  expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "true");
  expect(api.request).not.toHaveBeenCalledWith("/api/world?version_id=world-current");
  expect(useDocxWorkspaceStore.getState().request?.project.project_id).toBe("second-manuscript");

  await act(async () => {
    secondWorld.resolve(worlds[1]);
  });
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: text.manuscript })).toHaveValue("second-manuscript");
  });
  expect(screen.getByTestId("journal-world-select")).toHaveValue("world-old");
  expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "false");
});

it("keeps an explicitly selected journal world when opening an unbound manuscript", async () => {
  const second: JournalProject = {
    project_id: "second-manuscript",
    name: "Second manuscript",
    baseline_id: "second-baseline",
    binding: null,
    latest_check: null,
  };
  const templateWorld: JournalWorld = {
    ...world,
    version_id: "world-old",
    version_ordinal: 1,
    template: {
      source_id: "template-source",
      normalized_source_id: "normalized-template",
      snapshot_source_id: "template-facts",
      source_sha256: "a".repeat(64),
      original_sha256: "b".repeat(64),
      provenance: null,
    },
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/state") {
      return {
        worlds: [world, templateWorld],
        projects: [{
          project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline",
          binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
          latest_check: checked("world-current", "check-current"),
        }, second],
      };
    }
    if (url.pathname === "/api/world" && url.searchParams.get("version_id") === templateWorld.version_id) {
      return templateWorld;
    }
    return originalRequest(path, payload);
  });

  render(<JournalWorkspaceHarness />);
  const worldSelect = await screen.findByTestId("journal-world-select");
  await waitFor(() => expect(worldSelect).toHaveValue("world-current"));
  fireEvent.change(worldSelect, { target: { value: "world-old" } });
  await waitFor(() => expect(worldSelect).toHaveValue("world-old"));
  await waitFor(() => expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "false"));

  fireEvent.change(screen.getByRole("combobox", { name: text.manuscript }), {
    target: { value: "second-manuscript" },
  });

  await waitFor(() => expect(screen.getByRole("combobox", { name: text.manuscript })).toHaveValue(
    "second-manuscript",
  ));
  expect(worldSelect).toHaveValue("world-old");
  expect(screen.getByRole("button", { name: text.runCheck })).toBeEnabled();
});

it("starts on an already-open file tree manuscript without loading the workspace selection twice", async () => {
  const second: JournalProject = {
    project_id: "second-manuscript",
    name: "Second manuscript",
    baseline_id: "second-baseline",
    binding: { binding_id: "second-binding", baseline_id: "second-baseline", world_version_id: "world-old" },
    latest_check: null,
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (new URL(path, "http://workbench").pathname === "/api/state") {
      return {
        worlds: [world, { ...world, version_id: "world-old", version_ordinal: 1 }],
        projects: [{
          project_id: "manuscript", name: "Retained manuscript", baseline_id: "baseline",
          binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
          latest_check: checked("world-current", "check-current"),
        }, second],
      };
    }
    return originalRequest(path, payload);
  });
  useDocxWorkspaceStore.getState().open({
    appProjectId: "paper",
    project: second,
    world: { ...world, version_id: "world-old", version_ordinal: 1 },
    sourcePath: "manuscripts/second.docx",
    onSaved: async () => {},
  });
  render(<JournalWorkspaceHarness />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: text.manuscript })).toHaveValue("second-manuscript"));
  expect(screen.getByTestId("journal-world-select")).toHaveValue("world-old");
  expect(api.request.mock.calls.filter(([path]) => path === "/api/state")).toHaveLength(1);
});

it("refreshes the selected manuscript after a working copy save without another initial load", async () => {
  render(<JournalWorkspaceHarness />);
  await screen.findByRole("button", { name: text.runCheck });
  const stateReads = () => api.request.mock.calls.filter(([path]) => path === "/api/state").length;
  expect(stateReads()).toBe(1);
  act(() => {
    useDocxWorkspaceStore.getState().open({
      appProjectId: "paper",
      project: {
        project_id: "manuscript",
        name: "Retained manuscript",
        baseline_id: "baseline",
        binding: { binding_id: "binding", baseline_id: "baseline", world_version_id: "world-current" },
        latest_check: checked("world-current", "check-current"),
      },
      world,
      sourcePath: "manuscripts/paper.docx",
      onSaved: async () => {},
    });
  });
  await waitFor(() => expect(useDocxWorkspaceStore.getState().context?.onSaved).toBeTypeOf("function"));
  act(() => {
    useDocxWorkspaceStore.getState().saved();
  });
  await waitFor(() => expect(stateReads()).toBe(2));
  expect(api.request).toHaveBeenCalledWith("/api/world?version_id=world-current");
});

it("keeps a pending journal world choice when the current working copy saves", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  const pendingChoice = deferred<JournalWorld>();
  let currentWorldReads = 0;
  let oldWorldReads = 0;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/world") {
      const versionId = url.searchParams.get("version_id");
      if (versionId === "world-current") currentWorldReads += 1;
      if (versionId === "world-old") {
        oldWorldReads += 1;
        if (oldWorldReads === 1) return pendingChoice.promise;
      }
    }
    return originalRequest(path, payload);
  });

  render(<JournalWorkspaceHarness />);
  const select = await screen.findByTestId("journal-world-select");
  await waitFor(() => expect(select).toHaveValue("world-current"));
  fireEvent.change(select, { target: { value: "world-old" } });
  await waitFor(() => expect(oldWorldReads).toBe(1));

  act(() => {
    useDocxWorkspaceStore.getState().saved();
  });
  await waitFor(() => expect(currentWorldReads + oldWorldReads).toBe(3));
  await act(async () => {
    pendingChoice.resolve({ ...world, version_id: "world-old", version_ordinal: 1 });
  });

  await waitFor(() => expect(select).toHaveValue("world-old"));
});

it("anchors a historical check entry to its original library, manuscript and world", async () => {
  render(<JournalWorkspaceHarness />);
  await screen.findByRole("button", { name: text.runCheck });
  fireEvent.click(screen.getByRole("button", { name: /Example Journal · v1/ }));
  await waitFor(() => expect(screen.getByTestId("journal-object-entry")).toHaveTextContent("check:world-old:check-old"));
  expect(api.references.at(-1)).toEqual({ libraryRoot: "/retained/library", workbenchProjectId: "manuscript", kind: "check", objectId: "check-old", worldVersionId: "world-old", checkId: "check-old" });
});

it("keeps the newest retained journal object when an older lookup finishes late", async () => {
  const older = deferred<JournalAnnotationObject>();
  const olderTarget = sourceTarget("older-source");
  const newerTarget = sourceTarget("newer-source");
  api.target
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(retainedSource(newerTarget, "Newest retained instruction"));
  render(<JournalWorkspaceHarness />);
  await waitFor(() => expect(api.openTargets.length).toBeGreaterThan(0));
  const openTarget = api.openTargets[0];
  if (!openTarget) throw new Error("Expected a Journal annotation target handler");

  act(() => {
    openTarget(olderTarget);
    openTarget(newerTarget);
  });

  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("Newest retained instruction")).toBeInTheDocument();
  await act(async () => {
    older.resolve(retainedSource(olderTarget, "Stale retained instruction"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(within(dialog).getByText("Newest retained instruction")).toBeInTheDocument();
  expect(within(dialog).queryByText("Stale retained instruction")).not.toBeInTheDocument();
});

it("opens a retained journal object and navigates to its related work", async () => {
  const target = sourceTarget("related-source");
  api.target.mockResolvedValue(retainedSource(target, "Retained source for continuation"));
  const openTaskDetail = vi.spyOn(useResearchTasksStore.getState(), "openTaskDetail");
  try {
    render(<JournalWorkspaceHarness />);
    await waitFor(() => expect(api.openTargets.length).toBeGreaterThan(0));
    await waitFor(() => expect(useWorkspaceSurfaceStore.getState().active).toBe("journal"));
    const openTarget = api.openTargets[0];
    if (!openTarget) throw new Error("Expected a Journal annotation target handler");
    act(() => openTarget(target));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Retained source for continuation")).toBeInTheDocument();
    expect(api.target).toHaveBeenCalledWith(target);

    fireEvent.click(within(dialog).getByRole("button", { name: text.annotations.openTask }));

    expect(openTaskDetail).toHaveBeenCalledWith("task-related", "annotations");
    expect(useWorkspaceSurfaceStore.getState().active).toBe("files");
  } finally {
    openTaskDetail.mockRestore();
  }
});

it("offers rule and retained source fragment discussion inside the existing evidence dialog", async () => {
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByTestId("journal-object-entry")).toHaveTextContent("rule:world-current:columns-rule"));
  fireEvent.click(within(dialog).getByRole("button", { name: /Open source fragment/ }));
  await waitFor(() => expect(within(dialog).getAllByTestId("journal-object-entry").some((node) => node.textContent === "source:world-current:guide-fragment")).toBe(true));
  expect(api.references).toContainEqual({ libraryRoot: "/retained/library", workbenchProjectId: "manuscript", kind: "source", objectId: "guide-fragment", worldVersionId: "world-current", checkId: "check-current" });
});

it.each(["rule evidence", "source library", "version comparison", "historical check"] as const)(
  "does not reopen an old %s after the file tree opens another manuscript",
  async (operation) => {
    const secondWorld: JournalWorld = operation === "historical check"
      ? { ...world, version_id: "world-old", version_ordinal: 1 }
      : { ...world, version_id: "second-world", journal_id: "second-journal", journal_name: "Second journal", rules: [] };
    const second: JournalProject = {
      project_id: "second-manuscript", name: "Second manuscript", baseline_id: "second-baseline",
      binding: { binding_id: "second-binding", baseline_id: "second-baseline", world_version_id: secondWorld.version_id },
      latest_check: null,
    };
    const pending = deferred<JournalReview | JournalDiff | JournalWorld>();
    let historicalReadPending = false;
    const originalRequest = api.request.getMockImplementation();
    if (!originalRequest) throw new Error("Expected the journal request fixture");
    api.request.mockImplementation(async (path: string, payload?: unknown) => {
      const url = new URL(path, "http://workbench");
      if (url.pathname === "/api/review" && (operation === "rule evidence" || operation === "source library")) return pending.promise;
      if (url.pathname === "/api/diff" && operation === "version comparison") return pending.promise;
      if (url.pathname === "/api/world") {
        if (url.searchParams.get("version_id") === "world-old" && operation === "historical check" && !historicalReadPending) {
          historicalReadPending = true;
          return pending.promise;
        }
        if (url.searchParams.get("version_id") === secondWorld.version_id) return secondWorld;
      }
      if (url.pathname === "/api/history" && url.searchParams.get("project_id") === second.project_id) return { checks: [] };
      const response = await originalRequest(path, payload);
      if (url.pathname === "/api/state") return { ...response, projects: [...response.projects, second], worlds: [...response.worlds.filter((item: JournalWorld) => item.version_id !== secondWorld.version_id), secondWorld] };
      return response;
    });
    render(<JournalWorkspaceHarness />);
    const button = operation === "rule evidence"
      ? await screen.findByRole("button", { name: /Columns.*2/ })
      : await screen.findByRole("button", { name: operation === "source library" ? text.sourceLibrary : operation === "version comparison" ? text.compareVersions : /Example Journal · v1/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "true"));

    act(() => useDocxWorkspaceStore.getState().open({ appProjectId: "paper", project: second, world: secondWorld, onSaved: async () => {} }));
    await screen.findByRole("heading", { name: secondWorld.journal_name });
    await waitFor(() => expect(sidebar().getByRole("combobox", { name: text.manuscript })).toHaveValue(second.project_id));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(operation === "rule evidence" || operation === "source library"
        ? { world_version_id: world.version_id, fragments: [fragment], rule_links: [] }
        : operation === "version comparison"
          ? { scope_changed: true, journal_changed: false, changes: [] }
          : { ...world, version_id: "world-old", version_ordinal: 1 });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: secondWorld.journal_name })).toBeInTheDocument();
    expect(sidebar().getByRole("combobox", { name: text.manuscript })).toHaveValue(second.project_id);
    expect(screen.getByTestId("journal-world-select")).toHaveValue(secondWorld.version_id);
    expect(screen.queryByRole("region", { name: text.results })).not.toBeInTheDocument();
    expect(api.references.filter((reference) => reference.workbenchProjectId === second.project_id)).not.toContainEqual(
      expect.objectContaining({ objectId: rule.rule_id }),
    );
  },
);

it.each(["source page", "section contents", "section index", "handling note", "retained object"] as const)(
  "discards a late %s after the file tree opens another manuscript",
  async (operation) => {
    const pending = deferred<unknown>();
    const secondWorld: JournalWorld = { ...world, version_id: "second-world", journal_id: "second-journal", journal_name: "Second journal" };
    const secondCheck: JournalCheck = { ...checked(secondWorld.version_id, "second-check"), project_id: "second-manuscript", baseline_id: "second-baseline", world: secondWorld };
    const second: JournalProject = { project_id: "second-manuscript", name: "Second manuscript", baseline_id: "second-baseline",
      binding: { binding_id: "second-binding", baseline_id: "second-baseline", world_version_id: secondWorld.version_id }, latest_check: secondCheck };
    const findingCheck: JournalCheck = { ...checked(world.version_id, "check-current"), rule_results: [{
      rule_id: rule.rule_id, property: rule.property, basis_status: "candidate", verdict: "observed_difference", applicability: "APPLICABLE", limitations: [],
      findings: [{ section_index: 1, locator: "section:one", observed: 1, expected: 2, verdict: "observed_difference", message: "Columns differ" }],
    }] };
    const originalRequest = api.request.getMockImplementation();
    if (!originalRequest) throw new Error("Expected the journal request fixture");
    api.request.mockImplementation(async (path: string, payload?: unknown) => {
      const url = new URL(path, "http://workbench");
      if (url.pathname === "/api/world" && url.searchParams.get("version_id") === secondWorld.version_id) return secondWorld;
      if (url.pathname === "/api/history" && url.searchParams.get("project_id") === second.project_id) return { checks: [secondCheck] };
      if (url.pathname === "/api/review") {
        const current = url.searchParams.get("version_id") === secondWorld.version_id;
        return { world_version_id: current ? secondWorld.version_id : world.version_id,
          fragments: [{ ...fragment, kind: current ? "text_block" : "pdf_block", text: current ? "Second manuscript source" : "First manuscript source", content: current ? {} : { page: 3 } }],
          rule_links: [{ rule_id: rule.rule_id, fragment_ids: [fragment.fragment_id] }] };
      }
      if (url.pathname === "/api/source-page") return pending.promise;
      if (url.pathname === "/api/manuscript") return operation === "section index" ? pending.promise : { catalog: { items: [{ object_id: "section-object", object_type: "section", node_locator: "section:one" }] } };
      if (url.pathname === "/api/read") return operation === "section index"
        ? { items: [{ object_id: "section-object", content: { declared_values: { columns: 99 } } }] }
        : pending.promise;
      if (url.pathname === "/api/disposition") return {};
      if (url.pathname === "/api/check") return pending.promise;
      const response = await originalRequest(path, payload);
      if (url.pathname === "/api/state") return { ...response, projects: [{ ...response.projects[0], latest_check: findingCheck }, second], worlds: [...response.worlds, secondWorld] };
      return response;
    });
    api.target.mockReturnValueOnce(pending.promise);
    render(<JournalWorkspaceHarness />);
    if (operation === "retained object") {
      await waitFor(() => expect(api.openTargets.length).toBeGreaterThan(0));
      const openTarget = api.openTargets[0];
      if (!openTarget) throw new Error("Expected a retained Journal target handler");
      act(() => openTarget(sourceTarget("first-source")));
    } else {
      fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
      const dialog = await screen.findByRole("dialog");
      if (operation === "source page") fireEvent.click(within(dialog).getByRole("button", { name: /Open source fragment/ }));
      else if (operation === "handling note") {
        fireEvent.change(within(dialog).getByRole("textbox", { name: text.handlingNote }), { target: { value: "First manuscript note" } });
        fireEvent.click(within(dialog).getByRole("button", { name: text.saveHandling }));
        await waitFor(() => expect(api.request.mock.calls.some(([path]) => String(path).startsWith("/api/check?"))).toBe(true));
      } else fireEvent.click(within(dialog).getByRole("button", { name: text.readSection }));
    }
    await waitFor(() => expect(screen.getByTestId("journal-checks-panel")).toHaveAttribute("aria-busy", "true"));
    act(() => useDocxWorkspaceStore.getState().open({ appProjectId: "paper", project: second, world: secondWorld, onSaved: async () => {} }));
    await screen.findByRole("heading", { name: secondWorld.journal_name });
    await waitFor(() => expect(sidebar().getByRole("combobox", { name: text.manuscript })).toHaveValue(second.project_id));
    fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
    const currentDialog = await screen.findByRole("dialog");
    fireEvent.click(within(currentDialog).getByRole("button", { name: /Open source fragment/ }));
    expect(await within(currentDialog).findByText("Second manuscript source")).toBeInTheDocument();
    const oldTarget = sourceTarget("first-source");
    await act(async () => pending.resolve(operation === "source page"
      ? { png_base64: "c3RhbGU=", width_pt: 200, height_pt: 400 }
      : operation === "section index"
        ? { catalog: { items: [{ object_id: "section-object", object_type: "section", node_locator: "section:one" }] } }
        : operation === "section contents"
          ? { items: [{ object_id: "section-object", content: { declared_values: { columns: 99 } } }] }
          : operation === "handling note" ? findingCheck : retainedSource(oldTarget, "First manuscript object")));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(currentDialog).queryByRole("img", { name: text.sourcePage })).not.toBeInTheDocument();
    expect(within(currentDialog).queryByText(text.retainedSection)).not.toBeInTheDocument();
    expect(screen.queryByText("First manuscript object")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: text.results, hidden: true })).toBeInTheDocument();
    expect(api.references).toContainEqual(expect.objectContaining({ workbenchProjectId: second.project_id, objectId: secondCheck.check_id }));
    if (operation === "section index") expect(api.request.mock.calls.some(([path]) => path === "/api/read")).toBe(false);
  },
);

it("compares the selected journal versions and keeps each requirement's original evidence", async () => {
  const before: JournalRule = { ...rule, expected: 1, basis_status: "confirmed", evidence: [{ source_id: "guide", locator: "guide:line:1", quote: "Use one column in the initial manuscript" }] };
  const after: JournalRule = { ...rule, resolution: { reason: "Confirmed the updated guide", previous_expected: 1, previous_basis_status: "confirmed" } };
  const diff: JournalDiff = { scope_changed: true, journal_changed: false, changes: [{ property: rule.property, before, after, status: "changed" }] };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => new URL(path, "http://workbench").pathname === "/api/diff" ? diff : originalRequest(path, payload));
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: text.compareVersions }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox", { name: text.compareFrom })).toHaveValue("world-old");
  expect(api.request).toHaveBeenCalledWith("/api/diff?from_version=world-old&to_version=world-current");
  expect(within(dialog).getByText(text.scopeChanged)).toBeInTheDocument();
  expect(within(dialog).getByRole("heading", { name: `${text.properties.columns} · ${text.changes.changed}` })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByText(text.changeEvidence));
  expect(within(dialog).getByText(before.evidence[0].quote)).toBeVisible();
  expect(within(dialog).getByText(after.evidence[0].quote)).toBeVisible();
  expect(within(dialog).getByText(`${text.operatorDecision}: ${after.resolution?.reason}`)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("edits an exact font requirement as text and sends its name without numeric conversion", async () => {
  const fontRule: JournalRule = { ...rule, rule_id: "font-rule", property: "body_font_family", expected: "Times New Roman", unit: "font_family", basis_status: "candidate" };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/revise") return { ...world, version_id: "world-font", rules: [fontRule] };
    const response = await originalRequest(path, payload);
    if (new URL(path, "http://workbench").pathname === "/api/world") return { ...response, rules: [fontRule] };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: /Times New Roman/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByText(text.reviseRequirement));
  const input = within(dialog).getByDisplayValue("Times New Roman");
  expect(input).toHaveAttribute("type", "text");
  fireEvent.change(input, { target: { value: "PT Serif" } });
  fireEvent.change(within(dialog).getByLabelText(text.decisionReason), { target: { value: "Reviewed the journal guide" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.saveRevision }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/revise", { version_id: "world-current", rule_id: "font-rule", expected: "PT Serif", reason: "Reviewed the journal guide" }));
});

it.each([
  { property: "left_margin_twips", unit: "twips", initial: 1440, entered: "0", expected: 0, min: "0" },
  { property: "body_font_size_halfpoints", unit: "half_points", initial: 24, entered: "14.5", expected: 29, min: "0.01" },
  { property: "body_line_spacing_twips", unit: "spacing_twips", initial: 240, entered: "18", expected: 360, min: "0.01" },
] as const)("revises $property from its displayed physical unit without changing the source rule", async ({ property, unit, initial, entered, expected, min }) => {
  const numericRule: JournalRule = { ...rule, rule_id: "physical-rule", property, unit, expected: initial, basis_status: "confirmed" };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/revise") return { ...world, version_id: "world-revised" };
    const response = await originalRequest(path, payload);
    if (new URL(path, "http://workbench").pathname === "/api/world") return { ...response, rules: [numericRule] };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  const name = text.properties[property as keyof typeof text.properties];
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByText(text.reviseRequirement));
  const input = within(dialog).getByRole("spinbutton");
  expect(input).toHaveAttribute("min", min);
  fireEvent.change(input, { target: { value: entered } });
  fireEvent.change(within(dialog).getByLabelText(text.decisionReason), { target: { value: "Applied the reviewed physical layout requirement" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.saveRevision }));

  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/revise", {
    version_id: world.version_id, rule_id: numericRule.rule_id, expected,
    reason: "Applied the reviewed physical layout requirement",
  }));
  expect(numericRule.expected).toBe(initial);
  expect(numericRule.evidence).toEqual(rule.evidence);
});

it("explains an unchanged version comparison and closes it without revising a requirement", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (new URL(path, "http://workbench").pathname === "/api/diff") {
      return { scope_changed: false, journal_changed: false, changes: [{ property: rule.property, before: rule, after: rule, status: "unchanged" }] } satisfies JournalDiff;
    }
    return originalRequest(path, payload);
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: text.compareVersions }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(text.noRuleChanges)).toBeInTheDocument();
  expect(within(dialog).queryByText(text.scopeChanged)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.request.mock.calls.some(([path]) => path === "/api/revise")).toBe(false);
  expect(screen.getByTestId("journal-world-select")).toHaveValue(world.version_id);
});

function capturedFile(name: string, content: string) {
  const file = new File([content], name);
  file.arrayBuffer = async () => new TextEncoder().encode(content).buffer;
  return file;
}

it("imports a manuscript's chosen bytes and links the returned retained project", async () => {
  const imported: JournalProject = { project_id: "imported-paper", name: "Revised paper", baseline_id: "imported-baseline", binding: null, latest_check: null };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let created = false;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/projects") { created = true; return imported; }
    const response = await originalRequest(path, payload);
    if (path === "/api/state" && created) return { ...response, projects: [...response.projects, imported] };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await sidebar().findByRole("button", { name: text.importManuscript }));
  const dialog = await screen.findByRole("dialog");
  const file = capturedFile("paper.docx", "retained manuscript bytes");
  fireEvent.change(within(dialog).getByLabelText(text.files), { target: { files: [file] } });
  expect(within(dialog).getByLabelText(text.displayName)).toHaveValue("paper");
  fireEvent.change(within(dialog).getByLabelText(text.displayName), { target: { value: imported.name } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.importManuscript }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.request).toHaveBeenCalledWith("/api/projects", { name: imported.name, filename: file.name, content_base64: btoa("retained manuscript bytes") });
  expect(api.invoke).toHaveBeenCalledWith("journal_workbench_link", { projectId: "paper", workbenchProjectId: imported.project_id });
  expect(sidebar().getByRole("combobox", { name: text.manuscript })).toHaveValue(imported.project_id);
});

it("updates a manuscript baseline with the selected file and operator reason", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let updated = false;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/baseline") { updated = true; return { baseline_id: "updated-baseline" }; }
    const response = await originalRequest(path, payload);
    if (path === "/api/state" && updated) return { ...response, projects: response.projects.map((project: JournalProject) => ({ ...project, baseline_id: "updated-baseline" })) };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await sidebar().findByRole("button", { name: text.updateManuscript }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByLabelText(text.displayName)).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText(text.files), { target: { files: [capturedFile("revision.docx", "new baseline bytes")] } });
  fireEvent.change(within(dialog).getByLabelText(text.updateReason), { target: { value: "Applied editor comments" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.updateManuscript }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.request).toHaveBeenCalledWith("/api/baseline", {
    project_id: "manuscript", expected_baseline_id: "baseline", filename: "revision.docx", content_base64: btoa("new baseline bytes"),
    reason: "Applied editor comments", request_id: expect.stringMatching(/^request-/),
  });
  expect(screen.getByText(text.rebindAfterUpdate)).toBeInTheDocument();
  expect(sidebar().getByRole("button", { name: text.runCheck })).toBeDisabled();
});

it("recovers from selecting two templates and imports the chosen template together with a guide source", async () => {
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await within(screen.getByTestId("journal-workspace")).findByRole("button", { name: text.importJournal }));
  const dialog = await screen.findByRole("dialog");
  const template = capturedFile("layout.doc", "template bytes");
  const guide = capturedFile("author-guide.docx", "guide bytes");
  fireEvent.change(within(dialog).getByLabelText(text.files), { target: { files: [template, guide] } });
  fireEvent.click(within(dialog).getByText(text.sourceRoles));
  const guideRole = within(dialog).getByLabelText(`${text.sourceKind}: ${guide.name}`);
  expect(within(dialog).getByLabelText(`${text.sourceKind}: ${template.name}`)).toHaveValue("template_docx");
  expect(guideRole).toHaveValue("guide_docx");
  fireEvent.change(guideRole, { target: { value: "template_docx" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.importJournal }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(text.template.oneTemplate);
  expect(api.templateImport).not.toHaveBeenCalled();
  fireEvent.change(guideRole, { target: { value: "guide_docx" } });
  fireEvent.click(within(dialog).getByText(text.submissionContext));
  fireEvent.change(within(dialog).getByLabelText(text.articleType), { target: { value: "review_article" } });
  fireEvent.change(within(dialog).getByLabelText(text.stage), { target: { value: "revision" } });
  fireEvent.change(within(dialog).getByLabelText(text.language), { target: { value: "zh" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.importJournal }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.templateImport).toHaveBeenCalledWith(template, {
    journal_id: expect.stringMatching(/^journal-/), journal_name: world.journal_name, article_type: "review_article", stage: "revision", language: "zh",
  }, [{ name: guide.name, kind: "guide_docx", content_base64: btoa("guide bytes") }]);
});

it("imports explicitly classified guide sources without treating a Word guide as the template", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.request.mockImplementation(async (path: string, payload?: unknown) => path === "/api/worlds" ? world : originalRequest(path, payload));
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await within(screen.getByTestId("journal-workspace")).findByRole("button", { name: text.importJournal }));
  const dialog = await screen.findByRole("dialog");
  const guide = capturedFile("author-guide.docx", "Word guide");
  const checklist = capturedFile("checklist.txt", "Submission checklist");
  fireEvent.change(within(dialog).getByLabelText(text.files), { target: { files: [guide, checklist] } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.importJournal }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.request).toHaveBeenCalledWith("/api/worlds", expect.objectContaining({ sources: [
    { name: guide.name, kind: "guide_docx", content_base64: btoa("Word guide") },
    { name: checklist.name, kind: "guide_text", content_base64: btoa("Submission checklist") },
  ] }));
  expect(api.templateImport).not.toHaveBeenCalled();
});

it("requires rebinding the selected world before running a non-template check", async () => {
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let bound = false;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/bind") { bound = true; return {}; }
    if (path === "/api/check") return checked("world-old", "rebound-check");
    const response = await originalRequest(path, payload);
    if (path === "/api/state" && bound) return { ...response, projects: response.projects.map((project: JournalProject) => ({ ...project,
      binding: { ...project.binding, world_version_id: "world-old" }, latest_check: checked("world-old", "rebound-check"),
    })) };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  const select = await screen.findByTestId("journal-world-select");
  await waitFor(() => expect(select).toHaveValue("world-current"));
  fireEvent.change(select, { target: { value: "world-old" } });
  await screen.findByText(text.viewingUnboundVersion);
  expect(sidebar().getByRole("button", { name: text.runCheck })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: text.bind }));
  await waitFor(() => expect(sidebar().getByRole("button", { name: text.runCheck })).toBeEnabled());
  expect(api.request).toHaveBeenCalledWith("/api/bind", { project_id: "manuscript", world_version_id: "world-old", expected_binding_id: "binding" });
  act(() => useWorkspaceSurfaceStore.getState().showFiles());
  fireEvent.click(sidebar().getByRole("button", { name: text.runCheck }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("/api/check", { project_id: "manuscript" }));
  await waitFor(() => expect(useWorkspaceSurfaceStore.getState().active).toBe("journal"));
  expect(api.templateCheck).not.toHaveBeenCalled();
});

it("uses the explicit template-check operation for the selected retained manuscript", async () => {
  const { templateWorld, draft } = templateWithoutManuscript();
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  api.workspace.mockResolvedValue({ journalProjectId: draft.project_id });
  api.request.mockImplementation(async (path: string, payload?: unknown) => path === "/api/state"
    ? { worlds: [templateWorld], projects: [draft] } : originalRequest(path, payload));
  render(<JournalWorkspaceHarness />);
  const run = await sidebar().findByRole("button", { name: text.runCheck });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() => expect(api.templateCheck).toHaveBeenCalledWith(draft, templateWorld.version_id));
  await waitFor(() => expect(run).toBeEnabled());
  expect(api.request.mock.calls.some(([path]) => path === "/api/check")).toBe(false);
});

it("shows a retained PDF source page and anchors its discussion to the selected fragment", async () => {
  const parent = { ...fragment, fragment_id: "guide-heading", kind: "pdf_heading", text: "Author requirements" };
  const pdf: JournalFragment = { ...fragment, kind: "pdf_block", parent_fragment_id: parent.fragment_id,
    content: { page: 3, bbox: [20, 40, 120, 80], title: "Layout and columns" } };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let pageReads = 0;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/review") return { world_version_id: world.version_id, fragments: [parent, pdf], rule_links: [{ rule_id: rule.rule_id, fragment_ids: [pdf.fragment_id] }] };
    if (url.pathname === "/api/source-page") {
      pageReads += 1;
      if (pageReads === 1) throw new Error("Source page renderer is temporarily busy");
      return { png_base64: "cGFnZQ==", width_pt: 200, height_pt: 400 };
    }
    return originalRequest(path, payload);
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(parent.text)).toBeInTheDocument();
  const open = within(dialog).getByRole("button", { name: /Open source fragment/ });
  fireEvent.click(open);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Source page renderer is temporarily busy");
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const image = await within(dialog).findByRole("img", { name: text.sourcePage });
  expect(image).toHaveAttribute("src", "data:image/png;base64,cGFnZQ==");
  expect(image.nextElementSibling).toHaveStyle({ left: "10%", top: "10%", width: "50%", height: "10%" });
  expect(within(dialog).getByText(`${text.declaredReference}: ${pdf.content.title}`)).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledWith("/api/source-page?version_id=world-current&source_id=guide&page=3");
  expect(api.references).toContainEqual({ libraryRoot: "/retained/library", workbenchProjectId: "manuscript", kind: "source", objectId: pdf.fragment_id,
    worldVersionId: world.version_id, checkId: "check-current" });
});

it("reads the check's retained baseline and saves a defer note without changing its finding", async () => {
  const findingCheck: JournalCheck = { ...checked("world-current", "check-current"), baseline_id: "checked-baseline", validity: "STALE",
    rule_results: [{ rule_id: rule.rule_id, property: rule.property, basis_status: "candidate", verdict: "observed_difference", applicability: "APPLICABLE", limitations: [],
      findings: [{ section_index: 1, locator: "section:one", observed: 1, expected: 2, verdict: "observed_difference", message: "Columns differ" }] }],
    dispositions: [{ rule_id: rule.rule_id, action: "note", note: "Existing review note", created_at: "2026-11-10T00:00:00Z" }],
  };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let savedNote = "";
  api.request.mockImplementation(async (path: string, payload?: Record<string, unknown>) => {
    const url = new URL(path, "http://workbench");
    if (url.pathname === "/api/manuscript") return { catalog: { items: [{ object_id: "section-object", object_type: "section", node_locator: "section:one" }] } };
    if (path === "/api/read") return { items: [{ object_id: "section-object", content: { declared_values: { columns: 1, body_font_size_halfpoints: 24, body_line_spacing_twips: 480, top_margin_twips: 1440 } } }] };
    if (path === "/api/disposition") { savedNote = String(payload?.note); return {}; }
    if (url.pathname === "/api/check") return { ...findingCheck, dispositions: [...findingCheck.dispositions, { rule_id: rule.rule_id, action: "defer", note: savedNote, created_at: "2026-11-17T00:00:00Z" }] };
    const response = await originalRequest(path, payload);
    if (path === "/api/state") return { ...response, projects: response.projects.map((project: JournalProject) => ({ ...project, latest_check: findingCheck })) };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: /Columns.*2/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(text.staleHelp)).toBeInTheDocument();
  expect(within(dialog).getByText("Existing review note")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: text.readSection }));
  await within(dialog).findByText(text.retainedSection);
  expect(api.request).toHaveBeenCalledWith("/api/manuscript?project_id=manuscript&baseline_id=checked-baseline");
  expect(api.request).toHaveBeenCalledWith("/api/read", { project_id: "manuscript", baseline_id: "checked-baseline", render_bundle_id: null,
    query: { region: null, object_type: "section", object_id: "section-object", page_number: null, page_size: 1, cursor: null } });
  expect(within(dialog).getByText("12 pt")).toBeInTheDocument();
  expect(within(dialog).getByText("24 pt")).toBeInTheDocument();
  expect(within(dialog).getByText("25.4 mm")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("combobox", { name: text.handlingAction }), { target: { value: "defer" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: text.handlingNote }), { target: { value: "Keep one column until final submission" } });
  fireEvent.click(within(dialog).getByRole("button", { name: text.saveHandling }));
  expect(await within(dialog).findByText("Keep one column until final submission")).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledWith("/api/disposition", { check_id: "check-current", rule_id: rule.rule_id, action: "defer", note: "Keep one column until final submission" });
  expect(within(dialog).getByRole("textbox", { name: text.handlingNote })).toHaveValue("");
  expect(within(dialog).getByText(/Section 1.*Observed 1.*Expected 2/)).toBeInTheDocument();
});

it("keeps an exact font edit after a failed revision and retries with the same name and reason", async () => {
  const fontRule: JournalRule = { ...rule, rule_id: "font-rule", property: "body_font_family", expected: "Times New Roman", unit: "font_family" };
  const originalRequest = api.request.getMockImplementation();
  if (!originalRequest) throw new Error("Expected the journal request fixture");
  let revisionCalls = 0;
  api.request.mockImplementation(async (path: string, payload?: unknown) => {
    if (path === "/api/revise") {
      revisionCalls += 1;
      if (revisionCalls === 1) throw new Error("Revision service is temporarily unavailable");
      return { ...world, version_id: "world-font-revised", rules: [fontRule] };
    }
    const response = await originalRequest(path, payload);
    if (new URL(path, "http://workbench").pathname === "/api/world") return { ...response, rules: [fontRule] };
    return response;
  });
  render(<JournalWorkspaceHarness />);
  fireEvent.click(await screen.findByRole("button", { name: /Times New Roman/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByText(text.reviseRequirement));
  const family = within(dialog).getByDisplayValue("Times New Roman");
  const reason = within(dialog).getByLabelText(text.decisionReason);
  const save = within(dialog).getByRole("button", { name: text.saveRevision });
  expect(save).toBeDisabled();
  fireEvent.change(family, { target: { value: "  Source Han Serif SC  " } });
  fireEvent.change(reason, { target: { value: "Use the exact family named by the journal" } });
  fireEvent.click(save);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Revision service is temporarily unavailable");
  expect(family).toHaveValue("  Source Han Serif SC  ");
  expect(reason).toHaveValue("Use the exact family named by the journal");
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.request.mock.calls.filter(([path]) => path === "/api/revise")).toEqual([
    ["/api/revise", { version_id: world.version_id, rule_id: fontRule.rule_id, expected: "Source Han Serif SC", reason: "Use the exact family named by the journal" }],
    ["/api/revise", { version_id: world.version_id, rule_id: fontRule.rule_id, expected: "Source Han Serif SC", reason: "Use the exact family named by the journal" }],
  ]);
  expect(screen.getAllByText(text.versionCreated).length).toBeGreaterThan(0);
});

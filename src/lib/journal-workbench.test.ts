import { beforeEach, expect, it, vi } from "vitest";
import type {
  AnnotationContext,
  AnnotationTarget,
  TaskAnnotation,
} from "@/lib/task-collaboration";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const collaboration = vi.hoisted(() => ({ loadObjectAnnotations: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));
vi.mock("@/lib/task-collaboration", async (original) => ({
  ...await original<typeof import("@/lib/task-collaboration")>(),
  loadObjectAnnotations: collaboration.loadObjectAnnotations,
}));

import {
  capturedJournalFile,
  connectJournalWorkbench,
  formatJournalValue,
  journalAnnotationSource,
  journalCoverageMessage,
  journalInputValue,
  journalMessage,
  journalQuery,
  journalRequest,
  JournalWorkbenchError,
  journalResearchPrompt,
  journalTargetReference,
  journalUnitScale,
  linkJournalProject,
  loadJournalAnnotationObject,
  loadJournalTarget,
  parseJournalInput,
  requestJournalAnnotation,
  saveJournalAnnotation,
  type JournalAnnotationObject,
  type JournalObjectReference,
  type JournalWorld,
} from "./journal-workbench";

const reference: JournalObjectReference = {
  libraryRoot: "/retained/library",
  workbenchProjectId: "manuscript",
  kind: "source",
  objectId: "guide-fragment",
  worldVersionId: "world-2",
  checkId: null,
};

const annotationTarget = (overrides: Partial<AnnotationTarget> = {}): AnnotationTarget => ({
  projectId: "paper",
  taskId: "task-related",
  objectKind: "journal_source",
  objectId: JSON.stringify({
    libraryRoot: "/retained/library",
    manuscriptId: "manuscript",
    id: "guide-fragment",
  }),
  objectRevision: "world-2",
  path: null,
  ...overrides,
});

const annotationContext = (annotations: TaskAnnotation[]): AnnotationContext => ({
  annotations,
  deliveries: [],
  requirements: [],
  handlings: [],
  distillations: [],
});

beforeEach(() => {
  native.invoke.mockReset();
  collaboration.loadObjectAnnotations.mockReset();
});

it("preserves an actionable template refusal received over IPC", async () => {
  const refusal = { error: "Recapture the retained template.", code: "template_source_unavailable",
    action: "recapture_template", retryable_with_same_params: false };
  native.invoke.mockRejectedValueOnce(refusal);
  const failure = await journalRequest("/api/template-prepare", {}).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JournalWorkbenchError);
  expect(failure).toMatchObject({ message: refusal.error, detail: refusal });
});

it("passes Journal identities and nullable request fields through the native boundary", async () => {
  const retained = { reference };
  native.invoke
    .mockResolvedValueOnce(retained)
    .mockResolvedValueOnce({ id: "annotation-2" })
    .mockResolvedValueOnce({ python: "/python", libraryRoot: "/retained/library" })
    .mockResolvedValueOnce({ worlds: [] })
    .mockResolvedValueOnce({ journalProjectId: "manuscript" })
    .mockResolvedValueOnce({ id: "annotation-3" })
    .mockResolvedValueOnce({ python: "/selected/python", libraryRoot: "/retained/library" })
    .mockResolvedValueOnce({ version_id: "world-3" });

  await loadJournalAnnotationObject("paper", reference);
  await saveJournalAnnotation("paper", reference, "Exact source feedback", "annotation-parent");
  await connectJournalWorkbench();
  await journalRequest("/api/state");
  await linkJournalProject("paper", "manuscript");
  await saveJournalAnnotation(
    "paper",
    reference,
    "Please handle with the Journal reviewer",
    null,
    ["member-1", "member-2"],
  );
  await connectJournalWorkbench();
  await journalRequest("/api/worlds", { journal_id: "journal-3" });

  expect(native.invoke).toHaveBeenNthCalledWith(1, "journal_annotation_object", {
    projectId: "paper",
    reference,
    annotationId: null,
  });
  expect(native.invoke).toHaveBeenNthCalledWith(2, "journal_annotation_save", {
    projectId: "paper",
    reference,
    body: "Exact source feedback",
    parentId: "annotation-parent",
    mentions: [],
  });
  expect(native.invoke).toHaveBeenNthCalledWith(3, "journal_workbench_connect");
  expect(native.invoke).toHaveBeenNthCalledWith(4, "journal_workbench_request", {
    path: "/api/state",
    payload: null,
  });
  expect(native.invoke).toHaveBeenNthCalledWith(5, "journal_workbench_link", {
    projectId: "paper",
    workbenchProjectId: "manuscript",
  });
  expect(native.invoke).toHaveBeenNthCalledWith(6, "journal_annotation_save", {
    projectId: "paper",
    reference,
    body: "Please handle with the Journal reviewer",
    parentId: null,
    mentions: ["member-1", "member-2"],
  });
  expect(native.invoke).toHaveBeenNthCalledWith(7, "journal_workbench_connect");
  expect(native.invoke).toHaveBeenNthCalledWith(8, "journal_workbench_request", {
    path: "/api/worlds",
    payload: { journal_id: "journal-3" },
  });
});

it("normalizes a Journal annotation request's associated task", async () => {
  native.invoke.mockResolvedValue({
    annotation: { id: "annotation-1" },
    task: { id: "task-1", projectId: "paper", status: "running" },
    created: true,
    needsStart: false,
  });

  const result = await requestJournalAnnotation({
    projectId: "paper",
    reference,
    body: "Please handle this requirement",
    parentId: "annotation-parent",
    mentions: ["member-1"],
    taskId: "task-1",
    draft: null,
  });

  expect(result.task).toMatchObject({
    id: "task-1",
    projectId: "paper",
    status: "running",
    skillIds: [],
    dependencyIds: [],
    todos: [],
  });
});

it("rejects annotations without retained Journal source and parses retained source when present", () => {
  const withoutSource = {
    id: "annotation-without-source",
    target: annotationTarget(),
    source: null,
  } as TaskAnnotation;
  expect(() => journalAnnotationSource(withoutSource)).toThrow(
    "This annotation has no retained journal object.",
  );

  const withSource = {
    ...withoutSource,
    source: {
      kind: "journal_object",
      content: JSON.stringify({ reference, object: { text: "Retained guidance" } }),
      sha256: "a".repeat(64),
    },
  } satisfies TaskAnnotation;
  expect(journalAnnotationSource(withSource)).toEqual({
    reference,
    object: { text: "Retained guidance" },
  });
});

it("maps every supported Journal annotation target and rejects an unversioned or unknown object", () => {
  for (const [objectKind, expected] of [
    ["journal_rule", { kind: "rule", worldVersionId: "revision-2", checkId: null }],
    ["journal_source", { kind: "source", worldVersionId: "revision-2", checkId: null }],
    ["journal_check", { kind: "check", worldVersionId: "", checkId: "revision-2" }],
    ["journal_world", { kind: "world", worldVersionId: "revision-2", checkId: null }],
  ] as const) {
    expect(journalTargetReference(annotationTarget({
      objectKind,
      objectRevision: "revision-2",
    }))).toMatchObject(expected);
  }

  expect(journalTargetReference(annotationTarget({ objectKind: "document" }))).toBeNull();
  expect(journalTargetReference(annotationTarget({ objectRevision: "" }))).toBeNull();
});

it("opens an exact retained source without rereading the Journal object's current world", async () => {
  const target = annotationTarget();
  const original = {
    id: "annotation-original",
    target,
    source: {
      kind: "journal_object",
      content: JSON.stringify({ reference, object: { text: "Exact retained instruction" } }),
      sha256: "a".repeat(64),
    },
  } as TaskAnnotation;
  collaboration.loadObjectAnnotations.mockResolvedValue(annotationContext([original]));
  const loaded = { reference, target, relatedTasks: [] } as unknown as JournalAnnotationObject;
  native.invoke.mockResolvedValue(loaded);

  await expect(loadJournalTarget(target)).resolves.toBe(loaded);

  expect(collaboration.loadObjectAnnotations).toHaveBeenCalledWith({ ...target, taskId: null });
  expect(native.invoke).toHaveBeenCalledOnce();
  expect(native.invoke).toHaveBeenCalledWith("journal_annotation_object", {
    projectId: "paper",
    reference,
    annotationId: "annotation-original",
  });
});

it("hydrates a historical check's world before opening its retained object", async () => {
  const target = annotationTarget({
    objectKind: "journal_check",
    objectRevision: "check-7",
  });
  collaboration.loadObjectAnnotations.mockResolvedValue(annotationContext([]));
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "journal_workbench_request") return { world_version_id: "world-7" };
    return { reference, target, relatedTasks: [] };
  });

  await loadJournalTarget(target);

  expect(native.invoke).toHaveBeenNthCalledWith(1, "journal_workbench_request", {
    path: "/api/check?check_id=check-7",
    payload: null,
  });
  expect(native.invoke).toHaveBeenNthCalledWith(2, "journal_annotation_object", {
    projectId: "paper",
    reference: {
      libraryRoot: "/retained/library",
      workbenchProjectId: "manuscript",
      kind: "check",
      objectId: "guide-fragment",
      worldVersionId: "world-7",
      checkId: "check-7",
    },
    annotationId: null,
  });
});

it("opens a current world object directly from its retained identity", async () => {
  const target = annotationTarget({
    objectKind: "journal_world",
    objectRevision: "world-2",
  });
  collaboration.loadObjectAnnotations.mockResolvedValue(annotationContext([]));
  const loaded = { reference, target, relatedTasks: [] };
  native.invoke.mockResolvedValue(loaded);

  await expect(loadJournalTarget(target)).resolves.toBe(loaded);

  expect(native.invoke).toHaveBeenCalledOnce();
  expect(native.invoke).toHaveBeenCalledWith("journal_annotation_object", {
    projectId: "paper",
    reference: {
      ...reference,
      kind: "world",
      worldVersionId: "world-2",
    },
    annotationId: null,
  });
});

it("rejects a target that cannot identify a retained Journal object", async () => {
  await expect(loadJournalTarget(annotationTarget({ objectKind: "document" }))).rejects.toThrow(
    "This reference is not a retained journal object.",
  );
  expect(collaboration.loadObjectAnnotations).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
});

it("preserves exact font names through journal display and editable candidate values", () => {
  for (const family of ["Times New Roman", "宋体"]) {
    expect(formatJournalValue(family, "font_family")).toBe(family);
    expect(journalInputValue(family, "font_family")).toBe(family);
    expect(parseJournalInput(` ${family} `, "font_family")).toBe(family);
  }
  expect(journalInputValue(1440, "twips")).toBe("25.4");
  expect(parseJournalInput("25.4", "twips")).toBe(1440);
  expect(parseJournalInput("9.5", "half_points")).toBe(19);
});

it("asks journal research to retain the required family and its applicability", () => {
  const world = { journal_name: "Example", journal_id: "example", scope: { language: "en", stage: "initial_submission", article_type: "research_article" } } as JournalWorld;
  const prompt = journalResearchPrompt(world, "en", "Find required fonts", "https://example.org/guide");
  expect(prompt).toContain("body_font_family uses unit font_family");
  expect(prompt).toContain("Do not replace it with a similar or metrically compatible family");
  expect(prompt).toContain("manuscript alone does not establish a journal requirement");
  expect(prompt).toContain("separate scripts, sections or alternative fonts");
});

it("explains comparison coverage without exposing backend diagnostics", () => {
  const message = journalCoverageMessage({ code: "core_structural_only", message: "1 retained template observations have core_structural_only; inspect exact parts/objects with docx-query.", property: null, locator: null });
  expect(message).toContain("visual layout");
  expect(message).not.toContain("docx-query");
  expect(journalCoverageMessage({ code: "future_code", message: "internal data", property: null, locator: null })).toContain("could not be checked automatically");
});

it("formats nullable and structured Journal values in their retained units", () => {
  expect(formatJournalValue(null, "twips")).toBe("—");
  expect(formatJournalValue({ kind: "paragraph", role: "body" }, "effective_format")).toBe(
    "body · paragraph",
  );
  expect(formatJournalValue(3, "count")).toBe("3");
  expect(formatJournalValue(24, "half_points")).toBe("12 pt");
  expect(formatJournalValue(240, "spacing_twips")).toBe("12 pt");

  expect(journalInputValue(null, "twips")).toBe("");
  expect(journalInputValue({ kind: "paragraph", role: "body" }, "effective_format")).toBe(
    JSON.stringify({ kind: "paragraph", role: "body" }),
  );
  expect(journalInputValue("Times New Roman", "font_family")).toBe("Times New Roman");

  expect(journalUnitScale("count")).toBe(1);
  expect(journalUnitScale("half_points")).toBe(2);
  expect(journalUnitScale("spacing_twips")).toBe(20);
  expect(journalUnitScale("twips")).toBeCloseTo(1440 / 25.4);
});

it("captures the selected file bytes and carries source queries without changing their path", async () => {
  const file = new File(["captured guidance"], "author-guide.txt", { type: "text/plain" });
  expect(await capturedJournalFile(file)).toEqual({
    name: "author-guide.txt",
    content_base64: btoa("captured guidance"),
  });
  expect(journalQuery("/api/world", {
    version_id: "world 2",
    source: "guide/one",
  })).toBe("/api/world?version_id=world+2&source=guide%2Fone");
});

it("keeps an official starting URL and supplies the publisher lookup fallback when none is known", () => {
  const world = {
    journal_name: "Example",
    journal_id: "example",
    scope: { language: "en", stage: "initial_submission", article_type: "research_article" },
  } as JournalWorld;

  expect(journalResearchPrompt(world, "en", "Find guidance", "https://example.org/guide")).toContain(
    "https://example.org/guide",
  );
  expect(journalResearchPrompt(world, "en", "Find guidance", "")).toContain(
    "Use the journal identity to locate its publisher's author information",
  );
});

it("translates retained Journal messages while preserving unknown source text", () => {
  expect(journalMessage("Applicability basis: supplied author guide")).toBe(
    "Applicability basis: supplied author guide",
  );
  expect(journalMessage("Declared source value differs from the expectation.")).toBe(
    "Declared source value differs from the expectation.",
  );
  expect(journalMessage("unmapped operator text")).toBe("unmapped operator text");
});

it("maps every Journal coverage code to its user-facing explanation", () => {
  const gap = (code: string) => ({ code, message: `diagnostic:${code}`, property: null, locator: null });
  expect(journalCoverageMessage(gap("template_unknown_role"))).toContain("no clear role");
  expect(journalCoverageMessage(gap("template_mixed_region"))).toContain("more than one kind");
  expect(journalCoverageMessage(gap("template_unknown_region"))).toContain("more than one kind");
  expect(journalCoverageMessage(gap("core_structural_only"))).toContain("visual layout");
  expect(journalCoverageMessage(gap("core_table_band_size_unsupported"))).toContain(
    "alternating groups",
  );
  const other = journalCoverageMessage(gap("future_code"));
  expect(other).toContain("could not be checked automatically");
  expect(other).not.toContain("diagnostic:");
});

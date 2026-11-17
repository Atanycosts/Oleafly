// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskObservation, TaskObservationView, TaskTranscriptEvent } from "@/lib/research-tasks";
import { TaskObservations, TaskSourceRead } from "./TaskObservations";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };

const native = vi.hoisted(() => ({ observations: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/research-tasks", () => ({
  loadResearchTaskObservations: native.observations,
  previewResearchTaskSource: native.source,
}));
vi.mock("@/lib/docx-task-activity", () => ({ subscribeDocxTaskActivity: () => () => {} }));

beforeEach(() => vi.resetAllMocks());
const labels = en.tasks.observations;

function observationPage(events: TaskTranscriptEvent[], nextSequence: number, hasMore = false): TaskObservationView {
  return {
    summary: {
      taskId: "task-a", projectId: "paper", executionGeneration: 2, status: "running",
      goal: "Review evidence", successCriteria: [], runtime: null, usage: null, baseline: null,
      changedFiles: [], changedFileCount: 0, evidence: null, coverageGaps: [],
    },
    page: { events, nextSequence, throughSequence: nextSequence, hasMore },
  };
}

function toolRead(
  sequence: number,
  source: NonNullable<Extract<TaskObservation, { type: "toolExecution" }>["source"]> | null = null,
): TaskTranscriptEvent {
  return {
    taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
    event: { kind: "observation", observation: { type: "toolExecution", callId: `call-${sequence}`, name: "read_file", status: "done", inputSha256: "input", outputSha256: "output", skillId: null, skillInstructionsSha256: null, source } },
  };
}

it("retries a failed observation page from its retained cursor without duplicating earlier calls", async () => {
  const first = observationPage([toolRead(1)], 1, true);
  const second = observationPage([toolRead(2)], 2);
  native.observations.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("Page temporarily unavailable")).mockResolvedValueOnce(second);
  const onOpenCall = vi.fn();
  render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set(["call-1", "call-2"])} onOpenCall={onOpenCall} onReview={vi.fn()} onChecks={vi.fn()} />);
  const more = await screen.findByRole("button", { name: labels.more });
  expect(screen.getByText(labels.notCollected)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Observation records and source locators"));
  fireEvent.click(more);
  expect(await screen.findByRole("alert")).toHaveTextContent("Page temporarily unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: labels.openCall })).toHaveLength(2));
  expect(native.observations.mock.calls).toEqual([["task-a", 2, 0], ["task-a", 2, 1], ["task-a", 2, 1]]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: labels.more })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: labels.openCall })[1]);
  expect(onOpenCall).toHaveBeenCalledExactlyOnceWith("call-2");
});

it("ignores a late page result after the observation view unmounts", async () => {
  let resolvePage!: (value: TaskObservationView) => void;
  native.observations.mockResolvedValueOnce(observationPage([toolRead(1)], 1, true)).mockReturnValueOnce(new Promise<TaskObservationView>((resolve) => { resolvePage = resolve; }));
  const old = render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set()} onOpenCall={vi.fn()} onReview={vi.fn()} onChecks={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: labels.more }));
  await waitFor(() => expect(native.observations).toHaveBeenCalledTimes(2));
  old.unmount();
  native.observations.mockResolvedValueOnce(observationPage([toolRead(3)], 3));
  render(<TaskObservations taskId="task-a" generation={3} revision={1} availableCalls={new Set()} onOpenCall={vi.fn()} onReview={vi.fn()} onChecks={vi.fn()} />);
  await screen.findByText("#3 · call-3");
  await act(async () => resolvePage(observationPage([toolRead(2)], 2)));
  expect(screen.queryByText("#2 · call-2")).not.toBeInTheDocument();
  expect(screen.getByText("#3 · call-3")).toBeInTheDocument();
});

it("explains runtime restrictions and opens the retained baseline and evidence review surfaces", async () => {
  const runtimeRow: TaskTranscriptEvent = {
    taskId: "task-a", executionGeneration: 2, sequence: 1, createdAt: 1,
    event: {
      kind: "observation",
      observation: {
        type: "runtime", runtimeId: "builtin", providerId: "provider", modelId: "model", sessionId: "session",
        tools: [], declaredSkills: [], injectedSkills: [],
        unavailable: ["commands:disabled", "desktop_apps:disabled", "web_tools:unavailable"],
      },
    },
  };
  const view = observationPage([runtimeRow], 1);
  view.summary.runtime = runtimeRow;
  view.summary.baseline = {
    kind: "git_worktree", executionRoot: "workspace", sourceRevision: "git:revision", baselineHash: "baseline-hash",
    fileCount: 4, createdAt: 1, skipped: [{ path: "large-data.bin", reason: "too_large" }],
    initialGitStatus: [], initialGitStatusComplete: true,
  };
  view.summary.changedFiles = [
    { path: "main.tex", kind: "modified", beforeSha256: "before-main", afterSha256: "after-main", beforeSize: 12, afterSize: 14 },
    { path: "notes.md", kind: "added", beforeSha256: null, afterSha256: "after-notes", beforeSize: null, afterSize: 9 },
    { path: "draft.tex", kind: "deleted", beforeSha256: "before-draft", afterSha256: null, beforeSize: 7, afterSize: null },
  ];
  view.summary.changedFileCount = 3;
  view.summary.evidence = { checkedAt: 1, checks: [
    { id: "build", status: "pass", items: [] },
    { id: "numbers", status: "warn", items: [{ code: "numbers.unknownRun", file: "results.tex", line: 4, params: { run: "r009" } }] },
  ] };
  view.summary.coverageGaps = ["observations.baseline_has_skipped_files"];
  native.observations.mockResolvedValue(view);
  const onReview = vi.fn();
  const onChecks = vi.fn();

  render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set()} onOpenCall={vi.fn()} onReview={onReview} onChecks={onChecks} />);
  expect(await screen.findByText("provider / model · builtin")).toBeInTheDocument();
  expect(screen.getByText(/Commands turned off.*Desktop apps turned off.*Web tools unavailable/)).toBeInTheDocument();
  expect(screen.getByText("Reported input / output tokens: Unknown / Unknown")).toBeInTheDocument();
  fireEvent.click(screen.getByText(labels.baseline));
  expect(screen.getByText("git:revision")).toBeInTheDocument();
  expect(screen.getByText("SHA-256 baseline-hash")).toBeInTheDocument();
  expect(screen.getByText(labels.clean)).toBeInTheDocument();
  expect(screen.getByText(labels.skippedFiles)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review 3 file changes" }));
  fireEvent.click(screen.getByRole("button", { name: "View 2 evidence checks" }));
  expect(onReview).toHaveBeenCalledOnce();
  expect(onChecks).toHaveBeenCalledOnce();
});

it.each([false, null])("explains source retention %s and retries an unavailable recorded range", async (snapshotRetained) => {
  const source = { path: "source.txt", fileSha256: "retained-hash", offset: 20, endOffset: 30, truncated: true, snapshotRetained };
  native.source.mockRejectedValueOnce(new Error("Recorded bytes unavailable")).mockResolvedValueOnce({ source, text: "" });
  render(<TaskSourceRead taskId="task-a" generation={2} row={toolRead(9, source)} source={source} />);
  expect(screen.getByText(snapshotRetained === false ? labels.sourceNotArchived : labels.sourceRetentionUnknown)).toBeInTheDocument();
  const read = screen.getByRole("button", { name: "Read recorded source range" });
  fireEvent.click(read);
  expect(await screen.findByRole("alert")).toHaveTextContent("Recorded bytes unavailable");
  fireEvent.click(read);
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(native.source.mock.calls).toEqual([["task-a", 2, 9], ["task-a", 2, 9]]);
  expect(document.querySelector("pre")).toBeEmptyDOMElement();
});

it("shows retained member executions and each request's actual tools and context sizes", async () => {
  const row = (sequence: number, observation: TaskObservation): TaskTranscriptEvent => ({
    taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
    event: { kind: "observation", observation },
  });
  const retainedSource: NonNullable<Extract<TaskObservation, { type: "toolExecution" }>["source"]> = {
    path: "papers/source.txt", fileSha256: "source-hash", offset: 0, endOffset: 10, truncated: false, snapshotRetained: true,
    pdf: { path: "papers/source.pdf", sha256: "pdf-source-hash", pageCount: 12, pageStart: 2, pageEnd: 3 },
  };
  const view: TaskObservationView = {
    summary: {
      taskId: "task-a", projectId: "paper", executionGeneration: 2, status: "running",
      goal: "Review evidence", successCriteria: [], runtime: null, usage: null, baseline: null,
      changedFiles: [], changedFileCount: 0, evidence: null, coverageGaps: [],
    },
    page: {
      events: [
        row(1, { type: "member", memberId: "evidence-reviewer", executionId: "execution-7", triggerIds: ["file-change-3", "annotation-2"], status: "running" }),
        row(2, {
          type: "requestContext", sessionId: "session-7", schemaBytes: 1536, catalogBytes: 8192, skillBytes: 256,
          requirementIds: ["requirement-evidence"],
          tools: [{ name: "read_file", source: "builtin", schemaSha256: "read-schema-hash" }],
        }),
        row(3, { type: "member", memberId: "evidence-reviewer", executionId: "execution-7", triggerIds: ["file-change-3"], status: "completed" }),
        row(4, {
          type: "requestContext", sessionId: "session-7", schemaBytes: 768, catalogBytes: 8192, skillBytes: 512,
          requirementIds: ["requirement-citation"],
          tools: [{ name: "verify_citation", source: "mcp", schemaSha256: "citation-schema-hash" }],
        }),
        row(5, { type: "toolRequested", callId: "member-session-7:helper-1:read-source", name: "read_file", inputSha256: "source-input-hash", actor: "member-session-7:helper-1" }),
        row(6, {
          type: "toolExecution", callId: "member-session-7:helper-1:read-source", name: "read_file", status: "done",
          inputSha256: "source-input-hash", outputSha256: "source-output-hash", skillId: null, actor: "member-session-7:helper-1",
          skillInstructionsSha256: null,
          source: retainedSource,
        }),
      ], nextSequence: 6, throughSequence: 6, hasMore: false,
    },
  };
  native.observations.mockResolvedValue(view);
  native.source.mockResolvedValue({ source: retainedSource, text: "Retained PDF source range" });
  render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set()} onOpenCall={vi.fn()} onReview={vi.fn()} onChecks={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Member executions")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Member executions"));
  expect(screen.getByText("#1 · evidence-reviewer · running")).toBeInTheDocument();
  expect(screen.getByText("#3 · evidence-reviewer · completed")).toBeInTheDocument();
  expect(screen.getAllByText("Execution: execution-7")).toHaveLength(2);
  expect(screen.getByText("Triggers: file-change-3, annotation-2")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Context provided for each request"));
  expect(screen.getByText("Tool schemas: 1536 bytes · Tool catalog: 8192 bytes · Skills: 256 bytes")).toBeInTheDocument();
  expect(screen.getByText("Tool schemas: 768 bytes · Tool catalog: 8192 bytes · Skills: 512 bytes")).toBeInTheDocument();
  expect(screen.getByText("Requirement IDs: requirement-evidence")).toBeInTheDocument();
  expect(screen.getByText("Requirement IDs: requirement-citation")).toBeInTheDocument();
  expect(screen.getByText("The tool catalog describes available tools. Only the tools listed for this request were provided with schemas.")).toBeInTheDocument();
  const provided = screen.getAllByText("Provided tools (1)");
  expect(provided).toHaveLength(2);
  provided.forEach((summary) => { fireEvent.click(summary); });
  expect(screen.getAllByText("read_file")).toHaveLength(2);
  expect(screen.getByText("verify_citation")).toBeInTheDocument();
  expect(screen.getByText("read-schema-hash")).toBeInTheDocument();
  expect(screen.getByText("citation-schema-hash")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Observation records and source locators"));
  expect(screen.getByText((_, element) => element?.textContent === "Execution: member-session-7:helper-1")).toBeInTheDocument();
  expect(screen.getByText("The exact file version from this read is retained.")).toBeInTheDocument();
  expect(screen.getByTestId("pdf-read-source")).toHaveTextContent("papers/source.pdf · Page 2 – 3");
  expect(screen.getByText("PDF SHA-256 pdf-source-hash")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Read recorded source range" }));
  await waitFor(() => expect(screen.getByText("Retained PDF source range")).toBeInTheDocument());
  expect(native.source).toHaveBeenCalledWith("task-a", 2, 6);
  expect(native.observations).toHaveBeenCalledWith("task-a", 2, 0);
});

it("keeps parent and helper reads separate across member sessions and previews each original event", async () => {
  const actors = [undefined, "member-session-a:helper-1", "member-session-b:helper-1"];
  const sourceBySequence = new Map<number, NonNullable<Extract<TaskObservation, { type: "toolExecution" }>["source"]>>();
  const events: TaskTranscriptEvent[] = actors.flatMap((actor, index) => {
    const callId = actor ? `${actor}:read-source` : "read-source";
    const requestSequence = index * 2 + 10;
    const source = { path: "main.tex", fileSha256: `hash-${index}`, offset: 0, endOffset: 10, truncated: false, snapshotRetained: true };
    sourceBySequence.set(requestSequence + 1, source);
    const row = (sequence: number, observation: TaskObservation): TaskTranscriptEvent => ({
      taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
      event: { kind: "observation", observation },
    });
    return [
      row(requestSequence, { type: "toolRequested", callId, name: "read_file", inputSha256: "input", actor }),
      row(requestSequence + 1, {
        type: "toolExecution", callId, name: "read_file", status: "done", inputSha256: "input",
        outputSha256: "output", actor, skillId: null, skillInstructionsSha256: null,
        source,
      }),
    ];
  });
  native.observations.mockResolvedValue({
    summary: {
      taskId: "task-a", projectId: "paper", executionGeneration: 2, status: "running",
      goal: "Review evidence", successCriteria: [], runtime: null, usage: null, baseline: null,
      changedFiles: [], changedFileCount: 0, evidence: null, coverageGaps: [],
    },
    page: { events, nextSequence: 15, throughSequence: 15, hasMore: false },
  } satisfies TaskObservationView);
  native.source.mockImplementation((_taskId, _generation, sequence) => {
    const source = sourceBySequence.get(sequence);
    if (!source) return Promise.reject(new Error(`Missing retained source for event ${sequence}`));
    return Promise.resolve({ source, text: `Retained source from event ${sequence}` });
  });
  render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set()} onOpenCall={vi.fn()} onReview={vi.fn()} onChecks={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Observation records and source locators")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Observation records and source locators"));
  const buttons = screen.getAllByRole("button", { name: "Read recorded source range" });
  expect(buttons).toHaveLength(3);
  expect(screen.getByText("#10 → #11 · read-source")).toBeInTheDocument();
  for (const [index, button] of buttons.entries()) {
    const sequence = index * 2 + 11;
    const record = button.closest("li");
    expect(record).not.toBeNull();
    if (!record) throw new Error("The source action has no observation record.");
    if (actors[index]) expect(within(record).getByText((_, element) => element?.textContent === `Execution: ${actors[index]}`)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(within(record).getByText(`Retained source from event ${sequence}`)).toBeInTheDocument());
    expect(native.source).toHaveBeenNthCalledWith(index + 1, "task-a", 2, sequence);
  }
});

it("shows DOCX proposals and saves alongside ordinary task activity", async () => {
  const row = (sequence: number, observation: TaskObservation): TaskTranscriptEvent => ({
    taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
    event: { kind: "observation", observation },
  });
  const document = {
    sessionId: "docx-session", appProjectId: "app", workbenchProjectId: "paper",
    baselineId: "baseline-7", sourceSha256: "source-hash", sessionRevision: 4, savedRevision: 3,
  };
  native.observations.mockResolvedValue({
    summary: {
      taskId: "task-a", projectId: "paper", executionGeneration: 2, status: "running",
      goal: "Revise the manuscript", successCriteria: [], runtime: null, usage: null, baseline: null,
      changedFiles: [], changedFileCount: 0, evidence: null, coverageGaps: [],
    },
    page: {
      events: [
        row(1, {
          type: "docx",
          activity: {
            id: "proposal-activity", origin: {
              taskId: "task-a", generation: 2, groupId: "manuscript", memberId: "docx-member",
              executionId: "docx-execution", workIds: ["work-1", "work-2"],
            },
            document, proposalId: "proposal-7", createdAt: 1,
            event: {
              type: "runtime",
              event: {
                kind: "proposed",
                target: { targetId: "target-7", paragraphRef: "p7", revision: 4, original: "Original paragraph" },
                proposed: "Revised paragraph",
              },
            },
          },
        }),
        row(2, {
          type: "docx",
          activity: {
            id: "saved-activity", origin: {
              taskId: "task-a", generation: 2, groupId: "manuscript", memberId: "docx-member",
              executionId: "docx-execution", workIds: ["work-1", "work-2"],
            },
            document, proposalId: "proposal-7", createdAt: 2,
            event: { type: "outcome", outcome: { kind: "saved", requestId: "save-request-7", contentSha256: "saved-content-hash" } },
          },
        }),
        row(3, { type: "member", memberId: "normal-reviewer", executionId: "exec-normal", triggerIds: [], status: "completed" }),
        row(4, { type: "toolRequested", callId: "normal-read", name: "read_file", inputSha256: "input-hash" }),
        row(5, {
          type: "toolExecution", callId: "normal-read", name: "read_file", status: "done",
          inputSha256: "input-hash", outputSha256: "output-hash", skillId: null, skillInstructionsSha256: null, source: null,
        }),
      ],
      nextSequence: 5, throughSequence: 5, hasMore: false,
    },
  } satisfies TaskObservationView);

  render(<TaskObservations taskId="task-a" generation={2} revision={1} availableCalls={new Set(["normal-read"])} onOpenCall={vi.fn()} onReview={vi.fn()} onChecks={vi.fn()} />);
  const docx = await screen.findByTestId("task-docx-observations");
  fireEvent.click(within(docx).getByText("Task activity"));
  const proposal = within(docx).getByText("Proposed change · r4").closest("li");
  const saved = within(docx).getByText("Saved manuscript version · r4").closest("li");
  expect(proposal).not.toBeNull();
  expect(saved).not.toBeNull();
  if (!proposal || !saved) throw new Error("DOCX activity rows were not rendered.");
  expect(within(docx).getByText("proposal-activity · baseline-7")).toBeInTheDocument();
  expect(within(proposal).getByText("Member / execution: docx-member · docx-execution")).toBeInTheDocument();
  expect(within(proposal).getByText("Work context: work-1, work-2")).toBeInTheDocument();
  expect(within(proposal).getByText("Original paragraph")).toBeInTheDocument();
  expect(within(proposal).getByText("Revised paragraph")).toBeInTheDocument();
  expect(within(saved).getByText("save-request-7 · saved-content-hash")).toBeInTheDocument();

  fireEvent.click(screen.getByText("Member executions"));
  expect(screen.getByText("#3 · normal-reviewer · completed")).toBeInTheDocument();
  expect(screen.getByText("Execution: exec-normal")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Observation records and source locators"));
  expect(screen.getByText("#4 → #5 · normal-read")).toBeInTheDocument();
  expect(native.observations).toHaveBeenCalledWith("task-a", 2, 0);
});

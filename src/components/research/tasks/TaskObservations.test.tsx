// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskObservation, TaskObservationView, TaskTranscriptEvent } from "@/lib/research-tasks";
import { TaskObservations } from "./TaskObservations";

const native = vi.hoisted(() => ({ observations: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/research-tasks", () => ({
  loadResearchTaskObservations: native.observations,
  previewResearchTaskSource: native.source,
}));

beforeEach(() => vi.resetAllMocks());

it("shows retained member executions and each request's actual tools and context sizes", async () => {
  const row = (sequence: number, observation: TaskObservation): TaskTranscriptEvent => ({
    taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
    event: { kind: "observation", observation },
  });
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
          source: { path: "main.tex", fileSha256: "source-hash", offset: 0, endOffset: 10, truncated: false, snapshotRetained: true },
        }),
      ], nextSequence: 6, throughSequence: 6, hasMore: false,
    },
  };
  native.observations.mockResolvedValue(view);
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
  expect(screen.getByRole("button", { name: "Read recorded source range" })).toBeInTheDocument();
  expect(native.observations).toHaveBeenCalledWith("task-a", 2, 0);
});

it("keeps parent and helper reads separate across member sessions and previews each original event", async () => {
  const actors = [undefined, "member-session-a:helper-1", "member-session-b:helper-1"];
  const events: TaskTranscriptEvent[] = actors.flatMap((actor, index) => {
    const callId = actor ? `${actor}:read-source` : "read-source";
    const requestSequence = index * 2 + 10;
    const row = (sequence: number, observation: TaskObservation): TaskTranscriptEvent => ({
      taskId: "task-a", executionGeneration: 2, sequence, createdAt: sequence,
      event: { kind: "observation", observation },
    });
    return [
      row(requestSequence, { type: "toolRequested", callId, name: "read_file", inputSha256: "input", actor }),
      row(requestSequence + 1, {
        type: "toolExecution", callId, name: "read_file", status: "done", inputSha256: "input",
        outputSha256: "output", actor, skillId: null, skillInstructionsSha256: null,
        source: { path: "main.tex", fileSha256: `hash-${index}`, offset: 0, endOffset: 10, truncated: false, snapshotRetained: true },
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
  native.source.mockImplementation((_taskId, _generation, sequence) => Promise.resolve({ text: `Retained source from event ${sequence}` }));
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

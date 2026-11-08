// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      ], nextSequence: 4, throughSequence: 4, hasMore: false,
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
  expect(screen.getByText("read_file")).toBeInTheDocument();
  expect(screen.getByText("verify_citation")).toBeInTheDocument();
  expect(screen.getByText("read-schema-hash")).toBeInTheDocument();
  expect(screen.getByText("citation-schema-hash")).toBeInTheDocument();
  expect(native.observations).toHaveBeenCalledWith("task-a", 2, 0);
});

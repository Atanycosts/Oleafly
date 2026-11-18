// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
import { useFilesStore } from "@/store/files";
import { AgentWorkspaceFeedback } from "./AgentWorkspaceFeedback";

type FontFamilyState = "available" | "noSource" | "failed" | "stillMissing" | "checking" | "downloading";

function fontReceipt({
  families,
  missing = [],
  probed = true,
  measurer = "shaped",
  resolving = false,
}: {
  families: { family: string; state: FontFamilyState; packId?: string }[];
  missing?: { family: string }[];
  probed?: boolean;
  measurer?: "fixed" | "shaped";
  resolving?: boolean;
}) {
  return {
    acquisition: { families },
    status: { probed, missing },
    measurement: { measurer, resolving },
  };
}

beforeEach(() => {
  useFilesStore.setState({ projectId: "project" });
  useAgentWorkspaceStore.setState({ projectId: "project", operations: [], following: null, paused: false, latestTarget: null, navigation: null, sequence: 0 });
});

it("updates both panels from the same real result and never adopts a parallel flow", () => {
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "task" as const, taskId: "task", generation: 2 };
  store.beginFollow("project", origin);
  const call = { id: "operation", projectId: "project", sessionId: "word", title: "Manuscript", origin, operation: "format", target: { projectId: "project", sessionId: "word", paragraphRef: "p1", sessionRevision: 3 } };
  store.report({ ...call, phase: "started" });
  render(<><AgentWorkspaceFeedback compact /><AgentWorkspaceFeedback /></>);
  expect(screen.getAllByText("Updating formatting · In progress")).toHaveLength(2);
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-origin-kind", "task");
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-flow-key", "task:task:2");
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-session-id", "word");
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-session-revision", "3");
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-follow-state", "following");
  expect(screen.getByTestId("workspace-agent-follow")).toHaveAccessibleName("Pause following");
  act(() => {
    store.report({ ...call, phase: "failed", error: "Actual format error" });
    store.report({ ...call, id: "background", origin: { kind: "task", taskId: "other", generation: 1 }, operation: "save", phase: "succeeded" });
  });
  expect(screen.getAllByText("Updating formatting · Needs attention")).toHaveLength(2);
  expect(screen.queryByText("Saving working copy · Completed")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Pause following" })[0]);
  expect(screen.getAllByRole("button", { name: "Continue following" })).toHaveLength(2);
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-follow-state", "paused");
  expect(screen.getByTestId("sidebar-agent-operation")).toHaveAttribute("data-follow-state", "paused");
  fireEvent.click(screen.getAllByRole("button", { name: "Continue following" })[1]);
  expect(useAgentWorkspaceStore.getState().navigation?.target.paragraphRef).toBe("p1");
  expect(screen.getByTestId("workspace-agent-operation")).toHaveAttribute("data-follow-state", "following");
});

it("keeps a followed external run paused across a newer real target and resumes the same session", () => {
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "external" as const, flowId: "follow-run" };
  const first = {
    id: "format-first",
    projectId: "project",
    sessionId: "word",
    title: "Manuscript",
    origin,
    operation: "format",
    phase: "succeeded" as const,
    target: { projectId: "project", sessionId: "word", paragraphRef: "p1", sessionRevision: 3 },
  };
  store.beginFollow("project", origin);
  store.report(first);
  render(<AgentWorkspaceFeedback />);
  const feedback = screen.getByTestId("workspace-agent-operation");
  expect(feedback).toHaveAttribute("data-flow-key", "external:follow-run");
  expect(feedback).toHaveAttribute("data-follow-state", "following");

  fireEvent.click(screen.getByTestId("workspace-agent-follow"));
  expect(feedback).toHaveAttribute("data-follow-state", "paused");
  act(() => store.report({
    ...first,
    id: "format-second",
    target: { projectId: "project", sessionId: "word", paragraphRef: "p2", sessionRevision: 4 },
  }));
  expect(feedback).toHaveAttribute("data-follow-state", "paused");
  expect(feedback).toHaveAttribute("data-session-id", "word");
  expect(feedback).toHaveAttribute("data-session-revision", "4");
  expect(useAgentWorkspaceStore.getState().navigation?.target.paragraphRef).toBe("p1");

  fireEvent.click(screen.getByTestId("workspace-agent-follow"));
  expect(feedback).toHaveAttribute("data-follow-state", "following");
  expect(useAgentWorkspaceStore.getState().navigation).toMatchObject({
    flowKey: "external:follow-run",
    target: { sessionId: "word", paragraphRef: "p2", sessionRevision: 4 },
  });
});

it("turns successful save and check calls into their actual business receipts", () => {
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "task" as const, taskId: "task", generation: 4 };
  const call = {
    id: "receipt",
    projectId: "project",
    sessionId: "word",
    title: "Manuscript",
    origin,
    phase: "succeeded" as const,
    target: { projectId: "project", sessionId: "word", sessionRevision: 3 },
  };
  store.beginFollow("project", origin);
  store.report({
    ...call,
    operation: "save",
    result: {
      baselineId: "saved-baseline",
      revision: 3,
      sourceSha256: "b".repeat(64),
      document: { sessionId: "word", baselineId: "saved-baseline", sessionRevision: 3, savedRevision: 3, dirty: false },
    },
  });
  store.publishView({
    projectId: "project",
    documentId: "word",
    title: "Manuscript",
    kind: "docx",
    role: "working",
    revision: "3",
    sessionId: "word",
    sessionRevision: 3,
    dirty: false,
  });
  render(<AgentWorkspaceFeedback />);

  const feedback = screen.getByTestId("workspace-agent-operation");
  expect(screen.getByText("Saving working copy · Saved manuscript version")).toBeVisible();
  expect(feedback).toHaveAttribute("data-operation", "save");
  expect(feedback).toHaveAttribute("data-receipt-state", "saved");
  expect(feedback).toHaveAttribute("data-baseline-id", "saved-baseline");
  expect(feedback).toHaveAttribute("data-revision", "3");
  expect(feedback).toHaveAttribute("data-source-sha256", "b".repeat(64));

  act(() => store.report({
    ...call,
    id: "current-check",
    operation: "check",
    result: {
      operation: "check",
      ok: true,
      document: { sessionId: "word", baselineId: "saved-baseline", sessionRevision: 3, savedRevision: 3 },
      result: { template: "world", check: {
        check_id: "check-current", baseline_id: "saved-baseline", world_version_id: "world", validity: "CURRENT",
      } },
    },
  }));
  expect(screen.getByText("Checking requirements · Current")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "current");
  expect(feedback).toHaveAttribute("data-validity", "CURRENT");
  expect(feedback).toHaveAttribute("data-check-id", "check-current");
  expect(feedback).toHaveAttribute("data-world-version-id", "world");

  act(() => store.publishView({
    projectId: "project",
    documentId: "word",
    title: "Manuscript",
    kind: "docx",
    role: "working",
    revision: "4",
    sessionId: "word",
    sessionRevision: 4,
    dirty: true,
  }));
  expect(screen.getByText("Checking requirements · Historical · rerun needed")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "stale");
  expect(feedback).toHaveAttribute("data-validity", "STALE");

  act(() => store.report({
    ...call,
    id: "stale-check",
    operation: "check",
    result: {
      operation: "check",
      ok: true,
      document: { sessionId: "word", baselineId: "saved-baseline", sessionRevision: 3, savedRevision: 3 },
      result: { template: "world", check: {
        check_id: "check-stale", baseline_id: "saved-baseline", world_version_id: "world", validity: "STALE",
      } },
    },
  }));
  expect(screen.getByText("Checking requirements · Historical · rerun needed")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "stale");
  expect(feedback).toHaveAttribute("data-validity", "STALE");
});

it("does not invent optional save, check, or export receipt fields", () => {
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "external" as const, flowId: "receipts" };
  store.report({
    id: "partial-save",
    projectId: "project",
    sessionId: "word",
    origin,
    operation: "save",
    phase: "succeeded",
    result: {
      baselineId: "saved-baseline",
      revision: "3",
      sourceSha256: 42,
    },
  });
  render(<AgentWorkspaceFeedback />);
  const feedback = screen.getByTestId("workspace-agent-operation");

  expect(screen.getByText("Saving working copy · Saved manuscript version")).toBeVisible();
  expect(feedback).toHaveAttribute("data-baseline-id", "saved-baseline");
  expect(feedback).not.toHaveAttribute("data-revision");
  expect(feedback).not.toHaveAttribute("data-source-sha256");

  act(() => store.report({
    id: "partial-check",
    projectId: "project",
    sessionId: "word",
    origin,
    operation: "check",
    phase: "succeeded",
    target: { projectId: "project", sessionId: "word", sessionRevision: 3 },
    result: {
      operation: "check",
      result: {
        check: {
          validity: "CURRENT",
          baseline_id: 3,
          check_id: 9,
        },
      },
    },
  }));
  act(() => store.publishView({
    projectId: "project",
    documentId: "word",
    title: "Manuscript",
    kind: "docx",
    role: "original",
    revision: "3",
    sessionId: "word",
    sessionRevision: 3,
    dirty: false,
  }));

  expect(screen.getByText("Checking requirements · Result available")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "checked");
  expect(feedback).not.toHaveAttribute("data-validity");
  expect(feedback).not.toHaveAttribute("data-baseline-id");
  expect(feedback).not.toHaveAttribute("data-check-id");
  expect(feedback).not.toHaveAttribute("data-world-version-id");

  act(() => store.report({
    id: "export",
    projectId: "project",
    sessionId: "word",
    origin,
    operation: "export",
    phase: "succeeded",
    result: { operation: "export", result: { result: { status: "saved" } } },
  }));
  expect(screen.getByText("Exporting document · File saved")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "saved");

  act(() => store.report({
    id: "export",
    projectId: "project",
    sessionId: "word",
    origin,
    operation: "export",
    phase: "succeeded",
    result: { operation: "export", result: { result: { status: "download_requested" } } },
  }));
  expect(screen.getByText("Exporting document · Download requested")).toBeVisible();

  act(() => store.report({
    id: "export",
    projectId: "project",
    sessionId: "word",
    origin,
    operation: "export",
    phase: "succeeded",
    result: { operation: "export", result: { result: { status: 7 } } },
  }));
  expect(screen.getByText("Exporting document · Result available")).toBeVisible();
  expect(feedback).toHaveAttribute("data-receipt-state", "available");
});

it("starts following only for the operation the user explicitly follows", () => {
  const store = useAgentWorkspaceStore.getState();
  store.report({
    id: "unknown-action",
    projectId: "project",
    sessionId: "word",
    origin: { kind: "external", flowId: "manual-follow" },
    operation: "unknown_action",
    phase: "succeeded",
  });
  render(<AgentWorkspaceFeedback compact />);
  const feedback = screen.getByTestId("sidebar-agent-operation");

  expect(screen.getByText("Processing manuscript · Completed")).toBeVisible();
  expect(feedback).toHaveAttribute("data-follow-state", "idle");
  expect(screen.getByRole("button", { name: "Follow this operation" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Follow this operation" }));

  expect(feedback).toHaveAttribute("data-follow-state", "following");
  expect(useAgentWorkspaceStore.getState().following).toEqual({
    projectId: "project",
    flowKey: "external:manual-follow",
  });
});

it("hides another project's operations", () => {
  useAgentWorkspaceStore.getState().report({ id: "other", projectId: "another", sessionId: "word", origin: { kind: "external", flowId: "mcp" }, operation: "save", phase: "succeeded" });
  const view = render(<AgentWorkspaceFeedback />);
  expect(view.container).toBeEmptyDOMElement();
});

it("distinguishes a cancelled export and missing fonts from completed business results", () => {
  const store = useAgentWorkspaceStore.getState();
  const base = { id: "op", projectId: "project", sessionId: "word", origin: { kind: "external" as const, flowId: "flow" }, phase: "succeeded" as const };
  store.report({ ...base, operation: "export", result: { operation: "export", ok: true, result: { filename: "paper.docx", result: { status: "cancelled" } } } });
  render(<AgentWorkspaceFeedback />);
  expect(screen.getByText("Exporting document · Cancelled")).toBeVisible();
  act(() => store.report({
    ...base,
    operation: "prepare_fonts",
    result: fontReceipt({
      families: [{ family: "SimSun", state: "available" }],
      missing: [{ family: "SimSun" }],
    }),
  }));
  expect(screen.getByText("Preparing fonts · Fonts still missing")).toBeVisible();
});

it.each([
  ["noSource", "Fonts still missing"],
  ["failed", "Fonts still missing"],
  ["stillMissing", "Fonts still missing"],
  ["checking", "Resolving fonts"],
  ["downloading", "Resolving fonts"],
] as const)("uses %s acquisition state in the receipt", (state, expected) => {
  const store = useAgentWorkspaceStore.getState();
  store.report({
    id: "fonts",
    projectId: "project",
    sessionId: "word",
    origin: { kind: "chat", flowId: "chat-flow", chatId: "chat" },
    operation: "prepare_fonts",
    phase: "succeeded",
    result: fontReceipt({ families: [{ family: "Exact Serif", state, packId: "exact" }] }),
  });
  render(<AgentWorkspaceFeedback />);
  expect(screen.getByText(`Preparing fonts · ${expected}`)).toBeVisible();
  expect(screen.queryByText("Preparing fonts · Requested fonts resolved")).toBeNull();
});

it("claims readiness only for a complete shaped receipt and leaves unknown or legacy results available", () => {
  const store = useAgentWorkspaceStore.getState();
  const call = {
    id: "fonts",
    projectId: "project",
    sessionId: "word",
    origin: { kind: "chat" as const, flowId: "chat-flow", chatId: "chat" },
    operation: "prepare_fonts",
    phase: "succeeded" as const,
  };
  render(<AgentWorkspaceFeedback />);
  act(() => store.report({
    ...call,
    result: fontReceipt({ families: [{ family: "Exact Serif", state: "available", packId: "exact" }] }),
  }));
  expect(screen.getByText("Preparing fonts · Requested fonts resolved")).toBeVisible();
  act(() => store.report({ ...call, result: fontReceipt({ families: [] }) }));
  expect(screen.getByText("Preparing fonts · Requested fonts resolved")).toBeVisible();
  act(() => store.report({ ...call, result: fontReceipt({ families: [], probed: false }) }));
  expect(screen.getByText("Preparing fonts · Result available")).toBeVisible();
  act(() => store.report({
    ...call,
    result: {
      acquisition: { families: [{ family: "Exact Serif", state: "available" }] },
      status: { probed: true, missing: [] },
      measurement: { resolving: false },
    },
  }));
  expect(screen.getByText("Preparing fonts · Result available")).toBeVisible();
  act(() => store.report({
    ...call,
    result: {
      status: { probed: true, missing: [] },
      measurement: { measurer: "shaped", resolving: false },
    },
  }));
  expect(screen.getByText("Preparing fonts · Result available")).toBeVisible();
  act(() => store.report({
    ...call,
    result: {
      acquisition: { families: [{ family: "Exact Serif", state: "available" }] },
      status: { probed: true, missing: [] },
    },
  }));
  expect(screen.getByText("Preparing fonts · Result available")).toBeVisible();
});

it("projects a wrapped task receipt consistently and keeps paused updates tied to the store", () => {
  const store = useAgentWorkspaceStore.getState();
  const origin = { kind: "task" as const, taskId: "task", generation: 3 };
  const call = {
    id: "fonts",
    projectId: "project",
    sessionId: "word",
    title: "Manuscript",
    origin,
    operation: "prepare_fonts",
    phase: "succeeded" as const,
    target: { projectId: "project", sessionId: "word", paragraphRef: "p1", sessionRevision: 1 },
  };
  store.beginFollow("project", origin);
  store.report({
    ...call,
    result: { operation: "prepare_fonts", ok: true, result: fontReceipt({
      families: [{ family: "Exact Serif", state: "available" }],
      measurer: "fixed",
    }) },
  });
  render(<><AgentWorkspaceFeedback compact /><AgentWorkspaceFeedback /></>);
  expect(screen.getAllByText("Preparing fonts · Result available")).toHaveLength(2);

  fireEvent.click(screen.getAllByRole("button", { name: "Pause following" })[0]);
  act(() => store.report({
    ...call,
    result: { operation: "prepare_fonts", ok: true, result: fontReceipt({
      families: [{ family: "Exact Serif", state: "available" }],
      resolving: true,
    }) },
  }));
  expect(screen.getAllByText("Preparing fonts · Resolving fonts")).toHaveLength(2);
  expect(useAgentWorkspaceStore.getState().paused).toBe(true);

  act(() => store.report({
    ...call,
    result: { operation: "prepare_fonts", ok: true, result: fontReceipt({
      families: [{ family: "Exact Serif", state: "available" }],
    }) },
  }));
  expect(screen.getAllByText("Preparing fonts · Requested fonts resolved")).toHaveLength(2);
  expect(useAgentWorkspaceStore.getState().paused).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "Continue following" })[1]);
  expect(useAgentWorkspaceStore.getState().paused).toBe(false);
});

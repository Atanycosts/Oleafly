import type { AutomationHandle } from "@docx-editor.dev/core/automation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesStore } from "@/store/files";
import type {
  DocxApplyResult,
  DocxParagraph,
  DocxSession,
  DocxTarget,
} from "./docx-session";

const mocks = vi.hoisted(() => ({
  runInlineCompletion: vi.fn(),
}));

vi.mock("@/lib/ai-inline", () => ({
  runInlineCompletion: mocks.runInlineCompletion,
}));

import {
  createDocxAgentTools,
  DOCX_AGENT_HOST,
  registerDocxAgentSession,
  resetDocxAgentHostForTest,
  unregisterDocxAgentSession,
  updateDocxAgentSession,
} from "./docx-agent-host";

type Exec = (input?: unknown) => Promise<unknown>;

function paragraph(ref: string, text: string, paraId = ref): DocxParagraph {
  return {
    handle: { kind: "paragraph", ref } as AutomationHandle<"paragraph">,
    text,
    paraId,
  };
}

function harness(initial = [paragraph("p1", "Original paragraph.")]) {
  let revision = 0;
  let paragraphs = [...initial];
  const listeners = new Set<(revision: number) => void>();
  const session: DocxSession = {
    revision: () => revision,
    listParagraphs: () => paragraphs,
    captureTarget: (handle): DocxTarget => {
      const paragraph = paragraphs.find((item) => item.handle.ref === handle.ref);
      if (!paragraph) throw new Error("missing paragraph");
      return {
        paragraph: paragraph.handle,
        original: paragraph.text,
        revision,
        paraId: paragraph.paraId,
        structure: `structure:${paragraph.text}`,
      };
    },
    applySuggestion: vi.fn((target: DocxTarget, text: string): DocxApplyResult => {
      const current = paragraphs.find((item) => item.handle.ref === target.paragraph.ref);
      if (!current || current.text !== target.original) {
        return {
          ok: false,
          code: "stale-target",
          message: "The target changed.",
          revision,
          changed: false,
        };
      }
      paragraphs = paragraphs.map((item) =>
        item.handle.ref === target.paragraph.ref ? { ...item, text } : item,
      );
      revision += 1;
      for (const listener of listeners) listener(revision);
      return { ok: true, revision, changed: true };
    }),
    isSuggestionApplied: (target, text) =>
      paragraphs.find((item) => item.handle.ref === target.paragraph.ref)?.text === text,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  return {
    session,
    edit(ref: string, text: string) {
      paragraphs = paragraphs.map((item) =>
        item.handle.ref === ref ? { ...item, text } : item,
      );
      revision += 1;
      for (const listener of listeners) listener(revision);
    },
  };
}

function register(session: DocxSession, overrides: Record<string, unknown> = {}) {
  return registerDocxAgentSession({
    sessionId: "session-1",
    appProjectId: "app-project",
    workbenchProjectId: "paper-project",
    title: "Paper",
    filename: "paper.docx",
    baselineId: "baseline-1",
    savedRevision: 0,
    session,
    ...overrides,
  });
}

function tool(name: keyof ReturnType<typeof createDocxAgentTools>): Exec {
  return createDocxAgentTools()[name].execute as Exec;
}

beforeEach(() => {
  resetDocxAgentHostForTest();
  useFilesStore.setState({ projectId: "app-project" });
  mocks.runInlineCompletion.mockReset();
});

describe("active DOCX Agent host", () => {
  it("lists and reads the live session while separating it from the saved baseline", async () => {
    const local = harness();
    register(local.session);
    local.edit("p1", "Unsaved text.");

    expect(await tool("list_docx_documents")({})).toEqual({
      documents: [
        expect.objectContaining({
          sessionId: "session-1",
          baselineId: "baseline-1",
          sessionRevision: 1,
          savedRevision: 0,
          dirty: true,
        }),
      ],
    });
    expect(await tool("read_docx_document")({})).toEqual({
      document: expect.objectContaining({
        sessionRevision: 1,
        savedRevision: 0,
        dirty: true,
      }),
      paragraphs: [
        { paragraphRef: "p1", text: "Unsaved text.", paraId: "p1" },
      ],
    });

    updateDocxAgentSession("session-1", {
      baselineId: "baseline-2",
      savedRevision: 1,
    });
    expect(await tool("read_docx_document")({})).toMatchObject({
      document: {
        baselineId: "baseline-2",
        sessionRevision: 1,
        savedRevision: 1,
        dirty: false,
      },
    });
  });

  it("captures, suggests and applies one current paragraph", async () => {
    const local = harness();
    register(local.session);
    mocks.runInlineCompletion.mockResolvedValue("Revised paragraph.");

    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string; revision: number; structure: string };
    expect(captured).toMatchObject({
      paragraphRef: "p1",
      text: "Original paragraph.",
      revision: 0,
      structure: "structure:Original paragraph.",
    });

    const suggestion = (await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Make it clearer.",
      expected_revision: 0,
    })) as {
      target: { targetId: string };
      proposed: string;
      document: { sessionRevision: number; dirty: boolean };
    };
    expect(mocks.runInlineCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Make it clearer.",
        selection: "Original paragraph.",
      }),
    );
    expect(suggestion).toMatchObject({
      proposed: "Revised paragraph.",
      document: { sessionRevision: 0, dirty: false },
    });

    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 0,
      text: suggestion.proposed,
    })).toMatchObject({
      ok: true,
      changed: true,
      document: { sessionRevision: 1, savedRevision: 0, dirty: true },
    });
  });

  it("rejects stale expected and target revisions without overwriting newer text", async () => {
    const local = harness();
    register(local.session);
    mocks.runInlineCompletion.mockResolvedValue("Never applied.");
    const suggestion = (await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
    })) as { target: { targetId: string } };

    expect(await tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
      expected_revision: 4,
    })).toEqual({
      error: expect.stringContaining("expected revision 4, current revision 0"),
    });
    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 4,
      text: "Wrong revision.",
    })).toMatchObject({
      ok: false,
      code: "stale-target",
      changed: false,
    });

    local.edit("p1", "User changed this.");
    expect(await tool("apply_docx_suggestion")({
      target_id: suggestion.target.targetId,
      expected_revision: 0,
      text: "Never overwrite.",
    })).toEqual({
      error: "Error: The DOCX suggestion target changed since it was captured.",
    });
    expect(local.session.listParagraphs()[0].text).toBe("User changed this.");
  });

  it("rejects a target that changes while the suggestion is being generated", async () => {
    const local = harness();
    register(local.session);
    let finish!: (value: string) => void;
    mocks.runInlineCompletion.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );

    const pending = tool("suggest_docx_change")({
      paragraph_ref: "p1",
      instruction: "Revise.",
    });
    local.edit("p1", "User changed this first.");
    finish("Late suggestion.");

    await expect(pending).resolves.toEqual({
      error:
        "Error: The DOCX request was cancelled or its target changed.",
    });
  });

  it("streams the candidate to the caller and honors cancellation", async () => {
    const local = harness();
    register(local.session);
    const controller = new AbortController();
    const onToken = vi.fn();
    mocks.runInlineCompletion.mockImplementation(
      async ({ signal, onToken: emit }) => {
        emit("Partial candidate");
        expect(signal.aborted).toBe(false);
        return "Partial candidate";
      },
    );

    const streamingTools = createDocxAgentTools({
      signal: controller.signal,
      onToken,
    });
    expect(await (streamingTools.suggest_docx_change.execute as Exec)({
      paragraph_ref: "p1",
      instruction: "Revise.",
    })).toMatchObject({ proposed: "Partial candidate" });
    expect(onToken).toHaveBeenCalledWith("Partial candidate");

    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    controller.abort();
    const cancelledTools = createDocxAgentTools({
      signal: controller.signal,
    });
    expect(await (cancelledTools.apply_docx_suggestion.execute as Exec)({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Changed.",
    })).toMatchObject({
      error: expect.stringContaining("cancelled"),
    });
  });

  it("cannot apply a target after its session closes", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    unregisterDocxAgentSession("session-1");
    const reopened = harness();
    register(reopened.session);

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Must not apply.",
    })).toMatchObject({
      error: expect.stringContaining("no longer available"),
    });
    expect(reopened.session.applySuggestion).not.toHaveBeenCalled();
  });

  it("cannot use a target ID from another app project", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    useFilesStore.setState({ projectId: "other-project" });

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Must not apply.",
    })).toMatchObject({
      error: expect.stringContaining("not bound to the Agent for this project"),
    });
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
  });

  it("refuses an unbound or other-project session", async () => {
    expect(await tool("read_docx_document")({})).toEqual({
      error: "Error: No active DOCX working copy is bound to the Agent.",
    });
    const local = harness();
    register(local.session, { appProjectId: "other-project" });
    expect(await tool("read_docx_document")({ session_id: "session-1" })).toEqual({
      error:
        "Error: DOCX session session-1 is not bound to the Agent for this project.",
    });
  });

  it("removes targets when the working copy closes", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };
    unregisterDocxAgentSession("session-1");

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Changed.",
    })).toEqual({
      error: `Error: DOCX suggestion target ${captured.targetId} is no longer available.`,
    });
  });

  it("does not bypass the session's complex-structure refusal", async () => {
    const local = harness();
    register(local.session);
    local.session.applySuggestion = vi.fn((): DocxApplyResult => ({
      ok: false,
      code: "unsupported-target",
      message: "Mixed formatting.",
      revision: 0,
      changed: false,
    }));
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };

    expect(await tool("apply_docx_suggestion")({
      target_id: captured.targetId,
      expected_revision: 0,
      text: "Flattened.",
    })).toMatchObject({
      ok: false,
      code: expect.any(String),
      changed: false,
    });
  });

  it("rejects a stale target when the approval flow inspects it again", async () => {
    const local = harness();
    register(local.session);
    const captured = (await tool("capture_docx_target")({
      paragraph_ref: "p1",
    })) as { targetId: string };

    local.edit("p1", "User changed this while approval was pending.");

    await expect(DOCX_AGENT_HOST.inspectTarget(captured.targetId)).rejects.toThrow(
      "The DOCX suggestion target changed since it was captured.",
    );
    expect(local.session.applySuggestion).not.toHaveBeenCalled();
  });
});

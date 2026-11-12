import { describe, expect, it, vi } from "vitest";
import { createDocxTools, type DocxToolsHost } from "./tools";

function host(overrides: Partial<DocxToolsHost> = {}): DocxToolsHost {
  return {
    listDocuments: vi.fn(async () => []),
    readDocument: vi.fn(async () => ({
      document: {
        sessionId: "s1",
        sourceSha256: "a".repeat(64),
        appProjectId: "p1",
        workbenchProjectId: "paper",
        title: "Paper",
        filename: "paper.docx",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
      },
      paragraphs: [{ paragraphRef: "para-1", text: "Text" }],
    })),
    captureTarget: vi.fn(async () => ({
      sessionId: "s1",
      baselineId: "b1",
      sessionRevision: 2,
      savedRevision: 1,
      dirty: true,
      filename: "paper.docx",
      targetId: "target-1",
      paragraphRef: "para-1",
      text: "Text",
      revision: 2,
    })),
    suggestChange: vi.fn(async () => ({
      target: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
        filename: "paper.docx",
        targetId: "target-2",
        paragraphRef: "para-1",
        text: "Text",
        revision: 2,
      },
      proposed: "Changed",
      document: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
      },
    })),
    applySuggestion: vi.fn(async () => ({
      ok: true,
      changed: true,
      document: {
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 3,
        savedRevision: 1,
        dirty: true,
      },
    })),
    inspectTarget: vi.fn(async () => ({
      sessionId: "s1",
      baselineId: "b1",
      sessionRevision: 2,
      savedRevision: 1,
      dirty: true,
      filename: "paper.docx",
      targetId: "target-2",
      paragraphRef: "para-1",
      text: "Text",
      revision: 2,
    })),
    ...overrides,
  };
}

describe("DOCX business tools", () => {
  it("delegates list, read, capture, suggestion and application to one host", async () => {
    const api = host();
    const tools = createDocxTools(api);

    await tools.list_docx_documents.execute();
    await tools.read_docx_document.execute({ session_id: "s1" });
    await tools.capture_docx_target.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
    });
    await tools.suggest_docx_change.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
      instruction: "Revise",
      expected_revision: 2,
    });
    await tools.apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    });

    expect(api.readDocument).toHaveBeenCalledWith("s1");
    expect(api.captureTarget).toHaveBeenCalledWith("s1", "para-1");
    expect(api.suggestChange).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        paragraphRef: "para-1",
        instruction: "Revise",
        expectedRevision: 2,
      },
      undefined,
    );
    expect(api.applySuggestion).toHaveBeenCalledWith(
      {
        targetId: "target-2",
        expectedRevision: 2,
        text: "Changed",
      },
      undefined,
    );
    expect(api.inspectTarget).toHaveBeenCalledWith("target-2");
  });

  it("passes only the attribution supplied by the runtime to mutations", async () => {
    const api = host();
    const attribution = Object.freeze({
      taskId: "task-1",
      workId: "work-1",
      memberId: "member-1",
      executionId: "execution-1",
    });
    const tools = createDocxTools(api, { attribution });

    await tools.apply_docx_suggestion.execute({
      target_id: "target-1",
      expected_revision: 2,
      text: "Changed",
    });

    expect(api.applySuggestion).toHaveBeenCalledWith(
      expect.any(Object),
      { attribution },
    );
  });

  it("returns host failures as tool errors", async () => {
    const api = host({
      readDocument: vi.fn(async () => {
        throw new Error("not bound");
      }),
    });
    expect(await createDocxTools(api).read_docx_document.execute({})).toEqual({
      error: "Error: not bound",
    });
  });

  it("asks with a diff, then rechecks cancellation and the target before applying", async () => {
    const api = host();
    const confirm = vi.fn(async () => true);
    const mutationAllowed = vi.fn(() => true);
    const tools = createDocxTools(api, { confirm, mutationAllowed });

    await tools.apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    });

    expect(confirm).toHaveBeenCalledWith({
      tool: "apply_docx_suggestion",
      summary: "Apply a DOCX suggestion to paper.docx at para-1",
      path: "paper.docx#para-1",
      diff: {
        path: "paper.docx#para-1",
        oldText: "Text",
        newText: "Changed",
      },
    });
    expect(api.inspectTarget).toHaveBeenCalledTimes(2);
    expect(mutationAllowed).toHaveBeenCalledTimes(2);
    expect(api.applySuggestion).toHaveBeenCalledOnce();
  });

  it("does not apply after a decline or cancellation", async () => {
    const declinedApi = host();
    expect(await createDocxTools(declinedApi, {
      confirm: async () => false,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toMatchObject({ declined: true });
    expect(declinedApi.applySuggestion).not.toHaveBeenCalled();

    const cancelledApi = host();
    expect(await createDocxTools(cancelledApi, {
      confirm: async () => true,
      mutationAllowed: () => false,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toEqual({
      error: "The external request was cancelled before mutation.",
    });
    expect(cancelledApi.applySuggestion).not.toHaveBeenCalled();
  });

  it("does not apply when the target changes while approval is pending", async () => {
    const inspectTarget = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "s1",
        baselineId: "b1",
        sessionRevision: 2,
        savedRevision: 1,
        dirty: true,
        filename: "paper.docx",
        targetId: "target-2",
        paragraphRef: "para-1",
        text: "Text",
        revision: 2,
      })
      .mockRejectedValueOnce(
        new Error("The DOCX suggestion target changed since it was captured."),
      );
    const api = host({ inspectTarget });

    expect(await createDocxTools(api, {
      confirm: async () => true,
    }).apply_docx_suggestion.execute({
      target_id: "target-2",
      expected_revision: 2,
      text: "Changed",
    })).toEqual({
      error:
        "Error: The DOCX suggestion target changed since it was captured.",
    });
    expect(inspectTarget).toHaveBeenCalledTimes(2);
    expect(api.applySuggestion).not.toHaveBeenCalled();
  });
});

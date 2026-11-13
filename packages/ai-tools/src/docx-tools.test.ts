import { describe, expect, it, vi } from "vitest";
import {
  createDocxTools,
  type DocxFormatReadQuery,
  type DocxFormatReadResult,
  type DocxToolsHost,
} from "./tools";

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

  it("reads live format scope and applies a revisioned font and paragraph change", async () => {
    const api = host({
      readFormat: vi.fn(async (
        _sessionId: string | undefined,
        _query: DocxFormatReadQuery,
      ): Promise<DocxFormatReadResult> => ({
        document: { sessionId: "s1", baselineId: "b1", sessionRevision: 2,
          savedRevision: 1, dirty: true, filename: "paper.docx" },
        sourceSha256: "c".repeat(64),
        revision: 2,
        paragraph: {
          paragraphRef: "para-1",
          text: "Text",
          revision: 2,
          font: { bold: null, italic: null, underline: null, strikeThrough: null,
            highlightColor: null, subscript: null, superscript: null,
            name: null, size: null, color: null },
          paragraph: { alignment: "Left" as const, style: null, firstLineIndent: null,
            leftIndent: null, rightIndent: null, lineSpacing: null, spaceBefore: null,
            spaceAfter: null, widowControl: null, readingOrder: "LeftToRight" as const },
        },
        nextOffset: null,
      })),
      formatParagraph: vi.fn(async () => ({
        revision: 3,
        ok: true,
        changed: true,
        document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3,
          savedRevision: 1, dirty: true },
      })),
    });
    const confirm = vi.fn(async () => true);
    const mutationAllowed = vi.fn(() => true);
    const tools = createDocxTools(api, { confirm, mutationAllowed });

    expect(await tools.read_docx_format.execute({
      session_id: "s1",
      query: { paragraph_ref: "para-1", offset: 0, limit: 1 },
    })).toMatchObject({
      sourceSha256: "c".repeat(64),
      paragraph: { paragraphRef: "para-1" },
    });
    expect(await tools.apply_docx_format.execute({
      session_id: "s1",
      paragraph_ref: "para-1",
      expected_revision: 2,
      font: { name: "Arial", size: 12 },
      paragraph: { alignment: "Centered", spaceAfter: 6 },
    })).toMatchObject({ ok: true, changed: true, revision: 3 });

    expect(api.readFormat).toHaveBeenNthCalledWith(1, "s1", {
      paragraphRef: "para-1",
      offset: 0,
      limit: 1,
    });
    expect(api.formatParagraph).toHaveBeenCalledWith(
      "s1",
      "para-1",
      2,
      {
        font: { name: "Arial", size: 12 },
        paragraph: { alignment: "Centered", spaceAfter: 6 },
      },
      undefined,
    );
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: "apply_docx_format",
      summary: "Format a DOCX paragraph in paper.docx at para-1",
      diff: expect.objectContaining({
        path: "paper.docx#para-1",
        oldText: expect.stringContaining('"alignment": "Left"'),
        newText: expect.stringContaining('"name": "Arial"'),
      }),
    }));
    expect(mutationAllowed).toHaveBeenCalledTimes(2);
  });

  it("does not format after a declined approval or a cancellation", async () => {
    const readFormat = vi.fn(async () => ({
      document: { sessionId: "s1", baselineId: "b1", sessionRevision: 2,
        savedRevision: 1, dirty: true, filename: "paper.docx" },
      sourceSha256: "c".repeat(64), revision: 2, nextOffset: null,
    }));
    const declined = host({ readFormat, formatParagraph: vi.fn() });
    expect(await createDocxTools(declined, {
      confirm: async () => false,
    }).apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
    })).toMatchObject({ declined: true });
    expect(declined.formatParagraph).not.toHaveBeenCalled();

    const cancelledApi = host({ formatParagraph: vi.fn() });
    const controller = new AbortController();
    controller.abort();
    expect(await createDocxTools(cancelledApi, {
      signal: controller.signal,
    }).apply_docx_format.execute({
      paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
    })).toEqual({
      error: "The external request was cancelled before mutation.",
    });
    expect(cancelledApi.formatParagraph).not.toHaveBeenCalled();

    const committed = new AbortController();
    const committedApi = host({
      formatParagraph: vi.fn(async () => {
        committed.abort();
        return { ok: true, changed: true, revision: 3,
          document: { sessionId: "s1", baselineId: "b1", sessionRevision: 3,
            savedRevision: 1, dirty: true } };
      }),
    });
    expect(await createDocxTools(committedApi, { signal: committed.signal })
      .apply_docx_format.execute({
        paragraph_ref: "para-1", expected_revision: 2, font: { bold: true },
      })).toMatchObject({ ok: true, changed: true, revision: 3 });
  });

  it("saves at the explicit revision and checks only the supplied world version", async () => {
    const saveDocument = vi.fn(async () => ({
      baselineId: "b2", revision: 3, sourceSha256: "d".repeat(64),
      document: { sessionId: "s1", baselineId: "b2", sessionRevision: 3,
        savedRevision: 3, dirty: false },
    }));
    const checkTemplate = vi.fn(async (session, template) => ({
      template,
      check: { project_id: session === "s1" ? "paper" : "" },
    }));
    const api = host({ saveDocument, checkTemplate });
    const controller = new AbortController();
    const tools = createDocxTools(api, { signal: controller.signal });

    expect(await tools.save_docx_document.execute({
      session_id: "s1", expected_revision: 3,
    })).toMatchObject({ baselineId: "b2", revision: 3 });
    expect(await tools.check_docx_template.execute({
      session_id: "s1", template: "world-v7",
    })).toEqual({
      template: "world-v7",
      check: { project_id: "paper" },
    });
    expect(saveDocument).toHaveBeenCalledWith(
      "s1",
      3,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(checkTemplate).toHaveBeenCalledWith(
      "s1",
      "world-v7",
      expect.objectContaining({ signal: controller.signal }),
    );

    const saved = new AbortController();
    expect(await createDocxTools(host({
      saveDocument: vi.fn(async () => {
        saved.abort();
        return {
          baselineId: "b2", revision: 3, sourceSha256: "d".repeat(64),
          document: { sessionId: "s1", baselineId: "b2", sessionRevision: 3,
            savedRevision: 3, dirty: false },
        };
      }),
    }), { signal: saved.signal }).save_docx_document.execute({
      expected_revision: 3,
    })).toMatchObject({ baselineId: "b2", revision: 3 });

    const checked = new AbortController();
    expect(await createDocxTools(host({
      checkTemplate: vi.fn(async () => {
        checked.abort();
        return { template: "world-v7", check: { check_id: "check-7" } };
      }),
    }), { signal: checked.signal }).check_docx_template.execute({
      template: "world-v7",
    })).toMatchObject({ template: "world-v7", check: { check_id: "check-7" } });
  });

  it("returns unavailable capabilities instead of inventing a fallback", async () => {
    const tools = createDocxTools(host());
    for (const [run, error] of [
      [() => tools.read_docx_format.execute({}), "Live DOCX format reading is unavailable."],
      [() => tools.apply_docx_format.execute({ paragraph_ref: "para-1",
        expected_revision: 2, font: { bold: true } }), "Live DOCX formatting is unavailable."],
      [() => tools.save_docx_document.execute({ expected_revision: 2 }),
        "Live DOCX saving is unavailable."],
      [() => tools.check_docx_template.execute({ template: "world-v7" }),
        "Explicit DOCX template checking is unavailable."],
    ] as const) expect(await run()).toEqual({ unavailable: true, error });
  });
});

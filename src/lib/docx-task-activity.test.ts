import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _arguments: unknown): Promise<unknown> => undefined), listen: vi.fn(async () => vi.fn()),
  list: vi.fn(), read: vi.fn(), readPage: vi.fn(), readImage: vi.fn(), capture: vi.fn(), propose: vi.fn(), present: vi.fn(), identity: vi.fn(),
  taskOperation: vi.fn(),
  settleOperation: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/docx-agent-host", () => ({ listTaskDocxDocuments: mocks.list, readTaskDocxDocumentPage: mocks.readPage,
  readTaskDocxImage: mocks.readImage, captureTaskDocxTarget: mocks.capture, validateTaskDocxProposal: mocks.propose,
  presentTaskDocxProposal: mocks.present, docxTaskDocument: mocks.identity,
  runTaskDocxOperation: mocks.taskOperation, settleTaskDocxOperation: mocks.settleOperation }));
import { bindDocxTask, handleDocxRendererRequest, loadDocxTaskActivities, mountDocxTaskBridge, settleDocxTaskActivity, subscribeDocxTaskActivity, type DocxActivity, type DocxRendererRequest } from "./docx-task-activity";
const request: DocxRendererRequest = { token: "token", projectId: "app", workbenchProjectId: "paper", operation: "read", arguments: { session_id: "session", offset: 20, limit: 10 } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
});
function listener() {
  return (mocks.listen.mock.calls as unknown as [string, (event: { payload: DocxRendererRequest }) => Promise<void>][])[0][1];
}
const proposalRequest: DocxRendererRequest = {
  ...request, operation: "present", arguments: { activity: { id: "proposal" } as DocxActivity },
};
describe("task DOCX renderer bridge", () => {
  it("returns the native document identity when reading a dirty working copy", () => {
    const document = { sessionId: "session", appProjectId: "app", workbenchProjectId: "paper",
      baselineId: "baseline", sourceSha256: "a".repeat(64), sessionRevision: 7, savedRevision: 6 };
    mocks.identity.mockReturnValueOnce(document);
    mocks.readPage.mockReturnValueOnce({ document: { ...document, dirty: true, filename: "paper.docx", title: "Paper" },
      paragraphs: [], offset: 20, nextOffset: null, totalParagraphs: 20, nextQuery: null });
    const result = handleDocxRendererRequest(request) as { document: Record<string, unknown> };
    expect(result.document).toEqual(document);
    expect(result.document).not.toHaveProperty("dirty");
    expect(mocks.identity).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session");
  });

  it.each(["before commit", "after commit"] as const)("rechecks native task generation and retains the receipt when cancelled %s", async (cancelled) => {
    let active = true;
    const committed = vi.fn();
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "research_docx_request_validate" && !active) throw new Error("This DOCX task execution is no longer active.");
      return command === "research_docx_result";
    });
    mocks.taskOperation.mockImplementationOnce(async (scope: { beforeCommit(): Promise<void> }) => {
      // The template finishes loading after the generation was cancelled or retried.
      if (cancelled === "before commit") active = false;
      await scope.beforeCommit();
      committed();
      active = false;
      return { operation: "import_styles", ok: true };
    });
    await mountDocxTaskBridge();
    await listener()({ payload: { ...request, operation: "import_styles", operationId: "styles-intent",
      arguments: { session_id: "session", expected_revision: 1, template: "world", style_ids: ["Title"] } } });
    expect(mocks.invoke).toHaveBeenCalledWith("research_docx_request_validate", { token: request.token });
    if (cancelled === "before commit") {
      expect(committed).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", { token: request.token, result: undefined,
        error: "Error: This DOCX task execution is no longer active." });
    } else {
      expect(committed).toHaveBeenCalledOnce();
      expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", { token: request.token,
        result: { operation: "import_styles", ok: true }, error: undefined });
      expect(mocks.settleOperation).toHaveBeenCalledOnce();
    }
  });
  it("forwards runtime origin and bound context/navigation/font/export calls", async () => {
    const origin = { kind: "task" as const, taskId: "actual-task", generation: 4 };
    for (const operation of ["context", "prepare_fonts", "export"] as const) {
      await handleDocxRendererRequest({ ...request, origin, operation, arguments: { session_id: "session" } });
      expect(mocks.taskOperation).toHaveBeenLastCalledWith({ projectId: "app", workbenchProjectId: "paper", origin }, "session", operation, {});
    }
    await handleDocxRendererRequest({ ...request, origin, operation: "reveal", arguments: {
      session_id: "session", paragraph_ref: "p1", expected_revision: 7,
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith({ projectId: "app", workbenchProjectId: "paper", origin }, "session", "reveal", { paragraphRef: "p1", expectedRevision: 7 });
  });
  it("passes exact captured revision and session identity when binding, while preserving old callers", async () => {
    const identity = { sessionId: "session", appProjectId: "app", workbenchProjectId: "paper", baselineId: "b", sourceSha256: "hash", sessionRevision: 4, savedRevision: 3 };
    await bindDocxTask("app", "task", "session", 4, identity);
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_bind_task", { projectId: "app", taskId: "task", sessionId: "session", expectedRevision: 4, expectedSessionIdentity: identity });
    await bindDocxTask("app", "task", "session");
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_bind_task", { projectId: "app", taskId: "task", sessionId: "session" });
  });
  it("keeps style source and selection on the task-bound session", async () => {
    await handleDocxRendererRequest({ ...request, operation: "import_styles", arguments: { session_id: "session", expected_revision: 2, template: "world-selected", style_ids: ["Title"] } });
    expect(mocks.taskOperation).toHaveBeenCalledExactlyOnceWith({ projectId: "app", workbenchProjectId: "paper" }, "session", "import_styles", { expectedRevision: 2, template: "world-selected", styleIds: ["Title"] });
  });
  it("keeps batch formats and unified reading fields on the explicitly bound task", async () => {
    const operations = [{ paragraphRef: "p1", range: { start: 2, end: 4 }, font: { bold: true } }];
    await handleDocxRendererRequest({ ...request, operation: "format_batch", arguments: {
      session_id: "session", expected_revision: 2, operations,
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session", "format_batch", { expectedRevision: 2, operations });
    await handleDocxRendererRequest({ ...request, operation: "read_format", arguments: {
      query: { kind: "paragraphs", object_id: "object", role: "heading", text_offset: 5, text_limit: 30 },
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith({ projectId: "app", workbenchProjectId: "paper" }, undefined,
      "read_format", { query: { kind: "paragraphs", objectId: "object", role: "heading", textOffset: 5, textLimit: 30 } });
  });
  it("keeps the read revision when continuing a retained format window", async () => {
    await handleDocxRendererRequest({ ...request, operation: "read_format", arguments: {
      session_id: "session", query: { kind: "paragraphs", expected_revision: 7, offset: 50, limit: 20 },
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session",
      "read_format", { query: { kind: "paragraphs", expectedRevision: 7, offset: 50, limit: 20 } });
  });
  it("forwards a complete bound equation request with camelCase arguments", async () => {
    await handleDocxRendererRequest({ ...request, operation: "write_equation", arguments: {
      session_id: "session",
      paragraph_ref: "p1",
      expected_revision: 7,
      latex: "x^2",
      macros: "\\newcommand{\\R}{\\mathbb{R}}",
      object_ref: "math-1",
      expected_fingerprint: "fingerprint-1",
      adopt_source: true,
      offset: 3,
      display: false,
    } });
    expect(mocks.taskOperation).toHaveBeenCalledExactlyOnceWith(
      { projectId: "app", workbenchProjectId: "paper" },
      "session",
      "write_equation",
      {
        paragraphRef: "p1",
        expectedRevision: 7,
        latex: "x^2",
        macros: "\\newcommand{\\R}{\\mathbb{R}}",
        objectRef: "math-1",
        expectedFingerprint: "fingerprint-1",
        adoptSource: true,
        offset: 3,
        display: false,
      },
    );
  });
  it("returns metadata with pixels on an independent task image payload", async () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 1);
    view.setUint32(20, 1);
    mocks.readImage.mockResolvedValueOnce({
      revision: 7,
      objectRef: "drawing-1",
      part: "word/document.xml",
      relationshipId: "rId7",
      mediaPart: "word/media/image1.png",
      mimeType: "image/png",
      bytes,
      imageSha256: "d".repeat(64),
      document: {
        sessionId: "session", appProjectId: "app", workbenchProjectId: "paper",
        title: "Paper", filename: "paper.docx", baselineId: "baseline",
        sourceSha256: "a".repeat(64), sessionRevision: 7, savedRevision: 6, dirty: true,
      },
      sourceSha256: "a".repeat(64),
    });
    mocks.identity.mockReturnValueOnce({
      sessionId: "session", appProjectId: "app", workbenchProjectId: "paper",
      baselineId: "baseline", sourceSha256: "a".repeat(64),
      sessionRevision: 7, savedRevision: 6,
    });
    const result = await handleDocxRendererRequest({
      ...request,
      operation: "read_image",
      arguments: {
        session_id: "session",
        paragraph_ref: "p1",
        object_ref: "drawing-1",
        expected_revision: 7,
      },
    }) as {
      image: string;
      result: Record<string, unknown>;
      document: Record<string, unknown>;
    };
    expect(mocks.readImage).toHaveBeenCalledExactlyOnceWith(
      { projectId: "app", workbenchProjectId: "paper" },
      "session",
      { paragraphRef: "p1", objectRef: "drawing-1", expectedRevision: 7 },
    );
    expect(result.image).toBe(
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
    expect(result.result).toMatchObject({
      source: "live-docx", imageReadComplete: true, contentStatus: "pixels_provided",
      objectRef: "drawing-1", sourceSha256: "a".repeat(64),
      document: { sessionId: "session", sessionRevision: 7, sourceSha256: "a".repeat(64) },
      mediaPart: "word/media/image1.png", width: 1, height: 1,
    });
    expect(result.result).not.toHaveProperty("complete");
    expect(JSON.stringify(result.result)).not.toContain("base64");
    expect(result.document).toMatchObject({ sessionId: "session", sessionRevision: 7 });
  });
  it("refuses an image receipt when the task document advanced after its bytes were read", async () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 1);
    view.setUint32(20, 1);
    mocks.readImage.mockResolvedValueOnce({
      revision: 7,
      objectRef: "drawing-1",
      part: "word/document.xml",
      relationshipId: "rId7",
      mediaPart: "word/media/image1.png",
      mimeType: "image/png",
      bytes,
      imageSha256: "d".repeat(64),
      document: {
        sessionId: "session", appProjectId: "app", workbenchProjectId: "paper",
        title: "Paper", filename: "paper.docx", baselineId: "baseline",
        sourceSha256: "a".repeat(64), sessionRevision: 7, savedRevision: 6, dirty: true,
      },
      sourceSha256: "a".repeat(64),
    });
    mocks.identity.mockReturnValueOnce({
      sessionId: "session", appProjectId: "app", workbenchProjectId: "paper",
      baselineId: "baseline", sourceSha256: "a".repeat(64),
      sessionRevision: 8, savedRevision: 7,
    });
    await expect(handleDocxRendererRequest({
      ...request,
      operation: "read_image",
      arguments: {
        session_id: "session",
        paragraph_ref: "p1",
        object_ref: "drawing-1",
        expected_revision: 7,
      },
    })).rejects.toThrow("image changed before its document receipt was built");
  });
  it("routes explicit backend scope and snake_case arguments without UI task selection", () => {
    mocks.readPage.mockReturnValueOnce({
      document: { sessionId: "session" }, paragraphs: [], offset: 20, nextOffset: null,
      totalParagraphs: 20, nextQuery: null,
    });
    handleDocxRendererRequest({ ...request, operation: "identity", workbenchProjectId: null });
    expect(mocks.identity).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: null }, "session");
    expect(mocks.readPage).not.toHaveBeenCalled();
    handleDocxRendererRequest(request);
    expect(mocks.readPage).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session", {
      sessionId: "session", offset: 20, limit: 10,
    });
    handleDocxRendererRequest({ ...request, operation: "list" });
    expect(mocks.list).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session");
    handleDocxRendererRequest({ ...request, operation: "propose", arguments: { session_id: "session", target_id: "target", expected_revision: 2, text: "Task's own text" } });
    expect(mocks.propose).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "target", 2, "Task's own text", "session");
    expect(mocks.present).not.toHaveBeenCalled();
  });
  it("forwards live formatter, save and check operations with the bound scope", async () => {
    const scope = { projectId: "app", workbenchProjectId: "paper" };
    await handleDocxRendererRequest({ ...request, operation: "read_format", arguments: {
      session_id: "session", query: {
        kind: "nodes", paragraph_ref: "p1", part: "word/document.xml", path: [1, 2],
        namespace_uri: "urn:document", local_name: "p",
        attribute: { namespace_uri: "urn:attribute", local_name: "id", value: "target" },
        offset: 2, limit: 10,
      },
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "read_format", {
      query: {
        kind: "nodes", paragraphRef: "p1", part: "word/document.xml", path: [1, 2],
        namespaceUri: "urn:document", localName: "p",
        attribute: { namespaceUri: "urn:attribute", localName: "id", value: "target" },
        offset: 2, limit: 10,
      },
    });

    await handleDocxRendererRequest({ ...request, operation: "apply", arguments: {
      session_id: "session", target_id: "target", expected_revision: 2, text: "Replacement",
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "apply", {
      targetId: "target", expectedRevision: 2, text: "Replacement",
    });

    await handleDocxRendererRequest({ ...request, operation: "format", arguments: {
      session_id: "session", paragraph_ref: "p1", expected_revision: 2,
      format: { font: { bold: true } },
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "format", {
      paragraphRef: "p1", expectedRevision: 2, format: { font: { bold: true } },
    });

    await handleDocxRendererRequest({ ...request, operation: "format", arguments: {
      session_id: "session", paragraph_ref: "p1", expected_revision: 2,
      object_format: { kind: "cell", cell: { fill: "D9EAF7" } },
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "format", {
      paragraphRef: "p1", expectedRevision: 2, objectFormat: { kind: "cell", cell: { fill: "D9EAF7" } },
    });

    await handleDocxRendererRequest({ ...request, operation: "save", arguments: {
      session_id: "session", expected_revision: 2,
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "save", {
      expectedRevision: 2,
    });

    await handleDocxRendererRequest({ ...request, operation: "check", arguments: {
      session_id: "session", template: "world-v7",
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "check", {
      template: "world-v7",
    });
  });
  it("forwards complete read and range continuations to the bound session", async () => {
    const scope = { projectId: "app", workbenchProjectId: "paper" };
    mocks.readPage.mockReturnValueOnce({
      document: { sessionId: "session" }, paragraphs: [{
        paragraphRef: "p1", text: "Display", modelText: "Model", displayText: "Display",
        revision: 7, atoms: [{
          objectRef: "field", kind: "field", modelRange: { start: 0, end: 1 },
          displayRange: { start: 0, end: 1 }, complete: true, editable: false,
          payloadJson: "{\"code\":", payloadOffset: 0, payloadLength: 20,
          payloadContinuation: {
            sessionId: "session", offset: 3, limit: 1, expectedRevision: 7,
            textOffset: 20, textLimit: 40, atomOffset: 2, payloadOffset: 8,
          },
        }], editableRanges: [],
      }], offset: 3, nextOffset: null, totalParagraphs: 4, nextQuery: {
        sessionId: "session", offset: 3, limit: 1, expectedRevision: 7,
        textOffset: 20, textLimit: 40, atomOffset: 2,
      },
    });
    const page = await handleDocxRendererRequest({ ...request, operation: "read", arguments: {
      session_id: "session", offset: 3, limit: 1, expected_revision: 7,
      text_offset: 20, text_limit: 40, atom_offset: 2, payload_offset: 100,
    } }) as { next_query?: unknown; nextQuery?: unknown; paragraphs: { atoms: Record<string, unknown>[] }[] };
    expect(mocks.readPage).toHaveBeenCalledWith(scope, "session", {
      sessionId: "session", offset: 3, limit: 1, expectedRevision: 7,
      textOffset: 20, textLimit: 40, atomOffset: 2, payloadOffset: 100,
    });
    expect(page).toMatchObject({
      next_query: {
        session_id: "session", offset: 3, limit: 1, expected_revision: 7,
        text_offset: 20, text_limit: 40, atom_offset: 2,
      },
      paragraphs: [{ atoms: [{ payload_continuation: {
        session_id: "session", offset: 3, limit: 1, expected_revision: 7,
        text_offset: 20, text_limit: 40, atom_offset: 2, payload_offset: 8,
      } }] }],
    });
    expect(page).not.toHaveProperty("nextQuery");
    expect(page.paragraphs[0].atoms[0]).not.toHaveProperty("payloadContinuation");
    await handleDocxRendererRequest({ ...request, operation: "replace_range", arguments: {
      session_id: "session", paragraph_ref: "p1", expected_revision: 7,
      range: { start: 2, end: 5 }, expected_text: "old", replacement: "new",
    } });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(scope, "session", "replace_range", {
      paragraphRef: "p1", expectedRevision: 7, range: { start: 2, end: 5 },
      expectedText: "old", replacement: "new",
    });
  });
  it("reads a default native request with explicit null optional fields", async () => {
    mocks.readPage.mockReturnValueOnce({
      document: { sessionId: "session" }, paragraphs: [], offset: 0, nextOffset: null,
      totalParagraphs: 1, nextQuery: null,
    });
    const page = handleDocxRendererRequest({ ...request, arguments: {
      expected_revision: null, text_offset: null, text_limit: null,
      atom_offset: null, payload_offset: null,
    } } as unknown as DocxRendererRequest);
    expect(mocks.readPage).toHaveBeenCalledWith(
      { projectId: "app", workbenchProjectId: "paper" }, undefined,
      { offset: 0, limit: 20 },
    );
    expect(page).toMatchObject({ next_query: null });
  });
  it("replies using the request token on success and failure and unmounts the listener", async () => {
    const stop = await mountDocxTaskBridge();
    const callback = listener();
    mocks.readPage.mockReturnValue({ paragraphs: [] });
    await callback({ payload: request });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "research_docx_request_claim", { token: "token" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", { token: "token", result: { paragraphs: [] }, error: undefined });
    mocks.readPage.mockImplementationOnce(() => { throw new Error("Session closed"); });
    await callback({ payload: { ...request, token: "error-token" } });
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", { token: "error-token", result: undefined, error: "Error: Session closed" });
    stop();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("waits for native claim before presenting and acknowledges only after handling", async () => {
    await mountDocxTaskBridge();
    let claim!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { claim = resolve; }));
    const pending = listener()({ payload: proposalRequest });
    expect(mocks.present).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    claim();
    await pending;
    expect(mocks.present).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", {
      token: "token", result: { presented: true }, error: undefined,
    });
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.present.mock.invocationCallOrder[0]);
    expect(mocks.present.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[1]);
  });
  it("releases the checkpoint only after native confirms the actual operation was recorded", async () => {
    await mountDocxTaskBridge();
    mocks.taskOperation.mockResolvedValue({ operation: "save", ok: true });
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    const savedRequest: DocxRendererRequest = {
      ...request, operation: "save", operationId: "save-intent",
      arguments: { session_id: "session", expected_revision: 1 },
    };
    await listener()({ payload: savedRequest });
    expect(mocks.settleOperation).toHaveBeenCalledExactlyOnceWith(
      { projectId: "app", workbenchProjectId: "paper" }, "save-intent", "session",
    );
    expect(mocks.invoke.mock.invocationCallOrder[1]).toBeLessThan(mocks.settleOperation.mock.invocationCallOrder[0]);
    mocks.settleOperation.mockClear();
    await listener()({ payload: savedRequest });
    expect(mocks.settleOperation).not.toHaveBeenCalled();
  });
  it("refreshes retained activity as soon as native records a direct operation, even when recovery cleanup fails", async () => {
    await mountDocxTaskBridge();
    const refresh = vi.fn();
    const stop = subscribeDocxTaskActivity(refresh);
    mocks.taskOperation.mockResolvedValue({ operation: "save", ok: true });
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    mocks.settleOperation.mockImplementationOnce(async () => {
      expect(refresh).toHaveBeenCalledOnce();
      throw new Error("Recovery cleanup is unavailable");
    });
    const savedRequest: DocxRendererRequest = {
      ...request, operation: "save", operationId: "save-intent",
      arguments: { session_id: "session", expected_revision: 1 },
    };
    try {
      await listener()({ payload: savedRequest });
      expect(refresh).toHaveBeenCalledOnce();
      await listener()({ payload: savedRequest });
      expect(refresh).toHaveBeenCalledOnce();
    } finally { stop(); }
  });
  it("waits for save acknowledgement cleanup before claiming the next task edit", async () => {
    await mountDocxTaskBridge();
    let finish!: () => void;
    mocks.settleOperation.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    const first = listener()({ payload: {
      ...request, operation: "save", operationId: "save-intent",
      arguments: { session_id: "session", expected_revision: 1 },
    } });
    await vi.waitFor(() => expect(mocks.settleOperation).toHaveBeenCalledOnce());
    const next = listener()({ payload: { ...request, token: "next-edit" } });
    expect(mocks.invoke.mock.calls.map((call) => call[1])).not.toContainEqual({ token: "next-edit" });
    finish();
    await Promise.all([first, next]);
    expect(mocks.invoke).toHaveBeenCalledWith("research_docx_request_claim", { token: "next-edit" });
  });
  it.each(["cancelled", "expired"])("does not present a %s request when native claim rejects", async (reason) => {
    await mountDocxTaskBridge();
    mocks.invoke.mockRejectedValueOnce(new Error(reason));
    await listener()({ payload: proposalRequest });
    expect(mocks.present).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("research_docx_request_claim", { token: "token" });
  });
  it("does not present or acknowledge a duplicate token after its first claim", async () => {
    await mountDocxTaskBridge();
    const callback = listener();
    await callback({ payload: proposalRequest });
    mocks.invoke.mockRejectedValueOnce(new Error("Already claimed"));
    await callback({ payload: proposalRequest });
    expect(mocks.present).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      "research_docx_request_claim", "research_docx_result", "research_docx_request_claim",
    ]);
  });
  it("settles by retained proposal ID and never supplies invented task/member attribution", async () => {
    const document = { sessionId: "s", appProjectId: "app", workbenchProjectId: "paper", baselineId: "b", sourceSha256: "a".repeat(64), sessionRevision: 3, savedRevision: -1 };
    await settleDocxTaskActivity("app", "paper", "proposal", document, { kind: "applied" });
    expect(mocks.invoke).toHaveBeenCalledWith("research_docx_activity_settle", { projectId: "app", workbenchProjectId: "paper", proposalId: "proposal", document, outcome: { kind: "applied" } });
  });

  it("loads retained activity with the public default cursor and page size", async () => {
    await loadDocxTaskActivities("app", "paper");
    expect(mocks.invoke).toHaveBeenCalledWith("research_docx_activities", {
      projectId: "app",
      workbenchProjectId: "paper",
      afterCursor: 0,
      limit: 20,
    });
  });

  it.each([
    ["read_image", {}, "paragraph_ref, object_ref and expected_revision"],
    ["capture", {}, "paragraph_ref is required"],
    ["propose", { target_id: "target", expected_revision: 1 }, "target_id, expected_revision and text"],
    ["present", {}, "retained activity is required"],
    ["replace_range", { paragraph_ref: "p1", expected_revision: 1, range: { start: 0, end: 1 }, expected_text: "a" }, "replacement are required"],
    ["write_equation", { paragraph_ref: "p1", expected_revision: 1 }, "paragraph_ref, expected_revision and latex"],
    ["format", { paragraph_ref: "p1", expected_revision: 1 }, "a format are required"],
    ["format_batch", { expected_revision: 1 }, "expected_revision and operations"],
    ["import_styles", { expected_revision: 1, template: "world" }, "template, style_ids and expected_revision"],
    ["apply", { target_id: "target", expected_revision: 1 }, "target_id, expected_revision and text"],
    ["save", {}, "expected_revision is required"],
    ["check", {}, "template world version is required"],
  ] as const)("rejects incomplete %s requests before touching a document", (operation, args, message) => {
    expect(() => handleDocxRendererRequest({
      ...request,
      operation,
      arguments: args as DocxRendererRequest["arguments"],
    })).toThrow(message);
    expect(mocks.readImage).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.taskOperation).not.toHaveBeenCalled();
  });

  it("normalizes every optional format-read selector and supplies defaults for an empty query", () => {
    handleDocxRendererRequest({
      ...request,
      operation: "read_format",
      arguments: { session_id: "session" },
    });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(
      { projectId: "app", workbenchProjectId: "paper" },
      "session",
      "read_format",
      { query: {} },
    );

    handleDocxRendererRequest({
      ...request,
      operation: "read_format",
      arguments: {
        session_id: "session",
        query: {
          kind: "nodes",
          object_kind: "run",
          style_id: "Strong",
          object_id: "run-1",
          text: "needle",
          path: [1, "stale", 2.5, 3],
          attribute: { namespace_uri: "urn:attribute", local_name: "id" },
        },
      },
    });
    expect(mocks.taskOperation).toHaveBeenLastCalledWith(
      { projectId: "app", workbenchProjectId: "paper" },
      "session",
      "read_format",
      {
        query: {
          kind: "nodes",
          objectKind: "run",
          styleId: "Strong",
          objectId: "run-1",
          text: "needle",
          path: [1, 3],
          attribute: { localName: "id", namespaceUri: "urn:attribute" },
        },
      },
    );
  });
});

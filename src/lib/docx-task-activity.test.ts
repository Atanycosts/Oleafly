import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _arguments: unknown): Promise<void> => {}), listen: vi.fn(async () => vi.fn()),
  list: vi.fn(), read: vi.fn(), capture: vi.fn(), propose: vi.fn(), present: vi.fn(), identity: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/docx-agent-host", () => ({ listTaskDocxDocuments: mocks.list, readTaskDocxDocument: mocks.read,
  captureTaskDocxTarget: mocks.capture, validateTaskDocxProposal: mocks.propose,
  presentTaskDocxProposal: mocks.present, docxTaskDocument: mocks.identity }));
import { handleDocxRendererRequest, mountDocxTaskBridge, settleDocxTaskActivity, type DocxActivity, type DocxRendererRequest } from "./docx-task-activity";
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
  it("routes explicit backend scope and snake_case arguments without UI task selection", () => {
    handleDocxRendererRequest({ ...request, operation: "identity", workbenchProjectId: null });
    expect(mocks.identity).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: null }, "session");
    expect(mocks.read).not.toHaveBeenCalled();
    handleDocxRendererRequest(request);
    expect(mocks.read).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session", 20, 10);
    handleDocxRendererRequest({ ...request, operation: "list" });
    expect(mocks.list).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "session");
    handleDocxRendererRequest({ ...request, operation: "propose", arguments: { session_id: "session", target_id: "target", expected_revision: 2, text: "Task's own text" } });
    expect(mocks.propose).toHaveBeenCalledWith({ projectId: "app", workbenchProjectId: "paper" }, "target", 2, "Task's own text", "session");
    expect(mocks.present).not.toHaveBeenCalled();
  });
  it("replies using the request token on success and failure and unmounts the listener", async () => {
    const stop = await mountDocxTaskBridge();
    const callback = listener();
    mocks.read.mockReturnValue({ paragraphs: [] });
    await callback({ payload: request });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "research_docx_request_claim", { token: "token" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("research_docx_result", { token: "token", result: { paragraphs: [] }, error: undefined });
    mocks.read.mockImplementationOnce(() => { throw new Error("Session closed"); });
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
});

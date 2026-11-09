import { beforeEach, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
const state = vi.hoisted(() => ({
  files: { projectId: "paper", activePath: "methods.tex", mainDoc: "paper.tex", docVersion: 12 },
  runtime: "built-in", readFileContent: vi.fn(),
  config: { ai_provider: "selected", ai_model: "model" },
}));
vi.mock("@/store/files", () => ({ useFilesStore: { getState: () => state.files } }));
vi.mock("@/store/assistant-runtime", () => ({ useAssistantRuntimeStore: { getState: () => ({ runtime: state.runtime }) }, selectActiveRuntime: (s: {runtime:string}) => s.runtime }));
vi.mock("@/store/acp-sessions", () => ({ useAcpSessionsStore: { getState: () => ({ activeByProject: {}, sessions: {}, composers: {} }) } }));
vi.mock("@/lib/tauri", () => ({ readFileContent: state.readFileContent }));
vi.mock("@/components/ai/provider-config", () => ({ knownProviderConfig: () => state.config, loadProviderConfig: vi.fn(), deriveProviderState: (cfg: typeof state.config) => ({ provider: cfg.ai_provider, model: cfg.ai_model, ready: true }) }));
import { captureAssistantDelegation } from "./assistant-delegation-capture";
import { delegationContext, textSha256 } from "./assistant-delegation";
beforeEach(() => {
  state.files = { projectId: "paper", activePath: "methods.tex", mainDoc: "paper.tex", docVersion: 12 };
  state.runtime = "built-in";
  state.config = { ai_provider: "selected", ai_model: "model" };
  state.readFileContent.mockReset();
});
it("captures target, buffer and model before asynchronous disk reads and navigation", async () => {
  let resolve: (value: string) => void = () => {};
  state.readFileContent.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  const source = "a😀buffer";
  const view = { state: { doc: { toString: () => source }, selection: { main: { from: 1, to: 3 } }, sliceDoc: () => "😀" } } as unknown as EditorView;
  const pending = captureAssistantDelegation(view);
  state.files = { projectId: "other", activePath: "main.tex", mainDoc: "main.tex", docVersion: 90 };
  state.config = { ai_provider: "changed", ai_model: "new" };
  resolve("disk\r\n");
  const result = await pending;
  expect(result).toMatchObject({ projectId: "paper", path: "methods.tex", mainDocument: "paper.tex", editorDocVersion: 12, agentId: "selected", modelId: "model", sourceContent: source, selection: { from: 1, to: 3, text: "😀" } });
  expect(result.sourceSha256).toBe(await textSha256(source));
  expect(result.diskSha256).toBe(await textSha256("disk\n"));
  expect(state.readFileContent).toHaveBeenCalledWith("paper", "methods.tex");
  expect(delegationContext(result)).not.toContain('"sourceContent"');
});

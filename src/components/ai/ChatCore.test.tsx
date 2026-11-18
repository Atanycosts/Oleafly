// @vitest-environment jsdom

import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, ToolSet } from "@/lib/chat-types";
import type { ChatMessage, StoredChat } from "@/store/chats";
import enAi from "@/i18n/locales/en/ai.json" with { type: "json" };

interface RunOutcome {
  text: string;
  usage: { input: number; output: number };
  steps: number;
  stopped_at_cap: boolean;
  error: string | null;
}

interface HarnessOptions {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  signal?: AbortSignal;
  providerOverride?: { provider_id: string; model_id: string };
  effort?: string;
  web?: { search: boolean; fetch: boolean };
  onRequestId?: (requestId: string) => void;
  handlers: {
    onActivity?: () => void;
    onThinking?: (label: string) => void;
    onStep?: (step: number) => void;
    onRetry?: (attempt: number, max: number) => void;
    onText: (chunk: string) => void;
    onToolCall: (call: { id: string; name: string; args: unknown }) => void | Promise<void>;
    onToolResult: (result: { id: string; output: unknown }) => void;
    onNotice?: (code: string, detail: string | null) => void;
  };
}

interface PendingRun {
  options: HarnessOptions;
  resolve: (outcome: RunOutcome) => void;
  reject: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  runs: [] as PendingRun[],
  runAgentHarness: vi.fn(),
  agentProbeModel: vi.fn(),
  approvalsList: vi.fn(),
  approvalsModeGet: vi.fn(),
  getConfig: vi.fn(),
  mcpAgentToolsList: vi.fn(),
  refetchMcp: vi.fn(),
  refetchSkills: vi.fn(),
  agentSteer: vi.fn(),
  agentThreadRead: vi.fn(),
  agentThreadArchive: vi.fn(),
  agentThreadFork: vi.fn(),
  agentThreadRollback: vi.fn(),
  agentThreadDelete: vi.fn(),
  claimPrewarmed: vi.fn(),
  providerCredit: vi.fn(),
  chatRead: vi.fn(),
  readFileContent: vi.fn(),
  gitHeadOid: vi.fn(),
  gitLog: vi.fn(),
  gitShow: vi.fn(),
  gitStatus: vi.fn(),
  flushOpenFilesToDisk: vi.fn(),
  agentTurnBegin: vi.fn(),
  agentTurnFinish: vi.fn(),
  agentTurnStatus: vi.fn(),
  agentTurnRevert: vi.fn(),
  checkProjectBudget: vi.fn(),
  buildWorkspaceContext: vi.fn(),
  retrieveProjectChunks: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  logError: vi.fn(),
  registry: [] as unknown[],
}));

const scrollTo = vi.fn();

vi.mock("./agent-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-turn")>()),
  runAgentHarness: (options: HarnessOptions) => mocks.runAgentHarness(options),
}));

vi.mock("@/lib/agent-backend", () => ({
  agentSteer: (...args: unknown[]) => mocks.agentSteer(...args),
  agentThreadRead: (...args: unknown[]) => mocks.agentThreadRead(...args),
  agentThreadArchive: (...args: unknown[]) => mocks.agentThreadArchive(...args),
  agentThreadFork: (...args: unknown[]) => mocks.agentThreadFork(...args),
  agentThreadRollback: (...args: unknown[]) => mocks.agentThreadRollback(...args),
  agentThreadDelete: (...args: unknown[]) => mocks.agentThreadDelete(...args),
  agentThreadClaimPrewarmed: (...args: unknown[]) => mocks.claimPrewarmed(...args),
  providerCredit: (...args: unknown[]) => mocks.providerCredit(...args),
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  agentProbeModel: (...args: unknown[]) => mocks.agentProbeModel(...args),
  approvalsList: (...args: unknown[]) => mocks.approvalsList(...args),
  approvalsSet: vi.fn().mockResolvedValue(undefined),
  approvalsModeGet: (...args: unknown[]) => mocks.approvalsModeGet(...args),
  approvalsModeSet: vi.fn().mockResolvedValue(undefined),
  chatRead: (...args: unknown[]) => mocks.chatRead(...args),
  getConfig: (...args: unknown[]) => mocks.getConfig(...args),
  gitHeadOid: (...args: unknown[]) => mocks.gitHeadOid(...args),
  gitLog: (...args: unknown[]) => mocks.gitLog(...args),
  gitShow: (...args: unknown[]) => mocks.gitShow(...args),
  gitStatus: (...args: unknown[]) => mocks.gitStatus(...args),
  mcpAgentToolsList: (...args: unknown[]) => mocks.mcpAgentToolsList(...args),
  readFileContent: (...args: unknown[]) => mocks.readFileContent(...args),
}));

vi.mock("@/lib/external-file-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/external-file-changes")>()),
  flushOpenFilesToDisk: (...args: unknown[]) => mocks.flushOpenFilesToDisk(...args),
}));

vi.mock("@/lib/agent-turns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-turns")>()),
  agentTurnBegin: (...args: unknown[]) => mocks.agentTurnBegin(...args),
  agentTurnFinish: (...args: unknown[]) => mocks.agentTurnFinish(...args),
  agentTurnStatus: (...args: unknown[]) => mocks.agentTurnStatus(...args),
  agentTurnRevert: (...args: unknown[]) => mocks.agentTurnRevert(...args),
}));

vi.mock("@/lib/ai-budget", () => ({
  checkProjectBudget: (...args: unknown[]) => mocks.checkProjectBudget(...args),
}));

vi.mock("@/lib/ai-context", () => ({
  buildWorkspaceContext: (...args: unknown[]) => mocks.buildWorkspaceContext(...args),
}));

vi.mock("@/lib/ai-rag", () => ({
  formatRagContext: () => "",
  retrieveProjectChunks: (...args: unknown[]) => mocks.retrieveProjectChunks(...args),
}));

vi.mock("@/lib/mcp-agent-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp-agent-tools")>()),
  useMcpAgentTools: () => ({
    data: [],
    error: null,
    refetch: mocks.refetchMcp,
  }),
}));

vi.mock("@/lib/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/skills")>()),
  useSkills: () => ({
    data: [],
    refetch: mocks.refetchSkills,
  }),
}));

vi.mock("@/contributions/load-ai-toolsets", () => ({
  loadAiToolsets: async () => mocks.registry,
  useAiToolsets: () => mocks.registry,
}));

vi.mock("@/contributions/ai-toolsets", () => ({
  registerAiToolsets: () => {},
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    errorUnique: vi.fn(),
    success: vi.fn(),
    info: (...args: unknown[]) => mocks.toastInfo(...args),
  },
}));

vi.mock("@/lib/log", () => ({
  logError: (...args: unknown[]) => mocks.logError(...args),
}));

vi.mock("@/components/ai/SubagentActivity", () => ({
  SubagentActivity: () => null,
}));

vi.mock("@/components/ai/ChatHistoryModal", () => ({
  ChatHistoryModal: () => null,
}));

vi.mock("@/components/branding/OleaflyAssistantMascot", () => ({
  OleaflyAssistantMascot: () => null,
}));

vi.mock("@/components/ai/activity/SessionTranscriptDialog", () => ({
  SessionTranscriptDialog: () => null,
}));

vi.mock("@/components/ai/chat-parts", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@/components/ai/chat-parts")>();
  return {
    ...actual,
    MessageItem: ({ msg }: { msg: ChatMessage }) =>
      React.createElement(
        "div",
        {
          "data-message-id": msg.id,
          "data-message-role": msg.role,
          "data-message-content": msg.content,
        },
        msg.content || null,
      ),
  };
});

vi.mock("@/store/acp-sessions", () => {
  const state = {
    open: async () => undefined,
    permissions: {} as Record<string, unknown[]>,
  };
  const useAcpSessionsStore = Object.assign(
    <T,>(selector: (value: typeof state) => T) => selector(state),
    { getState: () => state },
  );
  return { useAcpSessionsStore, attachAcpListeners: async () => () => {} };
});

let ChatCore: typeof import("./ChatCore").ChatCore;
let resetProviderConfigCache: typeof import("./provider-config").resetProviderConfigCache;
let LATEX_ENGINE: typeof import("@/lib/document-engine").LATEX_ENGINE;
let createAppQueryClient: typeof import("@/lib/query").createAppQueryClient;
let activeChatRun: typeof import("./chat-run-registry").activeChatRun;
let endChatRun: typeof import("./chat-run-registry").endChatRun;
let useFilesStore: typeof import("@/store/files").useFilesStore;
let useChatsStore: typeof import("@/store/chats").useChatsStore;
let useComposerDrafts: typeof import("@/store/composer-drafts").useComposerDrafts;
let useSettingsStore: typeof import("@/store/settings").useSettingsStore;
let useApprovalModeStore: typeof import("@/store/approval-mode").useApprovalModeStore;
let useAgentTurnsStore: typeof import("@/store/agent-turns").useAgentTurnsStore;
let useAgentTodoStore: typeof import("@/store/agent-todos").useAgentTodoStore;
let useAgentFileChangesStore: typeof import("@/store/agent-file-changes").useAgentFileChangesStore;
let usePlanModeStore: typeof import("@/store/plan-mode").usePlanModeStore;
let usePlanApprovalStore: typeof import("@/store/plan-approval").usePlanApprovalStore;
let useChatGoalStore: typeof import("@/store/chat-goal").useChatGoalStore;
let useAiToolSettingsStore: typeof import("@/store/ai-tool-settings").useAiToolSettingsStore;
let useAssistantRuntimeStore: typeof import("@/store/assistant-runtime").useAssistantRuntimeStore;
let useAgentHandoffStore: typeof import("@/store/agent-handoff").useAgentHandoffStore;

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  Object.defineProperties(HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  });
  vi.resetModules();
  await (await import("./acp/tests/ui-fixtures")).initTestI18n();
  ({ ChatCore } = await import("./ChatCore"));
  ({ resetProviderConfigCache } = await import("./provider-config"));
  ({ LATEX_ENGINE } = await import("@/lib/document-engine"));
  ({ createAppQueryClient } = await import("@/lib/query"));
  ({ activeChatRun, endChatRun } = await import("./chat-run-registry"));
  ({ useFilesStore } = await import("@/store/files"));
  ({ useChatsStore } = await import("@/store/chats"));
  ({ useComposerDrafts } = await import("@/store/composer-drafts"));
  ({ useSettingsStore } = await import("@/store/settings"));
  ({ useApprovalModeStore } = await import("@/store/approval-mode"));
  ({ useAgentTurnsStore } = await import("@/store/agent-turns"));
  ({ useAgentTodoStore } = await import("@/store/agent-todos"));
  ({ useAgentFileChangesStore } = await import("@/store/agent-file-changes"));
  ({ usePlanModeStore } = await import("@/store/plan-mode"));
  ({ usePlanApprovalStore } = await import("@/store/plan-approval"));
  ({ useChatGoalStore } = await import("@/store/chat-goal"));
  ({ useAiToolSettingsStore } = await import("@/store/ai-tool-settings"));
  ({ useAssistantRuntimeStore } = await import("@/store/assistant-runtime"));
  ({ useAgentHandoffStore } = await import("@/store/agent-handoff"));
  await import("./usage/UsagePopover");
  await import("@/components/usage/UsageReport");
  await import("@/lib/attachments-intake");
  await import("@/lib/chat-attachments");
}, 60_000);

afterEach(() => {
  cleanup();
  const active = activeChatRun?.();
  if (active) {
    active.controller.abort();
    endChatRun(active);
  }
  scrollTo.mockClear();
});

beforeEach(() => {
  const active = activeChatRun();
  if (active) {
    active.controller.abort();
    endChatRun(active);
  }
  resetProviderConfigCache();
  mocks.runs.length = 0;
  mocks.runAgentHarness.mockReset().mockImplementation(
    (options: HarnessOptions) =>
      new Promise<RunOutcome>((resolve, reject) => {
        options.onRequestId?.(`request-${mocks.runs.length + 1}`);
        mocks.runs.push({ options, resolve, reject });
      }),
  );
  mocks.agentProbeModel
    .mockReset()
    .mockResolvedValue({ verdict: "verified", reason: "", probedAt: 1 });
  mocks.approvalsList.mockReset().mockResolvedValue({});
  mocks.approvalsModeGet.mockReset().mockResolvedValue("ask-for-approval");
  mocks.refetchMcp.mockReset().mockResolvedValue({ data: [], error: null });
  mocks.refetchSkills.mockReset().mockResolvedValue({ data: [] });
  mocks.agentSteer.mockReset().mockResolvedValue({ status: "delivered" });
  mocks.agentThreadRead.mockReset().mockResolvedValue([]);
  mocks.agentThreadArchive.mockReset().mockResolvedValue(true);
  mocks.agentThreadFork.mockReset().mockResolvedValue("thread-forked");
  mocks.agentThreadRollback.mockReset().mockResolvedValue([]);
  mocks.agentThreadDelete.mockReset().mockResolvedValue(undefined);
  mocks.claimPrewarmed.mockReset().mockResolvedValue(null);
  mocks.providerCredit.mockReset().mockResolvedValue(null);
  mocks.chatRead.mockReset().mockRejectedValue(new Error("no chat file"));
  mocks.readFileContent.mockReset().mockResolvedValue("");
  mocks.gitHeadOid.mockReset().mockResolvedValue(null);
  mocks.gitLog.mockReset().mockResolvedValue([]);
  mocks.gitShow.mockReset().mockResolvedValue("");
  mocks.gitStatus.mockReset().mockResolvedValue([]);
  mocks.flushOpenFilesToDisk.mockReset().mockResolvedValue(undefined);
  mocks.agentTurnBegin.mockReset().mockResolvedValue({ snapshotId: "snap-1", unavailable: null });
  mocks.agentTurnFinish.mockReset().mockResolvedValue({
    snapshotId: "snap-1",
    files: [],
    moreFiles: 0,
    skipped: [],
    overlapped: false,
    unavailable: null,
  });
  mocks.agentTurnStatus.mockReset().mockResolvedValue({ expired: false, files: [] });
  mocks.agentTurnRevert.mockReset();
  mocks.checkProjectBudget.mockReset().mockResolvedValue("ok");
  mocks.buildWorkspaceContext.mockReset().mockResolvedValue("");
  mocks.retrieveProjectChunks.mockReset().mockResolvedValue([]);
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  mocks.logError.mockReset().mockResolvedValue(undefined);
  mocks.getConfig.mockReset().mockResolvedValue(providerConfig());
  mocks.registry = [
    {
      id: "test-tools",
      mode: "chat",
      create: ({
        confirm,
      }: {
        confirm: (request: {
          tool: string;
          summary: string;
          path?: string;
        }) => Promise<boolean>;
      }) => ({
        write_file: {
          execute: async () => ({
            approved: await confirm({
              tool: "write_file",
              summary: "Write main.tex",
            }),
          }),
        },
      }),
    },
  ];

  localStorage.clear();
  window.sessionStorage.clear();
  const chat: StoredChat = {
    id: "chat-1",
    projectId: "project",
    title: "New chat",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    headOid: null,
  };
  useFilesStore.setState({
    projectId: "project",
    projectName: "Test project",
    projectKind: "",
    mainDoc: "main.tex",
    engine: LATEX_ENGINE,
    engineLoaded: true,
    loading: false,
    tree: [],
  });
  useChatsStore.setState({
    projectId: "project",
    chats: [chat],
    activeId: chat.id,
    live: {},
    saveProblems: {},
    skippedOnLoad: 0,
  });
  useComposerDrafts.setState({ drafts: {} });
  useSettingsStore.setState({
    chatFloating: false,
    settingsInitialSection: "general",
    settingsOpen: false,
    settingsScrollTarget: null,
    aiComposerHeight: 56,
  });
  useApprovalModeStore.setState({ modes: {}, loaded: {}, persisted: {} });
  useAgentTurnsStore.getState().reset();
  useAgentTodoStore.getState().clear();
  useAgentFileChangesStore.setState({ turns: {}, activeTurnByChat: {}, lastTurnByChat: {} });
  usePlanModeStore.setState({ enabledByProject: {}, loaded: {} });
  usePlanApprovalStore.setState({ byChat: {}, loaded: {} });
  useChatGoalStore.setState({ goalsByProject: {}, loaded: {} });
  useAiToolSettingsStore.setState({ enabledByName: {} });
  useAssistantRuntimeStore.setState({ runtime: "built-in", handoffRuntime: null });
  useAgentHandoffStore.setState({
    pendingPrompt: null,
    autoSend: false,
    pendingImages: [],
    pendingDelegation: null,
  });
});

function providerConfig() {
  return {
    ai_provider: "openai",
    ai_model: "gpt-first",
    ai_api_key: "test-key",
    ai_keys: { openai: "test-key" },
    ai_provider_models: {
      openai: [
        {
          id: "gpt-first",
          name: "GPT First",
          enabled: true,
          source: "fetched",
          trust: "verified",
        },
      ],
    },
    ai_model_probes: {},
    ai_custom_providers: [],
    ai_system_prompt: "",
    ai_personas: [],
  };
}

async function renderChat(): Promise<RenderResult> {
  const rendered = render(
    createElement(
      QueryClientProvider,
      { client: createAppQueryClient() },
      createElement(ChatCore),
    ),
  );
  await waitFor(() => {
    expect(rendered.container.querySelector('[data-tour-configured="true"]')).not.toBeNull();
  });
  return rendered;
}

function composerBox(): HTMLTextAreaElement {
  const box = document.querySelector("[data-chat-composer] textarea");
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("composer missing");
  return box;
}

function sendFromComposer(text: string): void {
  fireEvent.change(composerBox(), { target: { value: text } });
  fireEvent.keyDown(composerBox(), { key: "Enter" });
}

async function completeRun(index: number, text: string): Promise<void> {
  await act(async () => {
    const run = mocks.runs[index];
    run.options.handlers.onText(text);
    run.resolve({
      text,
      usage: { input: 0, output: 0 },
      steps: 1,
      stopped_at_cap: false,
      error: null,
    });
  });
  await waitFor(() => expect(activeChatRun()).toBeNull());
}

function savedMessages(): ChatMessage[] {
  return useChatsStore.getState().byId("chat-1")?.messages ?? [];
}

async function beginWriteApproval() {
  const rendered = await renderChat();
  sendFromComposer("Write the file");
  await waitFor(() => expect(mocks.runs).toHaveLength(1));
  const run = mocks.runs[0].options;

  await act(async () => {
    await run.handlers.onToolCall({ id: "call-1", name: "write_file", args: {} });
  });
  let result!: Promise<unknown>;
  act(() => {
    result = Promise.resolve(run.tools.write_file.execute?.({}));
  });
  return { rendered, run, result };
}

describe("ChatCore run recovery and approvals", () => {
  it("approves a pending tool through the confirmation UI and records the decision", async () => {
    const { rendered, run, result } = await beginWriteApproval();
    const dialog = await rendered.findByRole("alertdialog", { name: "Confirm AI edit" });
    fireEvent.click(within(dialog).getByTestId("tool-confirm-approve"));

    await expect(result).resolves.toEqual({ approved: true });
    act(() => {
      run.handlers.onToolResult({ id: "call-1", output: { approved: true } });
    });
    await completeRun(0, "Written.");

    expect(savedMessages().find((message) => message.toolCalls?.length)?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-1",
        name: "write_file",
        approval: "approved",
        status: "done",
      }),
    ]);
  });

  it("keeps a pending approval across a remount and applies the decision", async () => {
    const { rendered: first, run, result } = await beginWriteApproval();
    await first.findByRole("alertdialog", { name: "Confirm AI edit" });

    first.unmount();
    expect(
      savedMessages().find((message) => message.toolCalls?.length)?.toolCalls?.[0],
    ).toMatchObject({ id: "call-1", status: "running" });
    const remounted = await renderChat();
    const dialog = await remounted.findByRole("alertdialog", {
      name: "Confirm AI edit",
    });
    fireEvent.click(within(dialog).getByTestId("tool-confirm-approve"));

    await expect(result).resolves.toEqual({ approved: true });
    act(() => {
      run.handlers.onToolResult({ id: "call-1", output: { approved: true } });
    });
    await completeRun(0, "Approved after remount.");

    expect(remounted.queryByRole("alertdialog", { name: "Confirm AI edit" })).toBeNull();
    expect(
      savedMessages().find((message) => message.toolCalls?.length)?.toolCalls?.[0],
    ).toMatchObject({ approval: "approved", status: "done" });
  });

  it("restores and continues an active run after ChatCore remounts on the same chat", async () => {
    const first = await renderChat();
    sendFromComposer("Keep working on the draft");
    await waitFor(() => expect(mocks.runs).toHaveLength(1));
    act(() => mocks.runs[0].options.handlers.onText("First streamed paragraph."));
    await waitFor(() =>
      expect(useChatsStore.getState().live["chat-1"]?.at(-1)?.content).toBe(
        "First streamed paragraph.",
      ),
    );

    first.unmount();
    const remounted = await renderChat();

    expect(remounted.getByRole("button", { name: enAi.composer.stop })).toBeTruthy();
    expect(
      remounted.getByRole("button", { name: "Approval mode. Ask for approval" }),
    ).toBeDisabled();
    expect(remounted.container).toHaveTextContent("First streamed paragraph.");

    act(() => mocks.runs[0].options.handlers.onText(" More detail."));
    await waitFor(() =>
      expect(remounted.container).toHaveTextContent(
        "First streamed paragraph. More detail.",
      ),
    );

    await act(async () => {
      mocks.runs[0].resolve({
        text: "First streamed paragraph. More detail.",
        usage: { input: 0, output: 0 },
        steps: 1,
        stopped_at_cap: false,
        error: null,
      });
    });
    await waitFor(() => expect(activeChatRun()).toBeNull());
    expect(savedMessages().at(-1)?.content).toBe(
      "First streamed paragraph. More detail.",
    );
  });

  it("continues with local tools when the MCP catalog cannot refresh", async () => {
    mocks.refetchMcp.mockRejectedValueOnce(new Error("MCP catalog unavailable"));
    await renderChat();
    sendFromComposer("Use the local tool");
    await waitFor(() => expect(mocks.runs).toHaveLength(1));

    expect(mocks.refetchMcp).toHaveBeenCalledOnce();
    expect(mocks.runs[0].options.tools).toHaveProperty("write_file");
    expect(
      Object.keys(mocks.runs[0].options.tools).some((name) => name.startsWith("mcp__")),
    ).toBe(false);

    await completeRun(0, "Local tool complete.");
    expect(savedMessages().at(-1)?.content).toBe("Local tool complete.");
  });

  it("warns when the open chat was captured from an older project revision", async () => {
    const chat = useChatsStore.getState().byId("chat-1");
    if (!chat) throw new Error("chat fixture missing");
    useChatsStore.setState({
      chats: [
        {
          ...chat,
          headOid: "old-head",
          messages: [
            { id: "user-1", role: "user", content: "Review this draft" },
            { id: "assistant-1", role: "assistant", content: "Draft reviewed." },
          ],
        },
      ],
    });
    mocks.gitLog.mockResolvedValue([{ oid: "current-head" }]);

    const rendered = await renderChat();
    expect(
      await rendered.findByRole("button", { name: enAi.header.staleChatHint }),
    ).toBeTruthy();
  });
});

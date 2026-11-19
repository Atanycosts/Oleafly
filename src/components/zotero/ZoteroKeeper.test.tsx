// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import type { ZoteroLibraryStatus } from "@oleafly/backend-port";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";

const bridge = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  load: vi.fn(async () => {}),
  sync: vi.fn(),
  links: vi.fn(async (_projectId: string) => {}),
  refresh: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  event: null as ((status: ZoteroLibraryStatus) => void) | null,
  eventEnabled: false,
}));
const project = create<{ projectId: string | null }>(() => ({ projectId: null }));
const index = create<{ texts: Record<string, string> }>(() => ({ texts: {} }));
const library = create<{ status: ZoteroLibraryStatus | null; load(): Promise<void>; syncInBackground(): void; applyStatus(status: ZoteroLibraryStatus): void }>((set) => ({
  status: null,
  load: bridge.load,
  syncInBackground: bridge.sync,
  applyStatus: (status) => set({ status }),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: bridge.isTauri }));
vi.mock("@/hooks/use-tauri-event", () => ({ useTauriEvent: (_event: string, callback: NonNullable<typeof bridge.event>, enabled: boolean) => {
  bridge.event = callback;
  bridge.eventEnabled = enabled;
} }));
vi.mock("@/store/files", () => ({ useFilesStore: (selector: (state: ReturnType<typeof project.getState>) => unknown) => project(selector) }));
vi.mock("@/store/project-index", () => ({ useIndexStore: (selector: (state: ReturnType<typeof index.getState>) => unknown) => index(selector) }));
vi.mock("@/store/zotero-library", () => ({ useZoteroLibraryStore: { getState: () => library.getState(), subscribe: (listener: Parameters<typeof library.subscribe>[0]) => library.subscribe(listener) } }));
vi.mock("@/features/zotero-cite", () => ({ loadProjectLinks: bridge.links }));
vi.mock("@/features/zotero-actions", () => ({ useZoteroStaleStore: { getState: () => ({ refresh: bridge.refresh }) } }));
vi.mock("@/lib/log", () => ({ logError: bridge.logError }));

import { ZoteroKeeper } from "./ZoteroKeeper";

function status(generation: number): ZoteroLibraryStatus {
  return { local: { state: "ready" }, web: "notConnected", libraries: [], itemCount: 0, syncing: false, generation, bbtSeen: false, loaded: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.isTauri.mockReturnValue(true);
  bridge.load.mockResolvedValue(undefined);
  bridge.links.mockResolvedValue(undefined);
  bridge.event = null;
  bridge.eventEnabled = false;
  project.setState({ projectId: null });
  index.setState({ texts: {} });
  library.setState({ status: null });
});
afterEach(() => vi.restoreAllMocks());

it("loads the native library and refreshes on focus or visible-document events until unmount", async () => {
  let finish!: () => void;
  bridge.load.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<ZoteroKeeper />);
  expect(bridge.load).toHaveBeenCalledOnce();
  expect(bridge.sync).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(bridge.sync).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(bridge.sync).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(bridge.sync).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(bridge.sync).toHaveBeenCalledTimes(3);
  view.unmount();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(bridge.sync).toHaveBeenCalledTimes(3);
});

it("waits for project texts, then refreshes citation links only when the library generation changes", async () => {
  const view = render(<ZoteroKeeper />);
  await act(async () => project.setState({ projectId: "paper" }));
  expect(bridge.links).not.toHaveBeenCalled();
  await act(async () => index.setState({ texts: { "main.tex": "" } }));
  expect(bridge.links).toHaveBeenLastCalledWith("paper");
  expect(bridge.refresh).toHaveBeenCalledOnce();
  await act(async () => bridge.event?.(status(1)));
  expect(bridge.eventEnabled).toBe(true);
  expect(library.getState().status).toEqual(status(1));
  expect(bridge.links).toHaveBeenCalledTimes(2);
  await act(async () => bridge.event?.(status(1)));
  expect(bridge.links).toHaveBeenCalledTimes(2);
  await act(async () => project.setState({ projectId: "next-paper" }));
  expect(bridge.links).toHaveBeenLastCalledWith("next-paper");
  await act(async () => library.setState({ status: status(2) }));
  expect(bridge.links.mock.calls.map(([id]) => id)).toEqual(["paper", "paper", "next-paper", "next-paper"]);
  view.unmount();
  library.setState({ status: status(3) });
  expect(bridge.links).toHaveBeenCalledTimes(4);
});

it("reports link-read failures and can refresh again on the next library generation", async () => {
  const failure = new Error("Retained citation links are unavailable");
  bridge.links.mockRejectedValueOnce(failure);
  project.setState({ projectId: "paper" });
  index.setState({ texts: { "main.tex": "content" } });
  render(<ZoteroKeeper />);
  await act(async () => {});
  expect(bridge.logError).toHaveBeenCalledWith("read Zotero links for the project", failure);
  expect(bridge.refresh).not.toHaveBeenCalled();
  await act(async () => library.setState({ status: status(2) }));
  expect(bridge.refresh).toHaveBeenCalledOnce();
});

it("leaves native synchronization disabled in a browser session", async () => {
  bridge.isTauri.mockReturnValue(false);
  project.setState({ projectId: "paper" });
  index.setState({ texts: { "main.tex": "content" } });
  render(<ZoteroKeeper />);
  await act(async () => {});
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(bridge.eventEnabled).toBe(false);
  expect(bridge.load).not.toHaveBeenCalled();
  expect(bridge.sync).not.toHaveBeenCalled();
  expect(bridge.links).not.toHaveBeenCalled();
});

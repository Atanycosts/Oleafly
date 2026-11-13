import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), install: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ listFontComponents: mocks.list, installFontComponent: mocks.install }));
vi.mock("@/lib/log", () => ({ logError: mocks.log }));
import { useFontPacksStore } from "./font-packs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useFontPacksStore.setState({ packs: [], status: "idle", installing: null });
  mocks.list.mockResolvedValue([]);
});

it("shares the actual catalog promise and resolves every caller after the ready state", async () => {
  const response = deferred<[]>();
  mocks.list.mockReturnValueOnce(response.promise);
  const first = useFontPacksStore.getState().load();
  const second = useFontPacksStore.getState().load();
  expect(second).toBe(first);
  let finished = false;
  void second.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(mocks.list).toHaveBeenCalledOnce();
  response.resolve([]);
  await Promise.all([first, second]);
  expect(useFontPacksStore.getState().status).toBe("ready");
  await useFontPacksStore.getState().load();
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("settles all failed load callers and permits a later retry", async () => {
  const response = deferred<[]>();
  mocks.list.mockReturnValueOnce(response.promise);
  const first = useFontPacksStore.getState().load();
  const second = useFontPacksStore.getState().load();
  response.reject(new Error("Catalog offline"));
  await Promise.all([first, second]);
  expect(useFontPacksStore.getState().status).toBe("error");
  await useFontPacksStore.getState().load();
  expect(useFontPacksStore.getState().status).toBe("ready");
});

it("joins the same active download and waits to refresh installed metadata", async () => {
  const download = deferred<void>();
  mocks.install.mockReturnValueOnce(download.promise);
  const first = useFontPacksStore.getState().install("ptserif");
  const second = useFontPacksStore.getState().install("ptserif");
  expect(second).toBe(first);
  expect(mocks.install).toHaveBeenCalledOnce();
  expect(mocks.list).not.toHaveBeenCalled();
  download.resolve();
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(useFontPacksStore.getState().installing).toBeNull();
});

it("waits for a different active download rather than reporting a false failure", async () => {
  const download = deferred<void>();
  mocks.install.mockReturnValueOnce(download.promise).mockResolvedValueOnce(undefined);
  const first = useFontPacksStore.getState().install("lato");
  const second = useFontPacksStore.getState().install("ptserif");
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("lato");
  download.resolve();
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  expect(mocks.install.mock.calls).toEqual([["lato"], ["ptserif"]]);
});

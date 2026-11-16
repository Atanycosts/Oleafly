import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  remove: vi.fn(),
  downloadAll: vi.fn(),
  progress: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({
  listFontComponents: mocks.list,
  installFontComponent: mocks.install,
  removeFontComponent: mocks.remove,
  downloadAllFonts: mocks.downloadAll,
  withAssetProgress: mocks.progress,
}));
vi.mock("@/lib/log", () => ({ logError: mocks.log }));
import { ALL_FONT_PACKS, useFontPacksStore } from "./font-packs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useFontPacksStore.setState({
    packs: [],
    status: "idle",
    installing: null,
    progress: null,
    revision: 0,
    lastError: null,
  });
  mocks.list.mockResolvedValue([]);
  mocks.install.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.downloadAll.mockResolvedValue(undefined);
  mocks.progress.mockImplementation(
    async (_handlers: unknown, run: () => Promise<void>) => run(),
  );
});

it("shares the actual catalog promise and reuses the ready catalog", async () => {
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
  expect(mocks.list).toHaveBeenCalledOnce();
  await useFontPacksStore.getState().load(true);
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

it("serializes remove after an install of the same pack instead of joining it", async () => {
  const download = deferred<void>();
  mocks.install.mockReturnValueOnce(download.promise);
  const installing = useFontPacksStore.getState().install("lato");
  const removing = useFontPacksStore.getState().remove("lato");
  expect(mocks.remove).not.toHaveBeenCalled();

  download.resolve();
  await expect(installing).resolves.toBe(true);
  await expect(removing).resolves.toBe(true);
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("lato");
});

it("serializes install after a remove of the same pack instead of joining it", async () => {
  const removal = deferred<void>();
  mocks.remove.mockReturnValueOnce(removal.promise);
  const removing = useFontPacksStore.getState().remove("lato");
  const installing = useFontPacksStore.getState().install("lato");
  expect(mocks.install).not.toHaveBeenCalled();

  removal.resolve();
  await expect(removing).resolves.toBe(true);
  await expect(installing).resolves.toBe(true);
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("lato");
});

it("publishes shared progress and a revision after a successful install", async () => {
  const download = deferred<void>();
  const event = {
    component: "ptserif",
    label: "PT Serif Bold",
    file: "PTSerif-Bold.ttf",
    index: 2,
    total: 4,
    received: 10,
    file_total: 100,
  };
  mocks.progress.mockImplementationOnce(
    async (
      handlers: { component(progress: typeof event): void },
      run: () => Promise<void>,
    ) => {
      handlers.component({ ...event, component: "different-pack" });
      handlers.component(event);
      await run();
    },
  );
  mocks.install.mockReturnValueOnce(download.promise);

  const installing = useFontPacksStore.getState().install("ptserif");
  expect(useFontPacksStore.getState().progress).toEqual(event);
  expect(useFontPacksStore.getState().installing).toBe("ptserif");

  download.resolve();
  await expect(installing).resolves.toBe(true);
  expect(useFontPacksStore.getState().revision).toBe(1);
  expect(useFontPacksStore.getState().progress).toBeNull();
});

it("removes a pack through the shared operation state", async () => {
  const result = await useFontPacksStore.getState().remove("lato");
  expect(result).toBe(true);
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("lato");
  expect(useFontPacksStore.getState().revision).toBe(1);
});

it("downloads all template fonts once through the shared operation state", async () => {
  const first = useFontPacksStore.getState().downloadAll();
  const second = useFontPacksStore.getState().downloadAll();
  expect(second).toBe(first);
  expect(useFontPacksStore.getState().installing).toBe(ALL_FONT_PACKS);
  await expect(first).resolves.toBe(true);
  expect(mocks.downloadAll).toHaveBeenCalledOnce();
  expect(useFontPacksStore.getState().revision).toBe(1);
});

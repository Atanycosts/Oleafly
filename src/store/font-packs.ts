import { create } from "zustand";
import { logError } from "@/lib/log";
import {
  downloadAllFonts,
  installFontComponent,
  listFontComponents,
  removeFontComponent,
  withAssetProgress,
  type AssetProgress,
  type ComponentInfo,
} from "@/lib/tauri";

type Status = "idle" | "loading" | "ready" | "error";

export const ALL_FONT_PACKS = "__all__";
type OperationKind = "install" | "remove" | "downloadAll";

interface FontPacksState {
  packs: ComponentInfo[];
  status: Status;
  installing: string | null;
  progress: AssetProgress | null;
  revision: number;
  lastError: unknown;
  load: (force?: boolean) => Promise<void>;
  install: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  downloadAll: () => Promise<boolean>;
}

export const useFontPacksStore = create<FontPacksState>((set, get) => {
  let loading: Promise<void> | null = null;
  let operation: {
    kind: OperationKind;
    id: string;
    promise: Promise<boolean>;
  } | null = null;

  const load = (force = false): Promise<void> => {
    if (loading) {
      return force ? loading.then(() => load(true)) : loading;
    }
    if (!force && get().status === "ready") return Promise.resolve();
    if (get().status !== "ready") set({ status: "loading" });
    loading = (async () => {
      try {
        set({ packs: await listFontComponents(), status: "ready" });
      } catch (error) {
        void logError("list font packs", error);
        set({ status: "error" });
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  const execute = async (
    id: string,
    run: () => Promise<void>,
    afterSuccess: () => void,
  ): Promise<boolean> => {
    set({ installing: id, progress: null, lastError: null });
    let succeeded = false;
    try {
      await withAssetProgress(
        {
          component: (progress) => {
            if (id === ALL_FONT_PACKS || progress.component === id) {
              set({ progress });
            }
          },
        },
        run,
      );
      afterSuccess();
      set((state) => ({ revision: state.revision + 1 }));
      succeeded = true;
    } catch (error) {
      void logError("change font packs", error);
      set({ lastError: error });
    } finally {
      if (succeeded) await load(true);
      operation = null;
      set({ installing: null, progress: null });
    }
    return succeeded;
  };

  return {
    packs: [],
    status: "idle",
    installing: null,
    progress: null,
    revision: 0,
    lastError: null,
    load,
    install: (id) => {
      if (operation) {
        return operation.kind === "install" && operation.id === id
          ? operation.promise
          : operation.promise.then(() => get().install(id));
      }
      const promise = execute(
        id,
        () => installFontComponent(id),
        () =>
          set((state) => ({
            packs: state.packs.map((pack) =>
              pack.id === id ? { ...pack, installed: true } : pack,
            ),
          })),
      );
      operation = { kind: "install", id, promise };
      return promise;
    },
    remove: (id) => {
      if (operation) {
        return operation.kind === "remove" && operation.id === id
          ? operation.promise
          : operation.promise.then(() => get().remove(id));
      }
      const promise = execute(
        id,
        () => removeFontComponent(id),
        () =>
          set((state) => ({
            packs: state.packs.map((pack) =>
              pack.id === id ? { ...pack, installed: false } : pack,
            ),
          })),
      );
      operation = { kind: "remove", id, promise };
      return promise;
    },
    downloadAll: () => {
      if (operation) {
        return operation.kind === "downloadAll"
          ? operation.promise
          : operation.promise.then(() => get().downloadAll());
      }
      const promise = execute(
        ALL_FONT_PACKS,
        downloadAllFonts,
        () =>
          set((state) => ({
            packs: state.packs.map((pack) =>
              pack.kind === "typst-font" ? pack : { ...pack, installed: true },
            ),
          })),
      );
      operation = { kind: "downloadAll", id: ALL_FONT_PACKS, promise };
      return promise;
    },
  };
});

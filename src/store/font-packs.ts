import { create } from "zustand";
import { installFontComponent, listFontComponents, type ComponentInfo } from "@/lib/tauri";
import { logError } from "@/lib/log";

type Status = "idle" | "loading" | "ready" | "error";

interface FontPacksState {
  packs: ComponentInfo[];
  status: Status;
  installing: string | null;
  load: () => Promise<void>;
  install: (id: string) => Promise<boolean>;
}

export const useFontPacksStore = create<FontPacksState>((set, get) => {
  let loading: Promise<void> | null = null;
  let installation: { id: string; promise: Promise<boolean> } | null = null;
  return {
  packs: [],
  status: "idle",
  installing: null,
  load: () => {
    if (loading) return loading;
    set({ status: "loading" });
    loading = (async () => {
      try {
        set({ packs: await listFontComponents(), status: "ready" });
      } catch (error) {
        void logError("list font packs", error);
        set({ status: "error" });
      } finally { loading = null; }
    })();
    return loading;
  },
  install: (id) => {
    if (installation) {
      return installation.id === id ? installation.promise : installation.promise.then(() => get().install(id));
    }
    set({ installing: id });
    const promise = (async () => {
      try {
        await installFontComponent(id);
        await loading;
        set({ packs: await listFontComponents(), status: "ready" });
        return true;
      } catch (error) {
        void logError("install font pack", error);
        return false;
      } finally {
        installation = null;
        set({ installing: null });
      }
    })();
    installation = { id, promise };
    return promise;
  },
  };
});

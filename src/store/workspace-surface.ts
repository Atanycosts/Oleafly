import { create } from "zustand";
import { useSettingsStore } from "@/store/settings";

export type WorkspaceSurface = "files" | "word" | "journal" | "material";

function revealWorkspace() {
  if (useSettingsStore.getState().workspaceHidden) {
    useSettingsStore.setState({ workspaceHidden: false });
  }
}

/** Navigation only. Document sessions remain owned by their existing stores. */
export const useWorkspaceSurfaceStore = create<{
  active: WorkspaceSurface;
  journalOpen: boolean;
  journalSidebarTarget: HTMLElement | null;
  journalBusy: boolean;
  showFiles(): void;
  showWord(): void;
  showMaterial(): void;
  openJournal(): void;
  closeJournal(): void;
  setJournalSidebarTarget(target: HTMLElement | null): void;
  setJournalBusy(busy: boolean): void;
}>((set) => ({
  active: "files",
  journalOpen: false,
  journalSidebarTarget: null,
  journalBusy: false,
  showFiles: () => { revealWorkspace(); set({ active: "files" }); },
  showWord: () => { revealWorkspace(); set({ active: "word" }); },
  showMaterial: () => { revealWorkspace(); set({ active: "material" }); },
  openJournal: () => { revealWorkspace(); set({ active: "journal", journalOpen: true }); },
  closeJournal: () => set((state) => ({ journalOpen: false, active: state.active === "journal" ? "files" : state.active })),
  setJournalSidebarTarget: (journalSidebarTarget) => set({ journalSidebarTarget }),
  setJournalBusy: (journalBusy) => set({ journalBusy }),
}));

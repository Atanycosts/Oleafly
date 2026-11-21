import { create } from "zustand";
import type { JournalProject, JournalWorld } from "@/lib/journal-workbench";
import type { DocxRecoverySnapshot } from "@/lib/docx-recovery";
import { useWorkspaceSurfaceStore } from "@/store/workspace-surface";
import { useFilesStore } from "@/store/files";

export interface DocxWorkspaceRequest {
  appProjectId: string;
  project: JournalProject;
  world: JournalWorld | null;
  sourcePath?: string;
  recovery?: DocxRecoverySnapshot;
  onSaved(): Promise<void>;
}

export const useDocxWorkspaceStore = create<{
  request: DocxWorkspaceRequest | null;
  context: Pick<DocxWorkspaceRequest, "world" | "onSaved"> | null;
  minimized: boolean;
  recoveryOpen: boolean;
  toolsOpen: boolean;
  savedVersion: number;
  closeRequested: number;
  closingBlocked: boolean;
  setClosingBlocked(blocked: boolean): void;
  saved(): void;
  requestClose(): void;
  updateContext(context: Pick<DocxWorkspaceRequest, "world" | "onSaved">): void;
  setRecoveryOpen(open: boolean): void;
  setToolsOpen(open: boolean): void;
  open(request: DocxWorkspaceRequest): void;
  minimize(): void;
  restore(): void;
  close(): void;
}>((set, get) => ({
  request: null,
  context: null,
  minimized: false,
  recoveryOpen: false,
  toolsOpen: false,
  savedVersion: 0,
  closeRequested: 0,
  closingBlocked: false,
  setClosingBlocked: (closingBlocked) => set({ closingBlocked }),
  saved: () => set((state) => ({ savedVersion: state.savedVersion + 1 })),
  requestClose: () => {
    useWorkspaceSurfaceStore.getState().showWord();
    set((state) => ({ minimized: false, closeRequested: state.closeRequested + 1 }));
  },
  updateContext: (context) => set({ context }),
  setRecoveryOpen: (recoveryOpen) => set({ recoveryOpen }),
  setToolsOpen: (toolsOpen) => set({ toolsOpen }),
  open: (request) => {
    useWorkspaceSurfaceStore.getState().showWord();
    set((state) => {
      const context = { world: request.world, onSaved: request.onSaved };
      if (!state.request) return { request, context, minimized: false, closeRequested: 0, toolsOpen: !!request.recovery?.taskState };
      if (state.request.appProjectId === request.appProjectId && state.request.project.project_id === request.project.project_id) {
        return { context, minimized: false };
      }
      return { minimized: false };
    });
  },
  minimize: () => { useWorkspaceSurfaceStore.getState().showFiles(); set({ minimized: true }); },
  restore: () => { useWorkspaceSurfaceStore.getState().showWord(); set({ minimized: false }); },
  close: () => {
    const request = get().request;
    if (request?.sourcePath && useFilesStore.getState().projectId === request.appProjectId) {
      useFilesStore.getState().closeTab(request.sourcePath);
    }
    if (useWorkspaceSurfaceStore.getState().active === "word") useWorkspaceSurfaceStore.getState().showFiles();
    set({ request: null, context: null, minimized: false, closingBlocked: false, toolsOpen: false });
  },
}));

import { create } from "zustand";
import type { JournalProject, JournalWorld } from "@/lib/journal-workbench";
import type { DocxRecoverySnapshot } from "@/lib/docx-recovery";

export interface DocxWorkspaceRequest {
  appProjectId: string;
  project: JournalProject;
  world: JournalWorld | null;
  recovery?: DocxRecoverySnapshot;
  onSaved(): Promise<void>;
}

export const useDocxWorkspaceStore = create<{
  request: DocxWorkspaceRequest | null;
  context: Pick<DocxWorkspaceRequest, "world" | "onSaved"> | null;
  minimized: boolean;
  recoveryOpen: boolean;
  setRecoveryOpen(open: boolean): void;
  open(request: DocxWorkspaceRequest): void;
  minimize(): void;
  restore(): void;
  close(): void;
}>((set) => ({
  request: null,
  context: null,
  minimized: false,
  recoveryOpen: false,
  setRecoveryOpen: (recoveryOpen) => set({ recoveryOpen }),
  open: (request) => set((state) => {
    const context = { world: request.world, onSaved: request.onSaved };
    if (!state.request) return { request, context, minimized: false };
    if (state.request.appProjectId === request.appProjectId && state.request.project.project_id === request.project.project_id) {
      return { context, minimized: false };
    }
    return { minimized: false };
  }),
  minimize: () => set({ minimized: true }),
  restore: () => set({ minimized: false }),
  close: () => set({ request: null, context: null, minimized: false }),
}));

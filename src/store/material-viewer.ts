import { create } from "zustand";
import type { MaterialAnchor, MaterialKind } from "@/lib/material-surface";
import { useWorkspaceSurfaceStore, type WorkspaceSurface } from "@/store/workspace-surface";

export interface MaterialViewVersion {
  title: string;
  role?: "task_input" | "candidate" | "checked" | "evidence" | "result";
  /** SHA-256 of the exact retained content, with an optional sha256: prefix. */
  revision: string;
  load(): Promise<Uint8Array | string>;
  anchor?: MaterialAnchor;
  mediaType?: string;
  initialPage?: number;
}

export interface MaterialViewerRequest extends MaterialViewVersion {
  projectId: string;
  documentId: string;
  path?: string | null;
  kind: MaterialKind;
  previous?: MaterialViewVersion;
}

export interface MaterialVisit {
  id: number;
  request: MaterialViewerRequest;
}

let nextVisitId = 0;

/** A view onto retained materials. Editable document sessions keep their existing owners. */
export const useMaterialViewerStore = create<{
  request: MaterialViewerRequest | null;
  visits: MaterialVisit[];
  returnSurface: Exclude<WorkspaceSurface, "material">;
  open(request: MaterialViewerRequest): void;
  back(): void;
  restore(): void;
  close(): void;
}>((set, get) => ({
  request: null,
  visits: [],
  returnSurface: "files",
  open: (request) => {
    const surface = useWorkspaceSurfaceStore.getState().active;
    const current = get();
    const continuing = surface === "material" && current.request?.projectId === request.projectId;
    set({ request, visits: [...(continuing ? current.visits : []), { id: ++nextVisitId, request }],
      returnSurface: surface === "material" ? current.returnSurface : surface });
    useWorkspaceSurfaceStore.getState().showMaterial();
  },
  back: () => {
    const visits = get().visits;
    if (visits.length <= 1) { get().close(); return; }
    const previous = visits.slice(0, -1);
    set({ visits: previous, request: previous[previous.length - 1].request });
    useWorkspaceSurfaceStore.getState().showMaterial();
  },
  restore: () => {
    if (get().request) useWorkspaceSurfaceStore.getState().showMaterial();
  },
  close: () => {
    const surface = useWorkspaceSurfaceStore.getState();
    if (surface.active === "material") {
      const previous = get().returnSurface;
      if (previous === "word") surface.showWord();
      else if (previous === "journal" && surface.journalOpen) surface.openJournal();
      else surface.showFiles();
    }
    set({ request: null, visits: [] });
  },
}));

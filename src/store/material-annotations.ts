import { create } from "zustand";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";

export interface MaterialAnnotationOptions {
  /** Live working-copy adapter only. Never serialized with retained sources. */
  beforeStartTask?: (taskId: string) => Promise<void>;
}

export const useMaterialAnnotationsStore = create<{
  document: MaterialDocument | null;
  anchor: MaterialAnchor;
  options: MaterialAnnotationOptions;
  open(document: MaterialDocument, anchor?: MaterialAnchor, options?: MaterialAnnotationOptions): void;
  close(): void;
}>((set) => ({
  document: null,
  anchor: { kind: "whole" },
  options: {},
  open: (document, anchor = { kind: "whole" }, options = {}) => set({ document, anchor, options }),
  close: () => set({ document: null, anchor: { kind: "whole" }, options: {} }),
}));

export const openMaterialAnnotations = (document: MaterialDocument, anchor?: MaterialAnchor, options?: MaterialAnnotationOptions) =>
  useMaterialAnnotationsStore.getState().open(document, anchor, options);

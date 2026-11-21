import { create } from "zustand";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";

export interface MaterialAnnotationOptions {
  wordSessionId?: string;
  wordSessionRevision?: number;
  /** Live working-copy adapter only. Never serialized with retained sources. */
  beforeStartTask?: (taskId: string) => Promise<void>;
}

export interface MaterialFeedback {
  key: string;
  document: MaterialDocument;
  anchor: MaterialAnchor;
  options: MaterialAnnotationOptions;
  expanded: boolean;
}

const emptyCapture = { document: null, anchor: { kind: "whole" } as MaterialAnchor, options: {} };

export const useMaterialAnnotationsStore = create<{
  document: MaterialDocument | null;
  anchor: MaterialAnchor;
  options: MaterialAnnotationOptions;
  feedback: MaterialFeedback[];
  open(document: MaterialDocument, anchor?: MaterialAnchor, options?: MaterialAnnotationOptions): void;
  setExpanded(key: string, expanded: boolean): void;
  close(key?: string): void;
}>((set) => ({
  ...emptyCapture,
  feedback: [],
  open: (document, anchor = { kind: "whole" }, options = {}) => {
    const word = document.kind === "docx";
    const selectedParagraph = word && anchor.kind === "object"
      ? { id: anchor.id, range: anchor.range ?? null }
      : null;
    const key = JSON.stringify([document.projectId, document.documentId, options.wordSessionId ?? null,
      options.wordSessionRevision ?? document.revision.replace(/^sha256:/u, ""),
      selectedParagraph]);
    set((state) => {
      const existing = word ? state.feedback.find((entry) => entry.key === key) : undefined;
      const selected = existing ?? { key, document, anchor, options };
      return { document: selected.document, anchor: selected.anchor, options: selected.options,
        feedback: [{ ...selected, expanded: true }, ...state.feedback.filter((entry) => entry.key !== key)] };
    });
  },
  setExpanded: (key, expanded) => set((state) => ({
    feedback: state.feedback.map((entry) => entry.key === key ? { ...entry, expanded } : entry),
  })),
  close: (key) => set((state) => {
    const feedback = key === undefined ? [] : state.feedback.filter((entry) => entry.key !== key);
    const latest = feedback[0];
    return { feedback, ...(latest ? { document: latest.document, anchor: latest.anchor, options: latest.options } : emptyCapture) };
  }),
}));

export const openMaterialAnnotations = (document: MaterialDocument, anchor?: MaterialAnchor, options?: MaterialAnnotationOptions) =>
  useMaterialAnnotationsStore.getState().open(document, anchor, options);

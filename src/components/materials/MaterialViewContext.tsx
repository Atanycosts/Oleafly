import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { MaterialAnchor, MaterialDocument } from "@/lib/material-surface";
import { useAgentWorkspaceStore, type AgentWorkspaceView } from "@/store/agent-workspace";

const MaterialSelectionContext = createContext<((anchor: MaterialAnchor | null) => void) | null>(null);
const MaterialActivationContext = createContext<(() => void) | null>(null);

export function useActivateMaterialView() {
  return useContext(MaterialActivationContext);
}

export function useReportMaterialViewSelection() {
  return useContext(MaterialSelectionContext);
}

export function useMaterialViewSelection(selection: MaterialAnchor | null) {
  const report = useReportMaterialViewSelection();
  useEffect(() => { report?.(selection); }, [report, selection]);
}

export function MaterialViewContext({ document, active, materialRole, dirty, children }: {
  document: MaterialDocument | null;
  active: boolean;
  materialRole: AgentWorkspaceView["role"];
  dirty?: boolean;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<{ revision: string; anchor: MaterialAnchor } | null>(null);
  const documentRef = useRef(document);
  const previousActive = useRef(false);
  const published = useRef<{ projectId: string; documentId: string } | null>(null);
  documentRef.current = document;
  const report = useCallback((anchor: MaterialAnchor | null) => {
    const current = documentRef.current;
    setSelected(anchor && current ? { revision: current.revision, anchor } : null);
  }, []);
  const publish = useCallback(() => {
    if (!active) return;
    if (!document) {
      const previous = published.current;
      if (previous) useAgentWorkspaceStore.getState().clearView(previous.projectId, previous.documentId);
      return;
    }
    const selection = selected?.revision === document.revision ? selected.anchor : null;
    published.current = { projectId: document.projectId, documentId: document.documentId };
    useAgentWorkspaceStore.getState().publishView({ projectId: document.projectId, documentId: document.documentId,
      kind: document.kind, title: document.title, revision: document.revision, role: materialRole, dirty,
      selection: selection ? { revision: document.revision, anchor: selection } : null });
  }, [active, document, materialRole, dirty, selected]);
  useEffect(() => {
    const activated = active && !previousActive.current;
    previousActive.current = active;
    const current = document ? useAgentWorkspaceStore.getState().views[document.projectId] : null;
    if (activated || !current || current.documentId === document?.documentId) publish();
  }, [active, document, publish]);
  return <MaterialSelectionContext value={report}><MaterialActivationContext value={publish}><div className="contents" onPointerDownCapture={publish} onFocusCapture={publish} onWheelCapture={publish}>{children}</div></MaterialActivationContext></MaterialSelectionContext>;
}

import "/src/lib/polyfills";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { journalRequest, type JournalState, type JournalWorld } from "/src/lib/journal-workbench";
import { prepareHarnessI18n } from "./harness-i18n";
import { useFilesStore } from "/src/store/files";
import { createOleaflyTools } from "/src/lib/ai-tools";
import { useWorkspaceSurfaceStore } from "/src/store/workspace-surface";
import { useDocxWorkspaceStore } from "/src/store/docx-workspace";
import type { WordDocumentRef } from "/src/components/materials/WordDocument";
import "/src/styles/globals.css";

const DocxWorkspaceDialog = lazy(() => import("/src/components/research/DocxWorkspaceDialog"));

await prepareHarnessI18n();
const initial = await journalRequest<JournalState>("/api/state");
const boundWorldId = initial.projects[0]?.binding?.world_version_id;
const selectedWorld = boundWorldId ? await journalRequest<JournalWorld>(
  `/api/world?version_id=${encodeURIComponent(boundWorldId)}`,
) : null;
useFilesStore.setState({ projectId: "docx-harness" });
useWorkspaceSurfaceStore.getState().showWord();
const docxTools = createOleaflyTools();
Object.assign(window, { __docxTools: docxTools });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Harness() {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState(initial);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const workingEditor = useRef<WordDocumentRef>(null);
  useEffect(() => {
    const revealParagraph = (paraId: string) => {
      const editor = workingEditor.current?.getEditor();
      const nodeId = editor?.surface?.session.nodeIdOf(paraId);
      if (!nodeId || !editor?.scrollToAnchor({ paraId })) throw new Error(`Cannot locate DOCX paragraph ${paraId}`);
      return CSS.escape(nodeId);
    };
    Object.assign(window, { __docxRevealParagraph: revealParagraph });
    return () => { Reflect.deleteProperty(window, "__docxRevealParagraph"); };
  }, []);
  const minimizeFeedback = useCallback(() => setFeedbackVisible(false), []);
  const active = useWorkspaceSurfaceStore((store) => store.active);
  return open ? <Suspense fallback={<p>Opening DOCX working copy</p>}><>
    <nav aria-label="Workspace">
      <button type="button" onClick={() => useWorkspaceSurfaceStore.getState().showFiles()}>Source</button>
      <button type="button" onClick={() => useWorkspaceSurfaceStore.getState().showWord()}>Word</button>
      <button type="button" aria-pressed={feedbackVisible} onClick={() => setFeedbackVisible((visible) => !visible)}>Fixture feedback</button>
    </nav>
    <div hidden={active !== "word"} style={{ height: "calc(100vh - 2rem)" }}>
    <DocxWorkspaceDialog
    appProjectId="docx-harness"
    project={state.projects[0]}
    world={selectedWorld}
    workingEditorRef={workingEditor}
    feedbackVisible={feedbackVisible}
    onContextToolActivate={minimizeFeedback}
    onClose={() => setOpen(false)}
    onSaved={async () => setState(await journalRequest<JournalState>("/api/state"))}
  />
    </div>
    {active === "files" && <p>Source workspace</p>}
    {active === "journal" && <p>Journal workspace</p>}
  </></Suspense> : <button type="button" onClick={() => setOpen(true)}>Reopen working copy</button>;
}
const fullWorkspace = new URLSearchParams(location.search).has("workspace-center");
let content = <Harness />;
if (fullWorkspace) {
  const { WorkspaceCenter } = await import("/src/components/editor/WorkspaceCenter");
  useDocxWorkspaceStore.getState().open({
    appProjectId: "docx-harness", project: initial.projects[0], world: selectedWorld, onSaved: async () => {},
  });
  content = <div className="h-screen"><WorkspaceCenter /></div>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    {content}
  </QueryClientProvider>,
);

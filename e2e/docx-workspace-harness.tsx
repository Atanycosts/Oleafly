import "/src/lib/polyfills";
import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { journalRequest, type JournalState, type JournalWorld } from "/src/lib/journal-workbench";
import { prepareHarnessI18n } from "./harness-i18n";
import { useFilesStore } from "/src/store/files";
import { createOleaflyTools } from "/src/lib/ai-tools";
import { useWorkspaceSurfaceStore } from "/src/store/workspace-surface";
import "/src/styles/globals.css";

const DocxWorkspaceDialog = lazy(() => import("/src/components/research/DocxWorkspaceDialog"));

// Vite dev prebundling moves the shaper JS away from its relative WASM binary.
const [{ setHarfBuzzWasmUrl }, { default: harfBuzzWasmUrl }] = await Promise.all([
  import("@docx-editor.dev/core/layout"),
  import("@docx-editor.dev/core/harfbuzz.wasm?url"),
]);
setHarfBuzzWasmUrl(harfBuzzWasmUrl);
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
  const active = useWorkspaceSurfaceStore((store) => store.active);
  return open ? <Suspense fallback={<p>Opening DOCX working copy</p>}><>
    <nav aria-label="Workspace">
      <button type="button" onClick={() => useWorkspaceSurfaceStore.getState().showFiles()}>Source</button>
      <button type="button" onClick={() => useWorkspaceSurfaceStore.getState().showWord()}>Word</button>
    </nav>
    <div hidden={active !== "word"} style={{ height: "calc(100vh - 2rem)" }}>
    <DocxWorkspaceDialog
    appProjectId="docx-harness"
    project={state.projects[0]}
    world={selectedWorld}
    onClose={() => setOpen(false)}
    onSaved={async () => setState(await journalRequest<JournalState>("/api/state"))}
  />
    </div>
    {active === "files" && <p>Source workspace</p>}
    {active === "journal" && <p>Journal workspace</p>}
  </></Suspense> : <button type="button" onClick={() => setOpen(true)}>Reopen working copy</button>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);

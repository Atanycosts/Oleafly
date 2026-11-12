import "/src/lib/polyfills";
import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { journalRequest, type JournalState } from "/src/lib/journal-workbench";
import { prepareHarnessI18n } from "./harness-i18n";
import { useFilesStore } from "/src/store/files";
import { createOleaflyTools } from "/src/lib/ai-tools";
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
useFilesStore.setState({ projectId: "docx-harness" });
const docxTools = createOleaflyTools();
Object.assign(window, { __docxTools: docxTools });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Harness() {
  const [open, setOpen] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [state, setState] = useState(initial);
  return open ? <Suspense fallback={<p>Opening DOCX working copy</p>}><>
    <DocxWorkspaceDialog
    appProjectId="docx-harness"
    project={state.projects[0]}
    world={state.worlds[0] ? { ...state.worlds[0], sources: [], rules: [], coverage_gaps: [], limitations: [] } : null}
    onClose={() => setOpen(false)}
    onSaved={async () => setState(await journalRequest<JournalState>("/api/state"))}
    minimized={minimized}
    onMinimize={() => setMinimized(true)}
  />
  {minimized && <button type="button" onClick={() => setMinimized(false)}>Resume DOCX working copy</button>}
  </></Suspense> : <button type="button" onClick={() => setOpen(true)}>Reopen working copy</button>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);

import "/src/lib/polyfills";
import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  journalRequest,
  type JournalState,
  type JournalWorld,
} from "/src/lib/journal-workbench";
import { prepareHarnessI18n } from "./harness-i18n";
import { useFilesStore } from "/src/store/files";
import { createOleaflyTools } from "/src/lib/ai-tools";
import "/src/styles/globals.css";

const DocxWorkspaceDialog = lazy(() => import("/src/components/research/DocxWorkspaceDialog"));

const [{ setHarfBuzzWasmUrl }, { default: harfBuzzWasmUrl }] = await Promise.all([
  import("@docx-editor.dev/core/layout"),
  import("@docx-editor.dev/core/harfbuzz.wasm?url"),
]);
setHarfBuzzWasmUrl(harfBuzzWasmUrl);
await prepareHarnessI18n();

const initial = await journalRequest<JournalState>("/api/state");
const selectedWorld = initial.worlds[0];
const fullWorld = selectedWorld
  ? await journalRequest<JournalWorld>(
      `/api/world?version_id=${encodeURIComponent(selectedWorld.version_id)}`,
    )
  : null;
useFilesStore.setState({ projectId: "journal-template-harness" });
Object.assign(window, { __docxTools: createOleaflyTools() });

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Harness() {
  const [state, setState] = useState(initial);
  return (
    <Suspense fallback={<p>Opening journal template working copy</p>}>
      <DocxWorkspaceDialog
        appProjectId="journal-template-harness"
        project={state.projects[0]}
        world={fullWorld}
        onClose={() => {}}
        onSaved={async () => setState(await journalRequest<JournalState>("/api/state"))}
      />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);

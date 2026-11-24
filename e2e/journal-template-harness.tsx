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
import { beginChatRun, endChatRun } from "/src/components/ai/chat-run-registry";
import { useWorkspaceSurfaceStore } from "/src/store/workspace-surface";
import "/src/styles/globals.css";

const DocxWorkspaceDialog = lazy(() => import("/src/components/research/DocxWorkspaceDialog"));

const [{ setHarfBuzzWasmUrl }, { default: harfBuzzWasmUrl }] = await Promise.all([
  import("@docx-editor.dev/core/layout"),
  import("@docx-editor.dev/core/harfbuzz.wasm?url"),
]);
setHarfBuzzWasmUrl(harfBuzzWasmUrl);
await prepareHarnessI18n();

const initial = await journalRequest<JournalState>("/api/state");
const projectId = new URLSearchParams(location.search).get("project_id") ?? initial.projects[0].project_id;
const selectedWorld = initial.worlds[0];
const fullWorld = selectedWorld
  ? await journalRequest<JournalWorld>(
      `/api/world?version_id=${encodeURIComponent(selectedWorld.version_id)}`,
    )
  : null;
useFilesStore.setState({ projectId: "journal-template-harness" });
useWorkspaceSurfaceStore.getState().showWord();
Object.assign(window, {
  __docxTools: createOleaflyTools(),
  async __prepareFormatCandidate(worldVersionId: string) {
    const controller = new AbortController();
    const run = beginChatRun(controller, useFilesStore.getState().projectId);
    try {
      const tool = createOleaflyTools({ signal: controller.signal }).create_docx_format_candidate;
      return await tool.execute({ world_version_id: worldVersionId });
    } finally {
      endChatRun(run);
    }
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Harness() {
  const [state, setState] = useState(initial);
  return (
    <Suspense fallback={<p>Opening journal template working copy</p>}>
      <DocxWorkspaceDialog
        appProjectId="journal-template-harness"
        project={state.projects.find((project) => project.project_id === projectId)!}
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

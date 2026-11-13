import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { base64ToBytes } from "@/lib/base64";
import type { DocxFormatSnapshotV1 } from "@/lib/docx-format-types";

export interface JournalFormatRequest {
  token: string;
  projectId: string;
  baselineId: string;
  sourceSha256: string;
  contentBase64: string;
}

export async function deriveJournalFormatSnapshot(
  request: Pick<JournalFormatRequest, "sourceSha256" | "contentBase64">,
): Promise<DocxFormatSnapshotV1> {
  const bytes = base64ToBytes(request.contentBase64);
  const { openDocxFormatFacts } = await import("@/lib/docx-format");
  const snapshot = (await openDocxFormatFacts(bytes)).snapshot;
  if (snapshot.source_sha256 !== request.sourceSha256) {
    throw new Error("The DOCX format snapshot does not match the retained source bytes.");
  }
  return snapshot;
}

export async function answerJournalFormatRequest(request: JournalFormatRequest): Promise<void> {
  let result: DocxFormatSnapshotV1;
  try {
    result = await deriveJournalFormatSnapshot(request);
  } catch (error) {
    await invoke("journal_format_result", {
      token: request.token,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {
      // The native request may have timed out or ended before this answer.
    });
    return;
  }
  await invoke("journal_format_result", {
    token: request.token,
    result,
    error: null,
  });
}

/** Installed once by the main application window, independent of an open DOCX editor. */
export async function mountJournalFormatBridge(): Promise<() => void> {
  return listen<JournalFormatRequest>("journal-format-request", async ({ payload }) => {
    try {
      await invoke("journal_format_claim", { token: payload.token });
    } catch {
      return;
    }
    await answerJournalFormatRequest(payload);
  });
}

import type { Editor } from "@docx-editor.dev/core/contracts/editor";

type DocxHistoryEditor = Pick<Editor, "exec">;

const registrations = new Map<HTMLElement, () => DocxHistoryEditor | null>();

export function registerDocxHistory(
  root: HTMLElement,
  editor: () => DocxHistoryEditor | null,
): () => void {
  registrations.set(root, editor);
  return () => registrations.delete(root);
}

export function runDocxHistory(target: Element | null, redo: boolean): boolean {
  const marker = target?.closest<HTMLElement>("[data-docx-history]");
  if (!marker) return false;
  if (marker.dataset.docxHistory === "field") return false;
  if (marker.dataset.docxHistory === "working") {
    for (const [root, editor] of registrations) {
      if (!root.contains(marker)) continue;
      editor()?.exec({ type: redo ? "redo" : "undo" });
      break;
    }
  }
  return true;
}

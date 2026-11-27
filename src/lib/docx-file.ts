import { invoke } from "@tauri-apps/api/core";
import { connectJournalWorkbench, type JournalProject, type JournalWorld } from "@/lib/journal-workbench";

export interface OpenedWordDocument {
  project: JournalProject | null;
  world: JournalWorld | null;
  sourceChanged: boolean;
  choices: JournalProject[];
}

export interface WordOpenChoice { workbenchProjectId?: string; newCopy?: boolean }
const opening = new Map<string, Promise<OpenedWordDocument>>();

export const wordOriginalSha256 = (projectId: string, workbenchProjectId: string, sourcePath?: string) =>
  invoke<string | null>("journal_word_original_sha256", { projectId, workbenchProjectId, sourcePath });

/** Share concurrent opens, while every later open reads the latest saved working copy. */
export function openWordDocument(projectId: string, path: string, choice?: WordOpenChoice): Promise<OpenedWordDocument> {
  const key = JSON.stringify([projectId, path, choice]);
  const pending = opening.get(key);
  if (pending) return pending;
  const operation = connectJournalWorkbench()
    .then(() => invoke<OpenedWordDocument>("journal_word_open", { projectId, path, ...choice }))
    .finally(() => opening.delete(key));
  opening.set(key, operation);
  return operation;
}

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DocxDocumentRead, DocxFormatReadResult, DocxInlineAtom, DocxParagraphView, DocxReadQuery,
} from "../../packages/ai-tools/src/tools";
import type { DocxActivityPage } from "../../src/lib/docx-task-activity";
import type {
  JournalCheck,
  JournalProject,
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import type {
  ResearchTask,
  ResearchTaskStatus,
  TaskObservation,
  TaskTranscriptEvent,
  TaskTranscriptPage,
} from "../../src/lib/research-tasks";
import {
  tauriExpect as expect,
  type BrowserPageAdapter,
  type TauriPage,
} from "@srsholmes/tauri-playwright";
import {
  assertManuscriptInitialExport,
  assertManuscriptRepair,
  createControlledManuscript,
  type ControlledFormatKind,
  type ControlledManuscript,
  type CreateControlledManuscriptOptions,
  type ManuscriptInitialExportFacts,
  type ManuscriptRepairFacts,
} from "./word-manuscript-oracle";
import { scriptValue } from "../script-value";
import {
  collectTemplateReadCoverage,
  type TemplateReadInventory,
  type TemplateReadPage,
} from "./word-template-read-coverage";

export type Page = TauriPage | BrowserPageAdapter;

export const PROVIDER = "word-manuscript-live";
export const MODEL = "gpt/gpt-6.1-sol";
export const MODEL_EFFORT = "max" as const;
export const TASK_LIMIT_MINUTES = 20;

export interface WordManuscriptSourceHashes {
  template: string;
  english: string;
  chinese: string;
}

export interface WordManuscriptFixtureManifest {
  control: ControlledManuscript;
  sourceBytes: Uint8Array;
  damagedBytes: Uint8Array;
}

export type WordManuscriptFixtureOptions = CreateControlledManuscriptOptions;

export function prepareWordManuscriptFixture(
  sourceBytes: Uint8Array,
  templateBytes: Uint8Array,
  options: WordManuscriptFixtureOptions = {},
): WordManuscriptFixtureManifest {
  const control = createControlledManuscript(
    sourceBytes,
    templateBytes,
    options as CreateControlledManuscriptOptions,
  );
  return {
    control,
    sourceBytes: new Uint8Array(sourceBytes),
    damagedBytes: new Uint8Array(control.bytes),
  };
}

export function verifyWordManuscriptInitialExport(
  fixture: WordManuscriptFixtureManifest,
  exportedBytes: Uint8Array,
): ManuscriptInitialExportFacts {
  return assertManuscriptInitialExport(fixture.damagedBytes, exportedBytes);
}

export function verifyWordManuscriptRepair(
  fixture: WordManuscriptFixtureManifest,
  repairedBytes: Uint8Array,
): ManuscriptRepairFacts {
  return assertManuscriptRepair(
    fixture.sourceBytes,
    fixture.damagedBytes,
    repairedBytes,
    fixture.control,
  );
}

export const CONTROLLED_FORMAT_KINDS: readonly ControlledFormatKind[] = [
  "paragraph",
  "table-cell",
  "section",
];

export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Inspection helper only: model calls still consume and retain each bounded page. */
export async function collectDocxDocumentPages(
  read: (query: DocxReadQuery) => Promise<DocxDocumentRead>,
): Promise<DocxDocumentRead> {
  const first = await read({});
  const paragraphs = new Map<string, {
    view: DocxParagraphView;
    model: ReadTextChunks;
    display: ReadTextChunks;
    atoms: Map<string, { atom: DocxInlineAtom; payload?: ReadTextChunks }>;
  }>();
  const cursors = new Set<string>();
  let page = first;
  while (true) {
    if (page.document.sessionId !== first.document.sessionId
      || page.document.sessionRevision !== first.document.sessionRevision
      || page.document.sourceSha256 !== first.document.sourceSha256
      || page.totalParagraphs !== first.totalParagraphs) {
      throw new Error("The DOCX inspection changed while following its read continuation.");
    }
    for (const row of page.paragraphs) {
      const state = paragraphs.get(row.paragraphRef) ?? {
        view: row, model: { chunks: [], textLength: row.modelTextLength ?? row.modelText.length },
        display: { chunks: [], textLength: row.displayTextLength ?? row.displayText.length },
        atoms: new Map<string, { atom: DocxInlineAtom; payload?: ReadTextChunks }>(),
      };
      addReadText(state.model, row.modelText, row.modelTextOffset ?? 0,
        row.modelTextLength ?? row.modelText.length);
      addReadText(state.display, row.displayText, row.displayTextOffset ?? 0,
        row.displayTextLength ?? row.displayText.length);
      for (const atom of row.atoms) {
        const observed: { atom: DocxInlineAtom; payload?: ReadTextChunks } =
          state.atoms.get(atom.objectRef) ?? { atom };
        if (atom.payloadJson !== undefined) {
          observed.payload ??= { chunks: [], textLength: atom.payloadLength ?? atom.payloadJson.length };
          addReadText(observed.payload, atom.payloadJson, atom.payloadOffset ?? 0,
            atom.payloadLength ?? atom.payloadJson.length);
        }
        state.atoms.set(atom.objectRef, observed);
      }
      state.view = { ...state.view, editableRanges: [...new Map(
        [...state.view.editableRanges, ...row.editableRanges]
          .map(range => [`${range.start}:${range.end}`, range]),
      ).values()] };
      paragraphs.set(row.paragraphRef, state);
    }
    if (!page.nextQuery) break;
    const cursor = JSON.stringify(page.nextQuery);
    if (cursors.has(cursor)) throw new Error("The DOCX read continuation did not advance.");
    cursors.add(cursor);
    page = await read(page.nextQuery);
  }
  if (paragraphs.size !== first.totalParagraphs) {
    throw new Error(`The DOCX inspection read ${paragraphs.size}/${first.totalParagraphs} paragraphs.`);
  }
  return {
    document: first.document, offset: 0, nextOffset: null,
    nextQuery: null, totalParagraphs: first.totalParagraphs,
    paragraphs: [...paragraphs.values()].map(({ view, model, display, atoms }) => {
      const modelText = requireReadText(model), displayText = requireReadText(display);
      return {
        ...view, text: displayText, modelText, displayText,
        modelTextOffset: 0, modelTextLength: modelText.length, modelTextTruncated: false,
        displayTextOffset: 0, displayTextLength: displayText.length, displayTextTruncated: false,
        atoms: [...atoms.values()].map(({ atom, payload }) => payload
          ? { ...atom, payload: JSON.parse(requireReadText(payload)), payloadJson: undefined,
              payloadOffset: undefined, payloadLength: undefined, payloadContinuation: null }
          : atom),
      };
    }),
  };
}

export async function live<T = DocxDocumentRead>(page: Page): Promise<T> {
  return await collectDocxDocumentPages(query => page.evaluate<DocxDocumentRead>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument(${scriptValue(query)}))`,
  )) as T;
}

export function journalRequest<T>(
  page: Page,
  path: string,
  payload?: unknown,
): Promise<T> {
  const payloadArgument = payload === undefined ? "" : `, ${scriptValue(payload)}`;
  return page.evaluate<T>(
    `window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest(${scriptValue(path)}${payloadArgument}))`,
  );
}

export function activitiesPage(
  page: Page,
  projectId: string,
  manuscriptId: string,
  cursor: number,
  limit = 50,
) {
  return page.evaluate<DocxActivityPage>(
    `window.__TAURI_INTERNALS__.invoke('research_docx_activities',{
      projectId:${scriptValue(projectId)},workbenchProjectId:${scriptValue(manuscriptId)},
      afterCursor:${cursor},limit:${limit}
    })`,
  );
}

export async function transcript(page: Page, task: ResearchTask) {
  const result: TaskTranscriptEvent[] = [];
  let cursor: number | null = null;
  do {
    const batch: TaskTranscriptPage = await page.evaluate<TaskTranscriptPage>(
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m =>
        m.loadResearchTaskEvents(${scriptValue(task.id)},${task.executionGeneration},
          ${cursor === null ? "undefined" : cursor},100))`,
    );
    result.push(...batch.events);
    if (batch.nextSequence === null) return result;
    expect(batch.nextSequence).toBeGreaterThan(cursor ?? 0);
    cursor = batch.nextSequence;
  } while (true);
}

export async function allActivities(
  page: Page,
  projectId: string,
  manuscriptId: string,
  task: ResearchTask,
) {
  const pages: DocxActivityPage[] = [];
  const activities: DocxActivityPage["activities"] = [];
  let cursor = 0;
  do {
    const batch = await activitiesPage(page, projectId, manuscriptId, cursor);
    pages.push(batch);
    activities.push(...batch.activities);
    if (!batch.hasMore) break;
    expect(batch.nextCursor).toBeGreaterThan(cursor);
    cursor = batch.nextCursor;
  } while (true);
  return {
    pages,
    activities: activities.filter(
      ({ activity }) =>
        activity.origin.taskId === task.id
        && activity.origin.generation === task.executionGeneration,
    ),
  };
}

export async function loadTask(page: Page, projectId: string, taskId: string) {
  return page.evaluate<ResearchTask>(
    `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m =>
      (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(taskId)}))`,
  );
}

export async function waitForTask(page: Page, projectId: string, taskId: string) {
  const terminal = new Set<ResearchTaskStatus>([
    "awaiting_review",
    "completed",
    "failed",
    "cancelled",
  ]);
  let latest: ResearchTask | undefined;
  let observationTimeouts = 0;
  let lastObservedAt: string | undefined;
  await expect.poll(async () => {
    try {
      latest = await loadTask(page, projectId, taskId);
      if (latest) lastObservedAt = new Date().toISOString();
    } catch (error) {
      if (!(error instanceof Error)
        || error.message !== "TauriPage command 'eval' failed: timeout (30s)") {
        throw error;
      }
      observationTimeouts += 1;
      console.warn(`Task ${taskId} status observation timed out (${observationTimeouts}); last observed ${latest?.status ?? "unavailable"} at ${lastObservedAt ?? "never"}; continuing within the original task deadline.`);
      return null;
    }
    return latest && terminal.has(latest.status) ? latest.status : null;
  }, {
    timeout: (TASK_LIMIT_MINUTES * 60 + 90) * 1_000,
    intervals: [1_000, 2_000],
  }).not.toBeNull();
  return latest!;
}

export async function cancelIfRunning(page: Page, task: ResearchTask | undefined) {
  if (!task) return;
  const current = await loadTask(page, task.projectId, task.id);
  if (current.status !== "running") return;
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m =>
      m.cancelResearchTask(${scriptValue(current.id)}))`,
  );
}

export function finalSavedMutation(
  activities: readonly DocxActivityPage["activities"][number]["activity"][],
  saveOperationId: string,
) {
  const saveIndex = activities.findIndex(activity => activity.event.type === "runtime"
    && activity.event.event.kind === "operation"
    && activity.event.event.operation === "save"
    && activity.event.event.operationId === saveOperationId);
  if (saveIndex < 0) return undefined;
  const mutation = activities.slice(0, saveIndex).reverse().find(activity => {
    if (activity.event.type !== "runtime" || activity.event.event.kind !== "operation") return false;
    const operation = activity.event.event;
    return ["format", "format_batch", "apply"].includes(operation.operation)
      && operation.result.ok === true && record(operation.result.result)?.changed === true;
  });
  if (mutation?.event.type !== "runtime" || mutation.event.event.kind !== "operation") return undefined;
  const operationId = mutation.event.event.operationId;
  const checkpoint = activities.find(activity => activity.event.type === "operationCheckpoint"
    && activity.event.operationId === operationId && activity.event.phase === "saved");
  return { mutation, operationId, checkpoint };
}

export async function runJournalCheck(
  page: Page,
  projectId: string,
  worldVersionId: string,
): Promise<JournalCheck> {
  const panel = page.getByTestId("journal-checks-panel");
  const worldSelect = panel.getByTestId("journal-world-select");
  await expect(worldSelect).toBeVisible({ timeout: 90_000 });
  await expect(worldSelect).toBeEnabled({ timeout: 90_000 });
  await expect(worldSelect.locator(`option[value="${worldVersionId}"]`))
    .toHaveCount(1, { timeout: 90_000 });
  await worldSelect.selectOption(worldVersionId);
  await expect.poll(() => worldSelect.inputValue()).toBe(worldVersionId);
  const previous = (await journalRequest<JournalState>(page, "/api/state"))
    .projects.find((item) => item.project_id === projectId)?.latest_check?.check_id;
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await panel.getByText("Run check", { exact: true }).click();
  let checkId: string | undefined;
  await expect.poll(async () => {
    const current = (await journalRequest<JournalState>(page, "/api/state"))
      .projects.find((item) => item.project_id === projectId)?.latest_check;
    if (
      current?.check_id
      && current.check_id !== previous
      && current.validity === "CURRENT"
      && current.world_version_id === worldVersionId
    ) {
      checkId = current.check_id;
      return true;
    }
    return false;
  }, { timeout: 300_000 }).toBe(true);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
  return journalRequest<JournalCheck>(
    page,
    `/api/check?check_id=${encodeURIComponent(checkId!)}`,
  );
}

interface ToolEvidence {
  callId: string;
  name: string;
  status: string;
  request?: unknown;
  result?: unknown;
  resultText?: string;
  detailTruncated: boolean;
  modelError: boolean;
  requestVariants: unknown[];
  identityBasis?: "transcript_name" | "tool_requested" | "tool_execution" | "format_update_result";
}

interface TextRange {
  start: number;
  end: number;
}

export interface ParagraphCoverage {
  objectId: string;
  part: string;
  paragraphRef?: string;
  textLength: number;
  ranges: TextRange[];
  chunks: { start: number; end: number; text: string }[];
  pageOffsets: number[];
  continuations: number;
}

export interface NonBodyParagraphReceipt {
  part: string;
  index: number;
  objectId: string;
  textLength: number;
  textSha256: string;
  readOffsets: number[];
  continuations: number;
}

export interface NonBodyPartReceipt {
  part: string;
  expectedParagraphs: number;
  observedParagraphs: number;
  completeText: boolean;
  windows: {
    offset: number;
    nextOffset: number | null;
    objectIds: string[];
  }[];
  paragraphs: NonBodyParagraphReceipt[];
}

interface RevisionCoverage {
  identity: string;
  sourceSha256: string;
  expectedTotal: number | null;
  pageClosed: boolean;
  objectIdsSeen: Set<string>;
  paragraphs: Map<string, ParagraphCoverage>;
}

interface NonBodyParagraphCoverage {
  index: number;
  objectId: string;
  part: string;
  text: string;
  textLength: number;
  textSha256: string;
  ranges: TextRange[];
  chunks: { start: number; end: number; text: string }[];
  readOffsets: number[];
  continuations: number;
}

interface NonBodyPartCoverage {
  part: string;
  expected: Map<number, { text: string; textSha256: string }>;
  paragraphs: Map<number, NonBodyParagraphCoverage>;
  objectIndexes: Map<string, number>;
  windows: NonBodyPartReceipt["windows"];
  ranges: TextRange[];
  expectedTotal: number | null;
}

function parsedJson(detail: string): unknown | undefined {
  if (detail.includes("[output truncated]")) return undefined;
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return undefined;
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function evidenceFromEvents(events: readonly TaskTranscriptEvent[]): ToolEvidence[] {
  const calls = new Map<string, ToolEvidence>();
  const ensure = (callId: string): ToolEvidence => {
    const existing = calls.get(callId);
    if (existing) return existing;
    const created: ToolEvidence = {
      callId,
      name: "",
      status: "unknown",
      detailTruncated: false,
      modelError: false,
      requestVariants: [],
    };
    calls.set(callId, created);
    return created;
  };
  for (const { event } of events) {
    if (event.kind === "tool") {
      if (!event.callId) continue;
      const item = ensure(event.callId);
      if (event.name) {
        item.name = event.name;
        item.identityBasis = "transcript_name";
      }
      if (event.phase === "request" || event.phase === "update") {
        const request = parsedJson(event.detail);
        if (request !== undefined) {
          item.request = request;
          item.requestVariants.push(request);
        }
      } else if (event.phase === "result") {
        item.status = event.status ?? "unknown";
        item.resultText = event.detail;
        const result = parsedJson(event.detail);
        const envelope = record(result);
        item.modelError = envelope?.isError === true;
        if (Array.isArray(envelope?.content)) {
          const content = envelope.content.map(record).find(entry => entry?.type === "text");
          item.result = typeof content?.text === "string" ? parsedJson(content.text) : undefined;
        } else item.result = result;
        item.detailTruncated = event.detail.includes("[output truncated]");
      }
      continue;
    }
    if (event.kind !== "observation") continue;
    const observation: TaskObservation = event.observation;
    if (observation.type !== "toolExecution" && observation.type !== "toolRequested") continue;
    const item = ensure(observation.callId);
    item.name = observation.name;
    if (observation.type === "toolExecution") {
      item.status = observation.status;
      item.identityBasis = "tool_execution";
    } else if (item.identityBasis !== "tool_execution") {
      item.identityBasis = "tool_requested";
    }
  }
  for (const item of calls.values()) {
    if (item.name || item.status !== "done" || item.modelError || item.detailTruncated) continue;
    const request = record(item.request);
    const result = record(item.result);
    if (request?.operation === "format" && request.format_operation === "snapshot"
      && text(request.world_version_id) && text(result?.source_sha256)
      && (record(result?.snapshot) || (result?.projection === "json_fragment" && text(result.json)))) {
      item.name = "journal_read";
      item.identityBasis = "format_update_result";
    }
  }
  return [...calls.values()];
}

function mergeRange(ranges: TextRange[], start: number, end: number) {
  if (end <= start) return;
  ranges.push({ start, end });
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  let write = 0;
  for (const range of ranges) {
    const previous = ranges[write - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      ranges[write++] = range;
    }
  }
  ranges.length = write;
}

function rangeComplete(ranges: readonly TextRange[], total: number) {
  if (total === 0) return ranges.length === 0;
  return ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === total;
}

function addParagraph(
  coverage: RevisionCoverage,
  item: Record<string, unknown>,
  pageOffset: number,
) {
  const objectId = text(item.object_id) ?? text(item.objectId);
  if (!objectId) return;
  coverage.objectIdsSeen.add(objectId);
  if (text(item.kind) !== "paragraph") return;
  const part = text(item.part) ?? "";
  const key = `${part}\u0000${objectId}`;
  const existing = coverage.paragraphs.get(key) ?? {
    objectId,
    part,
    paragraphRef: text(item.paragraphRef) ?? text(item.paragraph_ref),
    textLength:
      number(item.modelTextLength)
      ?? number(item.textLength)
      ?? text(item.modelText)?.length
      ?? text(item.text)?.length
      ?? 0,
    ranges: [],
    chunks: [],
    pageOffsets: [],
    continuations: 0,
  };
  const delivered =
    text(item.modelText)
    ?? text(item.text)
    ?? "";
  const start =
    number(item.modelTextOffset)
    ?? number(item.textOffset)
    ?? 0;
  const length = number(item.textLength) ?? delivered.length;
  existing.textLength = Math.max(existing.textLength, number(item.modelTextLength) ?? length);
  mergeRange(existing.ranges, start, start + Math.min(length, delivered.length));
  existing.chunks.push({
    start,
    end: start + Math.min(length, delivered.length),
    text: delivered,
  });
  if (!existing.pageOffsets.includes(pageOffset)) existing.pageOffsets.push(pageOffset);
  if (record(item.textContinuation) || record(item.text_continuation)) {
    existing.continuations += 1;
  }
  coverage.paragraphs.set(key, existing);
}

interface ReadTextChunks {
  textLength: number;
  chunks: { start: number; end: number; text: string }[];
}

function addReadText(state: ReadTextChunks, value: string, start: number, total: number) {
  if (total !== state.textLength || start < 0 || start + value.length > total) {
    throw new Error("The DOCX text window has inconsistent offsets or length.");
  }
  for (const chunk of state.chunks) {
    const overlapStart = Math.max(chunk.start, start);
    const overlapEnd = Math.min(chunk.end, start + value.length);
    if (overlapStart < overlapEnd
      && chunk.text.slice(overlapStart - chunk.start, overlapEnd - chunk.start)
        !== value.slice(overlapStart - start, overlapEnd - start)) {
      throw new Error("The DOCX text window changed within one revision.");
    }
  }
  state.chunks.push({ start, end: start + value.length, text: value });
}

function requireReadText(state: ReadTextChunks) {
  const value = materializedText(state);
  if (value === null) throw new Error("The DOCX read left an unfinished text or payload window.");
  return value;
}

function materializedText(paragraph: ReadTextChunks) {
  const chunks = [...paragraph.chunks]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let value = "";
  for (const chunk of chunks) {
    if (chunk.start > cursor) return null;
    if (chunk.end <= cursor) continue;
    value += chunk.text.slice(Math.max(0, cursor - chunk.start));
    cursor = chunk.end;
  }
  return cursor === paragraph.textLength ? value : null;
}

function coverageGroup(
  groups: Map<string, RevisionCoverage>,
  identity: string,
  sourceSha256: string,
) {
  const existing = groups.get(identity);
  if (existing) {
    if (existing.sourceSha256 !== sourceSha256) {
      existing.pageClosed = false;
    }
    return existing;
  }
  const created: RevisionCoverage = {
    identity,
    sourceSha256,
    expectedTotal: null,
    pageClosed: false,
    objectIdsSeen: new Set(),
    paragraphs: new Map(),
  };
  groups.set(identity, created);
  return created;
}

function addPage(
  groups: Map<string, RevisionCoverage>,
  identity: string,
  sourceSha256: string,
  data: Record<string, unknown>,
  records: readonly unknown[],
  pageOffset: number,
) {
  const group = coverageGroup(groups, identity, sourceSha256);
  const total = number(data.total);
  if (total !== undefined) {
    group.expectedTotal = group.expectedTotal === null
      ? total
      : Math.max(group.expectedTotal, total);
  }
  for (const value of records) {
    const item = record(value);
    if (item) addParagraph(group, item, pageOffset);
  }
  const next = data.nextOffset !== undefined
    ? data.nextOffset
    : data.next_offset;
  if (next === null) group.pageClosed = true;
  const hasMore = data.hasMore ?? data.has_more;
  if (hasMore === false) group.pageClosed = true;
}

interface FragmentState {
  sourceSha256: string;
  jsonSha256: string;
  jsonLength: number;
  fragments: Map<number, string>;
  request: Record<string, unknown>;
  callIds: string[];
}

function fragmentsForTemplate(
  calls: readonly ToolEvidence[],
  worldVersionId: string,
  pages: TemplateReadPage[],
  gaps: string[],
) {
  const states = new Map<string, FragmentState>();
  for (const call of calls) {
    if (call.name !== "journal_read" || call.status !== "done" || call.modelError) continue;
    const request = record(call.request);
    const result = record(call.result);
    if (!request || !result || result.text_truncated === true || text(request.operation) !== "format") continue;
    if (text(request.format_operation) !== "snapshot") continue;
    if (text(request.world_version_id) !== worldVersionId) continue;
    if (text(request.collection) && !["objects", "style_definitions"].includes(String(request.collection))) continue;
    if (result.projection !== "json_fragment") {
      pages.push({ data: result, request, callIds: [call.callId] });
      continue;
    }
    const sourceSha256 = text(result.source_sha256);
    const jsonSha256 = text(result.json_sha256);
    const offset = number(result.json_offset);
    const length = number(result.json_length);
    const fragment = text(result.json);
    if (!sourceSha256 || !jsonSha256 || offset === undefined || length === undefined || fragment === undefined) {
      gaps.push(`journal_read ${call.callId} has incomplete fragment metadata`);
      continue;
    }
    const key = `${worldVersionId}\u0000${sourceSha256}\u0000${request.collection ?? "objects"}\u0000${request.detail ?? "full"}\u0000${jsonSha256}`;
    const state = states.get(key) ?? {
      sourceSha256,
      jsonSha256,
      jsonLength: length,
      fragments: new Map<number, string>(),
      request,
      callIds: [],
    };
    state.fragments.set(offset, fragment);
    state.callIds.push(call.callId);
    states.set(key, state);
    if (result.continuation !== null && result.continuation !== undefined) continue;
    const expected = [...state.fragments.entries()]
      .sort(([left], [right]) => left - right);
    let cursor = 0;
    const assembled: string[] = [];
    for (const [start, value] of expected) {
      if (start !== cursor) {
        gaps.push(`journal_read ${worldVersionId} fragment gap at ${cursor}`);
        break;
      }
      assembled.push(value);
      cursor += Array.from(value).length;
    }
    if (cursor !== state.jsonLength) {
      gaps.push(`journal_read ${worldVersionId} assembled ${cursor}/${state.jsonLength} characters`);
      continue;
    }
    const assembledJson = assembled.join("");
    if (sha256(Buffer.from(assembledJson)) !== state.jsonSha256) {
      gaps.push(`journal_read ${worldVersionId} assembled JSON digest mismatch`);
      continue;
    }
    const parsed = record(parsedJson(assembledJson));
    if (!parsed) {
      gaps.push(`journal_read ${worldVersionId} complete fragment JSON did not parse`);
      continue;
    }
    pages.push({ data: parsed, request: state.request, callIds: state.callIds });
    states.delete(key);
  }
  for (const state of states.values()) gaps.push(`journal_read ${worldVersionId} has an unfinished JSON fragment ${state.jsonSha256}`);
  return pages;
}

export interface ModelReadReceipt {
  complete: boolean;
  gaps: string[];
  manuscript: {
    revision: number;
    sourceSha256: string;
    expectedParagraphs: number;
    observedParagraphs: number;
    activityWindows: {
      offset: number;
      nextOffset: number | null;
      paragraphRefs: string[];
    }[];
    paragraphs: {
      paragraphRef: string;
      paraId: string | null;
      textLength: number;
      textSha256: string;
      readOffsets: number[];
    }[];
  };
  displayProjectionGaps: string[];
  modelDeliveryFailures: string[];
  failedReadAttempts: string[];
  format: {
    overviewRead: boolean;
    nonBodyPartsRead: string[];
    nonBody: {
      part: string;
      expectedParagraphs: number;
      observedParagraphs: number;
      completeText: boolean;
      paragraphs: {
        objectId: string;
        textLength: number;
        textSha256: string;
        readOffsets: number[];
        continuations: number;
      }[];
    }[];
    successfulCalls: {
      callId: string;
      query: unknown;
      revision: number;
      sourceSha256: string;
      liveRevision: number;
      liveSourceSha256: string;
    }[];
  };
  template: {
    worldVersionId: string;
    sourceSha256: string | null;
    expectedObjects: number | null;
    observedParagraphs: number;
    paragraphs: ParagraphCoverage[];
    inventoryCoverage?: ReturnType<typeof collectTemplateReadCoverage>;
  };
  successfulToolCalls: {
    callId: string;
    name: string;
    request: unknown;
    resultSha256: string;
    identityBasis?: ToolEvidence["identityBasis"];
  }[];
}

interface NarrativeParagraphRead {
  paragraphRef: string;
  paraId: string | null;
  text: string;
  textLength: number;
  textSha256: string;
  readOffsets: number[];
  chunks: ReadTextChunks["chunks"];
  model?: ReadTextChunks;
  payloads?: Map<string, ReadTextChunks>;
}

interface NarrativeWindow {
  offset: number;
  nextOffset: number | null;
  paragraphRefs: string[];
}

interface NarrativeActivityGroup {
  revision: number;
  sourceSha256: string;
  paragraphs: Map<string, NarrativeParagraphRead>;
  windows: NarrativeWindow[];
  requested: Set<string>;
  continuations: Set<string>;
}

function readCursor(query: Record<string, unknown> | undefined) {
  return JSON.stringify([
    number(query?.offset) ?? 0,
    number(query?.text_offset) ?? number(query?.textOffset) ?? null,
    number(query?.text_limit) ?? number(query?.textLimit) ?? null,
    number(query?.atom_offset) ?? number(query?.atomOffset) ?? null,
    number(query?.payload_offset) ?? number(query?.payloadOffset) ?? null,
  ]);
}

function addNarrativeParagraph(
  paragraphs: Map<string, NarrativeParagraphRead>,
  row: Record<string, unknown>,
  offset: number,
  gaps: string[],
  source: string,
) {
  const paragraphRef = text(row.paragraphRef);
  const delivered = text(row.displayText) ?? text(row.text);
  if (!paragraphRef || delivered === undefined) {
    gaps.push(`${source} returned an incomplete paragraph`);
    return;
  }
  const total = number(row.displayTextLength) ?? delivered.length;
  const paraId = text(row.paraId) ?? null;
  const current: NarrativeParagraphRead = paragraphs.get(paragraphRef) ?? {
    paragraphRef, paraId, text: "", textLength: total, textSha256: "", readOffsets: [], chunks: [],
  };
  if (current.paraId !== paraId) gaps.push(`${source} changed identity for ${paragraphRef}`);
  try {
    addReadText(current, delivered, number(row.displayTextOffset) ?? 0, total);
    const model = text(row.modelText);
    if (model !== undefined) {
      const modelLength = number(row.modelTextLength) ?? model.length;
      current.model ??= { textLength: modelLength, chunks: [] };
      addReadText(current.model, model, number(row.modelTextOffset) ?? 0, modelLength);
    }
    if (Array.isArray(row.atoms)) {
      for (const value of row.atoms) {
        const atom = record(value), objectRef = text(atom?.objectRef), json = text(atom?.payloadJson);
        if (!objectRef || json === undefined) continue;
        current.payloads ??= new Map();
        const payload = current.payloads.get(objectRef)
          ?? { textLength: number(atom?.payloadLength) ?? json.length, chunks: [] };
        addReadText(payload, json, number(atom?.payloadOffset) ?? 0,
          number(atom?.payloadLength) ?? json.length);
        current.payloads.set(objectRef, payload);
      }
    }
  } catch (error) {
    gaps.push(`${source} ${paragraphRef}: ${String(error)}`);
  }
  current.text = materializedText(current) ?? "";
  current.textSha256 = sha256(Buffer.from(current.text));
  if (!current.readOffsets.includes(offset)) current.readOffsets.push(offset);
  paragraphs.set(paragraphRef, current);
}

function formatPart(part: string) {
  return part.startsWith("/") ? part : `/${part}`;
}

function nonBodyGroups(
  expected: readonly { part: string; index: number; text: string }[],
) {
  const groups = new Map<string, NonBodyPartCoverage>();
  for (const paragraph of expected) {
    const part = formatPart(paragraph.part);
    const group = groups.get(part) ?? {
      part,
      expected: new Map(),
      paragraphs: new Map(),
      objectIndexes: new Map(),
      windows: [],
      ranges: [],
      expectedTotal: null,
    };
    if (group.expected.has(paragraph.index)) {
      throw new Error(`Duplicate non-body oracle paragraph ${part}#${paragraph.index}.`);
    }
    group.expected.set(paragraph.index, {
      text: paragraph.text,
      textSha256: sha256(Buffer.from(paragraph.text)),
    });
    groups.set(part, group);
  }
  return groups;
}

function addNonBodyParagraph(
  group: NonBodyPartCoverage,
  index: number,
  item: Record<string, unknown>,
  readOffset: number,
  revision: number,
  gaps: string[],
) {
  const expected = group.expected.get(index);
  const objectId = text(item.object_id) ?? text(item.objectId);
  if (!expected || !objectId) {
    gaps.push(`read_docx_format ${group.part}#${index} has no oracle or object identity`);
    return;
  }
  const current = group.paragraphs.get(index);
  if (current && current.objectId !== objectId) {
    gaps.push(`read_docx_format ${group.part}#${index} changed object identity`);
    return;
  }
  group.objectIndexes.set(objectId, index);
  const paragraph = current ?? {
    index,
    objectId,
    part: group.part,
    text: expected.text,
    textLength: expected.text.length,
    textSha256: expected.textSha256,
    ranges: [],
    chunks: [],
    readOffsets: [],
    continuations: 0,
  };
  const delivered = text(item.modelText) ?? text(item.text);
  if (delivered === undefined) {
    gaps.push(
      `read_docx_format ${group.part}#${index} did not include modelText or text`,
    );
  } else {
    const start =
      number(item.modelTextOffset)
      ?? number(item.textOffset)
      ?? 0;
    mergeRange(paragraph.ranges, start, start + delivered.length);
    paragraph.chunks.push({
      start,
      end: start + delivered.length,
      text: delivered,
    });
  }
  if (!paragraph.readOffsets.includes(readOffset)) {
    paragraph.readOffsets.push(readOffset);
  }
  const continuationValue = item.textContinuation;
  if (continuationValue !== undefined && continuationValue !== null) {
    const continuation = record(continuationValue);
    if (!continuation) {
      gaps.push(`read_docx_format ${group.part}#${index} has malformed textContinuation`);
    } else {
      paragraph.continuations += 1;
      const continuationObject = text(continuation.object_id);
      const continuationOffset = number(continuation.text_offset);
      const continuationRevision = number(continuation.expected_revision);
      if (
        text(continuation.kind) !== "paragraphs"
        || (continuationObject && continuationObject !== objectId)
        || continuationOffset === undefined
        || continuationRevision !== revision
      ) {
        gaps.push(
          `read_docx_format ${group.part}#${index} has an invalid textContinuation`,
        );
      }
    }
  }
  if (item.textTruncated === true && continuationValue == null) {
    gaps.push(`read_docx_format ${group.part}#${index} is truncated without continuation`);
  }
  group.paragraphs.set(index, paragraph);
}

function completeNonBodyPart(
  group: NonBodyPartCoverage,
  gaps: string[],
): NonBodyPartReceipt {
  const expectedIndexes = [...group.expected.keys()].sort((left, right) => left - right);
  const paragraphs = [...group.paragraphs.values()]
    .sort((left, right) => left.index - right.index);
  for (const [index, expected] of group.expected) {
    const paragraph = group.paragraphs.get(index);
    if (!paragraph) {
      gaps.push(`read_docx_format did not read ${group.part}#${index}`);
      continue;
    }
    const actual = materializedText(paragraph);
    if (
      actual === null
      || !rangeComplete(paragraph.ranges, paragraph.textLength)
      || actual !== expected.text
      || sha256(Buffer.from(actual)) !== expected.textSha256
    ) {
      gaps.push(
        `read_docx_format text coverage ${group.part}#${index} is incomplete or changed`,
      );
    }
  }
  const covered = group.windows.length > 0
    && group.ranges.length === 1
    && group.ranges[0].start === 0
    && group.ranges[0].end === expectedIndexes.length;
  if (!covered) {
    gaps.push(
      `read_docx_format windows ${JSON.stringify(group.ranges)} do not cover `
      + `${group.part} 0..${expectedIndexes.length}`,
    );
  }
  if (
    group.expectedTotal !== null
    && group.expectedTotal !== expectedIndexes.length
  ) {
    gaps.push(
      `read_docx_format total ${group.expectedTotal} disagrees with `
      + `${expectedIndexes.length} oracle paragraphs for ${group.part}`,
    );
  }
  const completeText =
    paragraphs.length === expectedIndexes.length
    && paragraphs.every((paragraph) => {
      const actual = materializedText(paragraph);
      return actual !== null
        && actual === group.expected.get(paragraph.index)?.text;
    });
  return {
    part: group.part,
    expectedParagraphs: expectedIndexes.length,
    observedParagraphs: paragraphs.length,
    completeText,
    windows: group.windows,
    paragraphs: paragraphs.map((paragraph) => ({
      part: paragraph.part,
      index: paragraph.index,
      objectId: paragraph.objectId,
      textLength: paragraph.textLength,
      textSha256: paragraph.textSha256,
      readOffsets: paragraph.readOffsets,
      continuations: paragraph.continuations,
    })),
  };
}

export function collectModelReadReceipt(
  events: readonly TaskTranscriptEvent[],
  activities: readonly DocxActivityPage["activities"][number]["activity"][],
  expected: {
    manuscriptRevision: number;
    manuscriptSourceSha256: string;
    manuscriptFormatSourceSha256: string;
    templateWorldVersionId: string;
    templateSourceSha256: string;
    manuscriptParagraphs: readonly { paragraphRef: string; text: string; modelText?: string; paraId?: string }[];
    nonBodyParagraphs: readonly { part: string; index: number; text: string }[];
    templateInventory?: TemplateReadInventory;
  },
): ModelReadReceipt {
  const calls = evidenceFromEvents(events);
  const gaps: string[] = [];
  const displayProjectionGaps: string[] = [];
  const modelDeliveryFailures: string[] = [];
  const failedReadAttempts: string[] = [];
  const readCalls = calls.filter(call => call.name === "read_docx_document");
  const refusedOffsets = new Set(readCalls.filter(call => {
    const result = record(call.result);
    return call.modelError || call.status === "error" || result?.text_truncated === true;
  }).map(call => number(record(call.request)?.offset) ?? 0));
  for (const call of readCalls) {
    const result = record(call.result);
    const document = record(result?.document);
    if (call.status === "done" && !call.modelError && Array.isArray(result?.paragraphs)
      && document?.sessionRevision === expected.manuscriptRevision
      && document?.sourceSha256 === expected.manuscriptSourceSha256) {
      refusedOffsets.delete(number(result.offset) ?? number(record(call.request)?.offset) ?? 0);
    }
  }
  const templateGroups = new Map<string, RevisionCoverage>();
  const nonBodyCoverage = nonBodyGroups(expected.nonBodyParagraphs);
  const templatePagesRaw: TemplateReadPage[] = [];
  const displayNarrativeByRevision = new Map<string, {
    revision: number;
    sourceSha256: string;
    pages: NarrativeWindow[];
    paragraphs: Map<string, NarrativeParagraphRead>;
    open: boolean;
    totals: Set<number>;
  }>();
  const formatCalls: ModelReadReceipt["format"]["successfulCalls"] = [];
  let overviewRead = false;
  const activityNarrativeByRevision = new Map<string, NarrativeActivityGroup>();

  for (const activity of activities) {
    if (activity.event.type !== "runtime") continue;
    const event = activity.event.event;
    const retainedPage = event.kind === "operation" && event.operation === "read"
      && event.result.ok === true ? record(event.result.result) : undefined;
    if (event.kind !== "read" && !retainedPage) continue;
    const identity =
      `revision:${activity.document.sessionRevision}:${activity.document.sourceSha256}`;
    const group = activityNarrativeByRevision.get(identity) ?? {
      revision: activity.document.sessionRevision,
      sourceSha256: activity.document.sourceSha256,
      paragraphs: new Map<string, NarrativeParagraphRead>(),
      windows: [],
      requested: new Set<string>(),
      continuations: new Set<string>(),
    };
    const offset = event.kind === "read" ? event.offset : number(retainedPage?.offset) ?? 0;
    if (refusedOffsets.has(offset)) continue;
    if (event.kind === "operation") {
      group.requested.add(readCursor(event.request));
      const continuation = record(retainedPage?.nextQuery) ?? record(retainedPage?.next_query);
      if (continuation) group.continuations.add(readCursor(continuation));
    }
    const rows = event.kind === "read" ? event.paragraphs
      : Array.isArray(retainedPage?.paragraphs) ? retainedPage.paragraphs : [];
    for (const row of rows) {
      const paragraph = record(row);
      if (paragraph) addNarrativeParagraph(group.paragraphs, paragraph, offset, gaps, "TaskStore read activity");
    }
    group.windows.push({
      offset,
      nextOffset: retainedPage?.nextOffset === null ? null
        : number(retainedPage?.nextOffset) ?? (rows.length > 0 ? offset + rows.length : null),
      paragraphRefs: rows.flatMap((paragraph) => text(record(paragraph)?.paragraphRef) ?? []),
    });
    activityNarrativeByRevision.set(identity, group);
  }

  for (const call of calls) {
    const coverageTool = [
      "read_docx_document",
      "read_docx_format",
      "journal_read",
    ].includes(call.name);
    const resultObject = record(call.result);
    const backendSafetyLimit =
      resultObject?.text_truncated === true
      || (
        typeof resultObject?.error === "string"
        && resultObject.error.includes("tool output exceeded the backend safety limit")
      );
    if (coverageTool && backendSafetyLimit) {
      const failure = `${call.name} ${call.callId} reached the model as a backend safety-limit error`;
      modelDeliveryFailures.push(failure);
      failedReadAttempts.push(failure);
    }
    if (coverageTool && call.modelError) {
      failedReadAttempts.push(`${call.name} ${call.callId} returned isError`);
      continue;
    }
    if (call.status !== "done") {
      if (coverageTool && call.status === "error" && !backendSafetyLimit) {
        failedReadAttempts.push(`${call.name} ${call.callId} did not complete successfully`);
      }
      continue;
    }
    if (backendSafetyLimit) continue;
    if (call.detailTruncated || !record(call.result)) {
      if (call.name === "read_docx_document") {
        displayProjectionGaps.push(
          `${call.callId}: transcript result is a cropped display projection; TaskStore activity is authoritative`,
        );
      } else if (coverageTool) {
        displayProjectionGaps.push(`${call.name} ${call.callId} has no complete display result; later successful reads must supply coverage`);
      }
      continue;
    }
    if (call.name === "read_docx_document") {
      const data = record(call.result);
      if (!data) {
        gaps.push(`read_docx_document ${call.callId} did not return a JSON object`);
        continue;
      }
      const documentIdentity = record(data.document);
      const revision = number(documentIdentity?.sessionRevision);
      const sourceSha256 = text(documentIdentity?.sourceSha256);
      const offset = number(data.offset);
      const totalParagraphs = number(data.totalParagraphs);
      const rows = data.paragraphs;
      if (
        revision === undefined
        || !sourceSha256
        || offset === undefined
        || totalParagraphs === undefined
        || !Array.isArray(rows)
      ) {
        gaps.push(`read_docx_document ${call.callId} omitted window identity or pagination`);
        continue;
      }
      const identity = `revision:${revision}:${sourceSha256}`;
      const group = displayNarrativeByRevision.get(identity) ?? {
        revision,
        sourceSha256,
        pages: [],
        paragraphs: new Map<string, NarrativeParagraphRead>(),
        open: false,
        totals: new Set<number>(),
      };
      group.totals.add(totalParagraphs);
      const paragraphRefs: string[] = [];
      for (const row of rows) {
        const paragraph = record(row);
        const paragraphRef = text(paragraph?.paragraphRef);
        if (!paragraph || !paragraphRef) {
          gaps.push(`read_docx_document ${call.callId} returned an incomplete paragraph`);
          continue;
        }
        addNarrativeParagraph(group.paragraphs, paragraph, offset, gaps, "read_docx_document");
        paragraphRefs.push(paragraphRef);
      }
      const rawNext = data.nextOffset !== undefined
        ? data.nextOffset
        : data.next_offset;
      const nextOffset = rawNext === null
        ? null
        : number(rawNext);
      if (nextOffset === undefined) {
        gaps.push(`read_docx_document ${call.callId} omitted nextOffset`);
      } else {
        group.pages.push({
          offset,
          nextOffset,
          paragraphRefs,
        });
        if (nextOffset === null) group.open = true;
      }
      displayNarrativeByRevision.set(identity, group);
      continue;
    }
    if (call.name === "read_docx_format") {
      const response = record(call.result);
      const tracked = response?.operation === "read_format";
      if (tracked && response.ok !== true) {
        failedReadAttempts.push(`read_docx_format ${call.callId} returned ok:false`);
        continue;
      }
      const data = tracked ? record(response.result) : response;
      if (!data) continue;
      const documentIdentity = record(tracked ? response.document : data.document);
      const revision = number(data.revision);
      const sourceSha256 = text(data.sourceSha256) ?? text(data.source_sha256);
      const liveRevision = number(documentIdentity?.sessionRevision);
      const liveSourceSha256 = text(documentIdentity?.sourceSha256);
      if (revision === undefined || !sourceSha256 || liveRevision === undefined || !liveSourceSha256) {
        gaps.push(`read_docx_format ${call.callId} omitted revision/source identity`);
        continue;
      }
      const request = record(call.request);
      const query = record(request?.query);
      formatCalls.push({
        callId: call.callId,
        query: query ?? null,
        revision,
        sourceSha256,
        liveRevision,
        liveSourceSha256,
      });
      const boundToManuscript =
        revision === expected.manuscriptRevision
        && sourceSha256 === expected.manuscriptFormatSourceSha256
        && liveRevision === expected.manuscriptRevision
        && liveSourceSha256 === expected.manuscriptSourceSha256;
      const expectedRevision = number(query?.expected_revision);
      const overview = record(data.overview);
      if (overview) {
        if (
          boundToManuscript
          && expectedRevision === expected.manuscriptRevision
          && text(query?.kind) === "overview"
        ) {
          overviewRead = true;
        } else {
          failedReadAttempts.push(
            `read_docx_format ${call.callId} overview is not bound to the pre-task revision`,
          );
        }
      }

      if (text(query?.kind) !== "paragraphs" || !Array.isArray(data.paragraphs)) {
        continue;
      }
      const queryPartRaw = text(query?.part);
      const queryPart = queryPartRaw ? formatPart(queryPartRaw) : undefined;
      const queryObjectId = text(query?.object_id);
      let paragraphPart = queryPart
        ? nonBodyCoverage.get(queryPart)
        : undefined;
      if (!paragraphPart && queryObjectId) {
        paragraphPart = [...nonBodyCoverage.values()].find(
          (group) => group.objectIndexes.has(queryObjectId),
        );
      }
      if (!paragraphPart) continue;
      if (!boundToManuscript || expectedRevision !== expected.manuscriptRevision) {
        failedReadAttempts.push(
          `read_docx_format ${call.callId} non-body page is not bound to the pre-task revision`,
        );
        continue;
      }
      const pageOffset = number(query?.offset) ?? 0;
      const rows = data.paragraphs;
      const objectIds: string[] = [];
      for (const [rowOffset, value] of rows.entries()) {
        const item = record(value);
        if (!item) {
          gaps.push(`read_docx_format ${call.callId} returned a malformed paragraph`);
          continue;
        }
        const rowPart = text(item.part);
        if (rowPart && formatPart(rowPart) !== paragraphPart.part) {
          gaps.push(
            `read_docx_format ${call.callId} returned ${rowPart} while reading ${paragraphPart.part}`,
          );
          continue;
        }
        const objectId = text(item.object_id) ?? text(item.objectId);
        const index = objectId
          ? paragraphPart.objectIndexes.get(objectId)
            ?? (queryObjectId ? undefined : pageOffset + rowOffset)
          : undefined;
        if (!objectId || index === undefined) {
          gaps.push(
            `read_docx_format ${call.callId} cannot map paragraph row ${rowOffset} in ${paragraphPart.part}`,
          );
          continue;
        }
        const readOffset =
          number(item.modelTextOffset)
          ?? number(item.textOffset)
          ?? 0;
        addNonBodyParagraph(
          paragraphPart,
          index,
          item,
          readOffset,
          expected.manuscriptRevision,
          gaps,
        );
        objectIds.push(objectId);
      }
      const rawNext = data.nextOffset !== undefined
        ? data.nextOffset
        : data.next_offset;
      const nextOffset = rawNext === null
        ? null
        : number(rawNext);
      if (nextOffset === undefined) {
        gaps.push(`read_docx_format ${call.callId} omitted nextOffset`);
      } else if (!queryObjectId) {
        paragraphPart.windows.push({ offset: pageOffset, nextOffset, objectIds });
        mergeRange(paragraphPart.ranges, pageOffset, pageOffset + rows.length);
        const total = number(data.total);
        if (total !== undefined) {
          paragraphPart.expectedTotal = paragraphPart.expectedTotal === null
            ? total
            : Math.max(paragraphPart.expectedTotal, total);
        }
      }
    }
  }

  const nonBody = [...nonBodyCoverage.values()]
    .sort((left, right) => left.part.localeCompare(right.part))
    .map((group) => completeNonBodyPart(group, gaps));

  const manuscriptIdentity =
    `revision:${expected.manuscriptRevision}:${expected.manuscriptSourceSha256}`;
  const narrative = activityNarrativeByRevision.get(manuscriptIdentity);
  const displayNarrative = displayNarrativeByRevision.get(manuscriptIdentity);
  const expectedParagraphs = new Map(
    expected.manuscriptParagraphs.map((paragraph) => [paragraph.paragraphRef, paragraph]),
  );
  const observedParagraphs = narrative ? [...narrative.paragraphs.values()] : [];
  if (!narrative) {
    gaps.push("no successful model narrative read activity reached the pre-task manuscript revision");
  } else {
    if (narrative.paragraphs.size !== expectedParagraphs.size) {
      gaps.push(
        `TaskStore read activity paragraph coverage ${narrative.paragraphs.size}/${expectedParagraphs.size}`,
      );
    }
    const intervals = narrative.windows.map((window) => ({
      start: window.offset,
      end: window.offset + window.paragraphRefs.length,
    }));
    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: TextRange[] = [];
    for (const interval of intervals) mergeRange(merged, interval.start, interval.end);
    const closed = merged.length === 1
      && merged[0].start === 0
      && merged[0].end === expected.manuscriptParagraphs.length;
    if (!closed) {
      gaps.push(
        `TaskStore read windows ${JSON.stringify(merged)} do not cover `
        + `0..${expected.manuscriptParagraphs.length}`,
      );
    }
    for (const [paragraphRef, expectedParagraph] of expectedParagraphs) {
      const observed = narrative.paragraphs.get(paragraphRef);
      if (!observed) {
        gaps.push(`TaskStore read activity did not read ${paragraphRef}`);
      } else {
        if (materializedText(observed) === null) {
          gaps.push(`TaskStore read activity left incomplete text for ${paragraphRef}`);
        } else if (observed.text !== expectedParagraph.text) {
          gaps.push(`TaskStore read activity plain text changed for ${paragraphRef}`);
        }
        if (observed.model && (materializedText(observed.model) === null
          || (expectedParagraph.modelText !== undefined
            && materializedText(observed.model) !== expectedParagraph.modelText))) {
          gaps.push(`TaskStore read activity left incomplete or changed model text for ${paragraphRef}`);
        }
        for (const [objectRef, payload] of observed.payloads ?? []) {
          if (materializedText(payload) === null) {
            gaps.push(`TaskStore read activity left incomplete payload for ${objectRef}`);
          }
        }
      }
    }
    for (const cursor of narrative.continuations) {
      if (!narrative.requested.has(cursor)) gaps.push(`TaskStore read continuation was not consumed: ${cursor}`);
    }
    if (displayNarrative) {
      if (
        displayNarrative.totals.size > 0
        && (
          displayNarrative.totals.size !== 1
          || !displayNarrative.totals.has(expected.manuscriptParagraphs.length)
        )
      ) {
        gaps.push(
          `display read total ${JSON.stringify([...displayNarrative.totals])}`
          + ` disagrees with TaskStore total ${expected.manuscriptParagraphs.length}`,
        );
      }
      for (const [paragraphRef, displayParagraph] of displayNarrative.paragraphs) {
        const activityParagraph = narrative.paragraphs.get(paragraphRef);
        if (!activityParagraph || materializedText(displayParagraph) === null
          || activityParagraph.text !== displayParagraph.text) {
          gaps.push(
            `display read projection disagrees with TaskStore for ${paragraphRef}`,
          );
        }
      }
    }
  }

  const templateCalls = calls.filter((call) => call.name === "journal_read");
  const templatePages = fragmentsForTemplate(
    templateCalls,
    expected.templateWorldVersionId,
    templatePagesRaw,
    gaps,
  );
  const templateInventoryCoverage = expected.templateInventory
    ? collectTemplateReadCoverage(templatePages, expected.templateInventory, expected.templateWorldVersionId)
    : undefined;
  if (templateInventoryCoverage) gaps.push(...templateInventoryCoverage.gaps);
  for (const { data, request } of templatePages) {
    if ((data.collection ?? request.collection ?? "objects") !== "objects") continue;
    const sourceSha256 = text(data.source_sha256) ?? text(data.sourceSha256);
    if (!sourceSha256) {
      gaps.push("journal_read template page omitted source_sha256");
      continue;
    }
    if (sourceSha256 !== expected.templateSourceSha256) {
      gaps.push("journal_read template page source differs from the selected template source");
      continue;
    }
    const snapshot = record(data.snapshot);
    const objects = snapshot?.objects;
    if (!Array.isArray(objects)) {
      gaps.push("journal_read template response omitted snapshot.objects");
      continue;
    }
    const query = record(request);
    const offset = number(query?.offset) ?? number(data.offset) ?? 0;
    addPage(
      templateGroups,
      `world:${expected.templateWorldVersionId}:${sourceSha256}`,
      sourceSha256,
      data,
      objects,
      offset,
    );
  }

  const templateGroupsForWorld = [...templateGroups.values()].filter(
    (group) => group.identity.includes(expected.templateWorldVersionId),
  );
  if (templateGroupsForWorld.length > 1) {
    gaps.push("template reads were split across more than one source identity");
  }
  const templateGroup = templateGroupsForWorld[0];
  const templateSourceSha256 = templateGroup?.sourceSha256 ?? null;
  const templateParagraphs = templateGroup
    ? [...templateGroup.paragraphs.values()]
    : [];
  if (!templateGroup) {
    gaps.push("no successful model journal_read covered the selected template world");
  } else {
    if (!templateGroup.pageClosed) gaps.push("template object pagination did not close");
    if (
      templateGroup.expectedTotal === null
      || templateGroup.objectIdsSeen.size !== templateGroup.expectedTotal
    ) {
      gaps.push(
        `template object coverage ${templateGroup.objectIdsSeen.size}/${templateGroup.expectedTotal ?? "?"}`,
      );
    }
    for (const item of templateParagraphs) {
      if (!rangeComplete(item.ranges, item.textLength)) {
        gaps.push(
          `template paragraph ${item.part}#${item.objectId} text coverage ${JSON.stringify(item.ranges)}/${item.textLength}`,
        );
      }
    }
  }

  return {
    complete: gaps.length === 0,
    gaps,
    manuscript: {
      revision: expected.manuscriptRevision,
      sourceSha256: expected.manuscriptSourceSha256,
      expectedParagraphs: expected.manuscriptParagraphs.length,
      observedParagraphs: narrative?.paragraphs.size ?? 0,
      activityWindows: (narrative?.windows ?? []).map((window) => ({
        ...window,
        nextOffset:
          window.offset + window.paragraphRefs.length
            === expected.manuscriptParagraphs.length
            ? null
            : window.offset + window.paragraphRefs.length,
      })),
      paragraphs: observedParagraphs.map(({
        paragraphRef,
        paraId,
        textLength,
        textSha256,
        readOffsets,
      }) => ({
        paragraphRef,
        paraId,
        textLength,
        textSha256,
        readOffsets,
      })),
    },
    displayProjectionGaps,
    modelDeliveryFailures,
    failedReadAttempts,
    format: {
      overviewRead,
      nonBodyPartsRead: nonBody
        .filter((part) => part.completeText)
        .map((part) => part.part),
      nonBody,
      successfulCalls: formatCalls,
    },
    template: {
      worldVersionId: expected.templateWorldVersionId,
      sourceSha256: templateSourceSha256,
      expectedObjects: templateGroup?.expectedTotal ?? null,
      observedParagraphs: templateGroup?.objectIdsSeen.size ?? 0,
      paragraphs: templateParagraphs,
      inventoryCoverage: templateInventoryCoverage,
    },
    successfulToolCalls: calls
      .filter((call) => call.status === "done" && !call.modelError
        && record(call.result)?.text_truncated !== true && call.resultText !== undefined)
      .map((call) => ({
        callId: call.callId,
        name: call.name,
        request: call.request,
        resultSha256: sha256(Buffer.from(call.resultText!)),
        identityBasis: call.identityBasis,
      })),
  };
}

export async function retireAndReadSource(
  page: Page,
  project: JournalProject,
  baselineId: string,
  path: string,
) {
  const source = await journalRequest<{
    content_base64: string;
    source_sha256: string;
  }>(
    page,
    `/api/manuscript-source?project_id=${encodeURIComponent(project.project_id)}`
      + `&baseline_id=${encodeURIComponent(baselineId)}`,
  );
  const bytes = Buffer.from(source.content_base64, "base64");
  expect(sha256(bytes)).toBe(source.source_sha256);
  await writeFile(path, bytes);
  return { ...source, bytes };
}

export async function readHashes(
  paths: { template: string; english: string; chinese: string },
) {
  return {
    template: sha256(await readFile(paths.template)),
    english: sha256(await readFile(paths.english)),
    chinese: sha256(await readFile(paths.chinese)),
  };
}

export async function writeJson(path: string, value: unknown) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

export async function readWorldProject(
  page: Page,
  projectId: string,
): Promise<JournalProject> {
  const project = (await journalRequest<JournalState>(page, "/api/state"))
    .projects.find((item) => item.project_id === projectId);
  expect(project, `Workbench project ${projectId} is missing`).toBeTruthy();
  return project!;
}

export type {
  DocxActivityPage,
  DocxDocumentRead,
  DocxFormatReadResult,
  JournalCheck,
  JournalProject,
  JournalState,
  JournalWorld,
  ResearchTask,
  TaskTranscriptEvent,
};

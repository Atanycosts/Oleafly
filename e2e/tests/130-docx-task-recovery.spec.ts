import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type { DocxRecoveryListing, DocxRecoveryMetadata, DocxRecoverySnapshot } from "../../src/lib/docx-recovery";
import type { DocxActivity, DocxActivityPage, DocxActivityTarget } from "../../src/lib/docx-task-activity";
import type { DocxRender } from "../../src/lib/docx-render";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { GroupSnapshot } from "../../src/lib/task-collaboration";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab, waitLong, type Page } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_DOCX_ATTRIBUTION_RECOVERY === "1";
const stage = process.env.OLEAFLY_DOCX_RECOVERY_STAGE;
const run = process.env.OLEAFLY_DOCX_RECOVERY_RUN;
const input = process.env.OLEAFLY_REAL_DOCX;
const inputHash = process.env.OLEAFLY_REAL_DOCX_SHA256;
const python = process.env.OLEAFLY_WORKBENCH_PYTHON!;
const PROVIDER = "docx-recovery-fixture";
const MODEL = "gpt/gpt-6.1-sol";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const path = (name: string) => resolve(run!, name);
const live = (page: Page) => page.evaluate<DocxDocumentRead>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);

interface Inventory {
  paragraphs: { text: string; safe: boolean }[];
}
interface Ledger {
  baselines: string[];
  requests: { requestId: string; resultBaselineId: string | null }[];
}
interface RunState {
  projectId: string;
  manuscript: string;
  originalSessionId: string;
  baselineId: string;
  original: string;
  proposed: string;
  proposal: DocxActivity;
  recovery: DocxRecoveryMetadata;
  restoredSessionId?: string;
  pending?: DocxRecoveryMetadata;
  committed?: { baselineId: string; sourceSha256: string; revision: number };
  committedSaved?: DocxActivity;
  committedLedger?: Ledger;
}
const readRun = async () => JSON.parse(await readFile(path("attribution.json"), "utf8")) as RunState;
const writeRun = (state: RunState) => writeFile(path("attribution.json"), JSON.stringify(state, null, 2));

async function activities(page: Page, state: Pick<RunState, "projectId" | "manuscript">) {
  const retained: DocxActivity[] = [];
  let cursor = 0;
  for (;;) {
    const batch = await page.evaluate<DocxActivityPage>(`window.__TAURI_INTERNALS__.invoke('research_docx_activities', {
      projectId: ${scriptValue(state.projectId)}, workbenchProjectId: ${scriptValue(state.manuscript)}, afterCursor: ${cursor}, limit: 50 })`);
    retained.push(...batch.activities.map(({ activity }) => activity));
    if (!batch.hasMore) return retained;
    expect(batch.nextCursor).toBeGreaterThan(cursor);
    cursor = batch.nextCursor;
  }
}

function ledger(state: Pick<RunState, "manuscript">): Ledger {
  const database = resolve(process.env.OLEAFLY_DATA_DIR!, "journal-library", "projects", state.manuscript, "project.sqlite3");
  const script = `import json,sqlite3,sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True) as db:
    baselines=[row[0] for row in db.execute("SELECT baseline_id FROM baseline ORDER BY rowid")]
    requests=[{"requestId":row[0],"resultBaselineId":json.loads(row[1]).get("result_baseline_id")} for row in db.execute("SELECT request_id,result_json FROM baseline_request ORDER BY rowid")]
print(json.dumps({"baselines":baselines,"requests":requests}))`;
  return JSON.parse(execFileSync(python, ["-c", script, database], { encoding: "utf8" }));
}

async function clickButton(page: Page, root: string, label: string) {
  await page.evaluate(`(() => {
    const surface = document.querySelector(${scriptValue(root)});
    const button = Array.from(surface.querySelectorAll('button')).find(item => item.textContent.trim() === ${scriptValue(label)});
    if (!button || button.disabled) throw new Error('Unavailable button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

async function selectProject(page: Page, projectId: string) {
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().openProject(${scriptValue(projectId)}))`);
  await expect.poll(() => page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => ({ id: m.useFilesStore.getState().projectId, loading: m.useFilesStore.getState().loading }))`)).toEqual({ id: projectId, loading: false });
}

async function restore(page: Page, state: RunState, recovery: DocxRecoveryMetadata) {
  await expect(page.getByTestId("docx-recovery-open")).toBeVisible({ timeout: 30_000 });
  await selectProject(page, state.projectId);
  await page.getByTestId("docx-recovery-open").click();
  const candidate = page.locator(`[data-testid=docx-recovery-candidate][data-recovery-key="${recovery.recoveryKey}"]`);
  await expect(candidate).toBeVisible();
  await page.locator(`[data-testid=docx-recovery-candidate][data-recovery-key="${recovery.recoveryKey}"] [data-testid=docx-recovery-restore]`).click();
  await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 90_000 });
}

async function checkpoint(page: Page, state: RunState, pending: boolean): Promise<DocxRecoveryMetadata> {
  let selected: DocxRecoveryMetadata | undefined;
  await expect.poll(async () => {
    const listing = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
    expect(listing.failures).toEqual([]);
    for (const candidate of listing.snapshots.filter(item => item.appProjectId === state.projectId)) {
      const snapshot = JSON.parse(await readFile(resolve(process.env.OLEAFLY_DATA_DIR!, "docx-recovery", `${candidate.recoveryKey}.json`), "utf8"));
      const bytes = Buffer.from(snapshot.contentBase64, "base64");
      if (hash(bytes) !== candidate.contentSha256 || !strFromU8(unzipSync(bytes)["word/document.xml"]).includes(state.proposed)) continue;
      if (!snapshot.taskState?.applied.some((source: { proposalId: string }) => source.proposalId === state.proposal.id)) continue;
      if (Boolean(snapshot.taskState.pendingSave) !== pending) continue;
      selected = candidate;
      return true;
    }
    return false;
  }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toBe(true);
  return selected!;
}

async function readSnapshot(page: Page, metadata: DocxRecoveryMetadata) {
  // Typed array values cannot cross the native eval JSON boundary directly.
  return page.evaluate<Omit<DocxRecoverySnapshot, "bytes"> & { bytes: number[] }>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(async m => {
    const snapshot = await m.readDocxRecovery(${scriptValue(metadata)});
    if (!snapshot) throw new Error('Selected checkpoint is missing');
    return { ...snapshot, bytes: Array.from(snapshot.bytes) };
  })`);
}

async function confirmRefusedRequest(page: Page, state: RunState, bytes: Buffer) {
  const current = await live(page);
  // Freeze a real pending request before it is sent, then advance the baseline
  // through the shared service. This reproduces a known refusal after restart
  // without intercepting HTTP or replacing the native commit implementation.
  const pending = await page.evaluate<DocxRecoveryMetadata>(`(async () => {
    const recovery = await window.__oleaflyE2EImport('/src/lib/docx-recovery.ts');
    const workbench = await window.__oleaflyE2EImport('/src/lib/journal-workbench.ts');
    const read = await window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument());
    const source = await workbench.journalRequest('/api/manuscript-source?project_id=' + encodeURIComponent(read.document.workbenchProjectId) + '&baseline_id=' + encodeURIComponent(read.document.baselineId));
    const bytes = Uint8Array.from(atob(source.content_base64), character => character.charCodeAt(0));
    const { sessionId, appProjectId, workbenchProjectId, baselineId, sourceSha256, sessionRevision, savedRevision } = read.document;
    return recovery.saveDocxRecovery({ appProjectId: read.document.appProjectId,
      workbenchProjectId: source.project_id, baseBaselineId: source.baseline_id,
      sourceSha256: source.source_sha256 }, read.document.sessionRevision, bytes.buffer,
      { document: { sessionId, appProjectId, workbenchProjectId, baselineId, sourceSha256, sessionRevision, savedRevision }, applied: [], receipts: [], pendingSave: {
        projectId: source.project_id, expectedBaselineId: source.baseline_id, filename: source.filename,
        reason: 'Reproduce a stale fixed save in the isolated acceptance library',
        requestId: 'docx-' + crypto.randomUUID(), revision: read.document.sessionRevision,
      } });
  })()`);
  expect(pending.contentSha256).toBe(hash(bytes));
  const advanced = await page.evaluate<{ result_baseline_id: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/baseline', ${scriptValue({
    project_id: state.manuscript, expected_baseline_id: current.document.baselineId,
    filename: basename(input!), content_base64: bytes.toString("base64"), reason: "Reproduce a stale fixed save in the isolated acceptance library",
    request_id: `refusal-advance-${Date.now()}`,
  })}))`);
  const before = ledger(state);
  expect(before.baselines.at(-1)).toBe(advanced.result_baseline_id);
  await clickButton(page, '[data-testid="docx-render-preview"]', "Close");
  await clickButton(page, '[data-testid="docx-workspace"]', "Close");
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
  await expect(page.getByTestId("docx-recovery-open")).toBeVisible();
  await page.getByTestId("docx-recovery-open").click();
  const selector = `[data-testid=docx-recovery-candidate][data-recovery-key="${pending.recoveryKey}"]`;
  await expect(page.locator(`${selector} [data-testid=docx-recovery-discard]`)).toBeDisabled();
  await page.evaluate(`(() => {
    window.__docxRefusalResponses = 0;
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    const register = callbacks.set.bind(callbacks);
    callbacks.set = (id, callback) => register(id, result => {
      if (result?.refusal === 'BASELINE_CONFLICT') window.__docxRefusalResponses += 1;
      return callback(result);
    });
  })()`);
  await page.locator(`${selector} [data-testid=docx-recovery-restore]`).click();
  await expect.poll(() => page.evaluate<number>(`window.__docxRefusalResponses`)).toBe(1);
  await expect(page.getByTestId("docx-recovery-dialog")).toContainText("BASELINE_CONFLICT", { timeout: 30_000 });
  await expect(page.locator(`${selector} [data-testid=docx-recovery-discard]`)).toBeEnabled();
  await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
  const refusedLedger = ledger(state);
  expect(refusedLedger.baselines).toEqual(before.baselines);
  expect(refusedLedger.requests.filter(item => item.requestId === pending.taskState!.pendingSave!.requestId))
    .toEqual([{ requestId: pending.taskState!.pendingSave!.requestId, resultBaselineId: null }]);
  // A repeat confirms the same persisted refusal, with no new baseline or Saved.
  await page.locator(`${selector} [data-testid=docx-recovery-restore]`).click();
  await expect.poll(() => page.evaluate<number>(`window.__docxRefusalResponses`)).toBe(2);
  await expect(page.locator(`${selector} [data-testid=docx-recovery-download]`)).toBeEnabled();
  const downloaded = path("refused-checkpoint.docx");
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(downloaded)})`);
  await page.locator(`${selector} [data-testid=docx-recovery-download]`).click();
  await expect.poll(() => readFile(downloaded).then(hash, () => null)).toBe(pending.contentSha256);
  await page.locator(`${selector} [data-testid=docx-recovery-discard]`).click();
  await page.getByTestId("docx-recovery-confirm-discard").click();
  await expect(page.locator(selector)).toHaveCount(0);
  const listing = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
  expect(listing.snapshots).toEqual([]);
  expect(ledger(state)).toEqual(refusedLedger);
  expect((await activities(page, state)).filter(item => item.event.type === "outcome" && item.event.outcome.kind === "saved"))
    .toEqual([state.committedSaved]);
  return { outcome: "BASELINE_CONFLICT", recovery: pending, currentBaselineId: advanced.result_baseline_id,
    discarded: true, downloadedSha256: hash(await readFile(downloaded)), ledger: refusedLedger };
}

async function source(page: Page, state: RunState, baselineId: string) {
  return page.evaluate<{ source_sha256: string; content_base64: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest(${scriptValue(`/api/manuscript-source?project_id=${encodeURIComponent(state.manuscript)}&baseline_id=${encodeURIComponent(baselineId)}`)}))`);
}

function packageComparison(savedPath: string, state: RunState) {
  const comparison = JSON.parse(execFileSync(python, ["e2e/tests/docx-real-package.py", input!, savedPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  expect(comparison.missingParts).toEqual([]);
  expect(comparison.addedParts).toEqual([]);
  expect(comparison.changedMedia).toEqual([]);
  expect(comparison.changedRelationships).toEqual([]);
  expect(comparison.lostOrModifiedProtectedNodes).toEqual({});
  expect(comparison.paragraphCount.before).toBe(comparison.paragraphCount.after);
  expect(comparison.paragraphTextChanges).toHaveLength(1);
  expect(comparison.paragraphTextChanges[0]).toMatchObject({ before: state.original, after: state.proposed });
  return comparison;
}

function toolResult<T>(request: Record<string, unknown>, field: string): T {
  for (const message of [...request.messages as { role: string; content: unknown }[]].reverse()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const envelope = JSON.parse(message.content);
    const result = Array.isArray(envelope.content)
      ? JSON.parse(envelope.content.find((entry: { type: string }) => entry.type === "text").text) : envelope;
    if (field in result) return result;
  }
  throw new Error(`Missing actual tool result containing ${field}`);
}

test.beforeEach(async () => {
  test.skip(!enabled, "Use the isolated native runner with OLEAFLY_DOCX_ATTRIBUTION_RECOVERY=1.");
  expect(stage).toBeTruthy();
  expect(run).toBeTruthy();
  expect(process.env.OLEAFLY_E2E_PRODUCTION).toBe("1");
  expect(hash(await readFile(input!))).toBe(inputHash);
});

// Model choices are scripted. Native task provenance, editor, crash lifecycle,
// checkpoint store, Workbench and LibreOffice execute their real product paths.
test("prepare native task-attributed checkpoint before SIGKILL", async ({ tauriPage: page }) => {
  test.skip(stage !== "prepare");
  test.setTimeout(300_000);
  const server = await startMockAiServer();
  try {
    const authorBytes = await readFile(input!);
    const inventory: Inventory = JSON.parse(execFileSync(python, ["e2e/tests/docx-real-package.py", input!], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    await createBlankProject(page, `DOCX task recovery ${basename(input!)} ${Date.now()}`);
    const projectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async m => {
      const config = await m.getConfig();
      await m.setConfig({ ...config, ai_custom_providers: [...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}), { id: ${scriptValue(PROVIDER)}, name: 'Scripted DOCX recovery fixture', baseURL: ${scriptValue(`${server.url}/v1`)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(PROVIDER)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'user' }] } });
    })`);
    await openRailTab(page, "Journal checks");
    const panel = page.getByTestId("journal-checks-panel");
    await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({ timeout: 30_000 });
    await panel.getByText("Import DOCX", { exact: true }).click();
    await page.fill('[role="dialog"] input:not([type="file"])', `Recovery ${basename(input!)}`);
    await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: basename(input!), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: authorBytes }]);
    await page.click('[role="dialog"] button[type="submit"]');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await panel.getByText("Edit DOCX working copy", { exact: true }).click();
    await expect.poll(() => live(page).then(read => read.document.dirty, () => null), { timeout: 90_000 }).toBe(false);
    const before = await live(page);
    const xml = strFromU8(unzipSync(authorBytes)["word/document.xml"]);
    const topLevel = await page.evaluate<string[]>(`(() => {
      const doc = new DOMParser().parseFromString(${scriptValue(xml)}, 'application/xml');
      const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      return Array.from(doc.getElementsByTagNameNS(ns, 'body')[0].children).filter(node => node.namespaceURI === ns && node.localName === 'p').map(node => Array.from(node.getElementsByTagNameNS(ns, 't')).map(t => t.textContent).join(''));
    })()`);
    const offset = before.paragraphs.findIndex(paragraph => topLevel.includes(paragraph.text) && paragraph.text.length >= 120 && paragraph.text.length <= 1800 && inventory.paragraphs.filter(p => p.text === paragraph.text).length === 1 && inventory.paragraphs.some(p => p.text === paragraph.text && p.safe));
    expect(offset).toBeGreaterThanOrEqual(0);
    const original = before.paragraphs[offset].text;
    const proposed = `${original} [DOCX recovery acceptance]`;
    let proposal: { activity: DocxActivity; presented: boolean } | undefined;
    const steps = [
      { name: "discover_tools", args: () => ({ query: "docx" }) },
      { name: "list_docx_documents", args: () => ({}) },
      { name: "read_docx_document", args: () => ({ offset, limit: 1 }) },
      { name: "capture_docx_target", args: (request: Record<string, unknown>) => ({ paragraph_ref: toolResult<{ paragraphs: { paragraphRef: string }[] }>(request, "paragraphs").paragraphs[0].paragraphRef }) },
      { name: "propose_docx_change", args: (request: Record<string, unknown>) => {
        const target = toolResult<{ target: DocxActivityTarget }>(request, "target").target;
        return { target_id: target.targetId, expected_revision: target.revision, text: proposed };
      } },
      { name: "docx_task_activity", args: (request: Record<string, unknown>) => {
        proposal = toolResult(request, "presented");
        return { limit: 50 };
      } },
    ];
    server.setResponder(request => {
      const messages = request.messages as { role: string; content: unknown }[];
      if (messages.some(m => m.role === "system" && typeof m.content === "string" && m.content.includes("Assess responsibility-based participation"))) return '{"decisions":[]}';
      const step = steps[messages.filter(m => m.role === "tool").length];
      return step ? { name: step.name, args: step.args(request) } : "DOCX_RECOVERY_PROPOSAL_COMPLETE";
    });
    const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.createResearchTask(${scriptValue({ projectId, title: "DOCX recovery provenance", prompt: "Read the bound DOCX window, capture the paragraph and propose one bounded change for user review. Do not apply or save. Finish after reading the retained proposal activity.", runtimeId: "builtin", agentId: PROVIDER, modelId: MODEL, skillIds: [], dependencyIds: [] })}))`);
    const group = await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.createTaskGroup(${scriptValue(projectId)}, ${scriptValue(task.id)}, [{ name: 'DOCX recovery reviewer', responsibility: 'Own one bound DOCX proposal; do not delegate or subscribe.', runtimeId: 'builtin', agentId: ${scriptValue(PROVIDER)}, modelId: ${scriptValue(MODEL)}, skillIds: [], coordinator: true }]))`);
    await clickButton(page, '[aria-label="Task activity"]', "Refresh activity");
    await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] select option')).some(option => option.value === ${scriptValue(task.id)})`, 15_000);
    await page.selectOption('[aria-label="Task activity"] select', task.id);
    await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] button')).some(button => button.textContent.trim() === 'Bind current DOCX' && !button.disabled)`, 15_000);
    await clickButton(page, '[aria-label="Task activity"]', "Bind current DOCX");
    await expect.poll(async () => (await activities(page, { projectId, manuscript: before.document.workbenchProjectId })).some(item =>
      item.origin.taskId === task.id && item.event.type === "runtime" && item.event.event.kind === "bound"),
    { timeout: 15_000 }).toBe(true);
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(task.id)}))`);
    await waitLong(page, `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => ['awaiting_review', 'failed'].includes((await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)})?.status))`, 150_000);
    const settled = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
    expect(settled.status, settled.error ?? "task result").toBe("awaiting_review");
    expect(proposal?.presented).toBe(true);
    expect((await live(page)).paragraphs).toEqual(before.paragraphs);
    expect(proposal!.activity.origin).toMatchObject({ taskId: task.id, generation: settled.executionGeneration, groupId: group.group.id });
    expect(proposal!.activity.origin.memberId).toBeTruthy();
    expect(proposal!.activity.origin.executionId).toBeTruthy();
    expect(proposal!.activity.origin.workIds.length).toBeGreaterThan(0);
    await clickButton(page, '[data-testid="docx-suggestion"]', "Accept");
    await expect.poll(() => live(page).then(read => read.paragraphs.some(p => p.text === proposed))).toBe(true);
    const state: RunState = { projectId, manuscript: before.document.workbenchProjectId, originalSessionId: before.document.sessionId, baselineId: before.document.baselineId, original, proposed, proposal: proposal!.activity, recovery: {} as DocxRecoveryMetadata };
    state.recovery = await checkpoint(page, state, false);
    const snapshot = await readSnapshot(page, state.recovery);
    expect(snapshot.taskState!.document.sessionId).toBe(before.document.sessionId);
    expect(snapshot.taskState!.applied.map(item => item.proposalId)).toEqual([state.proposal.id]);
    expect(hash(Buffer.from(snapshot.bytes))).toBe(state.recovery.contentSha256);
    await writeFile(path("accepted-checkpoint.docx"), Buffer.from(snapshot.bytes));
    await writeFile(path("accepted-package.json"), JSON.stringify(packageComparison(path("accepted-checkpoint.docx"), state), null, 2));
    expect(ledger(state).baselines).toEqual([state.baselineId]);
    await writeRun(state);
    await writeFile(path("prepared-activities.json"), JSON.stringify(await activities(page, state), null, 2));
    await page.screenshot({ path: path("accepted-before-kill.png") });
  } finally {
    await writeFile(path("scripted-requests.json"), JSON.stringify(server.requestBodies().map(body => JSON.parse(body)), null, 2));
    await server.close();
  }
});

test("restore-save native task checkpoint then interrupt a committed response", async ({ tauriPage: page }) => {
  test.skip(stage !== "restore-save");
  test.setTimeout(300_000);
  const state = await readRun();
  await restore(page, state, state.recovery);
  await expect.poll(() => live(page).then(read => read.document.dirty, () => null), { timeout: 90_000 }).toBe(true);
  await expect(page.getByTestId("docx-recovered-source")).toHaveCount(1, { timeout: 30_000 });
  const recovered = await live(page);
  expect(recovered.document.sessionId).not.toBe(state.originalSessionId);
  expect(recovered.paragraphs.some(p => p.text === state.proposed)).toBe(true);
  expect(recovered.document.savedRevision).toBe(-1);
  await expect(page.getByTestId("docx-suggestion")).toHaveCount(0);
  const retained = await activities(page, state);
  const resumed = retained.filter(item => item.proposalId === state.proposal.id && item.event.type === "outcome" && item.event.outcome.kind === "recovered");
  expect(resumed).toHaveLength(1);
  expect(resumed[0].origin).toEqual(state.proposal.origin);
  expect(resumed[0].document.sessionId).toBe(recovered.document.sessionId);
  expect(resumed[0].event).toMatchObject({ type: "outcome", outcome: { kind: "recovered", recoveryKey: state.recovery.recoveryKey, contentSha256: state.recovery.contentSha256, fromDocument: { sessionId: state.originalSessionId } } });
  // Let the real UI prepare and persist its save, then let native commit finish
  // Workbench and TaskStore. Only the response to React is withheld until kill.
  await page.evaluate(`(() => {
    window.__docxRecoveryCommitProbe = {};
    // Tauri defines invoke as a non-writable property. Its callback registry is
    // exposed for debugging; wrap registration and withhold only the exact
    // three-field native commit result before its promise is resolved.
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    const register = callbacks.set.bind(callbacks);
    callbacks.set = (id, callback) => register(id, result => {
      if (result && typeof result === 'object' &&
        Object.keys(result).sort().join(',') === 'baselineId,revision,sourceSha256' &&
        typeof result.baselineId === 'string' && typeof result.sourceSha256 === 'string' &&
        typeof result.revision === 'number') {
        window.__docxRecoveryCommitProbe = { result, callbackId: id };
        return;
      }
      return callback(result);
    });
    if (!Object.hasOwn(callbacks, 'set')) throw new Error('The native callback fault injection was not installed');
  })()`);
  await clickButton(page, '[data-testid="docx-workspace"]', "Save manuscript version");
  await expect.poll(() => page.evaluate<boolean>(`!!window.__docxRecoveryCommitProbe?.result`), { timeout: 90_000 }).toBe(true);
  const result = await page.evaluate<NonNullable<RunState["committed"]>>(`window.__docxRecoveryCommitProbe.result`);
  state.restoredSessionId = recovered.document.sessionId;
  state.pending = await checkpoint(page, state, true);
  state.committed = result;
  expect(result.baselineId).not.toBe(state.baselineId);
  expect(result.sourceSha256).toBe(state.recovery.contentSha256);
  // React is still awaiting the response, so its displayed session remains dirty.
  expect((await live(page)).document.dirty).toBe(true);
  const pending = await readSnapshot(page, state.pending);
  expect(pending.taskState?.pendingSave?.requestId).toMatch(/^docx-/);
  expect(pending.taskState?.document.sessionId).toBe(recovered.document.sessionId);
  const saved = (await activities(page, state)).filter(item => item.proposalId === state.proposal.id && item.event.type === "outcome" && item.event.outcome.kind === "saved");
  expect(saved).toHaveLength(1);
  state.committedSaved = saved[0];
  expect(saved[0].origin).toEqual(state.proposal.origin);
  expect(saved[0].document.baselineId).toBe(result.baselineId);
  expect(saved[0].event).toMatchObject({ type: "outcome", outcome: { kind: "saved", requestId: pending.taskState!.pendingSave!.requestId, contentSha256: state.recovery.contentSha256 } });
  const actual = await source(page, state, result.baselineId);
  expect(Buffer.from(actual.content_base64, "base64").equals(await readFile(path("accepted-checkpoint.docx")))).toBe(true);
  state.committedLedger = ledger(state);
  expect(state.committedLedger.baselines).toEqual([state.baselineId, result.baselineId]);
  expect(state.committedLedger.requests.filter(item => item.requestId === pending.taskState!.pendingSave!.requestId)).toEqual([{ requestId: pending.taskState!.pendingSave!.requestId, resultBaselineId: result.baselineId }]);
  await writeRun(state);
  await writeFile(path("response-lost-activities.json"), JSON.stringify(await activities(page, state), null, 2));
  await page.screenshot({ path: path("native-commit-response-withheld.png") });
});

test("reconcile native committed request after SIGKILL without another baseline", async ({ tauriPage: page }) => {
  test.skip(stage !== "reconcile");
  test.setTimeout(300_000);
  const state = await readRun();
  expect(state.pending).toBeDefined();
  expect(state.committed).toBeDefined();
  await restore(page, state, state.pending!);
  await expect.poll(() => live(page).then(read => read.document.dirty, () => null), { timeout: 90_000 }).toBe(false);
  const reopened = await live(page);
  expect(reopened.document.sessionId).not.toBe(state.restoredSessionId);
  expect(reopened.document.baselineId).toBe(state.committed!.baselineId);
  expect(reopened.document.sourceSha256).toBe(state.committed!.sourceSha256);
  expect(reopened.paragraphs.filter(p => p.text === state.proposed)).toHaveLength(1);
  await expect(page.getByTestId("docx-suggestion")).toHaveCount(0);
  expect(ledger(state)).toEqual(state.committedLedger);
  const retained = await activities(page, state);
  const outcomes = retained.filter(item => item.proposalId === state.proposal.id && item.event.type === "outcome");
  expect(outcomes.filter(item => item.event.type === "outcome" && item.event.outcome.kind === "applied")).toHaveLength(1);
  expect(outcomes.filter(item => item.event.type === "outcome" && item.event.outcome.kind === "recovered")).toHaveLength(1);
  const saved = outcomes.filter(item => item.event.type === "outcome" && item.event.outcome.kind === "saved");
  expect(saved).toHaveLength(1);
  expect(saved.find(item => item.id === state.committedSaved!.id)).toEqual(state.committedSaved);
  for (const result of outcomes) expect(result.origin).toEqual(state.proposal.origin);
  const listing = await page.evaluate<DocxRecoveryListing>(`window.__oleaflyE2EImport('/src/lib/docx-recovery.ts').then(m => m.listDocxRecovery())`);
  expect(listing.snapshots).toEqual([]);
  expect(listing.failures).toEqual([]);
  const actual = await source(page, state, reopened.document.baselineId);
  const bytes = Buffer.from(actual.content_base64, "base64");
  expect(hash(bytes)).toBe(state.recovery.contentSha256);
  await writeFile(path("reconciled.docx"), bytes);
  await writeFile(path("reconciled-package.json"), JSON.stringify(packageComparison(path("reconciled.docx"), state), null, 2));
  await expect(page.getByTestId("docx-render-state")).toContainText("PDF matches the saved working copy", { timeout: 150_000 });
  const renders = await page.evaluate<DocxRender[]>(`window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(m => m.loadDocxRenders(${scriptValue(state.manuscript)}, ${scriptValue(reopened.document.baselineId)}))`);
  const render = renders.find(item => item.baseline_id === reopened.document.baselineId && item.manifest.source_sha256 === hash(bytes));
  expect(render).toBeDefined();
  expect(render!.manifest.render_record.renderer_engine).toBe("LibreOffice");
  expect(render!.manifest.page_count).toBeGreaterThan(0);
  const pdf = await page.evaluate<number[]>(`window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(async m => Array.from(await m.loadDocxPdf(${scriptValue(state.manuscript)}, ${scriptValue(render)})))`);
  expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  expect(hash(Buffer.from(pdf))).toBe(render!.manifest.pdf_sha256);
  await writeFile(path("reconciled.pdf"), Buffer.from(pdf));
  await writeFile(path("reconciled-render.json"), JSON.stringify(render, null, 2));
  await clickButton(page, '[data-testid="docx-workspace"]', "Open PDF");
  await expect(page.getByTestId("docx-render-preview").locator("canvas").first()).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: path("reconciled-pdf.png") });
  await writeFile(path("reconciled-activities.json"), JSON.stringify(retained, null, 2));
  const reconciledLedger = ledger(state);
  const refused = await confirmRefusedRequest(page, state, bytes);
  await writeFile(path("refused-save.json"), JSON.stringify(refused, null, 2));
  const authorSha256 = hash(await readFile(input!));
  expect(authorSha256).toBe(inputHash);
  await writeFile(path("result.json"), JSON.stringify({ outcome: "PASSED", faultPoints: ["accepted-checkpoint-before-save", "native-commit-response-withheld"], authorSha256, savedBaselineId: reopened.document.baselineId, savedSourceSha256: hash(bytes), ledger: reconciledLedger, render, refused, modelDecisions: "scripted" }, null, 2));
});

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { TauriPage } from "@srsholmes/tauri-playwright";
import type { DocxDocumentRead } from "../../packages/ai-tools/src/tools";
import type { DocxActivity, DocxActivityPage, DocxActivityTarget } from "../../src/lib/docx-task-activity";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { GroupSnapshot } from "../../src/lib/task-collaboration";
import type { DocxRender } from "../../src/lib/docx-render";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab, waitLong } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

const PROVIDER = "docx-task-fixture";
const MODEL = "gpt/gpt-6.1-sol";
const ORIGINAL = "Validation is independent test data.";
const REPLACEMENTS = [
  "Validation selects the model. Keep test data held out.",
  "验证集用于选择模型，测试集用于独立评估。",
];
type Request = Record<string, unknown>;
type Message = { role: string; content: unknown };

function fixture(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>${ORIGINAL}</w:t></w:r></w:p><w:p><w:r><w:t>Human paragraph stays independent.</w:t></w:r></w:p><w:p><w:r><w:t>Protected field </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p><w:p><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Retained table cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`),
  });
}

function result<T>(request: Request, field: string): T {
  for (const message of [...request.messages as Message[]].reverse()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const envelope = JSON.parse(message.content);
    const value = Array.isArray(envelope.content)
      ? JSON.parse(envelope.content.find((entry: { type: string }) => entry.type === "text").text) : envelope;
    if (field in value) return value as T;
  }
  throw new Error(`No DOCX tool result containing ${field}.`);
}

const live = (page: TauriPage) => page.evaluate<DocxDocumentRead>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`);
const history = (page: TauriPage, projectId: string, manuscript: string) => page.evaluate<DocxActivityPage>(`window.__TAURI_INTERNALS__.invoke('research_docx_activities', { projectId: ${scriptValue(projectId)}, workbenchProjectId: ${scriptValue(manuscript)}, afterCursor: 0, limit: 50 })`);

async function clickButton(page: TauriPage, root: string, label: string) {
  await page.evaluate(`(() => {
    const surface = document.querySelector(${scriptValue(root)});
    const button = Array.from(surface.querySelectorAll('button')).find(item => item.textContent.trim() === ${scriptValue(label)});
    if (!button || button.disabled) throw new Error('Unavailable button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

// Scripted model decisions, actual Tauri task runtime, DOCX editor and Workbench.
test("native tasks propose DOCX changes and retain user decisions with exact saved versions", async ({ tauriPage: page }, testInfo) => {
  test.setTimeout(480_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `DOCX task attribution ${Date.now()}`);
    const projectId = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(async api => {
      const config = await api.getConfig();
      await api.setConfig({ ...config, ai_custom_providers: [...(config.ai_custom_providers ?? []).filter(p => p.id !== ${scriptValue(PROVIDER)}), { id: ${scriptValue(PROVIDER)}, name: 'Scripted DOCX task fixture', baseURL: ${scriptValue(`${server.url}/v1`)}, keyOptional: true }], ai_provider_models: { ...config.ai_provider_models, [${scriptValue(PROVIDER)}]: [{ id: ${scriptValue(MODEL)}, name: ${scriptValue(MODEL)}, enabled: true, source: 'user' }] } });
    })`);
    await openRailTab(page, "Journal checks");
    const panel = page.getByTestId("journal-checks-panel");
    await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({ timeout: 30_000 });
    await panel.getByText("Import DOCX", { exact: true }).click();
    await page.fill('[role="dialog"] input:not([type="file"])', "DOCX task fixture");
    await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: "task-fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(fixture()) }]);
    await page.click('[role="dialog"] button[type="submit"]');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await panel.getByText("Edit DOCX working copy", { exact: true }).click();
    await expect.poll(() => live(page).then((read) => read.paragraphs[0]?.text, () => null), { timeout: 90_000 }).toBe(ORIGINAL);
    const initial = await live(page);
    const manuscript = initial.document.workbenchProjectId;
    const records: { task: ResearchTask; proposed: DocxActivity; saved: DocxActivity; group: GroupSnapshot | null }[] = [];
    for (const [index, replacement] of REPLACEMENTS.entries()) {
      server.resetRequests();
      const group = index === 1;
      let proposal: { target: DocxActivityTarget; activity: DocxActivity; presented: boolean } | undefined;
      const steps = [
        { name: "discover_tools", args: () => ({ query: "docx" }) },
        { name: "list_docx_documents", args: () => ({}) },
        { name: "read_docx_document", args: () => ({ offset: 0, limit: 3 }) },
        { name: "capture_docx_target", args: (request: Request) => ({ paragraph_ref: result<{ paragraphs: { paragraphRef: string }[] }>(request, "paragraphs").paragraphs[0].paragraphRef }) },
        { name: "propose_docx_change", args: (request: Request) => {
          const captured = result<{ target: DocxActivityTarget }>(request, "target").target;
          return { target_id: captured.targetId, expected_revision: captured.revision, text: replacement };
        } },
        { name: "docx_task_activity", args: (request: Request) => {
          proposal = result(request, "presented");
          return { limit: 50 };
        } },
      ];
      server.setResponder((request) => {
        const messages = request.messages as Message[];
        if (messages.some((message) => message.role === "system" && typeof message.content === "string" && message.content.includes("Assess responsibility-based participation"))) return '{"decisions":[]}';
        const step = steps[messages.filter((message) => message.role === "tool").length];
        return step ? { name: step.name, args: step.args(request) } : "DOCX_TASK_PROPOSAL_COMPLETE";
      });
      const task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.createResearchTask(${scriptValue({ projectId, title: group ? "DOCX group proposal" : "DOCX single proposal", prompt: "Read the bound DOCX, capture its first paragraph and propose a correction. Do not apply or save. Read the retained activity before finishing.", runtimeId: "builtin", agentId: PROVIDER, modelId: MODEL, skillIds: [], dependencyIds: [] })}))`);
      const snapshot = group ? await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.createTaskGroup(${scriptValue(projectId)}, ${scriptValue(task.id)}, [{ name: 'DOCX reviewer', responsibility: 'Read the bound manuscript and propose the correction for user review.', runtimeId: 'builtin', agentId: ${scriptValue(PROVIDER)}, modelId: ${scriptValue(MODEL)}, skillIds: [], coordinator: true }]))`) : null;
      await clickButton(page, '[aria-label="Task activity"]', "Refresh activity");
      await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] select option')).some(option => option.value === ${scriptValue(task.id)})`, 15_000);
      await page.selectOption('[aria-label="Task activity"] select', task.id);
      await waitLong(page, `Array.from(document.querySelectorAll('[aria-label="Task activity"] button')).some(button => button.textContent.trim() === 'Bind current DOCX' && !button.disabled)`, 15_000);
      await clickButton(page, '[aria-label="Task activity"]', "Bind current DOCX");
      await expect.poll(async () => (await history(page, projectId, manuscript)).activities.some(({ activity }) => activity.origin.taskId === task.id && activity.event.type === "runtime" && activity.event.event.kind === "bound")).toBe(true);
      const before = await live(page);
      await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.startResearchTask(${scriptValue(task.id)}))`);
      await waitLong(page, `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => ['awaiting_review', 'failed'].includes((await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)})?.status))`, 150_000);
      const settled = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m => (await m.listResearchTasks(${scriptValue(projectId)})).find(t => t.id === ${scriptValue(task.id)}))`);
      expect(settled.status, settled.error ?? "task result").toBe("awaiting_review");
      expect(proposal?.presented).toBe(true);
      expect((await live(page)).paragraphs).toEqual(before.paragraphs);
      expect((await live(page)).document.sessionRevision).toBe(before.document.sessionRevision);
      const final = server.requestBodies().map((body) => JSON.parse(body) as Request).at(-1)!;
      expect(result<DocxActivityPage>(final, "activities").activities.some(({ activity }) => activity.id === proposal!.activity.id)).toBe(true);
      const requestTools = (final.tools as { function: { name: string } }[]).map((entry) => entry.function.name);
      expect(requestTools).not.toContain("apply_docx_suggestion");
      expect(requestTools).not.toContain("save_docx_document");
      const retained = (await history(page, projectId, manuscript)).activities.map((entry) => entry.activity);
      const proposed = retained.find((activity) => activity.id === proposal!.activity.id)!;
      expect(proposed.origin.taskId).toBe(task.id);
      expect(proposed.origin.generation).toBe(settled.executionGeneration);
      expect(proposed.document.sourceSha256).toBe(before.document.sourceSha256);
      if (snapshot) {
        const actual = await page.evaluate<GroupSnapshot>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskGroup(${scriptValue(projectId)}, ${scriptValue(task.id)}))`);
        const execution = actual.executions.find((entry) => entry.id === proposed.origin.executionId)!;
        expect(proposed.origin.groupId).toBe(snapshot.group.id);
        expect(proposed.origin.memberId).toBe(execution.memberId);
        expect(execution.modelId).toBe(MODEL);
        expect(execution.agentId).toBe(PROVIDER);
        expect(proposed.origin.workIds.length).toBeGreaterThan(0);
        for (const id of proposed.origin.workIds) expect(actual.work.some((work) => work.id === id && work.executionId === execution.id && work.memberId === execution.memberId)).toBe(true);
      } else {
        expect(proposed.origin.memberId).toBeNull();
        expect(proposed.origin.executionId).toBeNull();
        expect(proposed.origin.workIds).toEqual([]);
      }
      await clickButton(page, '[data-testid="docx-suggestion"]', "Accept");
      await expect.poll(async () => (await live(page)).paragraphs[0].text).toBe(replacement);
      await expect.poll(async () => (await history(page, projectId, manuscript)).activities.some(({ activity }) => activity.proposalId === proposed.id && activity.event.type === "outcome" && activity.event.outcome.kind === "applied")).toBe(true);
      await clickButton(page, '[data-testid="docx-workspace"]', "Save manuscript version");
      await expect.poll(() => live(page).then((read) => read.document.dirty), { timeout: 90_000 }).toBe(false);
      await expect.poll(async () => (await history(page, projectId, manuscript)).activities.some(({ activity }) => activity.proposalId === proposed.id && activity.event.type === "outcome" && activity.event.outcome.kind === "saved"), { timeout: 20_000 }).toBe(true);
      const saved = (await history(page, projectId, manuscript)).activities.map((entry) => entry.activity).find((activity) => activity.proposalId === proposed.id && activity.event.type === "outcome" && activity.event.outcome.kind === "saved")!;
      expect(saved.origin).toEqual(proposed.origin);
      const current = await live(page);
      expect(saved.document.baselineId).toBe(current.document.baselineId);
      expect(saved.document.baselineId).not.toBe(before.document.baselineId);
      const source = await page.evaluate<{ source_sha256: string; content_base64: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest('/api/manuscript-source?project_id=${encodeURIComponent(manuscript)}&baseline_id=${encodeURIComponent(saved.document.baselineId)}'))`);
      const bytes = Buffer.from(source.content_base64, "base64");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(saved.document.sourceSha256);
      expect(source.source_sha256).toBe(saved.document.sourceSha256);
      const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
      expect(xml).toContain(replacement);
      expect(xml).toContain("fldSimple");
      expect(xml).toContain("oMath");
      expect(xml).toContain("Retained table cell.");
      await writeFile(testInfo.outputPath(`task-${index}-saved.docx`), bytes);
      records.push({ task: settled, proposed, saved, group: snapshot });
    }
    await expect(page.getByTestId("docx-render-state")).toContainText("PDF matches the saved working copy", { timeout: 150_000 });
    const saved = records.at(-1)!.saved;
    const renders = await page.evaluate<DocxRender[]>(`window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(m => m.loadDocxRenders(${scriptValue(manuscript)}, ${scriptValue(saved.document.baselineId)}))`);
    expect(renders.some((render) => render.manifest.source_sha256 === saved.document.sourceSha256 && render.manifest.page_count > 0)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("task-proposal-saved.png") });
    await writeFile(testInfo.outputPath("task-activity.json"), JSON.stringify({ records, activities: await history(page, projectId, manuscript), renders }, null, 2));
    await clickButton(page, '[aria-label="Task activity"]', "Open bound task");
    await expect(page.getByTestId("research-task-detail")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("docx-workspace")).toBeHidden();
    await page.locator('[data-testid="task-docx-observations"] summary').click();
    await expect(page.getByTestId("task-docx-observations")).toContainText(REPLACEMENTS[1]);
    await clickButton(page, '[data-testid="task-observations"]', "Load more observations");
    await expect(page.getByTestId("task-docx-observations")).toContainText(saved.document.baselineId);
    await page.screenshot({ path: testInfo.outputPath("task-history-navigation.png") });
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(m => m.useResearchTasksStore.getState().setDetailOpen(false))`);
    await page.evaluate(`(() => { const resume = Array.from(document.querySelectorAll('button')).find(button => button.textContent.startsWith('Resume DOCX working copy')); if (!resume) throw new Error('DOCX resume button missing'); resume.click(); })()`);
    await expect(page.getByTestId("docx-workspace")).toBeVisible();
    expect((await live(page)).document.sessionId).toBe(initial.document.sessionId);
    await clickButton(page, '[data-testid="docx-workspace"]', "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
    expect((await history(page, projectId, manuscript)).activities.some(({ activity }) => activity.id === records[0].proposed.id)).toBe(true);
    await openRailTab(page, "Journal checks");
    await panel.getByText("Edit DOCX working copy", { exact: true }).click();
    await expect.poll(() => live(page).then((read) => read.paragraphs[0]?.text, () => null), { timeout: 90_000 }).toBe(REPLACEMENTS[1]);
    expect((await live(page)).document.sessionId).not.toBe(initial.document.sessionId);
    await expect(page.getByTestId("docx-suggestion")).toHaveCount(0);
  } finally {
    await writeFile(testInfo.outputPath("scripted-requests.json"), JSON.stringify(server.requestBodies().map((body) => JSON.parse(body)), null, 2));
    await server.close();
  }
});

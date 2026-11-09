import { strToU8, zipSync } from "fflate";
import { writeFileSync } from "node:fs";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { AnnotationContext, TaskAnnotation } from "../../src/lib/task-collaboration";
import type { JournalAnnotationRequest, JournalObjectReference } from "../../src/lib/journal-workbench";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

function decodeToolResult(content: string) {
  const result = JSON.parse(content);
  if (Array.isArray(result.content) && typeof result.isError === "boolean") {
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    return JSON.parse(result.content[0].text);
  }
  return result;
}

// Scripted provider tests native Workbench/storage/tool integration, not model reasoning.
// Group subscription/poll delivery and real-provider quality have separate acceptance scopes.
test("historical journal feedback creates an explicit task and links real business results", async ({ tauriPage: page }, testInfo) => {
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires an installed Workbench Python environment.");
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  let startedTaskId: string | null = null;
  let taskSettled = false;
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) await page.press("body", "Escape");
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `Journal annotations ${Date.now()}`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m=>m.useSettingsStore.getState().setUiLocalePreference('en'))`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const source = "\\documentclass{article}\n\\begin{document}\nCURRENT-LATEX-SOURCE\n\\end{document}\n";
    const amended = source.replace("CURRENT-LATEX-SOURCE", "CURRENT-LATEX-SOURCE JOURNAL-REVIEWED-TASK-COPY");
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m=>m.writeFileContent(${scriptValue(projectId)},'main.tex',${scriptValue(source)}))`);
    await openRailTab(page, "Journal checks");
    const panel = page.getByTestId("journal-checks-panel");
    await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({ timeout: 30_000 });
    const docx = Buffer.from(zipSync({
      "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>REAL-DOCX-JOURNAL-CONTENT</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/><w:cols w:num="1"/></w:sectPr></w:body></w:document>'),
    }));
    await panel.getByText("Import DOCX", { exact: true }).click();
    await page.fill('[role="dialog"] input:not([type="file"])', "Retained journal manuscript");
    await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: "manuscript.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx }]);
    await page.click('[role="dialog"] button[type="submit"]');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await panel.getByText("Import journal sources", { exact: true }).click();
    await page.fill('[role="dialog"] input[id$="-name"]', "Historical journal");
    await page.fill('[role="dialog"] input[id$="-journal"]', `journal-${projectId}`);
    const quote = "All manuscript pages must use A4 paper.";
    await page.setInputFiles('[role="dialog"] input[type="file"]', [{ name: "guide.txt", mimeType: "text/plain", buffer: Buffer.from(quote) }]);
    await page.click('[role="dialog"] button[type="submit"]');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await panel.getByText("Use this version", { exact: true }).click();
    await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
    await panel.getByText("Run check", { exact: true }).click();
    await expect(panel.getByText("Violation 2", { exact: true })).toBeVisible();
    const reference = await page.evaluate<JournalObjectReference>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async j=>{
      const w=await window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m=>m.getResearchWorkspace(${scriptValue(projectId)}));
      const state=await j.journalRequest('/api/state'); const p=state.projects.find(p=>p.project_id===w.journalProjectId);
      const world=await j.journalRequest('/api/world?version_id='+p.binding.world_version_id);
      return {libraryRoot:(await j.connectJournalWorkbench()).libraryRoot,workbenchProjectId:p.project_id,kind:'rule',objectId:world.rules.find(r=>r.property==='page_width_twips').rule_id,worldVersionId:world.version_id,checkId:p.latest_check.check_id};
    })`);
    const baseline = server.requestCount();
    const root = await page.evaluate<TaskAnnotation>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async j=>{
      await j.loadJournalAnnotationObject(${scriptValue(projectId)},${scriptValue(reference)});
      return j.saveJournalAnnotation(${scriptValue(projectId)},${scriptValue(reference)},'Keep this historical A4 requirement as evidence.',null);
    })`);
    expect(root.explicitRequest).toBe(false);
    expect(root.source?.content).toContain(quote);
    expect(server.requestCount()).toBe(baseline);
    const revised = await page.evaluate<{ version_id: string }>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(j=>j.journalRequest('/api/revise',{version_id:${scriptValue(reference.worldVersionId)},rule_id:${scriptValue(reference.objectId)},expected:12240,reason:'New operator revision; retain previous binding.'}))`);
    expect(revised.version_id).not.toBe(reference.worldVersionId);
    const requestBody = "Review this historical journal rule against the retained DOCX and current task source; amend only the task copy and link your handling.";
    const requested = await page.evaluate<JournalAnnotationRequest>(`window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(async j=>{
      const selected=await window.__oleaflyE2EImport('/src/lib/assistant-delegation-capture.ts').then(m=>m.captureAssistantTarget(${scriptValue(projectId)}));
      return j.requestJournalAnnotation({projectId:${scriptValue(projectId)},reference:${scriptValue(reference)},body:${scriptValue(requestBody)},parentId:${scriptValue(root.id)},mentions:[],taskId:null,draft:{projectId:${scriptValue(projectId)},title:'Historical journal review',prompt:${scriptValue(requestBody)},...selected,skillIds:[],dependencyIds:[]}});
    })`);
    expect(requested.created).toBe(true);
    expect(requested.needsStart).toBe(true);
    expect(requested.task.status).toBe("queued");
    expect(requested.task.startRequested).toBe(false);
    expect(server.requestCount()).toBe(baseline);
    const steps = [
      { name: "discover_tools", args: { query: "journal_" } },
      { name: "discover_tools", args: { query: "annotation_" } },
      { name: "annotation_context", args: { id: requested.annotation.id } },
      { name: "journal_context", args: {} },
      { name: "journal_read", args: { operation: "object", kind: "rule", object_id: reference.objectId, world_version_id: reference.worldVersionId } },
      { name: "journal_read", args: { operation: "content", query: { region: "body", page_size: 20 } } },
      { name: "journal_check", args: {} },
      { name: "read_file", args: { path: "main.tex" } },
      { name: "write_file", args: { path: "main.tex", content: amended } },
      { name: "compile", args: {} },
    ];
    server.setResponder(body => {
      const messages = body.messages as { role: string; content: unknown }[];
      const results = messages.filter(m=>m.role==="tool" && typeof m.content==="string").map(m=>decodeToolResult(m.content as string));
      if (results.length < steps.length) return steps[results.length];
      const artifact = results.find(r=>r.artifact?.generation > 0)?.artifact;
      if (results.length === steps.length) return { name: "discover_tools", args: { query: "task_pdf_text" } };
      if (results.length === steps.length + 1) return { name: "task_pdf_text", args: { reference: artifact } };
      if (results.length === steps.length + 2) return { name: "annotation_handle", args: { annotationId: requested.annotation.id, summary: "Reviewed retained A4 rule and DOCX; compiled the amended task copy. New guide remains unbound.", resultRefs: [results.find(r=>r.sourceRole==="retained_reference_data").target, artifact] } };
      return "Historical requirement and current DOCX were read; a real check and task PDF were produced, with handling linked for review.";
    });
    startedTaskId = requested.task.id;
    await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m=>m.startResearchTask(${scriptValue(requested.task.id)}))`);
    let task = requested.task;
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m=>(await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.id===${scriptValue(task.id)}))`);
      return task.status;
    }, { timeout: 120_000, intervals: [500] }).toBe("awaiting_review");
    taskSettled = true;
    const bodies = server.requestBodies().map(body=>JSON.parse(body));
    const last = bodies[bodies.length-1].messages as { role: string; content: unknown }[];
    const results = last.filter(m=>m.role==="tool" && typeof m.content==="string").map(m=>decodeToolResult(m.content as string));
    expect(JSON.stringify(results[2])).toContain(quote);
    const current = results[3].current.snapshot;
    expect(current.captured.worldVersionId).toBe(reference.worldVersionId);
    expect(current.project.binding.world_version_id).toBe(reference.worldVersionId);
    expect(current.project.latestCheck.validity).toBe("CURRENT");
    expect(current.project.latestCheck.updateAvailable).toBe(true);
    expect(current.latexApplicability.status).toBe("not_checked");
    expect(results[4].reference.worldVersionId).toBe(reference.worldVersionId);
    expect(results[4].object.expected).toBe(11906);
    expect(JSON.stringify(results[5])).toContain("REAL-DOCX-JOURNAL-CONTENT");
    expect(results[6].check.check_id).toBeTruthy();
    expect(results[6].check.world_version_id).toBe(reference.worldVersionId);
    expect(results[6].latexApplicability.status).toBe("not_checked");
    expect(results[11].text).toContain("JOURNAL-REVIEWED-TASK-COPY");
    expect(task.result?.changedFiles.some(file=>file.path==="main.tex")).toBe(true);
    expect(await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m=>m.readFileContent(${scriptValue(projectId)},'main.tex'))`)).toBe(source);
    const annotations = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadTaskAnnotations(${scriptValue(projectId)},${scriptValue(task.id)}))`);
    expect(annotations.annotations.find(a=>a.id===requested.annotation.id)).toMatchObject({ parentId: root.id, status: "handled" });
    expect(annotations.handlings.find(h=>h.annotationId===requested.annotation.id)?.resultRefs[0]).toEqual(results[4].target);
    expect(annotations.handlings.find(h=>h.annotationId===requested.annotation.id)?.resultRefs[1]).toEqual({
      projectId, taskId: task.id, objectKind: "task_pdf", objectId: results[11].artifact.pdfSha256,
      objectRevision: `generation:${task.executionGeneration}`, path: results[11].artifact.path,
    });
    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m=>{await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)});m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)},'annotations');})`);
    const detail = page.locator('[data-testid="research-task-detail"]');
    await expect(detail.getByText("Reviewed retained A4 rule and DOCX; compiled the amended task copy. New guide remains unbound.")).toBeVisible();
    await detail.locator('[data-testid="annotation-handling"] button').nth(1).click();
    const pdfReference = detail.getByTestId("task-annotation-source");
    await expect(pdfReference.getByText("Read PDF text", { exact: true })).toBeEnabled();
    await pdfReference.getByText("Read PDF text", { exact: true }).click();
    await expect(pdfReference.locator("pre")).toContainText("JOURNAL-REVIEWED-TASK-COPY");
    await detail.locator('[data-testid="annotation-handling"] button').first().click();
    await expect(page.locator('[data-testid="journal-retained-object"]')).toContainText(quote);
    await expect(page.locator('[data-testid="journal-retained-object"]')).toContainText(reference.worldVersionId);
    writeFileSync(testInfo.outputPath("checks.json"), JSON.stringify({
      mode: "scripted-provider-native-workbench", realModelReasoning: false,
      projectId, taskId: task.id, executionGeneration: task.executionGeneration,
      reference, revisedWorldVersionId: revised.version_id, rootAnnotationId: root.id,
      requestAnnotationId: requested.annotation.id, root, current,
      check: results[6].check, read: results[5], compiled: results[11].artifact,
      annotations, toolResults: results,
      assertions: { feedbackModelRequests: 0, pendingModelRequests: 0, explicitStartCalls: 1, compiledPdfLinkedAndReadableInUi: true, historicalSourceReadableInUi: true, projectSourceUnchanged: true },
    }, null, 2));
  } finally {
    try {
      if (startedTaskId && !taskSettled) {
        await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m=>m.cancelResearchTask(${scriptValue(startedTaskId)}))`);
      }
    } finally {
      await server.close();
    }
  }
});

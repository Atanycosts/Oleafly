import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { AnnotationContext, TaskAnnotation } from "../../src/lib/task-collaboration";
import type { RetainedPdfSelection } from "../../src/lib/pdf-selection";
import { test, expect } from "../fixtures";
import { createBlankProject, fillTextarea, openRailTab, setEditorContent, waitLong } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

// Scripted provider + real app IPC, compile, PDF text/page tools and storage.
// Native selection is a DOM Range; trusted mouse selection is tested in 24.
test("PDF feedback retains the displayed original through recompile and links its review result", async ({ tauriPage: page }, testInfo) => {
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  try {
    if (await page.evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) await page.press("body", "Escape");
    if (await page.evaluate<boolean>(`!!document.querySelector('[title="Back to library"]')`)) await page.click('[title="Back to library"]');
    await createBlankProject(page, `PDF selection ${Date.now()}`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m=>m.useSettingsStore.getState().setViewMode('split'))`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llava") ?? false`)).toBe(true);
    await page.evaluate(`window.__researchTasksSet?.(true)`);
    const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
    const sourceA = "\\documentclass{article}\n\\begin{document}\nFirst page.\\newpage\nORIGINAL-PDF-SELECTION-A\n\\end{document}\n";
    await setEditorContent(page, sourceA);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/compile.ts').then(m => m.useCompileStore.getState().recompile())`);
    await waitLong(page, `!!document.querySelector('[data-pdf-scroll-root] [data-page="2"]')`, 90_000);
    await page.evaluate(`document.querySelector('[data-pdf-scroll-root] [data-page="2"]').scrollIntoView()`);
    await waitLong(page, `!![...document.querySelectorAll('.textLayer span')].find(n => n.textContent.includes('ORIGINAL-PDF-SELECTION-A'))`, 90_000);
    const hashA = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/compile.ts').then(async m => { const bytes=m.useCompileStore.getState().pdfBytes; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join(''); })`);
    await page.evaluate(`(() => { const node=[...document.querySelectorAll('.textLayer span')].find(n=>n.textContent.includes('ORIGINAL-PDF-SELECTION-A')); node.scrollIntoView(); const r=document.createRange(); r.selectNodeContents(node); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
    await page.click('button[aria-label="PDF annotations and review"]');
    const dialog = page.locator('[data-testid="pdf-selection-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("blockquote")).toContainText("ORIGINAL-PDF-SELECTION-A");
    const feedback = "Keep this old PDF as evidence; this comment alone requests no model work.";
    await fillTextarea(page, '[data-testid="pdf-selection-dialog"] textarea', feedback);
    const baseline = server.requestCount();
    await dialog.getByText("Save feedback", { exact: true }).click();
    await expect(dialog.getByText("Feedback saved. No review has been started.")).toBeVisible();
    expect(server.requestCount()).toBe(baseline);
    const root = await page.evaluate<TaskAnnotation>(`window.__oleaflyE2EImport('/src/lib/pdf-selection.ts').then(async m=>(await m.listPdfSelections(${scriptValue(projectId)})).find(a=>a.body===${scriptValue(feedback)}))`);
    expect(root.explicitRequest).toBe(false);
    expect(JSON.parse(root.source!.content)).toMatchObject({ pdfSha256: hashA, selection: { pages: [{ page: 2 }] } });
    await page.click('[data-testid="pdf-selection-dialog"] button[aria-label="Close"]');

    const sourceB = sourceA.replace("ORIGINAL-PDF-SELECTION-A", "CURRENT-PDF-SELECTION-B");
    const revisedSource = sourceB.replace("\\end{document}", "\\par REVIEWED-CURRENT-SOURCE\n\\end{document}");
    await setEditorContent(page, sourceB);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/compile.ts').then(m => m.useCompileStore.getState().recompile())`);
    await page.evaluate(`document.querySelector('[data-pdf-scroll-root] [data-page="2"]').scrollIntoView()`);
    await waitLong(page, `!![...document.querySelectorAll('.textLayer span')].find(n=>n.textContent.includes('CURRENT-PDF-SELECTION-B'))`, 90_000);
    await page.evaluate(`window.getSelection()?.removeAllRanges()`);
    await page.click('button[aria-label="PDF annotations and review"]');
    await dialog.getByText(feedback, { exact: true }).click();
    await expect(dialog.locator("blockquote")).toContainText("ORIGINAL-PDF-SELECTION-A");
    const request = "Recheck the historical PDF selection against today's source, amend the task copy and compile it, keeping the old input distinct from the new result.";
    await fillTextarea(page, '[data-testid="pdf-selection-dialog"] [data-testid="task-annotations"] textarea', request);
    await dialog.locator('[data-testid="task-annotations"] button[role="checkbox"]').click();
    server.setResponder((body) => {
      const messages = body.messages as { role: string; content: unknown }[];
      const prompt = messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      const reference = JSON.parse(/using this complete reference: (\{[^\n]+\})/.exec(prompt)![1]);
      const annotationId = /this task's current request: ([^ .]+)\./.exec(prompt)![1];
      const results = messages.filter((message) => message.role === "tool" && typeof message.content === "string").map((message) => JSON.parse(message.content as string));
      const toolCount = results.length;
      const compiled = [...results].reverse().find((result) => result.artifact?.generation > 0)?.artifact;
      if (toolCount === 0) return { name: "discover_tools", args: { query: "task_pdf_" } };
      if (toolCount === 1) return { name: "discover_tools", args: { query: "annotation_handle" } };
      if (toolCount === 2) return { name: "read_file", args: { path: "main.tex" } };
      if (toolCount === 3) return { name: "task_pdf_text", args: { reference } };
      if (toolCount === 4) return { name: "task_pdf_pages", args: { reference, pages: [2], scale: 1 } };
      if (toolCount === 5) return { name: "write_file", args: { path: "main.tex", content: revisedSource } };
      if (toolCount === 6) return { name: "compile", args: {} };
      if (toolCount === 7) return { name: "task_pdf_text", args: { reference: compiled } };
      if (toolCount === 8) return { name: "task_pdf_pages", args: { reference: compiled, pages: [2], scale: 1 } };
      if (toolCount === 9) return { name: "annotation_handle", args: { annotationId, summary: "Read retained PDF A page 2; it differs from the current B source. Amended the task copy and verified its new PDF.", resultRefs: [{ objectKind: "pdf_selection", objectId: root.target.objectId, objectRevision: root.target.objectRevision, path: root.target.path }] } };
      return "Original PDF A and the revised B output were kept distinct; changes await review and handling is linked to the annotation.";
    });
    await dialog.locator('[data-testid="task-annotations"] button[type="submit"]').click();
    let task: ResearchTask | undefined;
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask | undefined>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m=>(await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.prompt.startsWith(${scriptValue(request)})))`);
      return task?.status;
    }, { timeout: 90_000, intervals: [500] }).toBe("awaiting_review");
    if (!task) throw new Error("The PDF review task was not created.");
    const generation = task.executionGeneration;
    const retained = await page.evaluate<RetainedPdfSelection>(`window.__oleaflyE2EImport('/src/lib/pdf-selection.ts').then(m=>m.loadTaskPdfSelection(${scriptValue(task.id)}))`);
    expect(retained.reference.generation).toBe(0);
    expect(retained.input.pdfSha256).toBe(hashA);
    const bodies = server.requestBodies().map((body) => JSON.parse(body));
    const results = bodies.flatMap((body) => body.messages).filter((message) => message.role === "tool" && typeof message.content === "string").map((message) => JSON.parse(message.content));
    const textResult = results.find((result) => result.artifact?.generation === 0 && Array.isArray(result.pages) && typeof result.pages[0] === "string");
    expect(textResult?.artifact).toEqual(retained.reference);
    expect(JSON.stringify(textResult?.pages)).toContain("ORIGINAL-PDF-SELECTION-A");
    expect(JSON.stringify(textResult?.pages)).not.toContain("CURRENT-PDF-SELECTION-B");
    expect(results.some((result) => result.path === "main.tex" && result.content?.includes("CURRENT-PDF-SELECTION-B"))).toBe(true);
    expect(results.some((result) => result.artifact?.pdfSha256 === hashA && JSON.stringify(result.pages) === "[2]")).toBe(true);
    const compiledText = results.find((result) => result.artifact?.generation === generation && typeof result.pages?.[0] === "string");
    expect(compiledText?.artifact.pdfSha256).not.toBe(hashA);
    expect(JSON.stringify(compiledText?.pages)).toContain("CURRENT-PDF-SELECTION-B");
    expect(JSON.stringify(compiledText?.pages)).toContain("REVIEWED-CURRENT-SOURCE");
    expect(JSON.stringify(compiledText?.pages)).not.toContain("ORIGINAL-PDF-SELECTION-A");
    expect(results.some((result) => result.artifact?.pdfSha256 === compiledText?.artifact.pdfSha256 && JSON.stringify(result.pages) === "[2]")).toBe(true);
    expect(task.result?.changedFiles.some((file) => file.path === "main.tex")).toBe(true);
    expect(await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m=>m.readFileContent(${scriptValue(projectId)},'main.tex'))`)).toBe(sourceB);
    expect(JSON.stringify(bodies)).toContain('data:image/png;base64,');
    const annotations = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadTaskAnnotations(${scriptValue(projectId)},${scriptValue(task.id)}))`);
    expect(annotations.annotations.find((annotation) => annotation.id === retained.annotationId)).toMatchObject({ parentId: root.id, body: request, status: "handled" });
    expect(annotations.handlings.find((handling) => handling.annotationId === retained.annotationId)?.resultRefs[0]).toMatchObject({ objectKind: "pdf_selection", objectId: root.target.objectId });
    const projectAnnotations = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadObjectAnnotations(${scriptValue(root.target)}))`);
    expect(projectAnnotations.annotations.map((annotation) => annotation.id).sort()).toEqual([root.id, retained.annotationId].sort());
    const originalBytes = await page.evaluate<number[]>(`window.__oleaflyE2EImport('/src/lib/pdf-selection.ts').then(async m=>Array.from(new Uint8Array(await m.readPdfSelection(${scriptValue(projectId)},${scriptValue(root.id)}))))`);
    expect(createHash("sha256").update(new Uint8Array(originalBytes)).digest("hex")).toBe(hashA);
    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m=>{await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)});m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)},'annotations');})`);
    const detail = page.locator('[data-testid="research-task-detail"]');
    await expect(detail.getByText("Read retained PDF A page 2; it differs from the current B source. Amended the task copy and verified its new PDF.")).toBeVisible();
    await detail.locator('[data-testid="annotation-handling"] button').click();
    await expect(detail.locator('[data-testid="task-pdf-selection"] blockquote')).toContainText("ORIGINAL-PDF-SELECTION-A");
    await waitLong(page, `!!document.querySelector('[data-testid="task-pdf-selection"] [data-page="2"] .textLayer')`, 30_000);
    await expect.poll(async () => page.evaluate<boolean>(`(() => {
      const scroller = document.querySelector('[data-testid="task-pdf-selection"] [data-pdf-scroll-root]');
      const page = scroller?.querySelector('[data-page="2"]');
      const text = [...page?.querySelectorAll('.textLayer span') ?? []].find(node => node.textContent.includes('ORIGINAL-PDF-SELECTION-A'));
      if (!scroller || !page || !text) return false;
      const viewport = scroller.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return Math.abs(pageRect.top - viewport.top) <= 3 && textRect.top >= viewport.top && textRect.bottom <= viewport.bottom;
    })()`), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("native-pdf-selection.png") });
    writeFileSync(testInfo.outputPath("checks.json"), JSON.stringify({ projectId, taskId: task.id, rootAnnotationId: root.id, root, retained, compiled: compiledText?.artifact,
      hashA, feedbackModelCalls: baseline, reviewModelCalls: server.requestCount() - baseline,
      originalTextAndCurrentSourceDistinct: true, originalPageImageDelivered: true, handlingLinked: true, originalPageAndSelectionVisible: true,
      taskCopyModifiedAndCompiled: true, compiledPageImageDelivered: true, originalProjectSourceUnchanged: true,
      explicitAnnotationEntry: true, singleTaskRequestRecorded: true,
      generation: task.executionGeneration, scriptedProvider: true, realModelReasoningTested: false }, null, 2));
  } finally { await server.close(); }
});

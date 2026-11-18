import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RetainedMaterial } from "../../src/lib/material-annotations";
import type { MaterialSnapshot } from "../../src/lib/material-surface";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type {
  AnnotationContext,
  AnnotationTarget,
} from "../../src/lib/task-collaboration";
import { test, expect } from "../fixtures";
import {
  createBlankProject,
  fillTextarea,
  openRailTab,
  setEditorContent,
  waitLong,
} from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";

function decodeToolResult(content: string): Record<string, any> {
  const result = JSON.parse(content);
  if (Array.isArray(result.content) && typeof result.isError === "boolean") {
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    return JSON.parse(result.content[0].text);
  }
  return result;
}

// Scripted provider + real app IPC, compile, retained material bytes, PDF text
// tools and storage. Native DOM Range selection; trusted mouse selection is 24.
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
    const feedbackPanel = page.getByTestId("material-annotations");
    await expect(feedbackPanel).toBeVisible();
    await expect(feedbackPanel).toContainText("Selected PDF text and areas");
    await expect(feedbackPanel).toContainText("ORIGINAL-PDF-SELECTION-A");
    const feedback = "Keep this old PDF as evidence; this comment alone requests no model work.";
    await fillTextarea(page, '[data-testid="material-annotations"] [data-testid="task-annotations"] textarea', feedback);
    const baseline = server.requestCount();
    await feedbackPanel.getByText("Save annotation", { exact: true }).click();
    await expect(feedbackPanel).toContainText(feedback);
    expect(server.requestCount()).toBe(baseline);

    const objectTarget: AnnotationTarget = {
      projectId,
      taskId: null,
      objectKind: "material",
      objectId: "compiled:main.tex",
      objectRevision: hashA,
      path: null,
    };
    const feedbackContext = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadObjectAnnotations(${scriptValue(objectTarget)}))`);
    const root = feedbackContext.annotations.find((annotation) => annotation.body === feedback);
    if (!root) throw new Error("The material PDF feedback was not retained.");
    expect(root.explicitRequest).toBe(false);
    expect(root.target).toMatchObject(objectTarget);
    const feedbackSnapshot = JSON.parse(root.source!.content) as MaterialSnapshot;
    expect(feedbackSnapshot.sha256).toBe(hashA);
    expect(feedbackSnapshot.document).toMatchObject({
      projectId,
      documentId: "compiled:main.tex",
      path: "main.tex",
      kind: "pdf",
      revision: hashA,
    });
    expect(feedbackSnapshot.anchor).toMatchObject({
      kind: "pdf",
      quote: "ORIGINAL-PDF-SELECTION-A",
      pages: [expect.objectContaining({ page: 2 })],
    });
    const retainedFeedback = await page.evaluate<RetainedMaterial>(`window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m=>m.readMaterialAnnotation(${scriptValue(projectId)},${scriptValue(root.id)}))`);
    expect(createHash("sha256").update(Buffer.from(retainedFeedback.bytes)).digest("hex")).toBe(hashA);

    const sourceB = sourceA.replace("ORIGINAL-PDF-SELECTION-A", "CURRENT-PDF-SELECTION-B");
    const revisedSource = sourceB.replace("\\end{document}", "\\par REVIEWED-CURRENT-SOURCE\n\\end{document}");
    await setEditorContent(page, sourceB);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/compile.ts').then(m => m.useCompileStore.getState().recompile())`);
    await page.evaluate(`document.querySelector('[data-pdf-scroll-root] [data-page="2"]').scrollIntoView()`);
    await waitLong(page, `!![...document.querySelectorAll('.textLayer span')].find(n=>n.textContent.includes('CURRENT-PDF-SELECTION-B'))`, 90_000);
    const hashB = await page.evaluate<string>(`window.__oleaflyE2EImport('/src/store/compile.ts').then(async m => { const bytes=m.useCompileStore.getState().pdfBytes; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join(''); })`);
    expect(hashB).not.toBe(hashA);
    await expect(feedbackPanel).toContainText("ORIGINAL-PDF-SELECTION-A");

    const feedbackCard = feedbackPanel.locator('[data-testid="task-annotation"]').filter({ hasText: feedback });
    await feedbackCard.getByText("Reply", { exact: true }).click();
    const request = "Recheck the historical PDF selection against today's source, amend the task copy and compile it, keeping the old input distinct from the new result.";
    await fillTextarea(page, '[data-testid="material-annotations"] [data-testid="task-annotations"] textarea', request);
    await feedbackPanel.locator('[data-testid="task-annotations"] button[role="checkbox"]').click();

    let frozenMaterialPath = "";
    let explicitAnnotationId = "";
    server.setResponder((body) => {
      const messages = body.messages as { role: string; content: unknown }[];
      const prompt = messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      frozenMaterialPath = /Exact source bytes are at (\S+) and/.exec(prompt)?.[1] ?? frozenMaterialPath;
      explicitAnnotationId = /Current material request: ([^ .]+)\./.exec(prompt)?.[1] ?? explicitAnnotationId;
      const results = messages
        .filter((message) => message.role === "tool" && typeof message.content === "string")
        .map((message) => decodeToolResult(message.content as string));
      const toolCount = results.length;
      const compiled = [...results].reverse().find((result) => result.artifact?.generation > 0)?.artifact;
      if (toolCount === 0) return { name: "discover_tools", args: { query: "read_paper" } };
      if (toolCount === 1) {
        if (!frozenMaterialPath) throw new Error("The material request did not identify its retained PDF.");
        return { name: "read_paper", args: { path: frozenMaterialPath } };
      }
      if (toolCount === 2) return { name: "read_file", args: { path: "main.tex" } };
      if (toolCount === 3) return { name: "write_file", args: { path: "main.tex", content: revisedSource } };
      if (toolCount === 4) return { name: "compile", args: {} };
      if (toolCount === 5) return { name: "discover_tools", args: { query: "task_pdf_text annotation_handle" } };
      if (toolCount === 6) return { name: "task_pdf_text", args: { reference: compiled } };
      if (toolCount === 7) {
        if (!explicitAnnotationId || !compiled) throw new Error("The task did not expose its annotation or compiled PDF.");
        return {
          name: "annotation_handle",
          args: {
            annotationId: explicitAnnotationId,
            summary: "Read retained PDF A page 2; it differs from the current B source. Amended the task copy and verified its new PDF.",
            resultRefs: [compiled],
          },
        };
      }
      return "Original PDF A and the revised B output were kept distinct; changes await review and handling is linked to the annotation.";
    });
    await feedbackPanel.getByText("Save annotation", { exact: true }).click();
    let task: ResearchTask | undefined;
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask | undefined>(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m=>(await m.listResearchTasks(${scriptValue(projectId)})).find(t=>t.prompt.startsWith(${scriptValue(request)})))`);
      return task?.status;
    }, { timeout: 90_000, intervals: [500] }).toBe("awaiting_review");
    if (!task) throw new Error("The PDF review task was not created.");
    const generation = task.executionGeneration;
    expect(task.prompt).toContain("material-source.pdf");
    expect(frozenMaterialPath).toMatch(/^research\/.+material-source\.pdf$/);
    expect(task.isolation).not.toBeNull();
    const executionRoot = task.isolation!.executionRoot;
    const retainedPdfBytes = readFileSync(join(executionRoot, frozenMaterialPath));
    expect(createHash("sha256").update(retainedPdfBytes).digest("hex")).toBe(hashA);
    const materialContext = JSON.parse(readFileSync(
      join(executionRoot, frozenMaterialPath.replace(/material-source\.pdf$/, "material-context.json")),
      "utf8",
    )) as MaterialSnapshot;
    expect(materialContext.sha256).toBe(hashA);
    expect(materialContext.anchor).toMatchObject({
      kind: "pdf",
      quote: "ORIGINAL-PDF-SELECTION-A",
      pages: [expect.objectContaining({ page: 2 })],
    });
    expect(readFileSync(join(executionRoot, "main.tex"), "utf8")).toBe(revisedSource);

    const bodies = server.requestBodies().map((body) => JSON.parse(body));
    const results = bodies.flatMap((body) => body.messages).filter((message) => message.role === "tool" && typeof message.content === "string").map((message) => decodeToolResult(message.content));
    const originalText = results.find((result) => result.source?.pdf?.sha256 === hashA && typeof result.text === "string");
    expect(originalText?.source?.pdf?.pageCount).toBe(2);
    expect(originalText?.text).toContain("ORIGINAL-PDF-SELECTION-A");
    expect(originalText?.text).not.toContain("CURRENT-PDF-SELECTION-B");
    expect(results.some((result) => result.path === "main.tex" && result.content?.includes("CURRENT-PDF-SELECTION-B"))).toBe(true);
    const compiledText = results.find((result) => result.artifact?.generation === generation && typeof result.text === "string");
    expect(compiledText?.artifact.pdfSha256).not.toBe(hashA);
    expect(compiledText?.text).toContain("CURRENT-PDF-SELECTION-B");
    expect(compiledText?.text).toContain("REVIEWED-CURRENT-SOURCE");
    expect(compiledText?.text).not.toContain("ORIGINAL-PDF-SELECTION-A");
    expect(task.result?.changedFiles.some((file) => file.path === "main.tex")).toBe(true);
    expect(await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m=>m.readFileContent(${scriptValue(projectId)},'main.tex'))`)).toBe(sourceB);

    const historyTarget = { ...objectTarget, objectRevision: null };
    const projectAnnotations = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadObjectAnnotations(${scriptValue(historyTarget)}))`);
    const requestRoot = projectAnnotations.annotations.find((annotation) => annotation.body === request && annotation.parentId === root.id && !annotation.explicitRequest);
    const explicit = projectAnnotations.annotations.find((annotation) => annotation.id === explicitAnnotationId);
    if (!requestRoot || !explicit) throw new Error("The material request lineage was not retained.");
    const taskAnnotations = await page.evaluate<AnnotationContext>(`window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m=>m.loadTaskAnnotations(${scriptValue(projectId)},${scriptValue(task.id)}))`);
    expect(taskAnnotations.annotations.find((annotation) => annotation.id === explicit.id)).toMatchObject({
      parentId: requestRoot.id,
      body: request,
      explicitRequest: true,
      status: "handled",
      target: { taskId: task.id },
    });
    const handling = taskAnnotations.handlings.find((item) => item.annotationId === explicit.id);
    expect(handling?.summary).toContain("retained PDF A page 2");
    expect(handling?.resultRefs[0]).toMatchObject({
      objectKind: "task_pdf",
      objectId: compiledText?.artifact.pdfSha256,
      objectRevision: `generation:${generation}`,
      path: compiledText?.artifact.path,
    });
    expect(projectAnnotations.annotations.map((annotation) => annotation.id).sort()).toEqual(
      [root.id, requestRoot.id, explicit.id].sort(),
    );
    const retainedOriginal = await page.evaluate<RetainedMaterial>(`window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m=>m.readMaterialAnnotation(${scriptValue(projectId)},${scriptValue(explicit.id)}))`);
    expect(createHash("sha256").update(Buffer.from(retainedOriginal.bytes)).digest("hex")).toBe(hashA);

    await openRailTab(page, "Research workspace");
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/research-tasks.ts').then(async m=>{await m.useResearchTasksStore.getState().bindProject(${scriptValue(projectId)});m.useResearchTasksStore.getState().receiveTask(${scriptValue(task)});m.useResearchTasksStore.getState().openTaskDetail(${scriptValue(task.id)},'annotations');})`);
    const detail = page.locator('[data-testid="research-task-detail"]');
    await expect(detail.getByText("Read retained PDF A page 2; it differs from the current B source. Amended the task copy and verified its new PDF.")).toBeVisible();
    const requestCard = detail
      .locator('[data-testid="task-annotation"]:has([data-testid="annotation-handling"])')
      .filter({ hasText: request });
    await requestCard.getByText("Recorded object", { exact: true }).click();
    const viewer = page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
    await expect(viewer).toContainText("main.tex · PDF");
    await expect.poll(() => page.evaluate<{ role: string; revision: string; anchorKind: string } | null>(
      `window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m => {
        const request = m.useMaterialViewerStore.getState().request;
        return request ? { role: request.role ?? '', revision: request.revision, anchorKind: request.anchor?.kind ?? '' } : null;
      })`,
    )).toEqual({ role: "task_input", revision: hashA, anchorKind: "pdf" });
    await waitLong(page, `!![...document.querySelectorAll('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"] [data-page="2"] .textLayer span')].find(node => node.textContent.includes('ORIGINAL-PDF-SELECTION-A'))`, 30_000);
    await expect.poll(async () => page.evaluate<boolean>(`(() => {
      const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
      const scroller = viewer?.querySelector('[data-pdf-scroll-root]');
      const page = scroller?.querySelector('[data-page="2"]');
      const text = [...page?.querySelectorAll('.textLayer span') ?? []].find(node => node.textContent.includes('ORIGINAL-PDF-SELECTION-A'));
      if (!viewer || !scroller || !page || !text) return false;
      const viewport = scroller.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return !viewer.closest('[role="dialog"], [role="alertdialog"]')
        && Math.abs(pageRect.top - viewport.top) <= 3
        && textRect.top >= viewport.top
        && textRect.bottom <= viewport.bottom;
    })()`), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("native-pdf-selection.png") });
    writeFileSync(testInfo.outputPath("checks.json"), JSON.stringify({
      projectId,
      taskId: task.id,
      rootAnnotationId: root.id,
      requestAnnotationId: requestRoot.id,
      explicitAnnotationId: explicit.id,
      root,
      feedbackSnapshot,
      materialContext,
      retainedFeedback: {
        snapshot: retainedFeedback.snapshot,
        byteLength: retainedFeedback.bytes.length,
      },
      compiled: compiledText?.artifact,
      hashA,
      hashB,
      feedbackModelCalls: baseline,
      reviewModelCalls: server.requestCount() - baseline,
      originalTextAndCurrentSourceDistinct: true,
      handlingLinked: true,
      originalRetainedPdfVisible: true,
      taskCopyModifiedAndCompiled: true,
      originalProjectSourceUnchanged: true,
      explicitMaterialAnnotationEntry: true,
      singleTaskRequestRecorded: true,
      generation: task.executionGeneration,
      scriptedProvider: true,
      realModelReasoningTested: false,
    }, null, 2));
  } finally { await server.close(); }
});

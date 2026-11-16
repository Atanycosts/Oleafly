import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { DocxDocumentRead, DocxWorkspaceContext } from "../../packages/ai-tools/src/tools";
import type { DocxActivityPage } from "../../src/lib/docx-task-activity";
import type { RetainedMaterial } from "../../src/lib/material-annotations";
import type { MaterialAnchor, MaterialReference } from "../../src/lib/material-surface";
import type { HtmlPreviewSnapshot } from "../../src/lib/notebook-commands";
import type { ResearchTask } from "../../src/lib/research-tasks";
import type { AnnotationContext } from "../../src/lib/task-collaboration";
import { expect, test } from "../fixtures";
import { clickCompile, createBlankProject, fillTextarea, openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";

type Page = TauriPage | BrowserPageAdapter;

const enabled = process.env.OLEAFLY_MATERIAL_WORKSPACE === "1";
const MATERIAL_SOURCE = "# Source evidence\n\nMATERIAL-SOURCE-EXACT-BYTES\r\nKeep the trailing CRLF.\r\n";
const CURRENT_PROJECT_SOURCE = "# Current project source\n\nCURRENT_PROJECT_DIFFERENT_FROM_RETAINED\r\n";
const MARKDOWN_RESULT = "# Material handling result\n\nMATERIAL-RESULT-FROM-TASK-COPY\n";
const OLD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#f4ead5"/><circle cx="180" cy="180" r="90" fill="#b4573f"/><text x="40" y="330" font-size="28">OLD-REVISION-ONLY</text></svg>';
const CURRENT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e1edf5"/><rect x="250" y="80" width="260" height="200" fill="#326f8d"/><text x="30" y="330" font-size="28">CURRENT-REVISION-ONLY</text></svg>';

type MaterialFixture = { reference: MaterialReference; content: string };
type MaterialFixtures = {
  markdown: MaterialFixture;
  oldImage: MaterialFixture;
  currentImage: MaterialFixture;
};
type DocxSessionState = DocxDocumentRead["document"];

function decodeToolResult(content: string): Record<string, unknown> {
  const envelope = JSON.parse(content) as {
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  if (Array.isArray(envelope.content)) {
    expect(envelope.isError).not.toBe(true);
    const text = envelope.content.find((entry) => entry.type === "text")?.text;
    return JSON.parse(text ?? "{}") as Record<string, unknown>;
  }
  return envelope as Record<string, unknown>;
}

function findResult(results: Record<string, unknown>[], predicate: (value: Record<string, unknown>) => boolean): Record<string, unknown> {
  const pending: unknown[] = [...results].reverse();
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const record = value as Record<string, unknown>;
    if (predicate(record)) return record;
    pending.push(...Object.values(record));
  }
  throw new Error(`Missing material task result: ${JSON.stringify(results)}`);
}

async function readDocx(page: Page): Promise<DocxDocumentRead> {
  return page.evaluate<DocxDocumentRead>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
  );
}

async function chooseDocxView(page: Page, label: string) {
  const opened = await page.evaluate<boolean>(`(() => {
    const trigger = document.querySelector('[data-testid="docx-workspace"] [aria-label="Display"]');
    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return false;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!opened) throw new Error("The DOCX display selector is unavailable.");
  await expect.poll(() => page.evaluate<boolean>(
    `Array.from(document.querySelectorAll('[role="option"]')).some(option => option.textContent?.trim() === ${scriptValue(label)})`,
  )).toBe(true);
  const chosen = await page.evaluate<boolean>(`(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(
      item => item.textContent?.trim() === ${scriptValue(label)}
    );
    if (!(option instanceof HTMLElement)) return false;
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  if (!chosen) throw new Error(`The DOCX view option is unavailable: ${label}`);
}

async function probeHtmlFrame(page: Page) {
  await expect.poll(async () => page.evaluate<number>(`(() => {
    const frame = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]');
    frame?.contentWindow?.postMessage({ type: 'oleafly-e2e-probe' }, '*');
    return window.__materialHtmlMessages?.length ?? 0;
  })()`), { timeout: 30_000, intervals: [250, 500] }).toBeGreaterThan(0);
}

function syntheticDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>WORD-WORKING-SESSION</w:t></w:r></w:p><w:p><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>Second paragraph remains in the same working copy.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>',
    ),
    "word/styles.xml": strToU8(
      '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
    ),
  });
}

async function clickText(page: Page, root: string, label: string) {
  const clicked = await page.evaluate<boolean>(`(() => {
    const surface = Array.from(document.querySelectorAll(${scriptValue(root)})).find(item => !item.closest('[hidden], [inert]'));
    const button = Array.from(surface?.querySelectorAll("button") ?? []).find((item) =>
      item.textContent?.trim() === ${scriptValue(label)}
      || item.getAttribute("aria-label") === ${scriptValue(label)}
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled || !button.getClientRects().length) {
      return false;
    }
    button.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0, buttons: 1, view: window
    }));
    button.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, cancelable: true, button: 0, buttons: 0, view: window
    }));
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Unavailable material-workspace action: ${label}`);
}

async function changedFileActionState(
  page: Page,
  path: string,
  label: string,
): Promise<"missing-detail" | "missing-row" | "missing-action" | "disabled" | "ready"> {
  return page.evaluate(`(() => {
    const detail = document.querySelector('[data-testid="research-task-detail"]');
    if (!(detail instanceof HTMLElement)) return 'missing-detail';
    const pathLabel = Array.from(detail.querySelectorAll('span')).find(
      item => item.textContent?.trim() === ${scriptValue(path)}
    );
    const row = pathLabel?.closest('div.p-3');
    if (!(row instanceof HTMLElement)) return 'missing-row';
    const action = Array.from(row.querySelectorAll('button')).find(item =>
      item.textContent?.trim() === ${scriptValue(label)}
      || item.getAttribute('aria-label') === ${scriptValue(label)}
    );
    if (!(action instanceof HTMLButtonElement) || !action.getClientRects().length) return 'missing-action';
    return action.disabled ? 'disabled' : 'ready';
  })()`);
}

async function clickChangedFileAction(page: Page, path: string, label: string) {
  const clicked = await page.evaluate<boolean>(`(() => {
    const detail = document.querySelector('[data-testid="research-task-detail"]');
    if (!(detail instanceof HTMLElement)) return false;
    const pathLabel = Array.from(detail.querySelectorAll('span')).find(
      item => item.textContent?.trim() === ${scriptValue(path)}
    );
    const row = pathLabel?.closest('div.p-3');
    if (!(row instanceof HTMLElement)) return false;
    const action = Array.from(row.querySelectorAll('button')).find(item =>
      item.textContent?.trim() === ${scriptValue(label)}
      || item.getAttribute('aria-label') === ${scriptValue(label)}
    );
    if (!(action instanceof HTMLButtonElement) || action.disabled) return false;
    action.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Unavailable task changed-file action: ${label} for ${path}`);
}

async function objectAnnotations(page: Page, reference: MaterialReference): Promise<AnnotationContext> {
  const context = await page.evaluate<AnnotationContext>(
    `window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadObjectAnnotations({
      projectId: ${scriptValue(reference.projectId)},
      taskId: null,
      objectKind: 'material',
      objectId: ${scriptValue(reference.documentId)},
      objectRevision: ${scriptValue(reference.revision)},
      path: null
    }))`,
  );
  return { ...context, annotations: context.annotations.filter(item => item.target.objectRevision === reference.revision) };
}

async function fillFeedback(page: Page, body: string) {
  await expect(page.locator('[data-testid="material-annotations"] textarea')).toBeVisible();
  await fillTextarea(page, '[data-testid="material-annotations"] textarea', body);
}

async function openAnnotations(
  page: Page,
  reference: MaterialReference,
  content: string,
  mediaType: string,
  anchor?: MaterialAnchor,
) {
  await page.evaluate(
    `Promise.all([
      window.__oleaflyE2EImport('/src/lib/material-surface.ts'),
      window.__oleaflyE2EImport('/src/store/material-annotations.ts')
    ]).then(async ([surface, annotations]) => {
      const document = await surface.createMaterialDocument(${scriptValue(reference)}, ${
        mediaType.startsWith("image/")
          ? `{ bytes: new TextEncoder().encode(${scriptValue(content)}), mediaType: ${scriptValue(mediaType)} }`
          : `{ text: ${scriptValue(content)}, mediaType: ${scriptValue(mediaType)} }`
      });
      annotations.openMaterialAnnotations(document${anchor ? `, ${scriptValue(anchor)}` : ""});
    })`,
  );
}

async function openViewer(
  page: Page,
  reference: MaterialReference,
  content: string,
  options: {
    mediaType: string;
    bytes?: number[];
    anchor?: MaterialAnchor;
    previous?: MaterialFixture;
  },
) {
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m => m.useMaterialViewerStore.getState().open({
      ...${scriptValue(reference)},
      load: async () => ${
        options.bytes
          ? `new Uint8Array(${scriptValue(options.bytes)})`
          : scriptValue(content)
      },
      mediaType: ${scriptValue(options.mediaType)},
      anchor: ${scriptValue(options.anchor ?? null)} ?? undefined,
      previous: ${
        options.previous
          ? `{
              title: ${scriptValue(options.previous.reference.title)},
              revision: ${scriptValue(options.previous.reference.revision)},
              load: async () => ${scriptValue(options.previous.content)},
              mediaType: ${scriptValue(options.mediaType)},
              anchor: ${scriptValue({ kind: "region", rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 } })}
            }`
          : "undefined"
      }
    }))`,
  );
}

// This scripted provider proves native task creation, task-copy tools, retained
// handling and result delivery. It does not prove real-model quality.
test("materials render in the center with versioned feedback and a scripted native Agent result", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_MATERIAL_WORKSPACE=1 in an isolated native runner.");
  test.setTimeout(240_000);
  const server = await startMockAiServer();
  let taskId: string | null = null;
  let taskSettled = false;
  try {
    await createBlankProject(page, `Material workspace ${Date.now()}`);
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setUiLocalePreference('en'))`);
    await page.evaluate(`window.__researchTasksSet?.(false)`);
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    const projectId = await page.evaluate<string>(
      `document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`,
    );
    expect(projectId).not.toBe("");
    await page.evaluate(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.writeFileContent(${scriptValue(projectId)}, 'material-source.md', ${scriptValue(MATERIAL_SOURCE)}))`,
    );

    const fixtures = await page.evaluate<MaterialFixtures>(`window.__oleaflyE2EImport('/src/lib/material-surface.ts').then(async m => {
      const reference = (document) => {
        const { source, ...value } = document;
        return value;
      };
      const markdown = await m.createMaterialDocument({
        projectId: ${scriptValue(projectId)},
        documentId: 'synthetic:material-notes',
        path: 'material-source.md',
        title: 'Synthetic material notes',
        kind: 'markdown'
      }, { text: ${scriptValue(MATERIAL_SOURCE)}, mediaType: 'text/markdown' });
      const oldImage = await m.createMaterialDocument({
        projectId: ${scriptValue(projectId)},
        documentId: 'synthetic:figure',
        path: 'figure.svg',
        title: 'Synthetic figure',
        kind: 'image'
      }, { bytes: new TextEncoder().encode(${scriptValue(OLD_SVG)}), mediaType: 'image/svg+xml' });
      const currentImage = await m.createMaterialDocument({
        projectId: ${scriptValue(projectId)},
        documentId: 'synthetic:figure',
        path: 'figure.svg',
        title: 'Synthetic figure',
        kind: 'image'
      }, { bytes: new TextEncoder().encode(${scriptValue(CURRENT_SVG)}), mediaType: 'image/svg+xml' });
      return {
        markdown: { reference: reference(markdown), content: ${scriptValue(MATERIAL_SOURCE)} },
        oldImage: { reference: reference(oldImage), content: ${scriptValue(OLD_SVG)} },
        currentImage: { reference: reference(currentImage), content: ${scriptValue(CURRENT_SVG)} }
      };
    })`);
    expect(fixtures.oldImage.reference.revision).not.toBe(fixtures.currentImage.reference.revision);

    await openViewer(page, fixtures.markdown.reference, fixtures.markdown.content, { mediaType: "text/markdown" });
    const center = page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
    await expect(center).toBeVisible();
    await expect(center).toContainText("Synthetic material notes");
    await expect(center).toContainText("Source evidence");
    expect(await page.evaluate<boolean>(`(() => {
      const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
      return !!viewer?.closest('[data-testid="workspace-center"]')
        && !viewer.closest('[role="dialog"], [role="alertdialog"]');
    })()`)).toBe(true);

    await openAnnotations(
      page,
      fixtures.markdown.reference,
      fixtures.markdown.content,
      "text/markdown",
      { kind: "whole" },
    );
    const feedback = page.getByTestId("material-annotations");
    await expect(feedback).toBeVisible();
    const ordinaryBody = "ORDINARY-MATERIAL-FEEDBACK";
    await fillFeedback(page, ordinaryBody);
    const requestsBeforeFeedback = server.requestCount();
    await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
    let markdownContext: AnnotationContext | undefined;
    await expect.poll(async () => {
      markdownContext = await objectAnnotations(page, fixtures.markdown.reference);
      return markdownContext.annotations.some((annotation) => annotation.body === ordinaryBody);
    }).toBe(true);
    const ordinary = markdownContext!.annotations.find((annotation) => annotation.body === ordinaryBody)!;
    expect(ordinary.explicitRequest).toBe(false);
    expect(ordinary.target).toMatchObject({
      projectId,
      objectKind: "material",
      objectId: fixtures.markdown.reference.documentId,
      objectRevision: fixtures.markdown.reference.revision,
    });
    expect(server.requestCount()).toBe(requestsBeforeFeedback);
    expect(await page.evaluate<boolean>(
      `window.__oleaflyE2EImport('/src/store/research-tasks-flag.ts').then(m => m.researchTasksEnabled())`,
    )).toBe(false);
    expect(await page.evaluate<ResearchTask[]>(
      `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.listResearchTasks(${scriptValue(projectId)}))`,
    )).toHaveLength(0);
    const retainedOrdinary = await page.evaluate<RetainedMaterial>(
      `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(${scriptValue(projectId)}, ${scriptValue(ordinary.id)}))`,
    );
    expect(new TextDecoder().decode(new Uint8Array(retainedOrdinary.bytes))).toBe(MATERIAL_SOURCE);
    await webviewScreenshot(page, testInfo.outputPath("central-markdown-feedback.png"));
    await fillFeedback(page, "UNSENT-MATERIAL-FEEDBACK-DRAFT");
    const materialWidth = await page.evaluate<number>(`document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]').getBoundingClientRect().width`);
    await clickText(page, '[data-testid="material-annotations"]', "Minimize feedback");
    await expect(page.getByTestId("material-annotations")).toBeHidden();
    expect(await page.evaluate<number>(`document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]').getBoundingClientRect().width`)).toBe(materialWidth);
    await clickText(page, '[data-testid="workspace-material-feedback-rail"]', "Open material feedback");
    expect(await page.evaluate<string>(`document.querySelector('[data-testid="material-annotations"] textarea').value`)).toBe("UNSENT-MATERIAL-FEEDBACK-DRAFT");
    await clickText(page, '[data-testid="material-annotations"]', "Minimize feedback");

    await openViewer(page, fixtures.currentImage.reference, fixtures.currentImage.content, {
      mediaType: "image/svg+xml",
      previous: fixtures.oldImage,
    });
    await clickText(page, '[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]', "Stack versions");
    await clickText(page, '[data-testid="material-version-stack"]', "Earlier version");
    await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) section[aria-label="Earlier version"] img')).toBeVisible();
    await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) section[aria-label="Current result"] img')).toBeVisible();
    await clickText(page, 'section[aria-label="Earlier version"]', "Select image area");
    await expect.poll(() => page.evaluate<boolean>(`(() => {
      const layer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="material-version-stack"] [data-version="previous"]');
      return layer instanceof HTMLElement && !layer.getAnimations().some(animation => animation.playState === 'running');
    })()`)).toBe(true);
    const selected = await page.evaluate<boolean>(`(() => {
      const section = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) section[aria-label="Earlier version"]');
      const image = section?.querySelector('img');
      const wrapper = image?.parentElement;
      if (!(wrapper instanceof HTMLElement)) return false;
      wrapper.setPointerCapture = () => {};
      const box = image.getBoundingClientRect();
      const point = (x, y) => ({ clientX: box.left + box.width * x, clientY: box.top + box.height * y });
      const fire = (type, x, y) => wrapper.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 19, pointerType: 'mouse', ...point(x, y)
      }));
      fire('pointerdown', 0.1, 0.1);
      fire('pointermove', 0.5, 0.6);
      fire('pointerup', 0.5, 0.6);
      return true;
    })()`);
    expect(selected).toBe(true);
    await clickText(page, 'section[aria-label="Earlier version"]', "Annotate selection");
    const oldBody = "OLD-REVISION-REGION";
    await fillFeedback(page, oldBody);
    await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
    await expect.poll(async () => {
      const context = await objectAnnotations(page, fixtures.oldImage.reference);
      return context.annotations.find((annotation) => annotation.body === oldBody)?.id ?? "";
    }).not.toBe("");

    await clickText(page, '[data-testid="material-version-stack"]', "Current result");
    await clickText(page, 'section[aria-label="Current result"]', "Annotate whole material");
    const currentBody = "CURRENT-REVISION-WHOLE";
    await fillFeedback(page, currentBody);
    await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
    await expect.poll(async () => {
      const context = await objectAnnotations(page, fixtures.currentImage.reference);
      return context.annotations.find((annotation) => annotation.body === currentBody)?.id ?? "";
    }).not.toBe("");

    const oldContext = await objectAnnotations(page, fixtures.oldImage.reference);
    const currentContext = await objectAnnotations(page, fixtures.currentImage.reference);
    expect(oldContext.annotations.map((annotation) => annotation.body)).toEqual([oldBody]);
    expect(currentContext.annotations.map((annotation) => annotation.body)).toEqual([currentBody]);
    const oldMaterial = await page.evaluate<RetainedMaterial>(
      `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(
        ${scriptValue(projectId)},
        ${scriptValue(oldContext.annotations[0].id)}
      ))`,
    );
    const currentMaterial = await page.evaluate<RetainedMaterial>(
      `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(
        ${scriptValue(projectId)},
        ${scriptValue(currentContext.annotations[0].id)}
      ))`,
    );
    expect(oldMaterial.snapshot.document.revision).toBe(fixtures.oldImage.reference.revision);
    expect(currentMaterial.snapshot.document.revision).toBe(fixtures.currentImage.reference.revision);
    expect(oldMaterial.snapshot.anchor).toEqual({ kind: "region", rect: {
      x: expect.closeTo(0.1, 8), y: expect.closeTo(0.1, 8), width: expect.closeTo(0.4, 8), height: expect.closeTo(0.5, 8),
    } });
    expect(currentMaterial.snapshot.anchor).toEqual({ kind: "whole" });
    expect(new TextDecoder().decode(new Uint8Array(oldMaterial.bytes))).toBe(OLD_SVG);
    expect(new TextDecoder().decode(new Uint8Array(currentMaterial.bytes))).toBe(CURRENT_SVG);

    expect(await page.evaluate<boolean>(`(() => {
      const card = Array.from(document.querySelectorAll('[data-testid="material-annotations"] [data-testid="task-annotation"]'))
        .find(item => item.textContent?.includes(${scriptValue(currentBody)}));
      const button = Array.from(card?.querySelectorAll('button') ?? []).find(item => item.textContent?.trim() === 'Recorded object');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click(); return true;
    })()`)).toBe(true);
    await expect.poll(() => page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m => m.useMaterialViewerStore.getState().request?.revision ?? '')`,
    )).toBe(fixtures.currentImage.reference.revision);
    await expect.poll(() => page.evaluate(`window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m => m.useMaterialViewerStore.getState().request?.anchor)`))
      .toEqual({ kind: "whole" });
    await webviewScreenshot(page, testInfo.outputPath("central-image-revisions.png"));

    await page.evaluate(`window.__oleaflyE2EImport('/src/store/workspace-surface.ts').then(m => m.useWorkspaceSurfaceStore.getState().showFiles())`);
    await clickCompile(page);
    let pdfBytes: number[] = [];
    await expect.poll(async () => {
      pdfBytes = await page.evaluate<number[]>(
        `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readCompiledPdf(${scriptValue(projectId)}).then(bytes => Array.from(new Uint8Array(bytes))).catch(() => []))`,
      );
      return pdfBytes.length;
    }, { timeout: 120_000 }).toBeGreaterThan(0);
    expect(pdfBytes.slice(0, 5)).toEqual([37, 80, 68, 70, 45]);
    const pdfReference = await page.evaluate<MaterialReference>(`window.__oleaflyE2EImport('/src/lib/material-surface.ts').then(async m => {
      const document = await m.createMaterialDocument({
        projectId: ${scriptValue(projectId)},
        documentId: 'compiled:pdf',
        path: null,
        title: 'Compiled PDF',
        kind: 'pdf'
      }, { bytes: new Uint8Array(${scriptValue(pdfBytes)}), mediaType: 'application/pdf' });
      const { source, ...reference } = document;
      return reference;
    })`);
    await openViewer(page, pdfReference, "", {
      mediaType: "application/pdf",
      bytes: pdfBytes,
      anchor: { kind: "page", page: 1, rects: [] },
    });
    await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]')).toContainText("Compiled PDF");
    await expect.poll(() => page.evaluate<boolean>(
      `!!document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"] canvas[width][height]')`,
    ), { timeout: 60_000 }).toBe(true);
    expect(await page.evaluate<boolean>(`(() => {
      const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
      return !!viewer?.closest('[data-testid="workspace-center"]')
        && !viewer.closest('[role="dialog"], [role="alertdialog"]');
    })()`)).toBe(true);

    const originalBeforeTask = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'material-source.md'))`,
    );
    expect(originalBeforeTask).toBe(MATERIAL_SOURCE);
    await openAnnotations(
      page,
      fixtures.markdown.reference,
      fixtures.markdown.content,
      "text/markdown",
      { kind: "whole" },
    );
    const requestBody = "Read material-source.md, write material-result.md with the requested markdown result, and link the produced file to this request.";
    let frozenSourcePath = "";
    let resultPath = "";
    server.setResponder((request) => {
      const messages = request.messages as { role: string; content: unknown }[];
      const prompt = messages
        .map((message) => typeof message.content === "string" ? message.content : "")
        .join("\n");
      const annotationId = /this task's current request: ([^ .]+)\./.exec(prompt)?.[1]
        ?? /Current material request: ([^ .]+)\./.exec(prompt)?.[1];
      frozenSourcePath = /Exact source bytes are at (\S+) and/.exec(prompt)?.[1] ?? frozenSourcePath;
      if (frozenSourcePath) resultPath = frozenSourcePath.replace(/material-source\.md$/u, "material-result.md");
      const results = messages
        .filter((message) => message.role === "tool" && typeof message.content === "string")
        .map((message) => decodeToolResult(message.content as string));
      if (results.length === 0) return { name: "discover_tools", args: { query: "annotation_handle" } };
      if (results.length === 1) {
        if (!frozenSourcePath) throw new Error("The material task prompt did not identify its frozen source.");
        return { name: "read_file", args: { path: frozenSourcePath } };
      }
      if (results.length === 2) return { name: "write_file", args: { path: resultPath, content: MARKDOWN_RESULT } };
      if (results.length === 3) {
        if (!annotationId) throw new Error("The material task prompt did not identify its current annotation.");
        return {
          name: "annotation_handle",
          args: {
            annotationId,
            summary: "Read the retained material source and wrote material-result.md in the task copy.",
            resultRefs: [{ objectKind: "file", objectId: resultPath, path: resultPath }],
          },
        };
      }
      return "The synthetic source was read, material-result.md was produced in the isolated task copy, and handling was linked.";
    });
    await fillFeedback(page, requestBody);
    await page.click('[data-testid="material-annotations"] button[role="checkbox"]');
    await clickText(page, '[data-testid="material-annotations"]', "Save annotation");

    let task: ResearchTask | undefined;
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask | undefined>(
        `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m =>
          (await m.listResearchTasks(${scriptValue(projectId)})).find(task => task.prompt.startsWith(${scriptValue(requestBody)}))
        )`,
      );
      taskId = task?.id ?? null;
      return taskId ?? "";
    }, { timeout: 60_000, intervals: [250] }).not.toBe("");
    if (!task) throw new Error("The material request did not create a research task.");
    await page.evaluate(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.writeFileContent(${scriptValue(projectId)}, 'material-source.md', ${scriptValue(CURRENT_PROJECT_SOURCE)}))`,
    );
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask | undefined>(
        `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m =>
          (await m.listResearchTasks(${scriptValue(projectId)})).find(task => task.id === ${scriptValue(taskId)})
        )`,
      );
      return task?.status;
    }, { timeout: 120_000, intervals: [500] }).toBe("awaiting_review");
    taskSettled = true;
    if (!task) throw new Error("The material request lost its research task.");
    expect(frozenSourcePath).toMatch(/^research\/[^/]+\/material-source\.md$/u);
    expect(task.isolation).not.toBeNull();
    expect(task.result?.changedFiles.some((file) => file.path === resultPath)).toBe(true);
    expect(task.result?.changedFiles.some((file) => file.path === "material-source.md")).not.toBe(true);
    expect(server.requestCount()).toBeGreaterThan(requestsBeforeFeedback);
    expect(await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'material-source.md'))`,
    )).toBe(CURRENT_PROJECT_SOURCE);
    expect(await page.evaluate<boolean>(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileContent(${scriptValue(projectId)}, 'material-result.md').then(() => true).catch(() => false))`,
    )).toBe(false);

    const requestBodies = server.requestBodies().map((body) => JSON.parse(body) as { messages: { role: string; content: unknown }[] });
    const toolResults = requestBodies
      .flatMap((body) => body.messages)
      .filter((message) => message.role === "tool" && typeof message.content === "string")
      .map((message) => decodeToolResult(message.content as string));
    expect(toolResults.some((result) => JSON.stringify(result).includes("MATERIAL-SOURCE-EXACT-BYTES"))).toBe(true);
    expect(toolResults.some((result) => JSON.stringify(result).includes("CURRENT_PROJECT_DIFFERENT_FROM_RETAINED"))).toBe(false);
    expect(requestBodies.some((body) => JSON.stringify(body).includes("MATERIAL-RESULT-FROM-TASK-COPY"))).toBe(true);

    const requestedContext = await objectAnnotations(page, fixtures.markdown.reference);
    const requested = requestedContext.annotations.find(
      (annotation) => annotation.explicitRequest && annotation.body === requestBody,
    );
    expect(requested?.explicitRequest).toBe(true);
    const taskContext = await page.evaluate<AnnotationContext>(
      `window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskAnnotations(${scriptValue(projectId)}, ${scriptValue(task.id)}))`,
    );
    const handling = taskContext.handlings.find((entry) => entry.annotationId === requested?.id);
    expect(handling?.summary).toContain("material-result.md");
    expect(handling?.resultRefs).toContainEqual(expect.objectContaining({
      objectKind: "file",
      objectId: resultPath,
      path: resultPath,
    }));
    expect(taskContext.annotations.find((annotation) => annotation.id === requested?.id)?.status).toBe("handled");

    await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setAssistantOpen(true))`);
    await expect(page.getByTestId("research-assistant")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="research-assistant"] [data-chat-composer] textarea')).toBeVisible();
    await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]')).toBeVisible();

    await clickText(page, '[data-testid="material-annotations"]', `View handling task · Handle material feedback · Synthetic material notes`);
    const detail = page.getByTestId("research-task-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("annotation-handling")).toContainText("material-result.md");
    await expect(detail).toContainText(requestBody);
    await webviewScreenshot(page, testInfo.outputPath("material-task-handling-and-agent.png"));
    await clickText(page, '[data-testid="research-task-detail"]', "Review");
    const previewStarted = await page.evaluate<boolean>(`(() => {
      const detail = document.querySelector('[data-testid="research-task-detail"]');
      const path = Array.from(detail?.querySelectorAll('span') ?? []).find((element) =>
        element.textContent?.trim() === ${scriptValue(resultPath)}
      );
      const row = path?.closest('div');
      const button = Array.from(row?.querySelectorAll('button') ?? []).find((item) =>
        item.textContent?.trim() === 'Preview'
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`);
    expect(previewStarted).toBe(true);
    await expect(detail.locator('.cm-content')).toContainText("MATERIAL-RESULT-FROM-TASK-COPY");
    await webviewScreenshot(page, testInfo.outputPath("material-task-result-and-agent.png"));
    await clickText(page, '[data-testid="research-task-detail"]', "Open in workspace");
    await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]')).toContainText("MATERIAL-RESULT-FROM-TASK-COPY");
    await expect(page.getByTestId("research-assistant")).toBeVisible();
    await webviewScreenshot(page, testInfo.outputPath("material-task-result-in-center.png"));
  } finally {
    try {
      if (taskId && !taskSettled) {
        await page.evaluate(
          `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.cancelResearchTask(${scriptValue(taskId)}))`,
        );
      }
    } finally {
      await server.close();
    }
  }
});

test("HTML material snapshots preserve interactive frozen resources in the center", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_MATERIAL_WORKSPACE=1 in an isolated native runner.");
  test.setTimeout(240_000);
  const originalHtml = `<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body><h1 id="result">Here's ORIGINAL-HTML</h1><button id="probe">ORIGINAL-BUTTON</button><script   SRC = "assets/script.js"></script></body></html>`;
  const originalCss = "body { background-color: rgb(12, 34, 56); color: white; }";
  const originalScript = `document.getElementById("probe").addEventListener("click", () => {
    const button = document.getElementById("probe");
    button.textContent = "INTERACTED";
    parent.postMessage({
      type: "oleafly-html-selection",
      selector: "#result",
      quote: document.getElementById("result").textContent + "|ORIGINAL-JS|" + getComputedStyle(document.body).backgroundColor + "|" + button.textContent
    }, "*");
  });
  addEventListener("message", (event) => {
    if (event.source === parent && event.data?.type === "oleafly-e2e-probe") {
      document.getElementById("probe").click();
    }
  });`;

  await createBlankProject(page, `HTML material ${Date.now()}`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setUiLocalePreference('en'))`);
  const projectId = await page.evaluate<string>(
    `document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`,
  );
  expect(projectId).not.toBe("");
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => Promise.all([
      m.writeFileContent(${scriptValue(projectId)}, 'report.html', ${scriptValue(originalHtml)}),
      m.writeFileContent(${scriptValue(projectId)}, 'assets/style.css', ${scriptValue(originalCss)}),
      m.writeFileContent(${scriptValue(projectId)}, 'assets/script.js', ${scriptValue(originalScript)})
    ]))`,
  );

  const snapshot = await page.evaluate<HtmlPreviewSnapshot>(
    `window.__oleaflyE2EImport('/src/lib/notebook-commands.ts').then(m => m.readHtmlPreview(${scriptValue(projectId)}, 'report.html'))`,
  );
  const bundle = JSON.parse(snapshot.bundle) as {
    version: number;
    entry: string;
    files: Record<string, string>;
  };
  expect(snapshot.path).toBe("report.html");
  expect(bundle.version).toBe(1);
  expect(bundle.entry).toBe("report.html");
  expect(Object.keys(bundle.files).sort()).toEqual([
    "assets/script.js",
    "assets/style.css",
    "report.html",
  ]);
  expect(Buffer.from(bundle.files["assets/style.css"], "base64").toString()).toBe(originalCss);
  expect(Buffer.from(bundle.files["assets/script.js"], "base64").toString()).toBe(originalScript);

  const reference = await page.evaluate<MaterialReference>(`window.__oleaflyE2EImport('/src/lib/material-surface.ts').then(async m => {
    const document = await m.createMaterialDocument({
      projectId: ${scriptValue(projectId)},
      documentId: 'file:report.html',
      path: 'report.html',
      title: 'report.html',
      kind: 'html'
    }, { text: ${scriptValue(snapshot.bundle)}, mediaType: 'application/vnd.oleafly.html-bundle+json' });
    const { source, ...reference } = document;
    return reference;
  })`);
  expect(reference.revision).toBe(snapshot.revision);
  await openViewer(page, reference, snapshot.bundle, {
    mediaType: "application/vnd.oleafly.html-bundle+json",
  });
  await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]')).toContainText("report.html");
  await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="material-html-view"]')).toBeVisible();
  await expect.poll(() => page.evaluate<boolean>(
    `!!document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]')`,
  )).toBe(true);
  expect(await page.evaluate<string>(`document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]')?.getAttribute("sandbox") ?? ''`))
    .toBe("allow-scripts");
  expect(await page.evaluate<boolean>(`(() => {
    const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
    return !!viewer?.closest('[data-testid="workspace-center"]')
      && !viewer.closest('[role="dialog"], [role="alertdialog"]');
  })()`)).toBe(true);
  await page.evaluate(`(() => {
    window.__materialHtmlMessages = [];
    window.addEventListener('message', event => {
      if (event.data?.type === 'oleafly-html-selection') window.__materialHtmlMessages.push(event.data);
    });
  })()`);
  await probeHtmlFrame(page);
  expect(await page.evaluate<string>(
    `window.__materialHtmlMessages.at(-1)?.quote ?? ''`,
  )).toBe("Here's ORIGINAL-HTML|ORIGINAL-JS|rgb(12, 34, 56)|INTERACTED");
  expect(await page.evaluate<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="material-html-view"] button')).find(
      item => item.textContent?.trim() === 'Annotate selection'
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`)).toBe(true);
  await clickText(page, '[data-testid="material-html-view"]', "Annotate selection");
  const annotationBody = "HTML-FROZEN-BUNDLE-FEEDBACK";
  await fillFeedback(page, annotationBody);
  await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
  let htmlContext: AnnotationContext | undefined;
  await expect.poll(async () => {
    htmlContext = await objectAnnotations(page, reference);
    return htmlContext.annotations.find((annotation) => annotation.body === annotationBody)?.id ?? "";
  }).not.toBe("");
  const sameVersion = htmlContext!.annotations.filter(
    (annotation) => annotation.target.objectRevision === reference.revision,
  );
  expect(sameVersion).toHaveLength(1);
  const retained = await page.evaluate<RetainedMaterial>(
    `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(
      ${scriptValue(projectId)},
      ${scriptValue(sameVersion[0].id)}
    ))`,
  );
  expect(retained.snapshot.document).toMatchObject({
    documentId: reference.documentId,
    path: "report.html",
    kind: "html",
    revision: snapshot.revision,
  });
  expect(retained.snapshot.anchor).toEqual({ kind: "html", selector: "#result", quote: "Here's ORIGINAL-HTML|ORIGINAL-JS|rgb(12, 34, 56)|INTERACTED" });
  expect(new TextDecoder().decode(new Uint8Array(retained.bytes))).toBe(snapshot.bundle);
  await webviewScreenshot(page, testInfo.outputPath("html-material-original.png"));

  const changedHtml = '<!doctype html><html><body><h1 id="result">CHANGED-HTML</h1><button id="probe">CHANGED-BUTTON</button></body></html>';
  const changedCss = "body { background-color: rgb(220, 30, 40); }";
  const changedScript = `document.body.dataset.changed = "true";`;
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => Promise.all([
      m.writeFileContent(${scriptValue(projectId)}, 'report.html', ${scriptValue(changedHtml)}),
      m.writeFileContent(${scriptValue(projectId)}, 'assets/style.css', ${scriptValue(changedCss)}),
      m.writeFileContent(${scriptValue(projectId)}, 'assets/script.js', ${scriptValue(changedScript)})
    ]))`,
  );
  const originalPreviewUrl = await page.evaluate<string>(
    `document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]')?.getAttribute('src') ?? ''`,
  );
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/material-viewer.ts').then(m =>
    m.useMaterialViewerStore.getState().open({
      ...${scriptValue(retained.snapshot.document)},
      load: async () => new Uint8Array(${scriptValue(retained.bytes)}),
      anchor: ${scriptValue(retained.snapshot.anchor)},
      mediaType: ${scriptValue(retained.snapshot.mediaType)}
    })
  )`);
  await expect(page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="material-html-view"]')).toBeVisible();
  await expect.poll(() => page.evaluate<string>(
    `document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]')?.getAttribute('src') ?? ''`,
  )).not.toBe(originalPreviewUrl);
  await page.evaluate(`(() => {
    window.__materialHtmlMessages = [];
  })()`);
  await probeHtmlFrame(page);
  expect(await page.evaluate<string>(
    `window.__materialHtmlMessages.at(-1)?.quote ?? ''`,
  )).toBe("Here's ORIGINAL-HTML|ORIGINAL-JS|rgb(12, 34, 56)|INTERACTED");
  await clickText(page, '[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]', "Back to report.html");
  await expect.poll(() => page.evaluate<string>(
    `document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) iframe[title="report.html"]')?.getAttribute('src') ?? ''`,
  )).toBe(originalPreviewUrl);
  await webviewScreenshot(page, testInfo.outputPath("html-material-restored-after-source-change.png"));
});

test("source ranges and diagram objects retain their own material identity", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_MATERIAL_WORKSPACE=1 in an isolated native runner.");
  test.setTimeout(120_000);
  await createBlankProject(page, `Source and diagram ${Date.now()}`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setUiLocalePreference('en'))`);
  const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`);
  const source = "const evidence = 42;\nconsole.log(evidence);\n";
  const range: MaterialAnchor = { kind: "text", from: 6, to: 14, quote: "evidence" };
  const diagram = 'flowchart LR\n  A[Source evidence] --> B[Working result]\n';
  const references = await page.evaluate<{ source: MaterialReference; diagram: MaterialReference }>(
    `window.__oleaflyE2EImport('/src/lib/material-surface.ts').then(async m => {
      const reference = document => { const {source, ...value} = document; return value; };
      return {
        source: reference(await m.createMaterialDocument({ projectId: ${scriptValue(projectId)}, documentId: 'file:example.js', path: 'example.js', title: 'example.js', kind: 'source' }, { text: ${scriptValue(source)}, mediaType: 'text/javascript' })),
        diagram: reference(await m.createMaterialDocument({ projectId: ${scriptValue(projectId)}, documentId: 'file:pipeline.mmd', path: 'pipeline.mmd', title: 'pipeline.mmd', kind: 'diagram' }, { text: ${scriptValue(diagram)}, mediaType: 'text/plain' }))
      };
    })`,
  );
  await openViewer(page, references.source, source, { mediaType: "text/javascript", anchor: range });
  await expect(page.getByTestId("retained-source-view")).toContainText("const evidence = 42;");
  expect(await page.evaluate(`document.querySelector('[data-testid="retained-source-view"] .cm-content')?.getAttribute('contenteditable')`)).toBe("false");
  await clickText(page, '[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]', "Annotate selection");
  await fillFeedback(page, "SOURCE-RANGE-FEEDBACK");
  await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
  await expect.poll(async () => (await objectAnnotations(page, references.source)).annotations.length).toBe(1);
  const sourceAnnotation = (await objectAnnotations(page, references.source)).annotations[0];
  const retained = await page.evaluate<RetainedMaterial>(
    `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(${scriptValue(projectId)}, ${scriptValue(sourceAnnotation.id)}))`,
  );
  expect(retained.snapshot.anchor).toEqual(range);
  expect(new TextDecoder().decode(new Uint8Array(retained.bytes))).toBe(source);
  await webviewScreenshot(page, testInfo.outputPath("source-range-feedback.png"));

  await openViewer(page, references.diagram, diagram, { mediaType: "text/plain" });
  await expect.poll(() => page.evaluate<number>(`document.querySelectorAll('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"] .react-flow__node[data-id]').length`)).toBeGreaterThan(0);
  const nodeId = await page.evaluate<string>(`(() => {
    const node = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"] .react-flow__node[data-id]');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return node.dataset.id;
  })()`);
  await clickText(page, '[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]', "Annotate selected object");
  await fillFeedback(page, "DIAGRAM-OBJECT-FEEDBACK");
  await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
  await expect.poll(async () => (await objectAnnotations(page, references.diagram)).annotations.length).toBe(1);
  const diagramAnnotation = (await objectAnnotations(page, references.diagram)).annotations[0];
  const diagramRetained = await page.evaluate<RetainedMaterial>(
    `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(${scriptValue(projectId)}, ${scriptValue(diagramAnnotation.id)}))`,
  );
  expect(diagramRetained.snapshot.anchor).toEqual({ kind: "object", id: nodeId });
  expect(new TextDecoder().decode(new Uint8Array(diagramRetained.bytes))).toBe(diagram);
  await webviewScreenshot(page, testInfo.outputPath("diagram-object-feedback.png"));
});

test("DOCX Main keeps one session across Original, Compare, formatting and material feedback", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_MATERIAL_WORKSPACE=1 in an isolated native runner.");
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires the isolated Workbench Python environment.");
  test.setTimeout(240_000);
  await createBlankProject(page, `DOCX material ${Date.now()}`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setUiLocalePreference('en'))`);
  const projectId = await page.evaluate<string>(
    `document.querySelector('[data-e2e-project-id]')?.getAttribute('data-e2e-project-id') ?? ''`,
  );
  expect(projectId).not.toBe("");
  const original = syntheticDocx();
  const originalSha = createHash("sha256").update(original).digest("hex");
  const path = "material-main.docx";
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(
      ${scriptValue(projectId)},
      ${scriptValue(path)},
      ${scriptValue(Buffer.from(original).toString("base64"))}
    ))`,
  );
  await page.evaluate(
    `window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`,
  );
  await openRailTab(page, "Explorer");
  await page.locator(`[role="treeitem"][data-path="${path}"]`).click();
  await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
  const opened = await readDocx(page);
  expect(opened.document.sourceSha256).toBe(originalSha);
  expect(opened.document.dirty).toBe(false);
  expect(opened.paragraphs.some((paragraph) => paragraph.text === "WORD-WORKING-SESSION")).toBe(true);
  const mainSession: DocxSessionState = opened.document;
  const target = opened.paragraphs.find((paragraph) => paragraph.text === "WORD-WORKING-SESSION");
  expect(target).toBeDefined();

  const change = await page.evaluate<{
    ok: boolean;
    changed: boolean;
    document: DocxSessionState;
  }>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
    m.createDocxAgentTools().apply_docx_format.execute(${scriptValue({
      paragraph_ref: target!.paragraphRef,
      expected_revision: opened.document.sessionRevision,
      font: { size: 17.5 },
    })})
  )`);
  expect(change).toMatchObject({ ok: true, changed: true, document: { dirty: true } });
  expect(change.document.sessionId).toBe(mainSession.sessionId);
  expect(change.document.sessionRevision).toBeGreaterThan(mainSession.sessionRevision);
  expect(change.document.savedRevision).toBe(mainSession.savedRevision);

  await chooseDocxView(page, "Version before this session");
  await expect(page.getByTestId("docx-original-surface")).toBeVisible();
  await expect(page.getByTestId("docx-editor-surface")).toBeHidden();
  expect((await readDocx(page)).document).toMatchObject({
    sessionId: change.document.sessionId,
    sessionRevision: change.document.sessionRevision,
    dirty: true,
  });

  await chooseDocxView(page, "Stack versions");
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setAssistantOpen(true))`);
  await expect(page.getByTestId("research-assistant")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("docx-original-surface")).toBeVisible();
  await expect(page.getByTestId("docx-editor-surface")).toBeHidden();
  await clickText(page, '[data-testid="docx-workspace"] [data-testid="word-surface"]', "Working copy");
  await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
  await expect(page.getByTestId("docx-original-surface")).toBeHidden();
  expect(await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="word-surface"]');
    const previous = root.querySelector('[data-word-surface-layer="previous"]');
    const current = root.querySelector('[data-word-surface-layer="current"]');
    return { previousInert: previous.inert, currentInert: current.inert,
      visibleLayers: [previous, current].filter(item => !item.hidden).length,
      toolbarCount: document.querySelectorAll('[data-testid="word-formatting-toolbar"]').length,
      paperEdge: !!root.querySelector('[data-testid="word-surface-paper-edge"]') };
  })()`)).toEqual({ previousInert: true, currentInert: false, visibleLayers: 1, toolbarCount: 1, paperEdge: true });
  expect((await readDocx(page)).document).toMatchObject({
    sessionId: change.document.sessionId,
    sessionRevision: change.document.sessionRevision,
    dirty: true,
  });
  await webviewScreenshot(page, testInfo.outputPath("docx-main-shared-surface.png"));
  await clickText(page, '[data-testid="docx-workspace"] [data-testid="word-surface"]', "Version before this session");
  expect(await page.evaluate<boolean>(`document.querySelector('[data-testid="word-surface"] [data-word-surface-layer="current"]').inert`)).toBe(true);
  expect((await readDocx(page)).document.sessionId).toBe(mainSession.sessionId);
  const historyContext = await page.evaluate<{ viewed: { role: string }; selectionWriteTarget: unknown }>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.getDocxWorkspaceContext())`,
  );
  expect(historyContext.viewed.role).toBe("original");
  expect(historyContext.selectionWriteTarget).toBeNull();
  await webviewScreenshot(page, testInfo.outputPath("docx-main-original-in-front.png"));

  await chooseDocxView(page, "Working copy");
  await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
  await expect(page.getByTestId("docx-original-surface")).toBeHidden();
  const followFlowId = "native-word-follow";
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m =>
    m.useAgentWorkspaceStore.getState().beginFollow(${scriptValue(projectId)}, {kind:'external',flowId:${scriptValue(followFlowId)}}))`);
  const applyFollowFormat = async (size: number) => {
    const current = await readDocx(page);
    return page.evaluate<{ ok: boolean }>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
      m.createDocxAgentTools({runId:()=>${scriptValue(followFlowId)}}).apply_docx_format.execute(${scriptValue({
        paragraph_ref: target!.paragraphRef, expected_revision: current.document.sessionRevision, font: { size },
      })}))`);
  };
  expect(await applyFollowFormat(18)).toMatchObject({ ok: true });
  await expect(page.getByTestId("workspace-agent-operation")).toContainText("Updating formatting · Completed");
  await expect(page.getByTestId("sidebar-agent-operation")).toContainText("Updating formatting · Completed");
  await chooseDocxView(page, "Version before this session");
  await expect.poll(() => page.evaluate<boolean>(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m => m.useAgentWorkspaceStore.getState().paused)`)).toBe(true);
  expect(await applyFollowFormat(18.5)).toMatchObject({ ok: true });
  await expect(page.getByTestId("docx-original-surface")).toBeVisible();
  await expect(page.getByTestId("docx-editor-surface")).toBeHidden();
  await clickText(page, '[data-testid="workspace-agent-operation"]', "Continue following");
  await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
  await expect(page.getByTestId("docx-original-surface")).toBeHidden();
  expect((await readDocx(page)).document.sessionId).toBe(mainSession.sessionId);
  await webviewScreenshot(page, testInfo.outputPath("docx-follow-resumed.png"));
  const prepared = await page.evaluate<{ acquisition: { families: unknown[] }; status: { probed: boolean }; measurement: { measurer: string } }>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.createDocxAgentTools({runId:()=>${scriptValue(followFlowId)}}).prepare_docx_fonts.execute({}))`,
  );
  expect(Array.isArray(prepared.acquisition.families)).toBe(true);
  expect(typeof prepared.status.probed).toBe("boolean");
  expect(["fixed", "shaped"]).toContain(prepared.measurement.measurer);
  expect((await readDocx(page)).document).toMatchObject({ sessionId: mainSession.sessionId, dirty: true });
  const exportPath = testInfo.outputPath("word-agent-export.docx");
  const exported = await page.evaluate<{ result: { status: string; path?: string }; sessionId: string; sessionRevision: number; byteLength: number }>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => {
      window.__e2eSetNextSavePath(${scriptValue(exportPath)});
      return m.createDocxAgentTools({runId:()=>${scriptValue(followFlowId)}}).export_docx_document.execute({});
    })`,
  );
  expect(exported).toMatchObject({ result: { status: "saved", path: exportPath }, sessionId: mainSession.sessionId });
  expect((await readFile(exportPath)).length).toBe(exported.byteLength);
  expect(exported.byteLength).toBeGreaterThan(0);
  await expect(page.getByTestId("workspace-agent-operation")).toContainText("File saved");
  const cancelledExport = await page.evaluate<{ result: { status: string } }>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => {
      window.__e2eSetNextSavePath(null);
      return m.createDocxAgentTools({runId:()=>${scriptValue(followFlowId)}}).export_docx_document.execute({});
    })`,
  );
  expect(cancelledExport.result.status).toBe("cancelled");
  await expect(page.getByTestId("workspace-agent-operation")).toContainText("Cancelled");
  await chooseDocxView(page, "Working copy");
  await clickText(page, '[data-testid="docx-workspace"]', "Annotate whole material");
  await expect(page.getByTestId("material-annotations")).toBeVisible();
  const captured = await page.evaluate<MaterialReference>(`window.__oleaflyE2EImport('/src/store/material-annotations.ts').then(m => {
    const document = m.useMaterialAnnotationsStore.getState().document;
    if (!document) throw new Error('DOCX material was not captured');
    const { source, ...reference } = document;
    return reference;
  })`);
  const feedback = "DOCX-WORKING-COPY-ACTUAL-BYTES";
  await fillFeedback(page, feedback);
  await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
  let context: AnnotationContext | undefined;
  await expect.poll(async () => {
    context = await objectAnnotations(page, captured);
    return context.annotations.find((annotation) => annotation.body === feedback)?.id ?? "";
  }).not.toBe("");
  const annotation = context!.annotations.find((item) => item.body === feedback)!;
  const retained = await page.evaluate<RetainedMaterial>(
    `window.__oleaflyE2EImport('/src/lib/material-annotations.ts').then(m => m.readMaterialAnnotation(
      ${scriptValue(projectId)},
      ${scriptValue(annotation.id)}
    ))`,
  );
  expect(retained.snapshot.document).toMatchObject({
    documentId: captured.documentId,
    title: captured.title,
    kind: "docx",
    revision: captured.revision,
  });
  expect(retained.bytes.slice(0, 2)).toEqual([80, 75]);
  expect(createHash("sha256").update(new Uint8Array(retained.bytes)).digest("hex"))
    .not.toBe(originalSha);
  expect(retained.snapshot.sha256.replace(/^sha256:/u, ""))
    .toBe(createHash("sha256").update(new Uint8Array(retained.bytes)).digest("hex"));
  await webviewScreenshot(page, testInfo.outputPath("docx-working-copy-whole-annotation.png"));

  await page.locator('[data-testid="docx-editor-surface"]').click({ position: { x: 100, y: 100 } });
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => {
    const current = await readDocx(page);
    const format = await page.evaluate<{ paragraph?: { font: { size: number | null } } }>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
        m.createDocxAgentTools().read_docx_format.execute({ query: { paragraph_ref: ${scriptValue(target!.paragraphRef)} } })
      )`,
    );
    return {
      sessionId: current.document.sessionId,
      fontSize: format.paragraph?.font.size,
    };
  }).toEqual({
    sessionId: mainSession.sessionId,
    fontSize: 12,
  });
  const textPosition = await page.evaluate<{ x: number; y: number }>(`(() => {
    const fragment = Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment')).find(item => item.textContent === 'WORD-WORKING-SESSION');
    if (!fragment) throw new Error('The working paper has no visible title fragment');
    const rect = fragment.getBoundingClientRect();
    return { x: rect.x + 15, y: rect.y + rect.height / 2 };
  })()`);
  await page.mouse.click(textPosition.x, textPosition.y);
  await page.keyboard.press("Meta+a");
  await clickText(page, '[data-testid="word-formatting-toolbar"]', "More formatting options");
  await page.selectOption('[data-testid="word-formatting-toolbar"] select[aria-label="Font size"]', "36");
  await expect.poll(() => page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(async m => {
    const format = await m.createDocxAgentTools().read_docx_format.execute({query:{paragraph_ref:${scriptValue(target!.paragraphRef)}}});
    return format.paragraph?.font.size;
  })`)).toBe(18);
  await clickText(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
  await expect.poll(() => page.evaluate<number>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(async m => {
    const format = await m.createDocxAgentTools().read_docx_format.execute({query:{paragraph_ref:${scriptValue(target!.paragraphRef)}}});
    return format.paragraph?.font.size;
  })`)).toBe(12);
  expect(await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m =>
    m.readFileBase64(${scriptValue(projectId)}, ${scriptValue(path)})
  )`)).toBe(Buffer.from(original).toString("base64"));

  const server = await startMockAiServer();
  let taskId: string | null = null;
  let task: ResearchTask | undefined;
  let settled = false;
  try {
    expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    let resultPath = "";
    let frozenSourcePath = "";
    server.setResponder((request) => {
      const messages = request.messages as { role: string; content: unknown }[];
      const prompt = messages.flatMap((item) => typeof item.content === "string" ? [item.content] : []).join("\n");
      frozenSourcePath = /Exact source bytes are at (\S+) and/.exec(prompt)?.[1] ?? frozenSourcePath;
      if (frozenSourcePath) resultPath = frozenSourcePath.replace(/material-source\.docx$/u, "material-result.docx");
      const results = messages.filter((item) => item.role === "tool" && typeof item.content === "string")
        .map((item) => decodeToolResult(item.content as string));
      if (results.length === 0) return { name: "discover_tools", args: { query: "docx" } };
      if (results.length === 1) return { name: "read_docx_document", args: { offset: 0, limit: 10 } };
      if (results.length === 2) {
        const read = findResult(results, (value) => Array.isArray(value.paragraphs) && !!value.document) as unknown as DocxDocumentRead;
        const paragraph = read.paragraphs.find((item) => item.text === "WORD-WORKING-SESSION");
        if (!paragraph) throw new Error("The material task could not read its bound Word working copy.");
        expect(read.document.sessionId).toBe(mainSession.sessionId);
        return { name: "apply_docx_format", args: {
          paragraph_ref: paragraph.paragraphRef,
          expected_revision: read.document.sessionRevision,
          font: { size: 19 },
        } };
      }
      if (results.length === 3 || results.length === 4) {
        const operation = results.length === 3 ? "format" : "replace_range";
        const actual = findResult(results, (value) => value.operation === operation && !!value.checkpoint) as {
          document: { sessionRevision: number }; checkpoint: { status: string };
        };
        expect(actual.checkpoint).toMatchObject({ status: "recorded" });
        const read = findResult(results, (value) => Array.isArray(value.paragraphs) && !!value.document) as unknown as DocxDocumentRead;
        const second = read.paragraphs.find((item) => item.text.startsWith("Second paragraph"));
        if (!second) throw new Error("The Word task has no second paragraph for bounded editing.");
        return results.length === 3 ? { name: "replace_docx_text_range", args: {
          paragraph_ref: second.paragraphRef, expected_revision: actual.document.sessionRevision,
          range: { start: 0, end: 6 }, expected_text: "Second", replacement: "Updated",
        } } : { name: "write_docx_equation", args: {
          paragraph_ref: second.paragraphRef, expected_revision: actual.document.sessionRevision,
          offset: second.modelText.length + 1, latex: "x^2+y^2=z^2", macros: "", display: false,
        } };
      }
      if (results.length === 5) {
        expect(findResult(results, (value) => value.operation === "write_equation" && !!value.checkpoint))
          .toMatchObject({ ok: true, checkpoint: { status: "recorded" } });
        if (!frozenSourcePath.endsWith("/material-source.docx")) {
          throw new Error("The Word task prompt did not identify its frozen DOCX source.");
        }
        return { name: "run_command", args: {
          command: `/bin/cp '${frozenSourcePath.replace(/'/gu, "'\\''")}' '${resultPath.replace(/'/gu, "'\\''")}'`,
        } };
      }
      if (results.length === 6) {
        expect(findResult(results, (value) => value.exitCode === 0)).toMatchObject({
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        });
        return { name: "discover_tools", args: { query: "annotation_handle" } };
      }
      if (results.length === 7) {
        const annotationId = /Current material request: ([^ .]+)\./.exec(prompt)?.[1];
        if (!annotationId) throw new Error("The Word task did not receive its material request.");
        return {
          name: "annotation_handle",
          args: {
            annotationId,
            summary: "Formatted the title to 19 pt in the bound Word working copy and copied the frozen DOCX source to material-result.docx.",
            resultRefs: [{ objectKind: "file", objectId: resultPath, path: resultPath }],
          },
        };
      }
      expect(findResult(results, (value) => typeof value.summary === "string" && Array.isArray(value.resultRefs)))
        .toMatchObject({ summary: expect.stringContaining("material-result.docx") });
      return "The requested formatting remains unsaved in the Word working copy, and material-result.docx is ready for review.";
    });
    await clickText(page, '[data-testid="docx-workspace"]', "Annotate whole material");
    const requestBody = "WORD-MATERIAL-TASK: Format the title to 19 pt, replace Second with Updated in the second paragraph, append the inline equation x^2+y^2=z^2 there, and report the unsaved changes.";
    await fillFeedback(page, requestBody);
    await page.click('[data-testid="material-annotations"] button[role="checkbox"]');
    await clickText(page, '[data-testid="material-annotations"]', "Save annotation");
    await expect.poll(async () => {
      task = await page.evaluate<ResearchTask | undefined>(
        `window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(async m =>
          (await m.listResearchTasks(${scriptValue(projectId)})).find(task => task.prompt.startsWith(${scriptValue(requestBody)})))`,
      );
      taskId = task?.id ?? null;
      return task?.status;
    }, { timeout: 120_000, intervals: [500] }).toBe("awaiting_review");
    if (!task) throw new Error("The Word material task was not retained.");
    settled = true;
    const result = await readDocx(page);
    expect(result.document).toMatchObject({ sessionId: mainSession.sessionId, dirty: true });
    const format = await page.evaluate<{ paragraph?: { font: { size: number | null } } }>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
        m.createDocxAgentTools().read_docx_format.execute({ query: { paragraph_ref: ${scriptValue(target!.paragraphRef)} } }))`,
    );
    expect(format.paragraph?.font.size).toBe(19);
    expect(await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m =>
      m.readFileBase64(${scriptValue(projectId)}, ${scriptValue(path)}))`)).toBe(Buffer.from(original).toString("base64"));
    await webviewScreenshot(page, testInfo.outputPath("docx-material-task-bound-working-copy.png"));

    expect(frozenSourcePath).toMatch(/^research\/[^/]+\/material-source\.docx$/u);
    expect(task.isolation).not.toBeNull();
    expect(task.result?.changedFiles).toContainEqual(expect.objectContaining({
      path: resultPath,
      kind: "added",
    }));
    expect(task.result?.changedFiles.some((file) => file.path === path)).not.toBe(true);
    const taskContext = await page.evaluate<AnnotationContext>(
      `window.__oleaflyE2EImport('/src/lib/task-collaboration.ts').then(m => m.loadTaskAnnotations(${scriptValue(projectId)}, ${scriptValue(taskId)}))`,
    );
    expect(taskContext.handlings.at(-1)?.resultRefs).toContainEqual(expect.objectContaining({
      objectKind: "file",
      objectId: resultPath,
      path: resultPath,
    }));

    await clickText(
      page,
      '[data-testid="material-annotations"]',
      `View handling task · ${task.title}`,
    );
    const detail = page.getByTestId("research-task-detail");
    await expect(detail).toBeVisible();
    await clickText(page, '[data-testid="research-task-detail"]', "Review");
    await expect.poll(() => changedFileActionState(page, resultPath, "Preview")).toBe("ready");
    await clickChangedFileAction(page, resultPath, "Preview");
    await expect.poll(() => changedFileActionState(page, resultPath, "Open in workspace")).toBe("ready");
    await clickChangedFileAction(page, resultPath, "Open in workspace");

    const retained = page.locator('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
    await expect(retained).toBeVisible({ timeout: 30_000 });
    await expect(retained).toContainText(resultPath);
    await expect.poll(() => page.evaluate<boolean>(`(() => {
      const viewer = document.querySelector('[data-testid="workspace-material-surface"]:not([hidden]) [data-testid="retained-material-viewer"]');
      return !!viewer?.closest('[data-testid="workspace-center"]')
        && !viewer.closest('[role="dialog"], [role="alertdialog"]')
        && (viewer.textContent ?? '').includes('WORD-WORKING-SESSION');
    })()`), { timeout: 120_000 }).toBe(true);
    await expect(detail).toBeHidden();
    expect(await page.evaluate<string>(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m =>
      m.readFileBase64(${scriptValue(projectId)}, ${scriptValue(path)}))`)).toBe(Buffer.from(original).toString("base64"));

    await openRailTab(page, "Explorer");
    await page.locator(`[role="treeitem"][data-path="${path}"]`).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 30_000 });
    const restored = await readDocx(page);
    expect(restored.document).toMatchObject({
      sessionId: mainSession.sessionId,
      dirty: true,
    });
    const restoredFormat = await page.evaluate<{ paragraph?: { font: { size: number | null } } }>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
        m.createDocxAgentTools().read_docx_format.execute({ query: { paragraph_ref: ${scriptValue(target!.paragraphRef)} } }))`,
    );
    expect(restoredFormat.paragraph?.font.size).toBe(19);
    expect(restored.paragraphs.some((item) => item.text.startsWith("Updated paragraph"))).toBe(true);
    await clickText(page, '[data-testid="docx-workspace"]', "Save version");
    await expect.poll(async () => (await readDocx(page)).document.dirty, { timeout: 60_000 }).toBe(false);
    const saved = (await readDocx(page)).document;
    expect(saved.sessionId).toBe(mainSession.sessionId);
    expect(saved.baselineId).not.toBe(mainSession.baselineId);
    const savedSource = await page.evaluate<{ source_sha256: string; bytes: number[] }>(
      `window.__oleaflyE2EImport('/src/lib/docx-workbench.ts').then(async m => {
        const source = await m.loadDocxSource(${scriptValue(saved.workbenchProjectId)}, ${scriptValue(saved.baselineId)});
        return {source_sha256: source.source_sha256, bytes: Array.from(source.bytes)};
      })`,
    );
    expect(createHash("sha256").update(new Uint8Array(savedSource.bytes)).digest("hex")).toBe(saved.sourceSha256);
    expect(savedSource.source_sha256).toBe(saved.sourceSha256);
    const activityPage = await page.evaluate<DocxActivityPage>(`window.__TAURI_INTERNALS__.invoke('research_docx_activities', {
      projectId: ${scriptValue(projectId)}, workbenchProjectId: ${scriptValue(saved.workbenchProjectId)}, afterCursor: 0, limit: 50 })`);
    expect(activityPage.hasMore).toBe(false);
    for (const operation of ["replace_range", "write_equation"]) {
      const actual = activityPage.activities.find(({activity}) => activity.origin.taskId === taskId &&
        activity.event.type === "runtime" && activity.event.event.kind === "operation" && activity.event.event.operation === operation)?.activity;
      expect(actual).toBeDefined();
      if (actual?.event.type !== "runtime" || actual.event.event.kind !== "operation") throw new Error("Missing actual Word operation.");
      expect(actual.event.event.result.ok).toBe(true);
      const operationId = actual.event.event.operationId;
      expect(activityPage.activities.some(({activity}) => activity.event.type === "operationCheckpoint" &&
        activity.event.operationId === operationId && activity.event.phase === "saved" &&
        activity.event.contentSha256 === saved.sourceSha256)).toBe(true);
    }
    const savedExportPath = testInfo.outputPath("word-task-saved.docx");
    await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(savedExportPath)})`);
    await clickText(page, '[data-testid="docx-workspace"]', "Download DOCX copy");
    await expect.poll(async () => readFile(savedExportPath).then(bytes => bytes.length).catch(() => 0)).toBeGreaterThan(0);
    const downloadedPackage = unzipSync(new Uint8Array(await readFile(savedExportPath)));
    const savedPackage = unzipSync(new Uint8Array(savedSource.bytes));
    expect(new TextDecoder().decode(downloadedPackage["word/document.xml"]))
      .toBe(new TextDecoder().decode(savedPackage["word/document.xml"]));

    await clickText(page, '[data-testid="docx-workspace"]', "Open PDF");
    await expect.poll(() => page.evaluate<boolean>(`!!document.querySelector('[data-testid="docx-render-preview"] .textLayer span')`), { timeout: 90_000 }).toBe(true);
    const pdfContext = await page.evaluate<DocxWorkspaceContext>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.getDocxWorkspaceContext())`);
    expect(pdfContext.viewed).toMatchObject({kind: "pdf", role: "result"});
    expect(pdfContext.selectionWriteTarget).toBeNull();
    const renders = await page.evaluate<{ bundle_id: string; baseline_id: string; manifest: { pdf_sha256: string } }[]>(
      `window.__oleaflyE2EImport('/src/lib/docx-render.ts').then(m => m.loadDocxRenders(${scriptValue(saved.workbenchProjectId)}, ${scriptValue(saved.baselineId)}))`);
    expect(renders.some(render => pdfContext.viewed?.documentId === `docx-render:${saved.workbenchProjectId}:${saved.baselineId}:${render.bundle_id}` &&
      pdfContext.viewed.revision === render.manifest.pdf_sha256)).toBe(true);
    const quote = await page.evaluate<string>(`(() => {
      const span = Array.from(document.querySelectorAll('[data-testid="docx-render-preview"] .textLayer span')).find(item => item.textContent?.includes('WORD-WORKING-SESSION'));
      if (!span) throw new Error('The saved PDF has no rendered title text');
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      return selection.toString();
    })()`);
    expect(quote).toContain("WORD-WORKING-SESSION");
    await expect.poll(() => page.evaluate<DocxWorkspaceContext>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.getDocxWorkspaceContext())`))
      .toMatchObject({viewed: {kind: "pdf", selection: {anchor: {kind: "pdf", quote}}}, selectionWriteTarget: null});
    await webviewScreenshot(page, testInfo.outputPath("docx-task-saved-pdf-selection.png"));
    await clickText(page, '[data-testid="docx-workspace"]', "Back to document");
    expect((await readDocx(page)).document).toMatchObject({sessionId: mainSession.sessionId, baselineId: saved.baselineId, dirty: false});
  } finally {
    if (taskId && !settled) await page.evaluate(`window.__oleaflyE2EImport('/src/lib/research-tasks.ts').then(m => m.cancelResearchTask(${scriptValue(taskId)}))`);
    await server.close();
  }
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import type { SemanticSelection } from "@docx-editor.dev/core/editor";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { DocxDocumentRead, DocxReadQuery, DocxWorkspaceContext } from "../../packages/ai-tools/src/tools";
import { declaredDocxDoi, docxDoiUrl } from "../../src/lib/docx-citation-doi";
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
type DocxParagraph = DocxDocumentRead["paragraphs"][number];

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

async function readDocx(page: Page, query?: DocxReadQuery): Promise<DocxDocumentRead> {
  return page.evaluate<DocxDocumentRead>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument(${query ? scriptValue(query) : ""}))`,
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

function syntheticDocx(twoColumns = false): Uint8Array {
  const columnBreak = twoColumns ? '<w:p><w:r><w:br w:type="column"/></w:r></w:p>' : "";
  const columns = twoColumns ? '<w:cols w:num="2" w:space="720"/>' : "";
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
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w14:paraId="00000001"><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>WORD-WORKING-SESSION</w:t></w:r></w:p>${columnBreak}<w:p w14:paraId="00000002"><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>Second paragraph remains in the same working copy.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/>${columns}</w:sectPr></w:body></w:document>`,
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

type Manuscript = { path: string; sha256: string; paragraphs: [string, string, string] };
type CitationTrial = { python: string; originalPath: string; exportPath: string; doi: string; titleQuery?: string };
type CitationReimport = {
  python: string;
  exportPath: string;
  doi: string;
  citations: [{ paraId: string; instruction: string }, { paraId: string; instruction: string }];
};

const publishedManuscript = (path: string): Manuscript => ({
  path,
  sha256: "31b5cbc408c359dc31224b081505264bad689f4601eef3a05969668f85c9d47b",
  paragraphs: ["0E8ABDCF", "4AD876D5", "3907DF96"],
});

function citationPackageEvidence(python: string, ...args: string[]) {
  const result = spawnSync(python, ["-B", "e2e/tests/docx-real-package.py", ...args], {
    encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("services/research-workbench/src") },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DOCX package check failed: ${(result.stdout || result.stderr).trim()}`);
  return JSON.parse(result.stdout);
}

test("DOCX citation picker uses live Crossref and preserves one source across columns", async ({ tauriPage: page }, testInfo) => {
  test.skip(process.env.OLEAFLY_DOCX_CITATION_ACCEPTANCE !== "1", "Requires an isolated desktop build with VITE_DOCX_CITATION_PREVIEW=1 and live Crossref.");
  test.setTimeout(240_000);
  const python = process.env.OLEAFLY_WORKBENCH_PYTHON;
  if (!python) throw new Error("Set OLEAFLY_WORKBENCH_PYTHON for DOCX citation acceptance.");
  const published = process.env.OLEAFLY_PUBLISHED_DOCX;
  await exerciseDocxWorkingCopy(page, published ? publishedManuscript(published) : undefined, {
    python,
    originalPath: published || testInfo.outputPath("original.docx"),
    exportPath: testInfo.outputPath("oleafly-export.docx"),
    doi: published ? "10.1038/nature14539" : "10.1023/a:1010933404324",
    titleQuery: published ? undefined : "Random Forests",
  });
});

test("authorized Word manuscript survives desktop review and citation export", async ({ tauriPage: page }, testInfo) => {
  const path = process.env.OLEAFLY_WORD_ORIGINAL_DOCX;
  test.skip(!path, "Supply an authorized long two-column Word manuscript with native Word citations.");
  test.setTimeout(300_000);
  const python = process.env.OLEAFLY_WORKBENCH_PYTHON;
  const doi = declaredDocxDoi(process.env.OLEAFLY_WORD_TRIAL_DOI ?? "");
  const paragraphs = (process.env.OLEAFLY_WORD_TRIAL_PARAGRAPHS ?? "").trim().toUpperCase().split(/\s*,\s*/u);
  if (!python || !doi || paragraphs.length !== 3 || new Set(paragraphs).size !== 3 ||
    paragraphs.some(id => !/^[A-F0-9]{8}$/u.test(id))) {
    throw new Error("Set the Workbench interpreter, trial DOI and three distinct paragraph IDs in left,edit,right order.");
  }
  const preflight = citationPackageEvidence(python, "--citation-input", path!, doi, paragraphs.join(","));
  expect(preflight).toMatchObject({ ok: true, issues: [] });
  await exerciseDocxWorkingCopy(page, { path: path!, sha256: preflight.sha256,
    paragraphs: [paragraphs[0], paragraphs[1], paragraphs[2]] }, {
    python, originalPath: path!, exportPath: testInfo.outputPath("oleafly-export.docx"), doi,
  });
});

test("published DOCX review survives save and reopen on desktop", async ({ tauriPage: page }) => {
  test.skip(process.env.OLEAFLY_DOCX_REVIEW_ACCEPTANCE !== "1", "Requires an isolated desktop runner and the published two-column DOCX.");
  test.setTimeout(240_000);
  const published = process.env.OLEAFLY_PUBLISHED_DOCX;
  if (!published) throw new Error("Set OLEAFLY_PUBLISHED_DOCX to the original Zenodo 8227226 DOCX.");
  await exerciseDocxWorkingCopy(page, publishedManuscript(published));
});

test("Word citation re-import remains editable on desktop", async ({ tauriPage: page }, testInfo) => {
  const path = process.env.OLEAFLY_WORD_REIMPORT_DOCX;
  test.skip(!path, "Supply the refreshed DOCX copy to re-import.");
  test.setTimeout(240_000);
  const python = process.env.OLEAFLY_WORKBENCH_PYTHON;
  const doi = declaredDocxDoi(process.env.OLEAFLY_WORD_REIMPORT_DOI ?? "");
  if (!python || !doi) throw new Error("Set OLEAFLY_WORKBENCH_PYTHON and OLEAFLY_WORD_REIMPORT_DOI.");
  const targets: { ok: boolean; sha256: string; editParaId: string; citations: CitationReimport["citations"] } =
    citationPackageEvidence(python, "--citation-reimport-targets", path!, doi);
  expect(targets).toMatchObject({ ok: true, issues: [] });
  expect(targets.citations).toHaveLength(2);
  const [left, right] = targets.citations;
  await exerciseDocxWorkingCopy(page, {
    path: path!, sha256: targets.sha256,
    paragraphs: [targets.editParaId, left.paraId, right.paraId],
  }, undefined, { python, doi, exportPath: testInfo.outputPath("oleafly-reexport.docx"), citations: targets.citations });
});

async function exerciseDocxWorkingCopy(
  page: Page,
  manuscript: Manuscript | undefined,
  citation?: CitationTrial,
  reimport?: CitationReimport,
) {
  await expect.poll(() => page.evaluate<string>("document.visibilityState"), {
    message: "Word desktop acceptance requires an unlocked desktop with the Oleafly window visible.",
    timeout: 5_000,
  }).toBe("visible");
  const original = manuscript ? await readFile(manuscript.path) : syntheticDocx(true);
  const originalSha = createHash("sha256").update(original).digest("hex");
  if (manuscript) expect(originalSha).toBe(manuscript.sha256);
  const originalBase64 = Buffer.from(original).toString("base64");
  await createBlankProject(page, `DOCX ${reimport ? "re-import" : citation ? "citation" : "review"} ${Date.now()}`);
  await page.evaluate("window.__oleaflyE2EImport('/src/store/settings.ts').then(m => m.useSettingsStore.getState().setUiLocalePreference('en'))");
  const file = manuscript ? "manuscript.docx" : "two-column-citation.docx";
  const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]').getAttribute('data-e2e-project-id')`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(${scriptValue(projectId)}, ${scriptValue(file)}, ${scriptValue(originalBase64)}))`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`);
  const openFile = () => page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().openFile(${scriptValue(file)}))`);
  const workspace = '[data-testid="docx-workspace"]';
  const surface = '[data-testid="docx-editor-surface"]';
  const tools = '[data-testid="docx-context-tools"]';
  const picker = `${tools}[role="dialog"][aria-label="Insert citation"]`;
  const searchbox = `${picker} input[type="search"]`;
  const notice = page.locator(`${picker} [role="status"]`);
  const waitForSession = (sourceSha: string, previousSession?: string) => expect.poll(async () => {
    const documents = await page.evaluate<DocxSessionState[]>(
      "window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.listDocuments())",
    );
    return documents.some(document => document.appProjectId === projectId &&
      document.sourceSha256 === sourceSha && document.sessionId !== previousSession);
  }, { timeout: 30_000 }).toBe(true);
  const activateInside = (selector: string) => page.evaluate(`document.querySelector(${scriptValue(selector)}).click()`);
  const activeInside = (selector: string) => page.evaluate<string | null>(`document.activeElement?.matches(${scriptValue(selector)})
    ? document.activeElement.textContent : null`);
  await openFile();
  await expect(page.locator(surface)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-resolving", "false", { timeout: 60_000 });
  await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-measurer", "shaped");
  await waitForSession(originalSha);
  const opened = (await readDocx(page)).document;
  expect(opened.sourceSha256).toBe(originalSha);
  const layout = (pageIndex: string) => page.evaluate(`(() => {
    const root = document.querySelector(${scriptValue(surface)});
    const viewport = root.querySelector('.docx-editor__scroll-container');
    const paper = root.querySelector(${scriptValue(`.docx-page[data-page-index="${pageIndex}"]`)});
    return { paper: paper.getBoundingClientRect().toJSON(),
      viewport: viewport.getBoundingClientRect().toJSON(), scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft };
  })()`);
  const targetIds = manuscript?.paragraphs ?? ["00000001", "00000002"];
  const readTargets = async () => {
    const matches = new Map<string, DocxParagraph>();
    let result = await readDocx(page, { limit: 50 });
    for (;;) {
      for (const paragraph of result.paragraphs) {
        const id = paragraph.paraId?.toUpperCase();
        if (id && targetIds.includes(id)) matches.set(id, paragraph);
      }
      if (!result.nextQuery || matches.size === targetIds.length) break;
      result = await readDocx(page, result.nextQuery);
    }
    expect(targetIds.filter(id => !matches.has(id)), "Missing manuscript paragraph IDs").toEqual([]);
    return targetIds.map(id => matches.get(id)!);
  };
  const reveal = async (paragraphRef: string) => {
    await page.evaluate(`(() => {
      window.__docxNavigation = { status: 'pending' };
      void window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(async m => {
        const { document } = await m.DOCX_AGENT_HOST.readDocument({ limit: 1 });
        await m.revealDocxWorkspaceTarget({ projectId: ${scriptValue(projectId)}, sessionId: document.sessionId, paragraphRef: ${scriptValue(paragraphRef)} });
        window.__docxNavigation = { status: 'revealed' };
      }).catch(error => { window.__docxNavigation = { status: 'failed', error: String(error) }; });
      return true;
    })()`);
    await expect.poll(async () => {
      const result = await page.evaluate<{ status: string; error?: string }>("window.__docxNavigation");
      if (result.error) throw new Error(result.error);
      return result.status;
    }, { message: `Reveal Word paragraph ${paragraphRef}` }).toBe("revealed");
  };
  const revealPaintedParagraph = async (target: DocxParagraph) => {
    if (!target.paraId) throw new Error(`No DOCX paragraph identity for ${target.paragraphRef}`);
    await reveal(target.paragraphRef);
    const { sessionId } = (await readDocx(page, { limit: 1 })).document;
    const nodeId = await page.evaluate<string | null>(`window.__oleaflyE2EImport('/src/components/research/DocxWorkspaceDialog.tsx')
      .then(m => m.e2eDocxParagraphNode(${scriptValue(sessionId)}, ${scriptValue(target.paraId)}))`);
    if (!nodeId) throw new Error(`No painted paragraph for ${target.paraId}`);
    return { nodeId, sessionId };
  };
  const modelSelection = (sessionId: string) => page.evaluate<SemanticSelection | null>(
    `window.__oleaflyE2EImport('/src/components/research/DocxWorkspaceDialog.tsx').then(m => m.e2eDocxSelection(${scriptValue(sessionId)}))`,
  );
  const placeCaret = async (target: DocxParagraph) => {
    const { nodeId, sessionId } = await revealPaintedParagraph(target);
    const position = await page.evaluate<{ left: number; right: number; pageIndex: string }>(`(() => {
      const fragment = Array.from(document.querySelectorAll(${scriptValue(`${surface} .docx-paragraph-fragment[data-fragment-index="0"]`)}))
        .find(item => item.dataset.paragraphId === ${scriptValue(nodeId)});
      const line = fragment?.querySelector('.docx-line');
      if (!line) throw new Error('Fixture line is not painted');
      line.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = line.getBoundingClientRect();
      const clientX = rect.left + 5, clientY = rect.top + Math.min(8, rect.height / 2);
      const hit = document.elementFromPoint(clientX, clientY);
      if (!hit || !line.contains(hit)) throw new Error('Fixture line is not under the pointer');
      const options = { bubbles: true, cancelable: true, clientX, clientY, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      hit.dispatchEvent(new PointerEvent('pointerdown', { ...options, buttons: 1 }));
      hit.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
      const paper = fragment.closest('.docx-page');
      const box = fragment.getBoundingClientRect();
      const paperLeft = paper.getBoundingClientRect().left;
      return { left: box.left - paperLeft, right: box.right - paperLeft, pageIndex: paper.dataset.pageIndex };
    })()`);
    await page.keyboard.press("Home");
    await expect.poll(() => page.evaluate(`(() => {
      const selection = document.getSelection();
      return document.activeElement?.matches(${scriptValue(`${surface} .docx-pages`)}) && selection?.isCollapsed
        ? selection.anchorNode?.parentElement?.closest('.docx-paragraph-fragment')?.dataset.paragraphId ?? null
        : null;
    })()`)).toBe(nodeId);
    const start = { paragraphId: nodeId, offset: 0 };
    await expect.poll(() => modelSelection(sessionId)).toMatchObject({ anchor: start, head: start });
    await expect.poll(async () => (await page.evaluate<DocxWorkspaceContext>(
      "window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(host => host.getDocxWorkspaceContext())",
    )).selectionWriteTarget?.paragraphRef).toBe(target.paragraphRef);
    return { ...position, nodeId, sessionId };
  };
  const reviewManuscript = async () => {
    const server = await startMockAiServer();
    let releaseHeldStream: (() => void) | null = null;
    const release = () => {
      releaseHeldStream?.();
      releaseHeldStream = null;
    };
    try {
      expect(await page.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
      const sessionId = opened.sessionId;
      const [left, human, right] = await readTargets();
      const reviewPrefix = "Suggested paragraph is complete.";
      const humanPrefix = "LOCAL ";
      for (const [target, prefix] of [[left, reviewPrefix], [human, humanPrefix], [right, " "]] as const) {
        expect(target.atoms, `Expected plain text in ${target.paraId}`).toHaveLength(0);
        expect(target.modelTextTruncated).not.toBe(true);
        expect(target.text.length).toBeGreaterThan(prefix.length);
        expect(target.editableRanges.some(({ start, end }) => start === 0 && end >= prefix.length),
          `Expected an editable paragraph opening in ${target.paraId}`).toBe(true);
      }
      const reviewReply = reviewPrefix + left.text.slice(reviewPrefix.length);
      const humanReply = humanPrefix + human.text.slice(humanPrefix.length);
      const staleReply = "STALE review must not apply.";
      const interruptedPrefix = "LOCALIZED";
      const interruptedReply = interruptedPrefix + reviewReply.slice(interruptedPrefix.length);
      const inlineSelector = '[data-testid="docx-inline-suggestion"]';
      const inline = page.locator(inlineSelector);
      const reviewEntry = page.locator('[data-testid="docx-inline-suggestion"] button').first();
      const review = page.locator('[data-testid="docx-suggestion"]');
      const reviewHeading = page.locator('[data-testid="docx-suggestion"] h3');
      const documentTools = page.locator('[data-testid="docx-document-tools"]');
      const accept = page.locator('[data-testid="docx-suggestion"] button').filter({ hasText: "Accept" }).first();
      const replacePrefix = async (target: DocxParagraph, replacement: string) => {
        const { nodeId, sessionId } = await placeCaret(target);
        for (let index = 0; index < replacement.length; index++) {
          await page.keyboard.press("Shift+ArrowRight");
        }
        await expect.poll(() => modelSelection(sessionId)).toMatchObject({
          anchor: { paragraphId: nodeId, offset: 0 },
          head: { paragraphId: nodeId, offset: replacement.length },
        });
        await page.evaluate(`document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: ${scriptValue(replacement)}, bubbles: true, cancelable: true
        }))`);
      };
      const paperState = () => page.evaluate(`(() => {
        const root = document.querySelector(${scriptValue(surface)});
        const viewport = root.querySelector('.docx-editor__scroll-container');
        return {
          pages: Array.from(root.querySelectorAll('.docx-page')).map(page => page.getBoundingClientRect().toJSON()),
          viewport: viewport.getBoundingClientRect().toJSON(),
          scrollTop: viewport.scrollTop,
          scrollLeft: viewport.scrollLeft
        };
      })()`);
      const beginSuggestion = async (paragraphRef: string, reply: string) => {
        server.setReply(reply);
        releaseHeldStream = server.holdNextStream();
        const requests = server.requestCount();
        await page.evaluate(`(() => {
          window.__docxSuggestionStatus = { state: 'pending' };
          const pending = window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
            m.DOCX_AGENT_HOST.suggestChange({
              sessionId: ${scriptValue(sessionId)},
              paragraphRef: ${scriptValue(paragraphRef)},
              instruction: 'Improve this paragraph while preserving its meaning.'
            })
          );
          pending.then(
            value => { window.__docxSuggestionStatus = { state: 'fulfilled', value }; },
            error => { window.__docxSuggestionStatus = { state: 'rejected', error: String(error) }; }
          );
        })()`);
        await expect.poll(() => server.requestCount(), { timeout: 30_000 }).toBe(requests + 1);
      };
      const pendingStatus = () => page.evaluate<string | null>(
        "window.__docxSuggestionStatus?.state ?? null",
      );
      const suggestionTitle = () => page.evaluate<string | null>(`(() => {
        const button = document.querySelector('[data-testid="docx-inline-suggestion"] button');
        return button?.getAttribute('title') ?? null;
      })()`);

      await reveal(left.paragraphRef);
      await beginSuggestion(left.paragraphRef, reviewReply);
      await expect.poll(suggestionTitle).toBe("Generating suggestion");
      await expect(review).toBeHidden();

      await replacePrefix(human, humanPrefix);
      await expect.poll(async () => (await readTargets())[1].text).toBe(humanReply);
      await expect.poll(suggestionTitle).toBe("Generating suggestion");
      await expect(documentTools).toHaveAttribute("aria-expanded", "false");
      await page.evaluate("new Promise(requestAnimationFrame)");
      const paperBeforeReady = await paperState();
      await page.evaluate("(() => { window.__docxReviewFocus = document.activeElement; })()");
      release();
      await expect.poll(suggestionTitle).toBe("Ready to review");
      await expect.poll(pendingStatus).toBe("fulfilled");
      await expect(review).toBeHidden();
      expect(await page.evaluate<boolean>("document.activeElement === window.__docxReviewFocus")).toBe(true);
      expect(await page.evaluate<boolean>(`(() => {
        const tools = document.querySelector(${scriptValue(tools)});
        return !tools || !tools.contains(document.activeElement);
      })()`)).toBe(true);
      expect(await paperState()).toEqual(paperBeforeReady);
      expect((await readTargets()).map(({ text }) => text)).toEqual([left.text, humanReply, right.text]);

      const viewportSize = () => page.evaluate<[number, number]>("[innerWidth, innerHeight]");
      const launchSize = await viewportSize();
      const resizeWindow = async (width: number, height: number) => {
        await page.evaluate(`window.__oleaflyE2EImport('/src/lib/e2e-probe.ts').then(m => m.resizeCurrentWindow(${width}, ${height}))`);
        await expect.poll(async () => {
          const [actualWidth, actualHeight] = await viewportSize();
          return Math.max(Math.abs(actualWidth - width), Math.abs(actualHeight - height));
        }).toBeLessThanOrEqual(1);
      };
      try {
        await resizeWindow(940, 620);
        await reveal(left.paragraphRef);
        await expect(reviewEntry).toBeVisible();
        await page.evaluate("new Promise(requestAnimationFrame)");
        const beforeReview = await paperState();
        expect(await page.evaluate<boolean>(`(() => {
          const viewport = document.querySelector(${scriptValue(`${surface} .docx-editor__scroll-container`)});
          const entry = document.querySelector(${scriptValue(inlineSelector)});
          if (!viewport || !entry) return false;
          const view = viewport.getBoundingClientRect(), box = entry.getBoundingClientRect();
          return box.left >= view.left - 1 && box.right <= view.right + 1 &&
            box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
        })()`), "The inline review entry must stay inside the 940x620 document viewport").toBe(true);
        await activateInside(`${inlineSelector} button`);
        await expect(documentTools).toHaveAttribute("aria-expanded", "true");
        await expect(reviewHeading).toContainText("Ready to review");
        await expect(reviewHeading).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(accept).toBeFocused();
        expect(await paperState()).toEqual(beforeReview);
        await page.keyboard.press("Escape");
        await expect(documentTools).toBeFocused();
        await expect(review).toBeHidden();
        expect(await paperState()).toEqual(beforeReview);

      } finally {
        await resizeWindow(...launchSize);
      }
      const pages = page.locator(`${surface} .docx-pages`);
      await placeCaret({ ...human, text: humanReply });
      await expect(pages).toBeFocused();
      const editingPosition = await modelSelection(sessionId);
      const beforeShortcut = await paperState();
      await page.keyboard.press("F6");
      await expect(reviewHeading).toBeFocused();
      expect(await paperState()).toEqual(beforeShortcut);
      await page.keyboard.press("Tab");
      await expect(accept).toBeFocused();
      await page.evaluate("document.activeElement.click()");
      await expect.poll(async () => (await readTargets())[0].text).toBe(reviewReply);
      await expect(reviewHeading).toContainText("Applied to this working copy");
      await expect(reviewHeading).toBeFocused();
      const appliedPaper = await paperState();
      await page.keyboard.press("Escape");
      await expect(review).toBeHidden();
      await expect(pages).toBeFocused();
      expect(await modelSelection(sessionId)).toEqual(editingPosition);
      expect(await paperState()).toEqual(appliedPaper);

      const afterAccept = (await readTargets()).map(({ text }) => text);
      expect(afterAccept).toEqual([reviewReply, humanReply, right.text]);
      await clickText(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
      await expect.poll(async () => (await readTargets()).map(({ text }) => text))
        .toEqual([left.text, humanReply, right.text]);
      await clickText(page, '[data-testid="word-formatting-toolbar"]', "Redo (Mod+Shift+Z)");
      await expect.poll(async () => (await readTargets()).map(({ text }) => text)).toEqual(afterAccept);

      const [currentLeft] = await readTargets();
      await beginSuggestion(currentLeft.paragraphRef, staleReply);
      await expect.poll(suggestionTitle).toBe("Generating suggestion");
      await replacePrefix(currentLeft, interruptedPrefix);
      await expect.poll(async () => (await readTargets())[0].text).toBe(interruptedReply);
      release();
      await expect.poll(pendingStatus).toBe("rejected");
      await expect(inline).toHaveCount(0);
      await activateInside('[data-testid="docx-document-tools"]');
      await expect(documentTools).toHaveAttribute("aria-expanded", "true");
      await expect(review).toContainText("Needs a fresh read");
      expect(await page.evaluate<boolean>(`Array.from(document.querySelectorAll('[data-testid="docx-suggestion"] button'))
        .some(button => button.textContent.trim() === 'Accept')`)).toBe(false);
      await activateInside('[data-testid="docx-document-tools"]');
      await expect(review).toBeHidden();
      const settledTexts = (await readTargets()).map(({ text }) => text);
      expect(settledTexts).toEqual([interruptedReply, humanReply, right.text]);
      expect(settledTexts[0]).not.toContain(staleReply);

      const [reviewTarget] = await readTargets();
      await reveal(reviewTarget.paragraphRef);
      await beginSuggestion(reviewTarget.paragraphRef, staleReply);
      await expect(reviewEntry).toBeVisible();
      release();
      await expect.poll(suggestionTitle).toBe("Ready to review");
      await expect.poll(pendingStatus).toBe("fulfilled");
      await page.evaluate(`document.querySelector(${scriptValue(`${inlineSelector} button`)}).focus({ preventScroll: true })`);
      await expect(reviewEntry).toBeFocused();
      const beforeWithdrawal = await paperState();
      const { document } = await readDocx(page, { limit: 1 });
      const replacement = "BACKGROUND";
      const changed = await page.evaluate(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
        m.createDocxAgentTools().replace_docx_text_range.execute(${scriptValue({
          session_id: sessionId, paragraph_ref: reviewTarget.paragraphRef, expected_revision: document.sessionRevision,
          range: { start: 0, end: interruptedPrefix.length }, expected_text: interruptedPrefix, replacement,
        })}))`);
      expect(changed).toMatchObject({ ok: true, changed: true });
      await expect(page.getByTestId("workspace-agent-operation")).toHaveAttribute("data-operation", "replace_range");
      await expect(inline).toHaveCount(0);
      await expect(documentTools).toBeFocused();
      await expect(documentTools).toHaveAttribute("aria-expanded", "false");
      expect(await paperState()).toEqual(beforeWithdrawal);
      expect((await readTargets())[0].text).toBe(replacement + interruptedReply.slice(interruptedPrefix.length));
      try {
        await resizeWindow(940, 620);
        const receipt = page.getByTestId("workspace-agent-operation");
        await expect(receipt).toBeVisible();
        expect(await page.evaluate<boolean>(`(() => {
          const rect = document.querySelector('[data-testid="workspace-agent-operation"]').getBoundingClientRect();
          const viewport = document.querySelector(${scriptValue(`${surface} .docx-editor__scroll-container`)}).getBoundingClientRect();
          return rect.bottom <= viewport.top || rect.top >= viewport.bottom ||
            rect.right <= viewport.left || rect.left >= viewport.right;
        })()`)).toBe(true);
        const followSelector = '[data-testid="workspace-agent-follow"]';
        const follow = page.locator(followSelector);
        await expect(follow).toBeVisible();
        expect(await page.evaluate<boolean>(`(() => {
          const button = document.querySelector(${scriptValue(followSelector)});
          const { x, y, width, height } = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
        })()`)).toBe(true);
        await page.evaluate(`document.querySelector(${scriptValue(followSelector)}).focus({ preventScroll: true })`);
        await expect(follow).toBeFocused();
        await page.evaluate("document.activeElement.click()");
        await expect(receipt).toHaveAttribute("data-follow-state", "following");
        const narrowPaper = await paperState();
        await page.evaluate(`document.querySelector(${scriptValue(followSelector)}).focus({ preventScroll: true })`);
        await expect(follow).toBeFocused();
        await page.evaluate("document.activeElement.click()");
        await expect(receipt).toHaveAttribute("data-follow-state", "paused");
        expect(await paperState()).toEqual(narrowPaper);
      } finally {
        await resizeWindow(...launchSize);
      }
      await clickText(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
      await expect.poll(async () => (await readTargets()).map(({ text }) => text)).toEqual(settledTexts);
      return settledTexts;
    } finally {
      release();
      await server.close();
    }
  };
  const saveAndReopen = async (expectedTexts: string[]) => {
    await clickText(page, workspace, "Save version");
    await expect(page.getByTestId("docx-save-state")).toContainText("All changes saved", { timeout: 60_000 });
    const saved = (await readDocx(page)).document;
    expect(saved.baselineId).not.toBe(opened.baselineId);
    expect(saved.sourceSha256).not.toBe(originalSha);
    await clickText(page, workspace, "Close");
    await expect(page.locator(workspace)).not.toBeVisible();
    await openFile();
    await expect(page.locator(surface)).toBeVisible({ timeout: 60_000 });
    await waitForSession(saved.sourceSha256, opened.sessionId);
    const reopened = (await readDocx(page)).document;
    expect(reopened.sessionId).not.toBe(opened.sessionId);
    expect(reopened).toMatchObject({ baselineId: saved.baselineId, sourceSha256: saved.sourceSha256, dirty: false });
    expect((await readTargets()).map(({ text }) => text)).toEqual(expectedTexts);
  };
  const assertOriginalUnchanged = async () => {
    expect(await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileBase64(${scriptValue(projectId)}, ${scriptValue(file)}))`))
      .toBe(originalBase64);
    if (manuscript) expect(createHash("sha256").update(await readFile(manuscript.path)).digest("hex")).toBe(originalSha);
  };
  const openCitationSource = async (target: DocxParagraph, { start, end }: { start: number; end: number }) => {
    const { sessionId } = (await readDocx(page, { limit: 1 })).document;
    const nodeId = await page.evaluate<string | null>(`window.__oleaflyE2EImport('/src/components/research/DocxWorkspaceDialog.tsx')
      .then(m => m.e2eDocxParagraphNode(${scriptValue(sessionId)}, ${scriptValue(target.paraId)}))`);
    if (!nodeId) throw new Error(`No model paragraph for ${target.paraId}`);
    const selector = `${surface} [data-field-atom="field"][data-start="${start}"][data-end="${end}"]`;
    const findField = `Array.from(document.querySelectorAll(${scriptValue(selector)}))
      .find(item => item.dataset.paragraphId === ${scriptValue(nodeId)})`;
    if (!await page.evaluate<boolean>(`Boolean(${findField})`)) await reveal(target.paragraphRef);
    await page.evaluate(`(() => {
      const field = ${findField};
      if (!field) throw new Error('The saved citation is not painted');
      field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const rect = field.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2, clientY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(clientX, clientY);
      if (!hit || !field.closest('.docx-line').contains(hit)) throw new Error('The saved citation is not under the pointer');
      const options = { bubbles: true, cancelable: true, clientX, clientY, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      hit.dispatchEvent(new PointerEvent('pointerdown', { ...options, buttons: 1 }));
      hit.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
      hit.dispatchEvent(new MouseEvent('click', { ...options, detail: 1 }));
    })()`);
    await expect(page.locator(`${tools} button`),
      `Open citation ${target.paraId}:${start}-${end}`,
    ).toContainText("View citation");
    await clickText(page, tools, "View citation");
    const sources = `${tools}[role="dialog"][aria-label="View citation"] li`;
    await expect(page.locator(sources)).toHaveCount(1);
    return sources;
  };
  const closeCitationSource = async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator(tools)).toHaveCount(0);
  };
  const downloadCopy = async (path: string) => {
    await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(path)})`);
    await clickText(page, workspace, "Download DOCX copy");
    await expect.poll(() => readFile(path).then(bytes => bytes.length).catch(() => 0)).toBeGreaterThan(0);
  };

  if (reimport && manuscript) {
    const verifySources = async () => {
      const [, ...citationTargets] = await readTargets();
      for (const [index, target] of citationTargets.entries()) {
        const { paraId, instruction } = reimport.citations[index];
        expect(target.paraId?.toUpperCase()).toBe(paraId);
        const fields = target.atoms.filter(atom => atom.kind === "field" &&
          (atom.payload as { code?: string } | undefined)?.code?.trim() === instruction.trim());
        expect(fields, `Expected one trial field in ${paraId}`).toHaveLength(1);
        const sources = await openCitationSource(target, fields[0].modelRange);
        await expect(page.locator(`${sources} a`)).toHaveAttribute("href", docxDoiUrl(reimport.doi));
        await closeCitationSource();
      }
    };
    const [body, ...citations] = await readTargets();
    expect(body.atoms).toHaveLength(0);
    expect(body.modelTextTruncated).not.toBe(true);
    expect(body.editableRanges.some(({ start, end }) => start === 0 && end > 0)).toBe(true);
    await verifySources();
    await placeCaret(body);
    const prefix = "LOCAL ";
    await page.evaluate(`document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: ${scriptValue(prefix)}, bubbles: true, cancelable: true
    }))`);
    const bodyText = async () => (await readTargets())[0].text;
    const expected = prefix + body.text;
    await expect.poll(bodyText).toBe(expected);
    await clickText(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
    await expect.poll(bodyText).toBe(body.text);
    await clickText(page, '[data-testid="word-formatting-toolbar"]', "Redo (Mod+Shift+Z)");
    await expect.poll(bodyText).toBe(expected);
    await saveAndReopen([expected, ...citations.map(({ text }) => text)]);
    await verifySources();
    await downloadCopy(reimport.exportPath);
    const evidence = citationPackageEvidence(reimport.python, "--citation-reimport", manuscript.path,
      reimport.exportPath, reimport.doi, manuscript.paragraphs[0], prefix);
    expect(evidence).toMatchObject({ ok: true, issues: [], doi: reimport.doi, sha256: { word: originalSha } });
    const inventory: { paragraphs: { paraId?: string; text: string }[] } = citationPackageEvidence(reimport.python, reimport.exportPath);
    const [exportedBody] = inventory.paragraphs.filter(({ paraId }) => paraId?.toUpperCase() === manuscript.paragraphs[0]);
    expect(exportedBody?.text === expected, "The re-export must contain the edit at the original paragraph ID").toBe(true);
    await assertOriginalUnchanged();
    return;
  }
  const persistedReview = manuscript ? await reviewManuscript() : null;
  if (!citation) {
    await saveAndReopen(persistedReview!);
    await assertOriginalUnchanged();
    return;
  }
  const { doi, exportPath, originalPath, python } = citation;
  if (!manuscript) await writeFile(originalPath, original);
  const openPicker = async (target: DocxParagraph) => {
    const position = await placeCaret(target);
    const before = await layout(position.pageIndex);
    await page.keyboard.press("Shift+F10");
    await expect.poll(() => activeInside(`${tools} button`)).toContain("Insert citation");
    await clickText(page, tools, "Insert citation");
    await expect(page.locator(searchbox)).toBeFocused();
    expect(await layout(position.pageIndex)).toEqual(before);
    return position;
  };
  const pickCrossref = async (query: string) => {
    await page.fill(searchbox, query);
    await expect(page.locator(picker)).toBeVisible();
    await activateInside(`${picker} button[aria-label="Search Crossref"]:not(:disabled)`);
    const selectResult = () => page.evaluate<string | null>(`(() => {
      const root = document.querySelector(${scriptValue(picker)});
      const error = root?.querySelector('[role="alert"]');
      if (error) throw new Error(error.textContent);
      const matches = Array.from(root?.querySelectorAll('section[aria-label="Crossref"] button[aria-describedby]') ?? [])
        .filter(button => document.getElementById(button.getAttribute('aria-describedby'))?.textContent
          .split(' · ').at(-1)?.toLowerCase() === ${scriptValue(doi)});
      if (matches.length > 1) throw new Error('Crossref returned more than one result for the trial DOI');
      const [match] = matches;
      if (!match) return null;
      match.click();
      return match.getAttribute('aria-label');
    })()`);
    let title: string | null = null;
    await expect.poll(async () => Boolean(title = await selectResult()), { timeout: 35_000 }).toBe(true);
    return title!;
  };
  const confirmCitation = async (expectedPlan: string) => {
    await expect(notice).toContainText(expectedPlan);
    await clickText(page, picker, "Insert citation");
    await expect(page.locator(picker)).toHaveCount(0);
  };
  const readCitationTargets = async () => {
    const paragraphs = await readTargets();
    return [paragraphs[0], paragraphs[paragraphs.length - 1]];
  };
  const citationCounts = async () => (await readCitationTargets())
    .map(({ atoms }) => atoms.filter(atom => atom.kind === "field").length);
  const emitMenuHistory = (redo: boolean) => page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: ${scriptValue(redo ? "menu://redo" : "menu://undo")},
      payload: null
    })`,
  );
  const [leftTarget, rightTarget] = await readCitationTargets();
  expect(await citationCounts()).toEqual([0, 0]);
  const originalTargetTexts = (await readTargets()).map(({ text }) => text);
  const bodyPrefix = "UNDO-CONTEXT ";
  await placeCaret(leftTarget);
  await page.evaluate(`document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: ${scriptValue(bodyPrefix)}, bubbles: true, cancelable: true
  }))`);
  const editedTargetTexts = [bodyPrefix + originalTargetTexts[0], ...originalTargetTexts.slice(1)];
  const targetTexts = async () => (await readTargets()).map(({ text }) => text);
  await expect.poll(targetTexts).toEqual(editedTargetTexts);
  const edited = (await readDocx(page)).document;
  await openPicker(leftTarget);
  const searchTerm = "history probe";
  await page.keyboard.insertText(searchTerm);
  await expect(page.locator(searchbox)).toHaveValue(searchTerm);
  for (const redo of [false, true]) {
    await emitMenuHistory(redo);
    await expect(page.locator(searchbox)).toHaveValue(redo ? searchTerm : "");
    await expect(page.locator(searchbox)).toBeFocused();
    expect((await readDocx(page)).document).toMatchObject({
      sessionId: edited.sessionId,
      sessionRevision: edited.sessionRevision,
      dirty: edited.dirty,
    });
    expect(await targetTexts()).toEqual(editedTargetTexts);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(picker)).toHaveCount(0);
  await expect.poll(() => page.evaluate<boolean>(
    `document.activeElement?.matches(${scriptValue(`${surface} .docx-pages`)}) ?? false`,
  )).toBe(true);
  await emitMenuHistory(false);
  await expect.poll(targetTexts).toEqual(originalTargetTexts);
  const leftLayout = await openPicker(leftTarget);
  const title = await pickCrossref(citation.titleQuery ?? doi);
  await confirmCitation("Add document source");
  await expect.poll(citationCounts).toEqual([1, 0]);
  const right = await openPicker(rightTarget);
  expect(right.pageIndex).toBe(leftLayout.pageIndex);
  expect(leftLayout.right, "Left and right paragraph boxes must be in distinct columns").toBeLessThanOrEqual(right.left);
  expect(await pickCrossref(docxDoiUrl(doi))).toBe(title);
  await confirmCitation(`Reuse: ${title}`);
  await expect.poll(citationCounts).toEqual([1, 1]);
  for (const leftCount of [1, 0]) {
    await clickText(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
    await expect.poll(citationCounts).toEqual([leftCount, 0]);
    await openPicker((await readCitationTargets())[1]);
    await page.fill(searchbox, doi);
    const localSources = page.locator(`${picker} section[aria-label="In this document"] button`);
    await expect(localSources).toHaveCount(leftCount);
    if (leftCount) await expect(localSources).toContainText(doi);
    await page.keyboard.press("Escape");
    await expect(page.locator(picker)).toHaveCount(0);
  }
  for (const counts of [[1, 0], [1, 1]]) {
    await clickText(page, '[data-testid="word-formatting-toolbar"]', "Redo (Mod+Shift+Z)");
    await expect.poll(citationCounts).toEqual(counts);
  }
  const savedTargetTexts = (await readTargets()).map(({ text }) => text);
  if (persistedReview) {
    expect(savedTargetTexts[0]).toContain(persistedReview[0]);
    expect(savedTargetTexts[1]).toBe(persistedReview[1]);
    expect(savedTargetTexts[2]).toContain(persistedReview[2]);
  }
  await saveAndReopen(savedTargetTexts);
  await expect.poll(citationCounts).toEqual([1, 1]);
  for (const current of await readCitationTargets()) {
    const [citationField] = current.atoms.filter(atom => atom.kind === "field");
    const sources = await openCitationSource(current, citationField.modelRange);
    await expect(page.locator(sources)).toContainText(title);
    await closeCitationSource();
  }
  await downloadCopy(exportPath);
  const evidence = citationPackageEvidence(python, "--citation-export", originalPath, exportPath, doi,
    ...(manuscript ? [manuscript.paragraphs.join(",")] : []));
  expect(evidence).toMatchObject({ ok: true, issues: [], doi, sha256: { original: originalSha } });
  await assertOriginalUnchanged();
}

test("DOCX chart exports its linked workbook in the desktop workspace", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_MATERIAL_WORKSPACE=1 in an isolated native runner.");
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires the isolated Workbench Python environment.");
  const source = await readFile("services/research-workbench/tests/fixtures/docx/native/s1-native-complex-objects/s1-native-complex-objects.docx");
  const expected = unzipSync(source)["word/embeddings/Workbook1.xlsx"];
  const file = "native-chart.docx";
  await createBlankProject(page, `DOCX chart ${Date.now()}`);
  const projectId = await page.evaluate<string>(`document.querySelector('[data-e2e-project-id]').getAttribute('data-e2e-project-id')`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(${scriptValue(projectId)}, ${scriptValue(file)}, ${scriptValue(source.toString("base64"))}))`);
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`);
  await openRailTab(page, "Explorer");
  await page.locator(`[role="treeitem"][data-path="${file}"]`).click();
  const surface = '[data-testid="docx-editor-surface"]';
  const chart = `${surface} [role="img"][aria-label="RFW-FX-EO-CHART-001"]`;
  const tools = '[data-testid="docx-context-tools"]';
  await expect(page.locator(chart)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("docx-font-state")).toHaveAttribute("data-resolving", "false");
  await expect(page.locator(tools)).toHaveCount(0);
  const view = () => page.evaluate(`(() => {
    const chart = document.querySelector(${scriptValue(chart)});
    const viewport = chart.closest('.docx-editor__scroll-container');
    return { paper: chart.closest('.docx-page').getBoundingClientRect().toJSON(),
      viewport: viewport.getBoundingClientRect().toJSON(), scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft };
  })()`);
  const before = await view();
  const opened = (await readDocx(page)).document;
  await page.evaluate(`(() => {
    const rect = document.querySelector(${scriptValue(chart)}).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2, clientY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(clientX, clientY);
    const options = { bubbles: true, cancelable: true, clientX, clientY, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...options, buttons: 1 }));
    hit.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
    hit.dispatchEvent(new MouseEvent('click', { ...options, detail: 1 }));
  })()`);
  await expect(page.locator(`${tools} button`)).toContainText("Export embedded workbook");
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(`${tools} button:focus`)).toContainText("Export embedded workbook");

  const saveRequests = () => page.evaluate<number>("window.__e2eFileDialogState?.saveRequests ?? 0");
  const requests = await saveRequests();
  await page.evaluate("window.__e2eSetNextSavePath(null)");
  await clickText(page, tools, "Export embedded workbook");
  await expect.poll(saveRequests).toBe(requests + 1);
  await expect(page.locator(`${tools} button:focus`)).toContainText("Export embedded workbook");
  expect(await view()).toEqual(before);

  const path = testInfo.outputPath("chart-workbook.xlsx");
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(path)})`);
  await clickText(page, tools, "Export embedded workbook");
  await expect.poll(saveRequests).toBe(requests + 2);
  await expect.poll(() => readFile(path).then(bytes => bytes.equals(Buffer.from(expected))).catch(() => false)).toBe(true);
  await expect(page.locator(tools)).toHaveCount(0);
  expect(await view()).toEqual(before);
  expect((await readDocx(page)).document).toMatchObject({ sessionRevision: opened.sessionRevision, dirty: false });
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

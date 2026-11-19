import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { live, type Page } from "./word-manuscript-live";
import type { DocxDocumentRead, DocxFormatReadResult } from "../../packages/ai-tools/src/tools";
import { expect } from "../fixtures";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";
import { assertManuscriptInitialExport } from "./word-manuscript-oracle";

const read = live;

async function clickButton(page: Page, root: string, label: string) {
  await page.evaluate(`(() => {
    const button = Array.from(document.querySelector(${scriptValue(root)}).querySelectorAll('button'))
      .find(item => item.textContent.trim() === ${scriptValue(label)} || item.getAttribute('aria-label') === ${scriptValue(label)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('Unavailable Word button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

async function chooseView(page: Page, label: string) {
  await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="docx-workspace"] [aria-label="Display"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('Word display control is unavailable.');
    button.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true}));
  })()`);
  await expect.poll(() => page.evaluate<boolean>(
    `Array.from(document.querySelectorAll('[role="option"]')).some(item => item.textContent.trim() === ${scriptValue(label)})`,
  )).toBe(true);
  await page.evaluate(`Array.from(document.querySelectorAll('[role="option"]'))
    .find(item => item.textContent.trim() === ${scriptValue(label)})
    .dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}))`);
}

async function download(page: Page, path: string) {
  await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(path)})`);
  await clickButton(page, '[data-testid="docx-workspace"]', "Download DOCX copy");
  await expect.poll(async () => readFile(path).then(bytes => bytes.length, () => 0), { timeout: 60_000 }).toBeGreaterThan(0);
  return readFile(path);
}

interface NavigationEvidence {
  capturedAt: string;
  revealErrors: { text: string; title: string }[];
  targetStartVisible: boolean;
  targetHitMatches: boolean;
  targetHighlighted: boolean;
  highlightCount: number;
}

async function navigationEvidence(page: Page, paintedNodeId: string): Promise<NavigationEvidence> {
  return page.evaluate<NavigationEvidence>(`Promise.all([
    window.__oleaflyE2EImport('/src/store/agent-workspace.ts'),
    window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts')
  ]).then(([agent,host]) => {
    const state = agent.useAgentWorkspaceStore.getState();
    const center = document.querySelector('[data-testid="workspace-center"]');
    const surface = center?.querySelector('[data-testid="docx-editor-surface"]');
    const rectOf = node => {
      const rect = node.getBoundingClientRect();
      return {x:rect.x,y:rect.y,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};
    };
    const describe = node => {
      const style = getComputedStyle(node);
      return {tag:node.tagName,class:node.className,rect:rectOf(node),display:style.display,
        visibility:style.visibility,opacity:style.opacity,clientWidth:node.clientWidth,clientHeight:node.clientHeight,
        scrollTop:node.scrollTop,scrollLeft:node.scrollLeft,scrollHeight:node.scrollHeight,
        hiddenAncestor:node.closest('[hidden],[aria-hidden="true"]')?.getAttribute('data-word-surface-layer') ?? null,
        page:node.closest('[data-page-index]')?.getAttribute('data-page-index') ?? null};
    };
    const fragments = Array.from(surface?.querySelectorAll('.docx-paragraph-fragment[data-paragraph-id]') ?? [])
      .filter(node => node.getAttribute('data-paragraph-id') === ${scriptValue(paintedNodeId)});
    const starts = fragments.flatMap(fragment => Array.from(fragment.querySelectorAll('.layout-run-text[data-start]'))
      .map(run => ({fragment,run,start:Number(run.getAttribute('data-start'))}))).sort((a,b) => a.start-b.start);
    const first = starts[0];
    const scroller = first?.fragment.closest('.docx-editor__scroll-container')
      ?? surface?.querySelector('.docx-editor__scroll-container');
    let startRect = null;
    if (first) {
      const text = document.createTreeWalker(first.run,NodeFilter.SHOW_TEXT).nextNode();
      if (text?.textContent.length) {
        const range = document.createRange();
        range.setStart(text,0);
        range.setEnd(text,1);
        startRect = rectOf(range);
      }
    }
    const scrollRect = scroller ? rectOf(scroller) : null;
    const point = startRect ? {x:(startRect.left+startRect.right)/2,y:(startRect.top+startRect.bottom)/2} : null;
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return !node.closest('[hidden]') && style.visibility === 'visible' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const targetStartVisible = !!(first && startRect?.width > 0 && startRect.height > 0 && point && scrollRect
      && visible(first.fragment) && point.x > Math.max(0,scrollRect.left) && point.x < Math.min(innerWidth,scrollRect.right)
      && point.y > Math.max(0,scrollRect.top) && point.y < Math.min(innerHeight,scrollRect.bottom));
    const hit = targetStartVisible ? document.elementFromPoint(point.x,point.y) : null;
    const highlights = Array.from(surface?.querySelectorAll('[data-docx-anchor-highlight]') ?? []);
    const targetHighlighted = !!(first && point && highlights.some(node => {
      const rect = node.getBoundingClientRect();
      return visible(node) && node.closest('[data-page-index]') === first.fragment.closest('[data-page-index]')
        && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }));
    return {capturedAt:new Date().toISOString(),revealErrors:Array.from(center?.children ?? [])
      .filter(node => node.matches('p[role="status"][title]'))
      .map(node => ({text:node.textContent,title:node.getAttribute('title')})),
      navigation:state.navigation,latestTarget:state.latestTarget,following:state.following,paused:state.paused,
      context:host.getDocxWorkspaceContext(),viewport:{width:innerWidth,height:innerHeight},
      font:surface?.closest('[data-testid="docx-workspace"]')?.querySelector('[data-testid="docx-font-state"]')?.outerHTML ?? null,
      wordSurface:surface?.closest('[data-word-surface-layer]')?.getAttribute('data-foreground') ?? null,
      surface:surface ? describe(surface) : null,scroller:scroller ? describe(scroller) : null,
      fragments:fragments.map(node => ({...describe(node),text:Array.from(node.querySelectorAll('.layout-run-text[data-start]')).map(run => run.textContent).join('')})),
      startRect,targetStartVisible,targetHitMatches:!!(hit && first.fragment.contains(hit)),targetHighlighted,
      highlightCount:highlights.length,highlights:highlights.map(describe)};
  })`);
}

export async function runWordManuscriptTakeover(
  page: Page,
  { projectId, outputDirectory, diagnoseNavigationFailure = false }: {
    projectId: string;
    outputDirectory: string;
    diagnoseNavigationFailure?: boolean;
  },
): Promise<Record<string, unknown>> {
  const runId = `manuscript-takeover-${randomUUID()}`;
  const marker = `TAKEOVER-${randomUUID()} `;
  const feedback = `[data-testid="workspace-agent-operation"][data-flow-key="external:${runId}"]`;
  const report: Record<string, unknown> = {
    outcome: "RUNNING", runId,
    scope: "Deterministic real-manuscript business operations before the live task. Probe edits are discarded before the model session is bound. Input uses the editor contenteditable. This probe does not call or assess a model.",
  };
  const before = await read(page);
  expect(before.document.appProjectId).toBe(projectId);
  expect(before.document.dirty).toBe(false);
  let paintedTarget: { paragraphRef: string; paintedNodeId: string } | null = null;
  await expect.poll(async () => {
    paintedTarget = await page.evaluate<{ paragraphRef: string; paintedNodeId: string } | null>(`(() => {
      const paragraphs = ${scriptValue(before.paragraphs)};
      const painted = Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment[data-paragraph-id]'))
        .filter(item => item.isContentEditable && getComputedStyle(item).visibility === 'visible')
        .filter(item => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
        .filter(item => Array.from(item.querySelectorAll('.layout-run-text[data-start]')).some(run => run.isContentEditable))
        .map(item => ({paintedNodeId:item.getAttribute('data-paragraph-id'),
          text:Array.from(item.querySelectorAll('.layout-run-text[data-start]')).map(run => run.textContent).join('')}));
      for (const paragraph of paragraphs) {
        if (!paragraph.paraId || !paragraph.text.trim() || paragraphs.filter(item => item.text === paragraph.text).length !== 1) continue;
        const matches = painted.filter(item => item.text === paragraph.text);
        if (matches.length === 1) return {paragraphRef:paragraph.paragraphRef,paintedNodeId:matches[0].paintedNodeId};
      }
      return null;
    })()`);
    return paintedTarget !== null;
  }, { timeout: 30_000, message: "A writable painted paragraph must map uniquely to the live read." }).toBe(true);
  const target = before.paragraphs.find(paragraph => paragraph.paragraphRef === paintedTarget!.paragraphRef)!;
  report.target = target;
  report.paintedTarget = paintedTarget;
  const navigationSamples: { stage: string; evidence: NavigationEvidence }[] = [];
  const captureNavigation = async (stage: string) => {
    const evidence = await navigationEvidence(page, paintedTarget!.paintedNodeId);
    navigationSamples.push({ stage, evidence });
    return evidence;
  };
  const navigationDiagnosticPath = resolve(outputDirectory, "word-manuscript-takeover-navigation.json");
  const writeNavigationDiagnostic = () => writeFile(navigationDiagnosticPath, JSON.stringify({
    runId, target, paintedTarget, samples: navigationSamples,
  }, null, 2));
  let awaitingResumeNavigation = false;
  const format = () => page.evaluate<DocxFormatReadResult>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readFormat(
      ${scriptValue(before.document.sessionId)}, {paragraphRef:${scriptValue(target!.paragraphRef)}}))`,
  );
  const initialFormat = await format();
  const initialSize = initialFormat.paragraph?.font.size;
  expect(typeof initialSize).toBe("number");
  if (typeof initialSize !== "number") throw new Error("The takeover target needs a definite font size.");
  const firstSize = initialSize + 0.5;
  const lastSize = initialSize + 1;
  const apply = async (size: number) => {
    const current = await read(page);
    const result = await page.evaluate<{ ok: boolean; changed: boolean }>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.createDocxAgentTools({runId:()=>${scriptValue(runId)}})
        .apply_docx_format.execute(${scriptValue({
          session_id: before.document.sessionId, paragraph_ref: target!.paragraphRef,
          expected_revision: current.document.sessionRevision, font: { size },
        })}))`,
    );
    expect(result).toMatchObject({ ok: true, changed: true });
    return result;
  };
  const sameSession = (value: DocxDocumentRead) => {
    expect(value.document.sessionId).toBe(before.document.sessionId);
    expect(value.document.baselineId).toBe(before.document.baselineId);
    expect(value.document.sourceSha256).toBe(before.document.sourceSha256);
  };
  const undo = async () => {
    const revision = (await read(page)).document.sessionRevision;
    await clickButton(page, '[data-testid="word-formatting-toolbar"]', "Undo (Mod+Z)");
    await expect.poll(() => read(page).then(value => value.document.sessionRevision)).toBeGreaterThan(revision);
  };
  await page.evaluate(`window.__oleaflyE2EImport('/src/store/docx-workspace.ts').then(m => {
    window.__wholeManuscriptTakeoverRequest = m.useDocxWorkspaceStore.getState().request;
  })`);
  try {
    report.before = before.document;
    const initialBytes = await download(page, resolve(outputDirectory, "takeover-before.docx"));
    await page.evaluate(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m =>
      m.useAgentWorkspaceStore.getState().beginFollow(${scriptValue(projectId)}, {kind:'external',flowId:${scriptValue(runId)}}))`);
    report.firstFormat = await apply(firstSize);
    await expect(page.locator(feedback)).toHaveAttribute("data-phase", "succeeded");
    await expect(page.locator(feedback)).toHaveAttribute("data-session-id", before.document.sessionId);
    await expect(page.locator(feedback)).toHaveAttribute("data-follow-state", "following");
    await expect(page.getByTestId("docx-editor-surface")).toBeVisible();

    // The painter uses canonical node IDs; readDocument's paraId is the distinct w14:paraId.
    const renderedTarget = `Array.from(document.querySelectorAll('[data-testid="docx-editor-surface"] .docx-paragraph-fragment[data-paragraph-id]'))
      .filter(item => item.getAttribute('data-paragraph-id') === ${scriptValue(paintedTarget!.paintedNodeId)} && item.isContentEditable)
      .filter(item => Array.from(item.querySelectorAll('.layout-run-text[data-start]'))
        .map(run => run.textContent).join('') === ${scriptValue(target!.text)})
      .filter(item => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })`;
    try {
      await expect.poll(() => page.evaluate<number>(`(${renderedTarget}).length`), {
        timeout: 30_000,
        message: "The exact takeover paragraph must be painted once before manual input.",
      }).toBe(1);
    } catch (cause) {
      const diagnostic = await page.evaluate(`(() => {
        const surface = document.querySelector('[data-testid="docx-editor-surface"]');
        const describe = node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {tag:node.tagName, class:node.getAttribute('class'),
            attributes:Object.fromEntries(Array.from(node.attributes).map(item => [item.name,item.value])),
            text:node.textContent.slice(0,600), rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
            display:style.display, visibility:style.visibility, opacity:style.opacity,
            isContentEditable:node.isContentEditable,
            hiddenAncestor:node.closest('[hidden],[aria-hidden="true"]')?.outerHTML.slice(0,600) ?? null,
            intersectsViewport:rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight};
        };
        const fragments = Array.from(surface?.querySelectorAll('.docx-paragraph-fragment') ?? []);
        const addressed = Array.from(surface?.querySelectorAll('[data-paragraph-id]') ?? []);
        const textRuns = Array.from(surface?.querySelectorAll('.layout-run-text') ?? []);
        const layoutClasses = {};
        for (const node of surface?.querySelectorAll('[class]') ?? []) for (const name of node.classList) {
          if (/layout|paragraph|text|frame|page/.test(name)) layoutClasses[name] = (layoutClasses[name] ?? 0) + 1;
        }
        return {capturedAt:new Date().toISOString(), target:${scriptValue(target)},
          exactRenderedMatches:(${renderedTarget}).length,
          surface:surface ? describe(surface) : null,
          ancestors:surface ? Array.from((function*(){for(let node=surface.parentElement;node;node=node.parentElement)yield node;})()).map(describe) : [],
          surfaceHtmlPrefix:surface?.outerHTML.slice(0,160000) ?? null,
          counts:{fragments:fragments.length,addressed:addressed.length,textRuns:textRuns.length}, layoutClasses,
          fragments:fragments.slice(0,64).map(node => ({...describe(node),
            layoutText:Array.from(node.querySelectorAll('.layout-run-text')).map(run => run.textContent).join(''),
            addressedLayoutText:Array.from(node.querySelectorAll('.layout-run-text[data-start]')).map(run => run.textContent).join(''),
            htmlPrefix:node.outerHTML.slice(0,4000)})),
          addressedNodes:addressed.slice(0,96).map(describe),
          textRuns:textRuns.slice(0,64).map(describe),
          targetTextNodes:surface ? Array.from(surface.querySelectorAll('*')).filter(node =>
            node.children.length === 0 && node.textContent.includes(${scriptValue(target!.text.slice(0,40))}))
            .slice(0,16).map(describe) : []};
      })()`);
      const path = resolve(outputDirectory, "word-manuscript-takeover-dom.json");
      await writeFile(path, JSON.stringify(diagnostic, null, 2));
      report.domDiagnostic = { path, capturedBeforeCleanup: true };
      throw cause;
    }
    report.manualTarget = await page.evaluate(`(async () => {
      const paragraph = (${renderedTarget})[0];
      paragraph.scrollIntoView({block:'center'});
      await new Promise(resolve => requestAnimationFrame(resolve));
      const run = paragraph.querySelector('.layout-run-text[data-start]');
      const rect = run.getBoundingClientRect();
      const clientX = rect.left + Math.min(4, rect.width / 2), clientY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(clientX,clientY);
      if (!paragraph.contains(hit)) throw new Error('The takeover paragraph is not available for hit-testing.');
      const options = {bubbles:true,cancelable:true,clientX,clientY,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true};
      hit.dispatchEvent(new PointerEvent('pointerdown', options));
      hit.dispatchEvent(new MouseEvent('mousedown', options));
      hit.dispatchEvent(new PointerEvent('pointerup', {...options,buttons:0}));
      hit.dispatchEvent(new MouseEvent('mouseup', {...options,buttons:0}));
      hit.dispatchEvent(new MouseEvent('click', {...options,buttons:0}));
      return {paragraphRef:${scriptValue(target!.paragraphRef)}, paraId:${scriptValue(target!.paraId)},
        paintedNodeId:paragraph.getAttribute('data-paragraph-id'), text:${scriptValue(target!.text)}};
    })()`);
    expect(await page.evaluate<boolean>(`new Promise(resolve => requestAnimationFrame(() => {
      resolve(document.execCommand('insertText', false, ${scriptValue(marker)}));
    }))`), "Word refused manual text input.").toBe(true);
    await expect.poll(() => read(page).then(value => value.paragraphs
      .find(paragraph => paragraph.paragraphRef === target!.paragraphRef)?.text.includes(marker))).toBe(true);
    const afterInput = await read(page);
    sameSession(afterInput);
    expect(afterInput.document.dirty).toBe(true);
    await expect(page.locator(feedback)).toHaveAttribute("data-follow-state", "paused");
    report.afterManualInput = afterInput.document;
    const pausedNavigation = await page.evaluate(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m => m.useAgentWorkspaceStore.getState().navigation)`);

    await chooseView(page, "Version before this session");
    await expect(page.getByTestId("docx-original-surface")).toBeVisible();
    await expect(page.getByTestId("docx-editor-surface")).toBeHidden();
    const originalContext = await page.evaluate<{ viewed: { role: string }; selectionWriteTarget: unknown }>(
      `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.getDocxWorkspaceContext())`,
    );
    expect(originalContext.viewed.role).toBe("original");
    expect(originalContext.selectionWriteTarget).toBeNull();
    report.backgroundFormat = await apply(lastSize);
    await expect(page.locator(feedback)).toHaveAttribute("data-follow-state", "paused");
    await expect(page.getByTestId("docx-original-surface")).toBeVisible();
    await expect(page.getByTestId("docx-editor-surface")).toBeHidden();
    expect(await page.evaluate(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m => m.useAgentWorkspaceStore.getState().navigation)`)).toEqual(pausedNavigation);
    const whilePaused = await read(page);
    sameSession(whilePaused);
    expect(whilePaused.paragraphs.some(paragraph => paragraph.text.includes(marker))).toBe(true);
    expect((await format()).paragraph?.font.size).toBe(lastSize);
    await webviewScreenshot(page, resolve(outputDirectory, "takeover-paused.png"));

    await expect.poll(() => page.evaluate<number>(
      `document.querySelectorAll('[data-testid="docx-editor-surface"] [data-docx-anchor-highlight]').length`,
    ), { timeout: 10_000, message: "The old highlight must expire while paused before testing the separate resume navigation." }).toBe(0);
    expect((await captureNavigation("before-resume")).highlightCount).toBe(0);
    awaitingResumeNavigation = true;
    await page.getByTestId("workspace-agent-follow").click();
    await expect(page.locator(feedback)).toHaveAttribute("data-follow-state", "following");
    await expect(page.getByTestId("docx-editor-surface")).toBeVisible();
    await expect(page.getByTestId("docx-original-surface")).toBeHidden();
    const navigationDeadline = Date.now() + 30_000;
    let located = false;
    let previousLocated = false;
    while (Date.now() < navigationDeadline) {
      const evidence = await captureNavigation("awaiting-resume-navigation");
      if (evidence.revealErrors.length) {
        throw new Error(`Word resume navigation failed: ${evidence.revealErrors.map(error => error.title).join("; ")}`);
      }
      const currentLocated = evidence.targetStartVisible && evidence.targetHitMatches && evidence.targetHighlighted;
      if (currentLocated && previousLocated) {
        located = true;
        break;
      }
      previousLocated = currentLocated;
      await delay(100);
    }
    expect(located, "Resume must reveal and freshly highlight the exact target without a navigation error. See word-manuscript-takeover-navigation.json.").toBe(true);
    const afterResume = await read(page);
    sameSession(afterResume);
    expect(afterResume.paragraphs).toEqual(whilePaused.paragraphs);
    expect(await page.evaluate(`window.__oleaflyE2EImport('/src/store/agent-workspace.ts').then(m => {
      const state = m.useAgentWorkspaceStore.getState();
      return {navigation:state.navigation,latestTarget:state.latestTarget};
    })`)).toMatchObject({
      navigation: { flowKey: `external:${runId}`, target: { sessionId: before.document.sessionId, sessionRevision: afterResume.document.sessionRevision, paragraphRef: target!.paragraphRef } },
      latestTarget: { flowKey: `external:${runId}`, target: { sessionId: before.document.sessionId, sessionRevision: afterResume.document.sessionRevision, paragraphRef: target!.paragraphRef } },
    });
    report.afterResume = afterResume.document;
    const completedNavigation = await captureNavigation("resume-navigation-complete");
    expect(completedNavigation.revealErrors, "Resume navigation must remain free of a reveal exception.").toEqual([]);
    expect(completedNavigation.targetStartVisible && completedNavigation.targetHitMatches).toBe(true);
    report.navigationDiagnostic = { path: navigationDiagnosticPath, located: true, capturedBeforeCleanup: true };
    await writeNavigationDiagnostic();
    await webviewScreenshot(page, resolve(outputDirectory, "takeover-resumed.png"));
    awaitingResumeNavigation = false;

    await undo();
    expect((await format()).paragraph?.font.size).toBe(firstSize);
    expect((await read(page)).paragraphs.some(paragraph => paragraph.text.includes(marker))).toBe(true);
    await undo();
    expect((await read(page)).paragraphs.some(paragraph => paragraph.text.includes(marker))).toBe(false);
    expect((await format()).paragraph?.font.size).toBe(firstSize);
    await undo();
    expect((await format()).paragraph?.font.size).toBe(initialSize);
    const undone = await read(page);
    sameSession(undone);
    expect(undone.document.dirty).toBe(true);
    expect(undone.paragraphs).toEqual(before.paragraphs);
    report.afterOrderedUndo = undone.document;
    const undoneBytes = await download(page, resolve(outputDirectory, "takeover-undone.docx"));
    report.undoXml = assertManuscriptInitialExport(initialBytes, undoneBytes);
    report.outcome = "PASSED";
  } catch (cause) {
    report.outcome = "FAILED";
    report.failure = String(cause);
    try {
      await captureNavigation("failure-before-cleanup");
    } catch (diagnosticFailure) {
      report.navigationCaptureFailure = String(diagnosticFailure);
    }
    try {
      await writeNavigationDiagnostic();
      const screenshotPath = resolve(outputDirectory, "takeover-navigation-failed.png");
      report.navigationDiagnostic = { path: navigationDiagnosticPath, screenshotPath, capturedBeforeCleanup: true };
      await webviewScreenshot(page, screenshotPath);
    } catch (diagnosticFailure) {
      report.navigationDiagnosticFailure = String(diagnosticFailure);
    }
    if (diagnoseNavigationFailure && awaitingResumeNavigation) {
      try {
        report.navigationReplay = await page.evaluate(`Promise.all([
          window.__oleaflyE2EImport('/src/store/agent-workspace.ts'),
          window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts')
        ]).then(async ([agent,host]) => {
          const target = agent.useAgentWorkspaceStore.getState().navigation?.target;
          if (!target) throw new Error('No failed navigation target is available for the diagnostic replay.');
          try {
            await host.revealDocxWorkspaceTarget(target);
            return {scope:'Single direct replay after the resume has already failed. This cannot change the failed outcome.',target,outcome:'resolved'};
          } catch (error) {
            return {scope:'Single direct replay after the resume has already failed. This cannot change the failed outcome.',target,outcome:'rejected',
              error:{name:error.name,message:error.message,stack:error.stack,string:String(error)}};
          }
        })`);
        await captureNavigation("after-failed-navigation-replay");
        await writeNavigationDiagnostic();
      } catch (replayFailure) {
        report.navigationReplayFailure = String(replayFailure);
      }
    }
    throw cause;
  } finally {
    try {
      const hasProbeRevision = (await read(page)).document.dirty;
      await clickButton(page, '[data-testid="docx-workspace"]', "Close");
      if (hasProbeRevision) {
        await expect(page.locator('[role="dialog"]')).toHaveCount(1);
        await clickButton(page, '[role="dialog"]', "Close and discard unsaved changes");
      }
      await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
      await page.evaluate(`Promise.all([
        window.__oleaflyE2EImport('/src/store/docx-workspace.ts'),
        window.__oleaflyE2EImport('/src/store/agent-workspace.ts')
      ]).then(([word,agent]) => {
        agent.useAgentWorkspaceStore.setState(state => ({following:null,paused:false,latestTarget:null,navigation:null,intentRevision:state.intentRevision+1}));
        word.useDocxWorkspaceStore.getState().open(window.__wholeManuscriptTakeoverRequest);
        delete window.__wholeManuscriptTakeoverRequest;
      })`);
      await expect.poll(() => read(page).then(value => value.document.sourceSha256, () => null), { timeout: 120_000 }).toBe(before.document.sourceSha256);
      const reopened = await read(page);
      expect(reopened.document).toMatchObject({ baselineId: before.document.baselineId, sourceSha256: before.document.sourceSha256, dirty: false });
      expect(reopened.paragraphs.map(paragraph => paragraph.text)).toEqual(before.paragraphs.map(paragraph => paragraph.text));
      report.cleanup = { discardedProbeRevisions: true, savedSourceUnchanged: true, reopened: reopened.document };
    } catch (cause) {
      report.outcome = "FAILED";
      report.cleanupFailure = String(cause);
      throw cause;
    } finally {
      await writeFile(resolve(outputDirectory, "word-manuscript-takeover.json"), JSON.stringify(report, null, 2));
    }
  }
  return report;
}

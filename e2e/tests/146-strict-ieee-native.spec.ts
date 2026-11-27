import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TauriPage } from "@srsholmes/tauri-playwright";
import { unzipSync } from "fflate";
import type { DocxDocumentRead, DocxNodeAddress } from "../../packages/ai-tools/src/tools";
import type {
  JournalBinding,
  JournalProject,
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import type { ResearchWorkspace } from "../../src/lib/research-workspace";
import { expect, test } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import {
  STRICT_WORD_NAMESPACE,
  TRANSITIONAL_WORD_NAMESPACE,
  strictIeeePackageFacts,
} from "../helpers/strict-ieee-package";
import { journalRequest, runJournalCheck } from "../helpers/word-manuscript-live";
import { scriptValue } from "../script-value";
import { webviewScreenshot } from "../webview-screenshot";

const enabled = process.env.OLEAFLY_STRICT_IEEE_NATIVE === "1";
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const a4ZipEntry = "Word-Letter-A4/conference-template-a4.docx";
const letterZipEntry = "Word-Letter-A4/conference-template-letter.docx";
const defaultFixtureRoot = resolve(".private/strict-ieee");
const fixturePaths = {
  a4: resolve(
    process.env.OLEAFLY_STRICT_IEEE_A4 ??
      join(defaultFixtureRoot, "conference-template-a4.docx"),
  ),
  zip: resolve(
    process.env.OLEAFLY_STRICT_IEEE_ZIP ??
      join(defaultFixtureRoot, "Word-Letter-A4.zip"),
  ),
};

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

interface JournalManuscript {
  baseline: {
    baseline_id: string;
    source_sha256: string;
    artifact_version_ids: string[];
  };
}

interface JournalSource {
  project_id: string;
  baseline_id: string;
  source_sha256: string;
  content_base64: string;
}

interface SnapshotIdentity {
  source_sha256: string;
  snapshot: {
    source_sha256: string;
    method_version: string;
  };
  total: number;
}

interface LocatedFinding {
  node_address?: DocxNodeAddress;
}

interface NodeQuery {
  source_sha256: string;
  total: number;
  nodes: {
    node_address: DocxNodeAddress;
    namespace_uri: string;
    local_name: string;
  }[];
}

type DocumentTarget = { world_version_id: string } | { project_id: string; baseline_id: string };

async function waitForWorld(page: TauriPage, journalName: string): Promise<JournalWorld> {
  let versionId: string | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    versionId = state.worlds.find((world) => world.journal_name === journalName)?.version_id;
    return Boolean(versionId);
  }, { timeout: 180_000 }).toBe(true);
  return journalRequest<JournalWorld>(
    page,
    `/api/world?version_id=${encodeURIComponent(versionId!)}`,
  );
}

async function workbenchProject(
  page: TauriPage,
  projectId: string,
): Promise<JournalProject | undefined> {
  const state = await journalRequest<JournalState>(page, "/api/state");
  return state.projects.find((project) => project.project_id === projectId);
}

async function workbenchManuscript(
  page: TauriPage,
  projectId: string,
): Promise<JournalManuscript> {
  const query = new URLSearchParams({ project_id: projectId, baseline_id: "current" });
  return journalRequest<JournalManuscript>(page, `/api/manuscript?${query}`);
}

async function retainedSource(
  page: TauriPage,
  projectId: string,
  baselineId: string,
): Promise<JournalSource> {
  const query = new URLSearchParams({ project_id: projectId, baseline_id: baselineId });
  return journalRequest<JournalSource>(page, `/api/manuscript-source?${query}`);
}

function retainedSnapshot(page: TauriPage, target: DocumentTarget) {
  return journalRequest<SnapshotIdentity>(page, "/api/docx-query", {
    operation: "snapshot", target, limit: 20,
  });
}

function retainedNode(page: TauriPage, target: DocumentTarget, nodeAddress: DocxNodeAddress) {
  return journalRequest<NodeQuery>(page, "/api/docx-query", {
    operation: "nodes", target, node_address: nodeAddress, limit: 1,
  });
}

async function importTemplateThroughUi(
  page: TauriPage,
  bytes: Uint8Array,
  filename: string,
  journalName: string,
): Promise<JournalWorld> {
  await openRailTab(page, "Journal checks");
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Use Word as template", { exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await panel.getByText("Use Word as template", { exact: true }).click();
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  await expect(dialog).toBeVisible();
  await page.setInputFiles('[role="dialog"][data-state="open"] input[type="file"]', [{
    name: filename,
    mimeType: docxMime,
    buffer: Buffer.from(bytes),
  }]);
  await page.fill('[role="dialog"][data-state="open"] input[id$="-name"]', journalName);
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0, {
    timeout: 180_000,
  });
  return waitForWorld(page, journalName);
}

async function readDocument(page: TauriPage): Promise<DocxDocumentRead> {
  let result: DocxDocumentRead | undefined;
  await expect.poll(async () => {
    try {
      result = await page.evaluate<DocxDocumentRead>(
        `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
      );
      return result.paragraphs.length > 0;
    } catch {
      return false;
    }
  }, { timeout: 120_000 }).toBe(true);
  return result!;
}

async function expectTemplateRefreshPreservesOpenDocument(
  page: TauriPage,
  projectId: string,
  binding: JournalBinding | null,
  before: DocxDocumentRead["document"],
  world: JournalWorld,
) {
  await expect(page.locator('[data-testid="journal-world-select"]')).toHaveValue(
    world.version_id,
    { timeout: 120_000 },
  );
  const after = await readDocument(page);
  expect(after.document.sessionId).toBe(before.sessionId);
  expect(after.document.sessionRevision).toBe(before.sessionRevision);
  expect(after.document.baselineId).toBe(before.baselineId);
  expect(after.document.sourceSha256).toBe(before.sourceSha256);
  expect(after.document.dirty).toBe(false);
  const project = await workbenchProject(page, projectId);
  expect(project?.binding).toEqual(binding);
  const returnToDocument = page.getByTestId("journal-checks-panel")
    .getByText("Return to document", { exact: true });
  await expect(returnToDocument).toBeEnabled({ timeout: 90_000 });
  await returnToDocument.click();
  await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("docx-template-status")).toContainText(world.journal_name, {
    timeout: 120_000,
  });
  await expect(page.getByTestId("docx-start-format-candidate")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId("docx-start-format-candidate")).toBeEnabled({
    timeout: 120_000,
  });
  await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(0);
  await page.evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  const sameRoot = await page.evaluate<boolean>(
    `window.__strictIeeeWordRoot === document.querySelector('[data-testid="docx-workspace"]')`,
  );
  expect(sameRoot, "Importing a template must not remount the open Word workspace.").toBe(true);
  return { after: after.document, project };
}

test("Strict IEEE OOXML opens through the file tree and refreshes Word without rebinding", async ({
  tauriPage: page,
}) => {
  test.skip(!enabled, "Set OLEAFLY_STRICT_IEEE_NATIVE=1 to run the native Strict IEEE acceptance.");
  test.setTimeout(900_000);

  const evidenceParent = resolve(
    process.env.OLEAFLY_STRICT_IEEE_OUTPUT ?? ".private/strict-ieee-native",
  );
  await mkdir(evidenceParent, { recursive: true });
  const evidence = await mkdtemp(join(evidenceParent, "run-"));
  const report: Record<string, unknown> = {
    outcome: "RUNNING",
    evidence,
    fixturePaths,
    stages: [] as Record<string, unknown>[],
    scope:
      "Native macOS UI, IEEE Strict A4 opened through the file tree, A4 and Letter template imports into the open session, and a retained Workbench comparison with exact node lookup. No format candidate or Word/WPS layout comparison.",
  };
  const stages = report.stages as Record<string, unknown>[];
  let failure: unknown;
  let stage = "reading fixture bytes";
  let beforeHashes: Record<string, string> = {};

  try {
    const [a4Bytes, zipBytes] = await Promise.all([
      readFile(fixturePaths.a4),
      readFile(fixturePaths.zip),
    ]);
    beforeHashes = {
      a4: digest(a4Bytes),
      zip: digest(zipBytes),
    };
    const zipParts = unzipSync(zipBytes);
    const a4FromZip = zipParts[a4ZipEntry];
    const letterBytes = zipParts[letterZipEntry];
    expect(a4FromZip, `${a4ZipEntry} must exist in the untouched IEEE template zip.`).toBeTruthy();
    expect(letterBytes, `${letterZipEntry} must exist in the untouched IEEE template zip.`).toBeTruthy();
    expect(digest(a4Bytes)).toBe(digest(a4FromZip!));

    const a4Facts = strictIeeePackageFacts(a4Bytes);
    const letterFacts = strictIeeePackageFacts(letterBytes!);
    expect(a4Facts, "The A4 IEEE template must be Strict OOXML.").toMatchObject({
      strict: true,
      namespace: STRICT_WORD_NAMESPACE,
      mainContentType: true,
    });
    expect(letterFacts, "The Letter IEEE template must be Strict OOXML.").toMatchObject({
      strict: true,
      namespace: STRICT_WORD_NAMESPACE,
      mainContentType: true,
    });
    report.fixtures = {
      a4: { path: fixturePaths.a4, sha256: beforeHashes.a4, ...a4Facts },
      letter: {
        zipPath: fixturePaths.zip,
        entry: letterZipEntry,
        sha256: digest(letterBytes!),
        ...letterFacts,
      },
    };
    stages.push({ stage, beforeHashes, fixtures: report.fixtures });

    await page.evaluate(
      `window.__oleaflyE2EImport('/src/store/settings.ts').then(({ useSettingsStore }) =>
        useSettingsStore.getState().setUiLocalePreference("en"))`,
    );
    await page.waitForFunction('document.documentElement.lang === "en"', 10_000);

    stage = "opening the untouched Strict A4 template through the native file tree";
    await createBlankProject(page, `Strict IEEE native ${Date.now()}`);
    const appProjectId = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`,
    );
    expect(appProjectId).toBeTruthy();
    const strictPath = "ieee-template-a4.docx";
    await page.evaluate(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.saveFileBase64(
        ${scriptValue(appProjectId)},
        ${scriptValue(strictPath)},
        ${scriptValue(a4Bytes.toString("base64"))}
      ))`,
    );
    await page.evaluate(
      `window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().refreshTree())`,
    );
    await openRailTab(page, "Explorer");
    await page.locator(`[role="treeitem"][data-path="${strictPath}"]`).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const openedDocument = await readDocument(page);
    expect(openedDocument.document.dirty).toBe(false);
    await expect(page.getByTestId("docx-start-format-candidate")).toHaveCount(0);
    const rootToken = await page.evaluate<boolean>(`(() => {
      const root = document.querySelector('[data-testid="docx-workspace"]');
      window.__strictIeeeWordRoot = root;
      return Boolean(root);
    })()`);
    expect(rootToken).toBe(true);
    const workspace = await page.evaluate<ResearchWorkspace>(
      `window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m => m.getResearchWorkspace(${scriptValue(appProjectId)}))`,
    );
    expect(workspace.journalProjectId).toBeTruthy();
    const workbenchProjectId = workspace.journalProjectId!;
    const beforeImport = await workbenchProject(page, workbenchProjectId);
    expect(beforeImport?.binding).toBeNull();
    const { baseline } = await workbenchManuscript(page, workbenchProjectId);
    expect(baseline.baseline_id).toBe(openedDocument.document.baselineId);
    expect(baseline.source_sha256).toBe(openedDocument.document.sourceSha256);
    expect(baseline.artifact_version_ids).toHaveLength(1);
    const source = await retainedSource(page, workbenchProjectId, baseline.baseline_id);
    expect(source).toMatchObject({
      project_id: workbenchProjectId,
      baseline_id: baseline.baseline_id,
      source_sha256: baseline.source_sha256,
    });
    const retainedBytes = Buffer.from(source.content_base64, "base64");
    expect(digest(retainedBytes)).toBe(baseline.source_sha256);
    expect(digest(retainedBytes)).toBe(openedDocument.document.sourceSha256);
    const link = workspace.wordDocuments?.find((item) => item.path === strictPath);
    expect(link).toMatchObject({
      path: strictPath,
      workbenchProjectId,
      originalSha256: beforeHashes.a4,
      normalizedSha256: baseline.source_sha256,
    });
    const openedAppCopy = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileBase64(
        ${scriptValue(appProjectId)},
        ${scriptValue(strictPath)}
      ))`,
    );
    expect(digest(Buffer.from(openedAppCopy, "base64"))).toBe(beforeHashes.a4);
    stages.push({
      stage,
      appProjectId,
      strictPath,
      openedDocument: openedDocument.document,
      workbenchProjectId,
      baseline,
      sourceSha256: source.source_sha256,
      link,
    });

    stage = "importing the first Strict A4 template into the unbound open Word copy";
    const a4World = await importTemplateThroughUi(
      page,
      a4Bytes,
      strictPath,
      `IEEE Strict A4 ${Date.now()}`,
    );
    expect(a4World.template).toMatchObject({
      original_sha256: beforeHashes.a4,
      source_sha256: baseline.source_sha256,
      provenance: { converted_sha256: baseline.source_sha256 },
    });
    const a4Refresh = await expectTemplateRefreshPreservesOpenDocument(
      page,
      workbenchProjectId,
      null,
      openedDocument.document,
      a4World,
    );
    await webviewScreenshot(page, resolve(evidence, "strict-ieee-a4-first-import.png"));
    stages.push({
      stage,
      template: a4World.template,
      formatAction: "visible and enabled",
      bindingAfter: a4Refresh.project?.binding,
      after: a4Refresh.after,
    });

    stage = "running the A4 template check to establish an explicit binding";
    await openRailTab(page, "Journal checks");
    const a4Check = await runJournalCheck(page, workbenchProjectId, a4World.version_id);
    const binding = (await workbenchProject(page, workbenchProjectId))?.binding;
    expect(binding).toMatchObject({
      baseline_id: baseline.baseline_id,
      world_version_id: a4World.version_id,
    });
    const boundDocument = await readDocument(page);
    expect(boundDocument.document.sessionId).toBe(openedDocument.document.sessionId);
    expect(boundDocument.document.sessionRevision).toBe(openedDocument.document.sessionRevision);
    stages.push({ stage, checkId: a4Check.check_id, binding, boundDocument: boundDocument.document });

    stage = "importing the untouched Strict Letter template into the same open Word copy";
    const letterName = `IEEE Strict Letter ${Date.now()}`;
    const letterWorld = await importTemplateThroughUi(
      page,
      letterBytes!,
      "conference-template-letter.docx",
      letterName,
    );
    expect(letterWorld.template?.original_sha256).toBe(digest(letterBytes!));
    expect(letterWorld.template?.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    const letterRefresh = await expectTemplateRefreshPreservesOpenDocument(
      page,
      workbenchProjectId,
      binding!,
      boundDocument.document,
      letterWorld,
    );
    expect(letterRefresh.project?.binding?.world_version_id).toBe(a4World.version_id);
    await webviewScreenshot(page, resolve(evidence, "strict-ieee-letter-in-open-word.png"));
    stages.push({
      stage,
      template: letterWorld.template,
      formatAction: "visible and enabled",
      bindingBefore: binding,
      bindingAfter: letterRefresh.project?.binding,
      before: boundDocument.document,
      after: letterRefresh.after,
    });

    stage = "rechecking the retained baseline, source and file-tree link after both imports";
    const sourceAfter = await retainedSource(page, workbenchProjectId, baseline.baseline_id);
    expect(sourceAfter).toMatchObject({
      project_id: source.project_id,
      baseline_id: source.baseline_id,
      source_sha256: source.source_sha256,
    });
    expect(digest(Buffer.from(sourceAfter.content_base64, "base64"))).toBe(
      openedDocument.document.sourceSha256,
    );
    const workspaceAfter = await page.evaluate<ResearchWorkspace>(
      `window.__oleaflyE2EImport('/src/lib/research-workspace.ts').then(m => m.getResearchWorkspace(${scriptValue(appProjectId)}))`,
    );
    expect(workspaceAfter.journalProjectId).toBe(workbenchProjectId);
    expect(workspaceAfter.wordDocuments?.find((item) => item.path === strictPath)).toEqual(
      link,
    );
    const appCopy = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/lib/tauri.ts').then(m => m.readFileBase64(
        ${scriptValue(appProjectId)},
        ${scriptValue(strictPath)}
      ))`,
    );
    expect(digest(Buffer.from(appCopy, "base64"))).toBe(beforeHashes.a4);
    stages.push({
      stage,
      sourceSha256: sourceAfter.source_sha256,
      baselineId: sourceAfter.baseline_id,
      link: workspaceAfter.wordDocuments?.find((item) => item.path === strictPath),
      appCopySha256: digest(Buffer.from(appCopy, "base64")),
    });

    stage = "running the real A4 versus Letter comparison";
    await openRailTab(page, "Journal checks");
    const check = await runJournalCheck(page, workbenchProjectId, letterWorld.version_id);
    const comparison = check.template_comparison;
    expect(check).toMatchObject({
      baseline_id: baseline.baseline_id,
      project_id: workbenchProjectId,
      source_sha256: baseline.source_sha256,
      world_version_id: letterWorld.version_id,
      validity: "CURRENT",
    });
    expect(comparison?.total).toBeGreaterThan(0);
    const address = (comparison?.findings as LocatedFinding[] | undefined)
      ?.find(({ node_address }) => node_address?.part === "/word/document.xml"
        && node_address.path.length > 2)?.node_address;
    expect(address).toMatchObject({
      version: "xml-element-path-1",
      source_sha256: baseline.source_sha256,
    });
    stages.push({ stage, checkId: check.check_id, findings: comparison?.total });

    stage = "reading the retained snapshots and the exact finding node";
    const manuscriptTarget = { project_id: workbenchProjectId, baseline_id: baseline.baseline_id };
    const a4Target = { world_version_id: a4World.version_id };
    const letterTarget = { world_version_id: letterWorld.version_id };
    const a4Snapshot = await retainedSnapshot(page, a4Target);
    const manuscriptSnapshot = await retainedSnapshot(page, manuscriptTarget);
    const letterSnapshot = await retainedSnapshot(page, letterTarget);
    const manuscriptNode = await retainedNode(page, manuscriptTarget, address!);
    const a4Node = await retainedNode(page, a4Target, address!);
    for (const [capture, expectedSha256] of [
      [a4Snapshot, baseline.source_sha256],
      [manuscriptSnapshot, baseline.source_sha256],
      [letterSnapshot, letterWorld.template!.source_sha256],
    ] as const) {
      expect(capture.source_sha256).toBe(expectedSha256);
      expect(capture.snapshot.source_sha256).toBe(expectedSha256);
      expect(capture.total).toBeGreaterThan(0);
    }
    expect(a4Snapshot.snapshot.method_version).toBe(manuscriptSnapshot.snapshot.method_version);
    expect(manuscriptNode).toMatchObject({
      source_sha256: baseline.source_sha256,
      total: 1,
      nodes: [{ node_address: address, namespace_uri: TRANSITIONAL_WORD_NAMESPACE }],
    });
    expect(a4Node).toEqual(manuscriptNode);
    stages.push({
      stage,
      a4SnapshotObjects: a4Snapshot.total,
      manuscriptSnapshotObjects: manuscriptSnapshot.total,
      letterSnapshotObjects: letterSnapshot.total,
      snapshotMethod: manuscriptSnapshot.snapshot.method_version,
      node: manuscriptNode.nodes[0],
    });
  } catch (cause) {
    failure = cause;
    report.failure = {
      stage,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    try {
      const [a4After, zipAfter] = await Promise.all([
        readFile(fixturePaths.a4),
        readFile(fixturePaths.zip),
      ]);
      const afterHashes = {
        a4: digest(a4After),
        zip: digest(zipAfter),
      };
      report.fixtureHashes = { before: beforeHashes, after: afterHashes };
      report.fixturesUnchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
      report.outcome = failure
        ? "FAILED"
        : report.fixturesUnchanged
          ? "PASSED"
          : "FAILED";
      await writeFile(
        resolve(evidence, "strict-ieee-native-report.json"),
        JSON.stringify(report, null, 2),
      );
    } catch (reportFailure) {
      if (!failure) failure = reportFailure;
    }
  }

  if (failure) throw failure;
  expect(report.fixturesUnchanged).toBe(true);
});

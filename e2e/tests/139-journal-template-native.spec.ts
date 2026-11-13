import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { BrowserPageAdapter, TauriPage } from "@srsholmes/tauri-playwright";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  DocxDocumentRead,
  DocxFormatReadResult,
  DocxTemplateCheckResult,
} from "../../packages/ai-tools/src/tools";
import type {
  DocxFormatObject,
  DocxFormatProperties,
  DocxFormatSnapshotV1,
} from "../../src/lib/docx-format-types";
import type { NormalizedJournalTemplate } from "../../src/lib/docx-template-client";
import type {
  JournalCheck,
  JournalProject,
  JournalState,
  JournalWorld,
} from "../../src/lib/journal-workbench";
import { test, expect } from "../fixtures";
import { createBlankProject, openRailTab } from "../helpers";
import { scriptValue } from "../script-value";

const enabled = process.env.OLEAFLY_TEMPLATE_NATIVE_ACCEPTANCE === "1";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Page = TauriPage | BrowserPageAdapter;

interface FindingsPage {
  schema_version: 1;
  operation: "findings";
  check_id: string;
  source_sha256: string;
  findings: TemplateFinding[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
}

interface TemplateFinding {
  case_id: string;
  object_id: string;
  kind: string;
  role: string;
  part: string;
  path: number[];
  property_path: string;
  observed: unknown;
  expected: unknown;
  verdict: "observed_difference" | "observed_match" | "cannot_determine";
}

interface PackageComparison {
  sourceSha256: string;
  outputSha256: string;
  missingParts: string[];
  addedParts: string[];
  changedMedia: string[];
  changedRelationships: string[];
  changedXmlParts: string[];
  paragraphCount: { before: number; after: number };
  paragraphTextChanges: { index: number; paraId: string | null; before: string; after: string }[];
  lostOrModifiedProtectedNodes: Record<string, Record<string, number>>;
  nodeCountChanges: Record<string, Record<string, { before: number; after: number }>>;
}

interface JournalRead {
  items: { object_id: string; object_type: string; node_locator: string; content: Record<string, unknown> }[];
  read_receipt: { read_record_id: string; ranges: unknown[]; unread_ranges: unknown[] };
  pagination: { has_more: boolean; next_cursor: string | null };
}

interface TemplateFontRequirement {
  family: string;
  roles: string[];
  scripts: string[];
}

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DUPLICATE_TEXT = "重复段落 identical";

function syntheticDuplicateDocx(): Uint8Array {
  const paragraph = (size: number, eastAsia: string) =>
    `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="${eastAsia}"/><w:sz w:val="${size}"/></w:rPr><w:t>${DUPLICATE_TEXT}</w:t></w:r></w:p>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${paragraph(20, "SimSun")}${paragraph(28, "SimHei")}<w:sectPr/></w:body></w:document>`,
    ),
  });
}

function comparePaths(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function topLevelParagraphs(snapshot: DocxFormatSnapshotV1): DocxFormatObject[] {
  return snapshot.objects
    .filter((object) =>
      object.kind === "paragraph" &&
      object.part === "/word/document.xml" &&
      object.evidence.top_level_body === true
    )
    .sort((left, right) => comparePaths(left.path, right.path));
}

function paragraphIndexAtPath(
  snapshot: DocxFormatSnapshotV1,
  path: readonly number[],
): number {
  const index = topLevelParagraphs(snapshot)
    .findIndex((paragraph) =>
      paragraph.path.length === path.length &&
      paragraph.path.every((value, slot) => value === path[slot])
    );
  expect(index, `Template paragraph ${path.join(".")} has a live reading-order position.`)
    .toBeGreaterThanOrEqual(0);
  return index;
}

function exactParagraphObject(
  result: DocxFormatReadResult,
  path: readonly number[],
): DocxFormatObject | undefined {
  const matched = result.objects?.find((object) => {
    const candidate = object as unknown as DocxFormatObject;
    return candidate.kind === "paragraph" &&
      candidate.path.length === path.length &&
      candidate.path.every((value, slot) => value === path[slot]);
  });
  return matched ? matched as unknown as DocxFormatObject : undefined;
}

function exactFormatObject(
  result: DocxFormatReadResult,
  objectId: string,
): DocxFormatObject | undefined {
  const matched = result.objects?.find((object) => {
    const candidate = object as unknown as DocxFormatObject;
    return candidate.object_id === objectId;
  });
  return matched ? matched as unknown as DocxFormatObject : undefined;
}

function fontRequirementsFromSnapshot(
  snapshot: DocxFormatSnapshotV1,
): TemplateFontRequirement[] {
  const families = new Map<string, { roles: Set<string>; scripts: Set<string> }>();
  for (const object of snapshot.objects) {
    if (object.kind !== "run" || !object.text?.trim()) continue;
    const run = object.properties.run as DocxFormatProperties;
    const usage = object.properties.script_usage as DocxFormatProperties;
    const complexLane = run.complexLane;
    const complexLaneFamily = complexLane && typeof complexLane === "object" &&
        !Array.isArray(complexLane)
      ? (complexLane as DocxFormatProperties).fontFamily
      : undefined;
    const add = (family: unknown, scripts: string[]) => {
      if (typeof family !== "string" || !family.trim()) return;
      const active = scripts.filter((script) => usage[script] === true);
      if (!active.length) return;
      const record = families.get(family) ??
        { roles: new Set<string>(), scripts: new Set<string>() };
      record.roles.add(object.role);
      for (const script of active) record.scripts.add(script);
      families.set(family, record);
    };
    add(run.fontFamily, [
      "latin",
      "other",
      ...(typeof complexLaneFamily === "string" && complexLaneFamily ? [] : ["complex"]),
    ]);
    add(run.fontFamilyEastAsia, ["east_asian"]);
    const latinLane = run.latinLane;
    if (latinLane && typeof latinLane === "object" && !Array.isArray(latinLane)) {
      const lane = latinLane as DocxFormatProperties;
      add(lane.fontFamily, ["latin", "other"]);
      add(lane.fontFamilyEastAsia, ["east_asian"]);
    }
    if (complexLane && typeof complexLane === "object" && !Array.isArray(complexLane)) {
      add((complexLane as DocxFormatProperties).fontFamily, ["complex"]);
    }
  }
  return [...families.entries()]
    .map(([family, value]) => ({
      family,
      roles: [...value.roles].sort(),
      scripts: [...value.scripts].sort(),
    }))
    .sort((left, right) => left.family < right.family ? -1 : left.family > right.family ? 1 : 0);
}

async function journalRequest<T>(
  page: Page,
  path: string,
  payload?: unknown,
): Promise<T> {
  const payloadArgument = payload === undefined ? "" : `, ${scriptValue(payload)}`;
  return page.evaluate<T>(
    `window.__oleaflyE2EImport('/src/lib/journal-workbench.ts').then(m => m.journalRequest(${scriptValue(path)}${payloadArgument}))`,
  );
}

async function clickWorkspaceButton(page: Page, label: string) {
  await page.evaluate(`(() => {
    const surface = document.querySelector('[data-testid="docx-workspace"]');
    const button = Array.from(surface.querySelectorAll('button')).find(item =>
      item.textContent.trim() === ${scriptValue(label)} || item.getAttribute('aria-label') === ${scriptValue(label)}
    );
    if (!button || button.disabled) throw new Error('Unavailable workspace button: ' + ${scriptValue(label)});
    button.click();
  })()`);
}

async function executeDocxTool<T>(
  page: Page,
  name: "read_docx_format" | "apply_docx_format" | "save_docx_document" | "check_docx_template",
  input: Record<string, unknown>,
): Promise<T> {
  return page.evaluate<T>(`window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m =>
    m.createDocxAgentTools()[${scriptValue(name)}].execute(${scriptValue(input)}))`);
}

async function readDocument(page: Page): Promise<DocxDocumentRead> {
  return page.evaluate<DocxDocumentRead>(
    `window.__oleaflyE2EImport('/src/lib/docx-agent-host.ts').then(m => m.DOCX_AGENT_HOST.readDocument())`,
  );
}

async function waitForDocument(page: Page, dirty: boolean, timeout = 120_000): Promise<DocxDocumentRead> {
  let latest: DocxDocumentRead | undefined;
  await expect.poll(async () => {
    try {
      latest = await readDocument(page);
      return latest.document.dirty;
    } catch {
      return null;
    }
  }, { timeout }).toBe(dirty);
  return latest!;
}

async function waitForProject(
  page: Page,
  projectName: string,
): Promise<JournalProject> {
  let project: JournalProject | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    project = state.projects.find((item) => item.name === projectName);
    return Boolean(project);
  }, { timeout: 120_000 }).toBe(true);
  return project!;
}

async function waitForWorld(
  page: Page,
  journalId: string,
): Promise<JournalWorld> {
  let versionId: string | undefined;
  await expect.poll(async () => {
    const state = await journalRequest<JournalState>(page, "/api/state");
    versionId = state.worlds.find((item) => item.journal_id === journalId)?.version_id;
    return Boolean(versionId);
  }, { timeout: 180_000 }).toBe(true);
  return journalRequest<JournalWorld>(
    page,
    `/api/world?version_id=${encodeURIComponent(versionId!)}`,
  );
}

async function importTemplateThroughUi(
  page: Page,
  bytes: Uint8Array,
  filename: string,
  journalName: string,
  journalId: string,
): Promise<void> {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Use Word as template", { exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await panel.getByText("Use Word as template", { exact: true }).click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await page.fill('[role="dialog"] input[id$="-name"]', journalName);
  await page.fill('[role="dialog"] input[id$="-journal"]', journalId);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: filename,
    mimeType: "application/msword",
    buffer: Buffer.from(bytes),
  }]);
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 180_000 });
}

async function importManuscriptThroughUi(
  page: Page,
  bytes: Uint8Array,
  filename: string,
  projectName: string,
): Promise<void> {
  const panel = page.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled({
    timeout: 90_000,
  });
  await panel.getByText("Import DOCX", { exact: true }).click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await page.fill('[role="dialog"] input:not([type="file"])', projectName);
  await page.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: filename,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(bytes),
  }]);
  await expect(dialog.locator('button[type="submit"]')).toBeEnabled();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 180_000 });
}

async function selectJournalProject(page: Page, projectId: string): Promise<void> {
  const panel = page.getByTestId("journal-checks-panel");
  const select = panel.locator("select").first();
  await expect(select).toBeEnabled({ timeout: 90_000 });
  await select.selectOption(projectId);
  await expect.poll(() => select.inputValue()).toBe(projectId);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
}

async function runJournalCheck(
  page: Page,
  projectId: string,
  worldVersionId: string,
): Promise<JournalCheck> {
  const panel = page.getByTestId("journal-checks-panel");
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
      current?.check_id &&
      current.check_id !== previous &&
      current.validity === "CURRENT" &&
      current.world_version_id === worldVersionId
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

async function inspectManuscript(
  page: Page,
  project: JournalProject,
): Promise<{
  snapshot: DocxFormatSnapshotV1;
  nodes: Record<string, unknown>;
  relationships: Record<string, unknown>;
  catalog: Record<string, unknown>;
  read: JournalRead | null;
}> {
  const snapshotResponse = await journalRequest<{ snapshot: DocxFormatSnapshotV1 }>(
    page,
    "/api/docx-query",
    {
      target: { project_id: project.project_id, baseline_id: project.baseline_id },
      operation: "snapshot",
    },
  );
  const nodes = await journalRequest<Record<string, unknown>>(page, "/api/docx-query", {
    target: { project_id: project.project_id, baseline_id: project.baseline_id },
    operation: "nodes",
    part: "/word/document.xml",
    offset: 0,
    limit: 50,
  });
  const relationships = await journalRequest<Record<string, unknown>>(
    page,
    "/api/docx-query",
    {
      target: { project_id: project.project_id, baseline_id: project.baseline_id },
      operation: "relationships",
    },
  );
  const catalog = await journalRequest<{
    catalog: { items: { object_id: string; object_type: string; node_locator: string }[] };
  }>(
    page,
    `/api/manuscript?project_id=${encodeURIComponent(project.project_id)}&baseline_id=${encodeURIComponent(project.baseline_id)}`,
  );
  const item = catalog.catalog.items[0];
  const read = item
    ? await journalRequest<JournalRead>(page, "/api/read", {
        project_id: project.project_id,
        baseline_id: project.baseline_id,
        render_bundle_id: null,
        query: {
          region: null,
          object_type: item.object_type,
          object_id: item.object_id,
          page_number: null,
          page_size: 1,
          cursor: null,
        },
      })
    : null;
  return { snapshot: snapshotResponse.snapshot, nodes, relationships, catalog, read };
}

async function findingsForProperty(
  page: Page,
  check: JournalCheck,
  propertyPath: string,
  verdict: TemplateFinding["verdict"] = "observed_difference",
): Promise<TemplateFinding[]> {
  const findings: TemplateFinding[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;
  for (;;) {
    const response = await journalRequest<FindingsPage>(page, "/api/docx-query", {
      target: { check_id: check.check_id },
      operation: "findings",
      offset,
      limit: 1_000,
      verdict,
      property_path: propertyPath,
    });
    expectedTotal ??= response.total;
    expect(response.total).toBe(expectedTotal);
    expect(response.check_id).toBe(check.check_id);
    expect(response.findings.every((finding) => finding.property_path === propertyPath)).toBe(true);
    findings.push(...response.findings);
    if (!response.has_more) {
      expect(response.next_offset).toBeNull();
      break;
    }
    expect(response.next_offset).toBe(offset + response.findings.length);
    expect(response.findings.length).toBeGreaterThan(0);
    offset = response.next_offset!;
  }
  expect(findings).toHaveLength(expectedTotal!);
  expect(new Set(findings.map((finding) => finding.case_id)).size).toBe(findings.length);
  return findings;
}

function runFontSizeTarget(
  snapshot: DocxFormatSnapshotV1,
  live: DocxDocumentRead,
  findings: TemplateFinding[],
): {
  finding: TemplateFinding;
  paragraphRef: string;
  paragraphIndex: number;
  paragraphPath: number[];
  paraId?: string;
  paragraphText: string;
  runObjectId: string;
  observed: number;
  expected: number;
} {
  const objects = new Map(snapshot.objects.map((object) => [object.object_id, object]));
  const orderedParagraphs = topLevelParagraphs(snapshot);
  const paragraphPositions = new Map(
    orderedParagraphs.map((paragraph, index) => [paragraph.object_id, index]),
  );
  const candidates = findings.flatMap((finding) => {
    if (
      finding.verdict !== "observed_difference" ||
      finding.property_path !== "run.fontSizePt" ||
      finding.kind !== "run" ||
      typeof finding.expected !== "number" ||
      typeof finding.observed !== "number"
    ) return [];
    const run = objects.get(finding.object_id);
    const paragraphId = run?.evidence.paragraph_object_id;
    const paragraph = typeof paragraphId === "string" ? objects.get(paragraphId) : undefined;
    const paragraphText = paragraph?.text ?? "";
    const paragraphIndex = paragraph ? paragraphPositions.get(paragraph.object_id) : undefined;
    if (
      !run ||
      run.kind !== "run" ||
      run.path.length !== finding.path.length ||
      !run.path.every((value, slot) => value === finding.path[slot]) ||
      paragraph?.kind !== "paragraph" ||
      paragraphIndex === undefined ||
      paragraph.path.length !== finding.path.length - 1 ||
      !paragraph.path.every((value, slot) => value === finding.path[slot])
    ) return [];
    const liveParagraph = live.paragraphs[paragraphIndex];
    if (!liveParagraph) return [];
    return [{
      finding,
      paragraphRef: liveParagraph.paragraphRef,
      paragraphIndex,
      paragraphPath: [...paragraph.path],
      ...(liveParagraph.paraId === undefined ? {} : { paraId: liveParagraph.paraId }),
      paragraphText,
      runObjectId: finding.object_id,
      observed: finding.observed,
      expected: finding.expected,
    }];
  });
  const selected = candidates.sort((left, right) => {
    const leftTitle = left.finding.role === "document_title" ? 1 : 0;
    const rightTitle = right.finding.role === "document_title" ? 1 : 0;
    return rightTitle - leftTitle;
  })[0];
  expect(selected, "The Chinese manuscript has a live run with an explicit template point-size difference.").toBeTruthy();
  return selected;
}

function runPackageComparison(sourcePath: string, outputPath: string): PackageComparison {
  const python = process.env.OLEAFLY_WORKBENCH_PYTHON ??
    resolve("services/research-workbench/.venv/bin/python");
  return JSON.parse(execFileSync(
    python,
    [resolve("e2e/tests/docx-real-package.py"), sourcePath, outputPath],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )) as PackageComparison;
}

function assertPackagePreserved(comparison: PackageComparison): void {
  expect(comparison.missingParts).toEqual([]);
  expect(comparison.addedParts).toEqual([]);
  expect(comparison.changedMedia).toEqual([]);
  expect(comparison.changedRelationships).toEqual([]);
  expect(comparison.lostOrModifiedProtectedNodes).toEqual({});
  expect(comparison.paragraphCount.after).toBe(comparison.paragraphCount.before);
  expect(comparison.paragraphTextChanges).toEqual([]);
}

test("legacy Word template drives native EN and ZH Agent format repair", async ({ tauriPage: page }, testInfo) => {
  test.skip(!enabled, "Set OLEAFLY_TEMPLATE_NATIVE_ACCEPTANCE=1 and provide authorized template and manuscript paths.");
  test.setTimeout(1_500_000);
  const inputPaths = {
    template: process.env.OLEAFLY_NATIVE_TEMPLATE_DOC,
    english: process.env.OLEAFLY_NATIVE_DOCX_EN,
    chinese: process.env.OLEAFLY_NATIVE_DOCX_ZH,
  };
  expect(inputPaths.template, "OLEAFLY_NATIVE_TEMPLATE_DOC is required.").toBeTruthy();
  expect(inputPaths.english, "OLEAFLY_NATIVE_DOCX_EN is required.").toBeTruthy();
  expect(inputPaths.chinese, "OLEAFLY_NATIVE_DOCX_ZH is required.").toBeTruthy();
  expect(inputPaths.template!.toLowerCase().endsWith(".doc"), "The template input must be legacy Word .doc.").toBe(true);
  for (const path of Object.values(inputPaths)) {
    expect(path && existsSync(path), `${path} must exist and be readable.`).toBe(true);
  }
  const [templatePath, englishPath, chinesePath] = await Promise.all([
    realpath(inputPaths.template!),
    realpath(inputPaths.english!),
    realpath(inputPaths.chinese!),
  ]);
  const sourceBytes = {
    template: new Uint8Array(await readFile(templatePath)),
    english: new Uint8Array(await readFile(englishPath)),
    chinese: new Uint8Array(await readFile(chinesePath)),
  };
  const initialHashes = {
    template: sha256(sourceBytes.template),
    english: sha256(sourceBytes.english),
    chinese: sha256(sourceBytes.chinese),
  };
  const evidenceParent = resolve(
    process.env.OLEAFLY_NATIVE_TEMPLATE_OUTPUT ?? ".private/journal-template-native",
  );
  await mkdir(evidenceParent, { recursive: true });
  const evidence = await mkdtemp(resolve(evidenceParent, "run-"));
  const report: Record<string, unknown> = {
    outcome: "RUNNING",
    evidence,
    inputs: { templatePath, englishPath, chinesePath },
    initialHashes,
    stages: [] as Record<string, unknown>[],
    modelCalls: 0,
    scope: "Real native normalization, Workbench HTTP, retained DOCX reads, checks and ordinary DOCX Agent tools. No model call or model quality claim.",
  };
  const stages = report.stages as Record<string, unknown>[];
  let stage = "starting";
  try {
    await page.evaluate(
      `window.__oleaflyE2EImport('/src/store/settings.ts').then(({ useSettingsStore }) =>
        useSettingsStore.getState().setUiLocalePreference("en"))`,
    );
    await page.waitForFunction('document.documentElement.lang === "en"', 10_000);
    const libreOffice = process.env.OLEAFLY_NATIVE_LIBREOFFICE ??
      process.env.OLEAFLY_LIBREOFFICE ??
      null;
    stage = "normalizing .doc through native Tauri IPC";
    const normalized = await page.evaluate<NormalizedJournalTemplate>(`window.__TAURI_INTERNALS__.invoke(
      'journal_template_normalize', {
        name: ${scriptValue(basename(templatePath))},
        contentBase64: ${scriptValue(Buffer.from(sourceBytes.template).toString("base64"))},
        executable: ${scriptValue(libreOffice)}
      })`);
    const normalizedBytes = new Uint8Array(Buffer.from(normalized.normalized.content_base64, "base64"));
    expect(normalized.original_sha256).toBe(initialHashes.template);
    expect(sha256(new Uint8Array(Buffer.from(normalized.original.content_base64, "base64")))).toBe(initialHashes.template);
    expect(normalized.source_sha256).toBe(sha256(normalizedBytes));
    expect(normalized.normalized.provenance).toMatchObject({
      engine: "LibreOffice",
      method: "libreoffice --headless --convert-to docx:Office Open XML Text",
      converted_sha256: normalized.source_sha256,
    });
    expect(Array.from(normalizedBytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(resolve(evidence, "normalized-template.docx"), normalizedBytes);

    stage = "deriving core template format snapshot";
    const templateSnapshot = await page.evaluate<DocxFormatSnapshotV1>(`window.__oleaflyE2EImport(
      '/src/lib/docx-template-client.ts').then(m => m.docxFormatSnapshot(
        Uint8Array.from(atob(${scriptValue(normalized.normalized.content_base64)}), c => c.charCodeAt(0))
      ))`);
    expect(templateSnapshot.source_sha256).toBe(normalized.source_sha256);
    expect(templateSnapshot.parts.length).toBeGreaterThan(0);
    expect(templateSnapshot.objects.some((object) => object.kind === "paragraph")).toBe(true);
    const expectedTemplateFonts = fontRequirementsFromSnapshot(templateSnapshot);
    expect(expectedTemplateFonts.length).toBeGreaterThan(0);
    expect(expectedTemplateFonts.every((font) =>
      font.family.trim() &&
      font.roles.length > 0 &&
      font.scripts.length > 0
    )).toBe(true);
    expect(expectedTemplateFonts.some((font) => font.scripts.includes("east_asian"))).toBe(false);
    await writeFile(resolve(evidence, "template-snapshot.json"), JSON.stringify(templateSnapshot, null, 2));
    stages.push({
      stage,
      normalized,
      snapshotSourceSha256: templateSnapshot.source_sha256,
      expectedTemplateFonts,
    });

    stage = "creating native project and importing template through UI";
    await createBlankProject(page, `Journal template native ${Date.now()}`);
    const appProjectId = await page.evaluate<string>(
      `window.__oleaflyE2EImport('/src/store/files.ts').then(m => m.useFilesStore.getState().projectId)`,
    );
    expect(appProjectId).toBeTruthy();
    await openRailTab(page, "Journal checks");
    const journalId = `native-template-${randomUUID()}`;
    const journalName = `Native legacy template ${Date.now()}`;
    await importTemplateThroughUi(
      page,
      sourceBytes.template,
      basename(templatePath),
      journalName,
      journalId,
    );
    const world = await waitForWorld(page, journalId);
    expect(world.template).toMatchObject({
      original_sha256: initialHashes.template,
      provenance: {
        engine: "LibreOffice",
        method: "libreoffice --headless --convert-to docx:Office Open XML Text",
      },
    });
    expect(world.template!.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(world.template?.font_requirements).toEqual(expectedTemplateFonts);
    await expect.poll(() => page.locator('[data-testid="journal-world-select"]').inputValue())
      .toBe(world.version_id);
    await expect(page.getByTestId("journal-template-facts")).toContainText(initialHashes.template);
    stages.push({ stage, appProjectId, world });

    stage = "importing and checking English manuscript through UI";
    const englishName = `Native template English ${Date.now()}`;
    await importManuscriptThroughUi(
      page,
      sourceBytes.english,
      basename(englishPath),
      englishName,
    );
    const englishProject = await waitForProject(page, englishName);
    await selectJournalProject(page, englishProject.project_id);
    const englishCheck = await runJournalCheck(page, englishProject.project_id, world.version_id);
    const englishInspection = await inspectManuscript(page, englishProject);
    expect(englishCheck).toMatchObject({
      project_id: englishProject.project_id,
      baseline_id: englishProject.baseline_id,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    expect(englishInspection.snapshot.source_sha256).toBe(initialHashes.english);
    expect(englishInspection.read?.read_receipt.read_record_id).toBeTruthy();
    expect(englishInspection.catalog).toHaveProperty("catalog");
    expect(englishInspection.nodes).toHaveProperty("nodes");
    expect(englishInspection.relationships).toHaveProperty("relationships");
    stages.push({
      stage,
      project: englishProject,
      check: englishCheck,
      querySourceSha256: englishInspection.snapshot.source_sha256,
      readReceipt: englishInspection.read?.read_receipt.read_record_id,
    });

    stage = "importing and checking Chinese manuscript through UI";
    const chineseName = `Native template Chinese ${Date.now()}`;
    await importManuscriptThroughUi(
      page,
      sourceBytes.chinese,
      basename(chinesePath),
      chineseName,
    );
    const chineseProject = await waitForProject(page, chineseName);
    await selectJournalProject(page, chineseProject.project_id);
    const chineseCheck = await runJournalCheck(page, chineseProject.project_id, world.version_id);
    const chineseInspection = await inspectManuscript(page, chineseProject);
    expect(chineseCheck).toMatchObject({
      project_id: chineseProject.project_id,
      baseline_id: chineseProject.baseline_id,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    expect(chineseInspection.snapshot.source_sha256).toBe(initialHashes.chinese);
    expect(chineseInspection.read?.read_receipt.read_record_id).toBeTruthy();
    expect(chineseInspection.catalog).toHaveProperty("catalog");
    expect(chineseInspection.nodes).toHaveProperty("nodes");
    expect(chineseInspection.relationships).toHaveProperty("relationships");
    stages.push({
      stage,
      project: chineseProject,
      check: chineseCheck,
      querySourceSha256: chineseInspection.snapshot.source_sha256,
      readReceipt: chineseInspection.read?.read_receipt.read_record_id,
    });

    stage = "round-tripping unchanged English DOCX";
    await selectJournalProject(page, englishProject.project_id);
    await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const englishLive = await waitForDocument(page, false);
    expect(englishLive.document).toMatchObject({
      workbenchProjectId: englishProject.project_id,
      baselineId: englishProject.baseline_id,
      sourceSha256: initialHashes.english,
      dirty: false,
    });
    const englishTarget = englishLive.paragraphs.find((paragraph) => paragraph.text.trim().length >= 40);
    expect(englishTarget).toBeTruthy();
    let englishFormat: DocxFormatReadResult | undefined;
    if (englishTarget) {
      englishFormat = await executeDocxTool<DocxFormatReadResult>(
        page,
        "read_docx_format",
        { query: { kind: "objects", paragraph_ref: englishTarget.paragraphRef, limit: 20 } },
      );
      expect(englishFormat).toMatchObject({
        revision: englishLive.document.sessionRevision,
        document: {
          sessionId: englishLive.document.sessionId,
          filename: englishLive.document.filename,
          baselineId: englishProject.baseline_id,
          sessionRevision: englishLive.document.sessionRevision,
          savedRevision: englishLive.document.savedRevision,
          dirty: false,
        },
      });
      expect(englishFormat.paragraph?.text).toBe(englishTarget.text);
      stages.push({ stage: "English ordinary Agent format read", result: englishFormat });
    }
    const englishExport = resolve(evidence, "english-roundtrip.docx");
    await page.evaluate(`window.__e2eSetNextSavePath(${scriptValue(englishExport)})`);
    await clickWorkspaceButton(page, "Download DOCX copy");
    await expect.poll(async () => {
      try {
        return (await readFile(englishExport)).length;
      } catch {
        return 0;
      }
    }, { timeout: 60_000 }).toBeGreaterThan(0);
    const englishExportBytes = new Uint8Array(await readFile(englishExport));
    const englishExportSha256 = sha256(englishExportBytes);
    expect(englishFormat, "The English live format read did not complete.").toBeTruthy();
    expect(englishFormat!.sourceSha256).toBe(englishExportSha256);
    const englishComparison = runPackageComparison(englishPath, englishExport);
    assertPackagePreserved(englishComparison);
    await writeFile(resolve(evidence, "english-package-comparison.json"), JSON.stringify(englishComparison, null, 2));
    stages.push({
      stage,
      formatSourceSha256: englishFormat!.sourceSha256,
      exportSha256: englishExportSha256,
      comparison: englishComparison,
    });
    await clickWorkspaceButton(page, "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);

    stage = "reading Chinese edit target findings";
    const fontSizeFindings = await findingsForProperty(
      page,
      chineseCheck,
      "run.fontSizePt",
    );
    expect(fontSizeFindings.length).toBeGreaterThan(0);

    stage = "opening Chinese working copy";
    await selectJournalProject(page, chineseProject.project_id);
    await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const chineseLive = await waitForDocument(page, false);
    const target = runFontSizeTarget(
      chineseInspection.snapshot,
      chineseLive,
      fontSizeFindings,
    );
    const fontCards = page.getByTestId("docx-template-font");
    await expect(fontCards).toHaveCount(expectedTemplateFonts.length);
    for (const [index, font] of expectedTemplateFonts.entries()) {
      await expect(fontCards.nth(index)).toContainText(font.family);
      for (const role of font.roles) await expect(fontCards.nth(index)).toContainText(role);
      for (const script of font.scripts) await expect(fontCards.nth(index)).toContainText(script);
    }
    const beforeFormat = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: target.paragraphRef, limit: 50 } },
    );
    expect(beforeFormat.paragraph).toMatchObject({
      paragraphRef: target.paragraphRef,
      text: target.paragraphText,
    });
    expect(exactParagraphObject(beforeFormat, target.paragraphPath)).toMatchObject({
      part: "/word/document.xml",
      path: target.paragraphPath,
      kind: "paragraph",
    });
    if (target.paraId === undefined) {
      expect(beforeFormat.paragraph?.paraId).toBeDefined();
    } else {
      expect(beforeFormat.paragraph?.paraId).toBe(target.paraId);
    }
    expect(exactFormatObject(beforeFormat, target.runObjectId)).toMatchObject({
      object_id: target.runObjectId,
      path: target.finding.path,
      properties: {
        run: { fontSizePt: target.observed },
      },
    });

    stage = "applying ordinary Agent point size";
    const formatApplied = await executeDocxTool<{
      ok: boolean;
      changed: boolean;
      revision: number;
      document: DocxDocumentRead["document"];
    }>(page, "apply_docx_format", {
      paragraph_ref: target.paragraphRef,
      expected_revision: beforeFormat.revision,
      font: { size: target.expected },
    });
    expect(formatApplied).toMatchObject({
      ok: true,
      changed: true,
      document: { dirty: true },
    });
    const dirtyLive = await waitForDocument(page, true);
    const dirtyParagraph = dirtyLive.paragraphs[target.paragraphIndex];
    expect(dirtyParagraph).toBeTruthy();
    expect(dirtyParagraph.paragraphRef).toBe(target.paragraphRef);
    const dirtyFormat = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: dirtyParagraph!.paragraphRef, limit: 20 } },
    );
    expect(dirtyFormat.paragraph?.font.size).toBe(target.expected);
    expect(exactFormatObject(dirtyFormat, target.runObjectId)).toMatchObject({
      object_id: target.runObjectId,
      properties: {
        run: { fontSizePt: target.expected },
      },
    });
    expect(exactParagraphObject(dirtyFormat, target.paragraphPath)).toBeDefined();
    stages.push({
      stage: "Chinese format applied",
      target,
      beforeFormat,
      result: formatApplied,
    });

    stage = "saving Chinese Agent format edit";
    const saved = await executeDocxTool<{
      baselineId: string;
      revision: number;
      sourceSha256: string;
      formatStatus?: string;
      document: DocxDocumentRead["document"];
    }>(page, "save_docx_document", {
      expected_revision: formatApplied.document.sessionRevision,
    });
    expect(saved).toMatchObject({
      formatStatus: "recorded",
      document: { dirty: false, savedRevision: formatApplied.document.sessionRevision },
    });
    expect(saved.baselineId).not.toBe(chineseProject.baseline_id);
    expect(saved.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    await waitForDocument(page, false);

    stage = "rechecking with ordinary Agent tool";
    const rechecked = await executeDocxTool<DocxTemplateCheckResult>(
      page,
      "check_docx_template",
      { template: world.version_id },
    );
    expect(rechecked.check).toMatchObject({
      project_id: chineseProject.project_id,
      baseline_id: saved.baselineId,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    const recheckedCheck = rechecked.check as unknown as JournalCheck;
    const afterFontSizeFindings = await findingsForProperty(
      page,
      recheckedCheck,
      "run.fontSizePt",
      "observed_match",
    );
    const afterFontSize = afterFontSizeFindings.find(
      (finding) => finding.case_id === target.finding.case_id,
    );
    expect(afterFontSize, JSON.stringify(rechecked.check, null, 2)).toBeTruthy();
    expect(afterFontSize).toMatchObject({
      object_id: target.finding.object_id,
      property_path: "run.fontSizePt",
      observed: target.expected,
      expected: target.finding.expected,
      verdict: "observed_match",
    });
    stages.push({
      stage: "Chinese recheck",
      beforeFontSize: target.finding,
      afterFontSize,
    });

    stage = "closing and reopening saved Chinese DOCX";
    const beforeCloseFormat = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: dirtyParagraph!.paragraphRef, limit: 20 } },
    );
    expect(beforeCloseFormat.paragraph?.font.size).toBe(target.expected);
    await clickWorkspaceButton(page, "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
    await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const reopenedLive = await waitForDocument(page, false);
    const reopenedParagraph = reopenedLive.paragraphs[
      paragraphIndexAtPath(chineseInspection.snapshot, target.paragraphPath)
    ];
    expect(reopenedParagraph).toBeTruthy();
    const reopenedFormat = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: reopenedParagraph!.paragraphRef, limit: 20 } },
    );
    expect(reopenedFormat).toMatchObject({
      sourceSha256: saved.sourceSha256,
      paragraph: { font: { size: target.expected } },
    });
    expect(exactParagraphObject(reopenedFormat, target.paragraphPath)).toBeDefined();
    expect(exactFormatObject(reopenedFormat, target.runObjectId)).toMatchObject({
      object_id: target.runObjectId,
      properties: {
        run: { fontSizePt: target.expected },
      },
    });
    stages.push({ stage, reopenedFormat });

    stage = "retaining and comparing saved Chinese DOCX package";
    const savedSource = await journalRequest<{ content_base64: string; source_sha256: string }>(
      page,
      `/api/manuscript-source?project_id=${encodeURIComponent(chineseProject.project_id)}&baseline_id=${encodeURIComponent(saved.baselineId)}`,
    );
    const savedBytes = new Uint8Array(Buffer.from(savedSource.content_base64, "base64"));
    expect(savedSource.source_sha256).toBe(saved.sourceSha256);
    expect(sha256(savedBytes)).toBe(saved.sourceSha256);
    const savedPath = resolve(evidence, "chinese-agent-saved.docx");
    await writeFile(savedPath, savedBytes);
    const chineseComparison = runPackageComparison(chinesePath, savedPath);
    assertPackagePreserved(chineseComparison);
    const savedPackage = unzipSync(savedBytes);
    expect(savedPackage["word/document.xml"]).toBeTruthy();
    expect(strFromU8(savedPackage["word/document.xml"]!)).toContain(target.paragraphText);
    const python = process.env.OLEAFLY_WORKBENCH_PYTHON ??
      resolve("services/research-workbench/.venv/bin/python");
    execFileSync(python, ["-c", `
import sys, zipfile, xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
with zipfile.ZipFile(sys.argv[1]) as package:
    root = ET.fromstring(package.read("word/document.xml"))
path = [int(value) for value in sys.argv[2].split("#", 1)[1].split(".")]
assert path[0] == 0, "canonical path must start at the document root"
node = root
for index in path[1:]:
    node = list(node)[index]
assert node.tag == W + "r", "canonical path must resolve to the repaired run"
size = node.find(W + "rPr/" + W + "sz")
assert size is not None, "direct run size is missing"
assert int(size.get(W + "val")) == round(float(sys.argv[3]) * 2), "repaired run size differs"
print("exact canonical run size retained")
`, savedPath, target.runObjectId, String(target.expected)], { encoding: "utf8" });
    await writeFile(resolve(evidence, "chinese-package-comparison.json"), JSON.stringify(chineseComparison, null, 2));
    stages.push({
      stage,
      saved,
      comparison: chineseComparison,
      sourceSha256: saved.sourceSha256,
      runObjectId: target.runObjectId,
      fontSizePt: target.expected,
    });

    stage = "closing Chinese workspace before duplicate-text acceptance";
    await clickWorkspaceButton(page, "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);

    stage = "importing duplicate-text DOCX without authored paragraph IDs";
    const duplicateBytes = syntheticDuplicateDocx();
    const duplicatePackage = unzipSync(duplicateBytes);
    const duplicateXml = strFromU8(duplicatePackage["word/document.xml"]!);
    expect(duplicateXml).not.toContain("w14:paraId");
    const duplicatePath = resolve(evidence, "duplicate-text-no-paraid.docx");
    await writeFile(duplicatePath, duplicateBytes);
    const duplicateSnapshot = await page.evaluate<DocxFormatSnapshotV1>(`window.__oleaflyE2EImport(
      '/src/lib/docx-template-client.ts').then(m => m.docxFormatSnapshot(
        Uint8Array.from(atob(${scriptValue(Buffer.from(duplicateBytes).toString("base64"))}), c => c.charCodeAt(0))
      ))`);
    const duplicateParagraphFacts = topLevelParagraphs(duplicateSnapshot);
    expect(duplicateParagraphFacts).toHaveLength(2);
    expect(duplicateParagraphFacts.map((paragraph) => paragraph.text)).toEqual([
      DUPLICATE_TEXT,
      DUPLICATE_TEXT,
    ]);
    expect(duplicateParagraphFacts[0].path).not.toEqual(duplicateParagraphFacts[1].path);
    const duplicateName = `Native duplicate paragraphs ${Date.now()}`;
    await importManuscriptThroughUi(
      page,
      duplicateBytes,
      "duplicate-text-no-paraid.docx",
      duplicateName,
    );
    const duplicateProject = await waitForProject(page, duplicateName);
    await selectJournalProject(page, duplicateProject.project_id);

    stage = "locating duplicate paragraph by reference and canonical path";
    await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const duplicateLive = await waitForDocument(page, false);
    expect(duplicateLive.paragraphs).toHaveLength(2);
    expect(duplicateLive.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      DUPLICATE_TEXT,
      DUPLICATE_TEXT,
    ]);
    const duplicateFirstRef = duplicateLive.paragraphs[0].paragraphRef;
    const duplicateSecondRef = duplicateLive.paragraphs[1].paragraphRef;
    expect(duplicateFirstRef).not.toBe(duplicateSecondRef);
    const duplicateFirst = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: duplicateFirstRef, limit: 50 } },
    );
    const duplicateSecond = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      { query: { kind: "objects", paragraph_ref: duplicateSecondRef, limit: 50 } },
    );
    expect(duplicateFirst.paragraph).toMatchObject({
      paragraphRef: duplicateFirstRef,
      text: DUPLICATE_TEXT,
      font: { name: "Arial", size: 10 },
    });
    expect(duplicateSecond.paragraph).toMatchObject({
      paragraphRef: duplicateSecondRef,
      text: DUPLICATE_TEXT,
      font: { name: "Arial", size: 14 },
    });
    expect(duplicateFirst.paragraph?.paraId).toMatch(/^[a-f0-9]{8}$/i);
    expect(duplicateSecond.paragraph?.paraId).toMatch(/^[a-f0-9]{8}$/i);
    expect(duplicateFirst.paragraph?.paraId).not.toBe(duplicateSecond.paragraph?.paraId);
    expect(exactParagraphObject(duplicateFirst, duplicateParagraphFacts[0].path))
      .toMatchObject({ path: duplicateParagraphFacts[0].path });
    expect(exactParagraphObject(duplicateSecond, duplicateParagraphFacts[1].path))
      .toMatchObject({ path: duplicateParagraphFacts[1].path });
    const duplicateFirstRuns = duplicateFirst.objects?.filter((object) => object.kind === "run") as
      DocxFormatObject[] | undefined;
    const duplicateSecondRuns = duplicateSecond.objects?.filter((object) => object.kind === "run") as
      DocxFormatObject[] | undefined;
    expect((duplicateFirstRuns?.[0].properties.run as DocxFormatProperties).fontFamilyEastAsia)
      .toBe("SimSun");
    expect((duplicateSecondRuns?.[0].properties.run as DocxFormatProperties).fontFamilyEastAsia)
      .toBe("SimHei");

    stage = "changing only the second duplicate paragraph";
    const duplicateFormat = await executeDocxTool<{
      ok: boolean;
      changed: boolean;
      revision: number;
      document: DocxDocumentRead["document"];
    }>(page, "apply_docx_format", {
      paragraph_ref: duplicateSecondRef,
      expected_revision: duplicateSecond.revision,
      font: { nameEastAsia: "KaiTi" },
    });
    expect(duplicateFormat).toMatchObject({
      ok: true,
      changed: true,
      document: { dirty: true },
    });
    await waitForDocument(page, true);
    const duplicateSaved = await executeDocxTool<{
      baselineId: string;
      revision: number;
      sourceSha256: string;
      document: DocxDocumentRead["document"];
    }>(page, "save_docx_document", {
      expected_revision: duplicateFormat.document.sessionRevision,
    });
    await waitForDocument(page, false);
    const duplicateSavedSource = await journalRequest<{
      content_base64: string;
      source_sha256: string;
    }>(
      page,
      `/api/manuscript-source?project_id=${encodeURIComponent(duplicateProject.project_id)}&baseline_id=${encodeURIComponent(duplicateSaved.baselineId)}`,
    );
    const duplicateSavedBytes = new Uint8Array(Buffer.from(duplicateSavedSource.content_base64, "base64"));
    expect(duplicateSavedSource.source_sha256).toBe(duplicateSaved.sourceSha256);
    expect(sha256(duplicateSavedBytes)).toBe(duplicateSaved.sourceSha256);
    const duplicateSavedPath = resolve(evidence, "duplicate-text-second-only.docx");
    await writeFile(duplicateSavedPath, duplicateSavedBytes);
    const duplicateSavedSnapshot = await page.evaluate<DocxFormatSnapshotV1>(`window.__oleaflyE2EImport(
      '/src/lib/docx-template-client.ts').then(m => m.docxFormatSnapshot(
        Uint8Array.from(atob(${scriptValue(duplicateSavedSource.content_base64)}), c => c.charCodeAt(0))
      ))`);
    const savedDuplicateParagraphs = topLevelParagraphs(duplicateSavedSnapshot);
    expect(savedDuplicateParagraphs).toHaveLength(2);
    const savedRuns = (paragraph: DocxFormatObject) =>
      duplicateSavedSnapshot.objects.filter((object) =>
        object.kind === "run" && object.evidence.paragraph_object_id === paragraph.object_id
      );
    const savedFirstRun = savedRuns(savedDuplicateParagraphs[0])[0];
    const savedSecondRun = savedRuns(savedDuplicateParagraphs[1])[0];
    const savedFirstRunProperties = savedFirstRun.properties.run as DocxFormatProperties;
    const savedSecondRunProperties = savedSecondRun.properties.run as DocxFormatProperties;
    expect(savedFirstRunProperties).toMatchObject({
      fontFamily: "Arial",
      fontFamilyEastAsia: "SimSun",
      fontSizePt: 10,
    });
    expect(savedSecondRunProperties).toMatchObject({
      fontFamily: "Arial",
      fontFamilyEastAsia: "KaiTi",
      fontSizePt: 14,
    });
    const duplicateComparison = runPackageComparison(duplicatePath, duplicateSavedPath);
    assertPackagePreserved(duplicateComparison);
    await writeFile(
      resolve(evidence, "duplicate-package-comparison.json"),
      JSON.stringify(duplicateComparison, null, 2),
    );

    stage = "reopening duplicate-text DOCX and validating both canonical paths";
    await clickWorkspaceButton(page, "Close");
    await expect(page.getByTestId("docx-workspace")).toHaveCount(0);
    await page.getByTestId("journal-checks-panel").getByText("Edit DOCX working copy", { exact: true }).click();
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 120_000 });
    const duplicateReopened = await waitForDocument(page, false);
    expect(duplicateReopened.paragraphs).toHaveLength(2);
    expect(duplicateReopened.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      DUPLICATE_TEXT,
      DUPLICATE_TEXT,
    ]);
    const reopenedDuplicateFirst = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      {
        query: {
          kind: "objects",
          paragraph_ref: duplicateReopened.paragraphs[0].paragraphRef,
          limit: 50,
        },
      },
    );
    const reopenedDuplicateSecond = await executeDocxTool<DocxFormatReadResult>(
      page,
      "read_docx_format",
      {
        query: {
          kind: "objects",
          paragraph_ref: duplicateReopened.paragraphs[1].paragraphRef,
          limit: 50,
        },
      },
    );
    expect(reopenedDuplicateFirst.paragraph?.font.size).toBe(10);
    expect(reopenedDuplicateSecond.paragraph?.font.size).toBe(14);
    expect(exactParagraphObject(reopenedDuplicateFirst, savedDuplicateParagraphs[0].path))
      .toBeDefined();
    expect(exactParagraphObject(reopenedDuplicateSecond, savedDuplicateParagraphs[1].path))
      .toBeDefined();
    const reopenedFirstEastAsia = (reopenedDuplicateFirst.objects?.find((object) =>
      object.kind === "run"
    )?.properties as DocxFormatProperties | undefined)?.run as DocxFormatProperties | undefined;
    const reopenedSecondEastAsia = (reopenedDuplicateSecond.objects?.find((object) =>
      object.kind === "run"
    )?.properties as DocxFormatProperties | undefined)?.run as DocxFormatProperties | undefined;
    expect(reopenedFirstEastAsia?.fontFamilyEastAsia).toBe("SimSun");
    expect(reopenedSecondEastAsia?.fontFamilyEastAsia).toBe("KaiTi");
    stages.push({
      stage: "duplicate-text no w14:paraId",
      sourceSha256: sha256(duplicateBytes),
      savedSha256: duplicateSaved.sourceSha256,
      firstParaId: duplicateFirst.paragraph?.paraId,
      secondParaId: duplicateSecond.paragraph?.paraId,
      firstPath: duplicateParagraphFacts[0].path,
      secondPath: duplicateParagraphFacts[1].path,
      comparison: duplicateComparison,
    });

    stage = "verifying author inputs remain unchanged";
    expect(sha256(new Uint8Array(await readFile(templatePath)))).toBe(initialHashes.template);
    expect(sha256(new Uint8Array(await readFile(englishPath)))).toBe(initialHashes.english);
    expect(sha256(new Uint8Array(await readFile(chinesePath)))).toBe(initialHashes.chinese);
    report.finalHashes = initialHashes;
    report.outcome = "PASSED";
  } finally {
    if (report.outcome !== "PASSED") report.outcome = "FAILED";
    report.finishedAt = new Date().toISOString();
    report.failedStage = report.outcome === "PASSED" ? null : stage;
    try {
      report.finalHashes = {
        template: sha256(new Uint8Array(await readFile(templatePath))),
        english: sha256(new Uint8Array(await readFile(englishPath))),
        chinese: sha256(new Uint8Array(await readFile(chinesePath))),
      };
    } catch (error) {
      report.finalHashError = String(error);
    }
    await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("journal-template-native-report", {
      path: resolve(evidence, "report.json"),
      contentType: "application/json",
    });
  }
});

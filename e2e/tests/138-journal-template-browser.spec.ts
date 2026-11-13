import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DEFAULT_BROWSER_URL = "http://127.0.0.1:1420";

interface FormatSnapshot {
  schema_version: 1;
  source_sha256: string;
  parts: { name: string; byte_length: number; sha256: string; xml: boolean; status: string }[];
  objects: {
    object_id: string;
    part: string;
    path: number[];
    kind: string;
    text?: string;
    style_id?: string;
    role: string;
    role_basis: { source: string; value: string; certainty: string }[];
    properties: Record<string, any>;
  }[];
}

interface JournalWorld {
  version_id: string;
  template: {
    source_sha256: string;
    original_sha256: string;
    normalized_source_id: string;
    snapshot_source_id: string;
  };
}

interface TemplateComparison {
  findings: Record<string, unknown>[];
  finding_summary: Record<string, number>;
  total: number;
  has_more: boolean;
  next_offset: number | null;
  findings_artifact_version_id: string;
}

interface JournalCheck {
  check_id: string;
  project_id: string;
  baseline_id: string;
  binding_id?: string;
  world_version_id: string;
  source_sha256: string;
  validity: string;
  summary: Record<string, number>;
  rule_results: Record<string, unknown>[];
  template_comparison?: TemplateComparison;
}

interface FindingsPage {
  schema_version: 1;
  operation: "findings";
  check_id: string;
  source_sha256: string;
  findings: Record<string, unknown>[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
}

interface RequestRecorder {
  path: string;
  method: string;
  status: number;
  request_sha256?: string;
  response: unknown;
}

interface WorkbenchProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
  stderr: () => string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesFromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

function paragraph(text: string, style: string, directRun = "", paraId?: string): string {
  return `<w:p${paraId ? ` w14:paraId="${paraId}"` : ""}><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:rPr>${directRun}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
}

function docx(body: string, styles: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="bin" ContentType="application/octet-stream"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/customXml/item1.xml" ContentType="application/xml"/>' +
      "</Types>",
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${REL}"><Relationship Id="document" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships xmlns="${REL}">` +
        `<Relationship Id="styles" Type="${OFFICE_REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="custom" Type="${OFFICE_REL}/customXml" Target="../customXml/item1.xml"/>` +
        `<Relationship Id="raw" Type="urn:oleafly:acceptance:raw-part" Target="media/raw.bin"/>` +
      "</Relationships>",
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:acme="urn:oleafly:acceptance">` +
        `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><acme:tracking acme:mode="opaque"/></w:sectPr></w:body>` +
      "</w:document>",
    ),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`),
    "customXml/item1.xml": strToU8('<acceptance:root xmlns:acceptance="urn:oleafly:acceptance" keep="exact"><acceptance:value>42</acceptance:value></acceptance:root>'),
    "word/media/raw.bin": new Uint8Array([0, 255, 7, 19, 82, 0, 128]),
    ...extra,
  });
}

function templateFixture(): Uint8Array {
  const styles =
    '<w:style w:type="paragraph" w:styleId="BodyBase"><w:name w:val="Body Base"/><w:rPr><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="BodyBase"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="BodyAlias"><w:name w:val="Body"/><w:basedOn w:val="BodyBase"/></w:style>';
  return docx(
    paragraph("Template body at fourteen points.", "Body") +
      paragraph("Template alias body also at fourteen points.", "BodyAlias"),
    styles,
  );
}

function manuscriptFixture(): Uint8Array {
  const styles =
    '<w:style w:type="paragraph" w:styleId="BodyBase"><w:name w:val="Body Base"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="BodyBase"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/></w:style>';
  const body =
    paragraph("Synthetic body target whose journal size must change.", "Body", '<w:sz w:val="20"/>', "10000001") +
    paragraph("Figure 1. Retained caption text.", "Caption", '<w:sz w:val="18"/>', "10000002") +
    '<w:customXml w:element="AcceptanceUnknown"><w:p><w:r><w:t>Unknown XML body container remains.</w:t></w:r></w:p></w:customXml>' +
    "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w=\"5000\"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Retained table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
  return docx(body, styles);
}

function effectiveFormatMatrix(): Uint8Array {
  const styles =
    '<w:style w:type="paragraph" w:styleId="InheritedBase"><w:name w:val="Body Base"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="BodyChild"><w:name w:val="Body"/><w:basedOn w:val="InheritedBase"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="BodyAlias"><w:name w:val="Body"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style>';
  return docx(
    paragraph("same-style-ten", "BodyChild", '<w:sz w:val="20"/>') +
      paragraph("same-style-twelve", "BodyChild") +
      paragraph("different-style-twelve", "BodyAlias") +
      paragraph("inheritance-twelve", "BodyChild"),
    styles,
  );
}

async function startWorkbench(root: string): Promise<WorkbenchProcess> {
  const module = resolve("services/research-workbench");
  const child = spawn(
    resolve(module, ".venv/bin/python"),
    ["-m", "research_file_workbench.workbench.launcher", "--library-root", root],
    { cwd: module, env: { ...process.env, PYTHONPATH: "src" } },
  );
  let errors = "";
  const url = await new Promise<string>((accept, reject) => {
    let output = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) accept(match[0]);
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Workbench exited ${code}: ${errors}`)));
  });
  return { child, url, stderr: () => errors };
}

async function stopWorkbench(service: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (service.child.exitCode !== null) return;
  service.child.stdin.end();
  await Promise.race([
    new Promise<void>((done) => service.child.once("exit", () => done())),
    new Promise<void>((done) => setTimeout(done, 5_000)),
  ]);
  if (service.child.exitCode === null) service.child.kill("SIGTERM");
}

async function coreSnapshot(page: Page, bytes: Uint8Array): Promise<FormatSnapshot> {
  return page.evaluate(async (encoded) => {
    const modulePath = "/src/lib/docx-format.ts";
    const { openDocxFormatFacts } = await import(modulePath);
    const data = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return (await openDocxFormatFacts(data)).snapshot as unknown as FormatSnapshot;
  }, base64(bytes));
}

function runFor(snapshot: FormatSnapshot, text: string): { styleId: string | undefined; role: string; size: number } {
  const paragraphFacts = snapshot.objects.find((object) => object.kind === "paragraph" && object.text === text);
  const runFacts = snapshot.objects.find((object) => object.kind === "run" && object.text === text);
  if (!paragraphFacts || !runFacts) throw new Error(`Format facts are missing for ${text}`);
  return {
    styleId: paragraphFacts.style_id,
    role: paragraphFacts.role,
    size: runFacts.properties.run.fontSizePt as number,
  };
}

function walk(value: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  for (const child of Object.values(value)) walk(child, visit);
}

function comparisonFindings(value: unknown): Record<string, unknown>[] {
  const findings: Record<string, unknown>[] = [];
  walk(value, (item) => {
    if (
      typeof item.object_id === "string" &&
      typeof item.property_path === "string" &&
      "observed" in item &&
      "expected" in item &&
      typeof item.verdict === "string"
    ) findings.push(item);
  });
  return findings;
}

function comparisonIdentity(finding: Record<string, unknown>): string {
  return typeof finding.case_id === "string" && finding.case_id
    ? finding.case_id
    : `${String(finding.object_id)}\0${String(finding.property_path)}`;
}

function comparisonDigest(findings: Record<string, unknown>[]): string {
  const digest = createHash("sha256");
  for (const finding of findings) {
    digest.update(
      JSON.stringify({
        case_id: finding.case_id ?? null,
        object_id: finding.object_id,
        part: finding.part,
        path: finding.path,
        property_path: finding.property_path,
        observed: finding.observed,
        expected: finding.expected,
        verdict: finding.verdict,
      }),
    );
    digest.update("\0");
  }
  return digest.digest("hex");
}

function assertRoleComparisonFindings(
  findings: Record<string, unknown>[],
  template: FormatSnapshot,
  manuscript: FormatSnapshot,
): void {
  expect(findings.length).toBeGreaterThan(0);
  const identities = findings.map(comparisonIdentity);
  expect(new Set(identities).size).toBe(identities.length);
  expect(
    findings.filter((finding) => finding.verdict === "violation"),
    "Template observations remain observed differences until an explicit text rule is violated.",
  ).toEqual([]);
  const templateById = new Map(template.objects.map((object) => [object.object_id, object]));
  const manuscriptById = new Map(manuscript.objects.map((object) => [object.object_id, object]));
  for (const finding of findings) {
    const observedObject = manuscriptById.get(String(finding.object_id));
    expect(observedObject, JSON.stringify(finding)).toBeTruthy();
    expect(observedObject).toMatchObject({
      kind: finding.kind,
      role: finding.role,
      part: finding.part,
      path: finding.path,
    });
    expect(Array.isArray(observedObject!.role_basis)).toBe(true);
    expect(Array.isArray(finding.role_basis)).toBe(true);
    for (const basis of finding.role_basis as Record<string, unknown>[]) {
      expect(basis).toMatchObject({
        source: expect.any(String),
        certainty: expect.any(String),
      });
    }
    expect(typeof finding.property_path).toBe("string");
    if (finding.role !== "unknown") {
      expect((finding.role_basis as unknown[]).length, JSON.stringify(finding)).toBeGreaterThan(0);
      const templateIds = finding.template_object_ids;
      expect(Array.isArray(templateIds) && templateIds.length, JSON.stringify(finding)).toBeTruthy();
      expect((finding.template_role_basis as unknown[]).length, JSON.stringify(finding)).toBeGreaterThan(0);
      for (const basis of finding.template_role_basis as Record<string, unknown>[]) {
        expect(basis).toMatchObject({
          source: expect.any(String),
          certainty: expect.any(String),
        });
      }
      for (const templateId of templateIds as string[]) {
        const templateObject = templateById.get(templateId);
        expect(templateObject, JSON.stringify(finding)).toMatchObject({
          kind: finding.kind,
          role: finding.role,
        });
        expect(templateObject!.role_basis.length).toBeGreaterThan(0);
      }
    }
  }
}

function snapshotIn(value: unknown): FormatSnapshot {
  let found: FormatSnapshot | null = null;
  walk(value, (item) => {
    if (
      item.schema_version === 1 &&
      typeof item.source_sha256 === "string" &&
      Array.isArray(item.parts) &&
      Array.isArray(item.objects)
    ) found = item as unknown as FormatSnapshot;
  });
  if (!found) throw new Error("The DOCX query did not return a format snapshot.");
  return found;
}

test("template DOCX drives the live editor, saved baseline and explicit recheck", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const browserBase = (process.env.OLEAFLY_BROWSER_TEST_URL ?? DEFAULT_BROWSER_URL).replace(/\/$/, "");
  const evidenceParent = resolve(
    process.env.OLEAFLY_TEMPLATE_OUTPUT ?? ".private/journal-template-acceptance",
  );
  await mkdir(evidenceParent, { recursive: true });
  const root = await mkdtemp(resolve(evidenceParent, "run-"));
  const templateBytes = templateFixture();
  const manuscriptBytes = manuscriptFixture();
  const matrixBytes = effectiveFormatMatrix();
  const templatePath = resolve(root, "template.docx");
  const manuscriptPath = resolve(root, "manuscript.docx");
  const matrixPath = resolve(root, "effective-format-matrix.docx");
  await Promise.all([
    writeFile(templatePath, templateBytes),
    writeFile(manuscriptPath, manuscriptBytes),
    writeFile(matrixPath, matrixBytes),
  ]);
  const initialHashes = {
    template: sha256(templateBytes),
    manuscript: sha256(manuscriptBytes),
    matrix: sha256(matrixBytes),
  };
  const report: Record<string, unknown> = {
    outcome: "RUNNING",
    browserBase,
    evidence: root,
    integration:
      "actual Workbench HTTP, actual @docx-editor core adapter, real React DOCX dialog/tools; Tauri recovery commands scripted",
    initialHashes,
    requests: [] as RequestRecorder[],
    stages: [] as Record<string, unknown>[],
  };
  const requests = report.requests as RequestRecorder[];
  const stages = report.stages as Record<string, unknown>[];
  let stage = "starting Workbench";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let service: WorkbenchProcess | undefined;
  try {
    service = await startWorkbench(resolve(root, "library"));
    browser = await chromium.launch({ channel: "chrome" });
    const corePage = await browser.newPage();
    await corePage.goto(`${browserBase}/e2e/journal-template-core.html`);
    stage = "computing independent core snapshots";
    const [templateSnapshot, manuscriptSnapshot, matrixSnapshot] = await Promise.all([
      coreSnapshot(corePage, templateBytes),
      coreSnapshot(corePage, manuscriptBytes),
      coreSnapshot(corePage, matrixBytes),
    ]);
    expect(templateSnapshot.source_sha256).toBe(initialHashes.template);
    expect(manuscriptSnapshot.source_sha256).toBe(initialHashes.manuscript);
    expect(matrixSnapshot.source_sha256).toBe(initialHashes.matrix);
    const matrix = {
      sameStyleTen: runFor(matrixSnapshot, "same-style-ten"),
      sameStyleTwelve: runFor(matrixSnapshot, "same-style-twelve"),
      differentStyleTwelve: runFor(matrixSnapshot, "different-style-twelve"),
      inheritanceTwelve: runFor(matrixSnapshot, "inheritance-twelve"),
    };
    expect(matrix.sameStyleTen).toMatchObject({ styleId: "BodyChild", role: "body", size: 10 });
    expect(matrix.sameStyleTwelve).toMatchObject({ styleId: "BodyChild", role: "body", size: 12 });
    expect(matrix.differentStyleTwelve).toMatchObject({ styleId: "BodyAlias", role: "body", size: 12 });
    expect(matrix.inheritanceTwelve).toMatchObject({ styleId: "BodyChild", role: "body", size: 12 });
    expect(matrixSnapshot.parts.some((part) => part.name.endsWith("/customXml/item1.xml"))).toBe(true);
    expect(matrixSnapshot.parts.some((part) => part.name.endsWith("/word/media/raw.bin"))).toBe(true);
    expect(manuscriptSnapshot.objects.some((object) => object.kind === "unsupported_node")).toBe(true);
    stages.push({ stage: "effective-format-matrix", matrix, snapshot: matrixSnapshot.source_sha256 });
    await writeFile(resolve(root, "effective-format-matrix.json"), JSON.stringify(matrix, null, 2));

    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request<T>(path: string, payload?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetch(new URL(path, service!.url), {
          method: payload === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            Connection: "close",
            "X-RFW-Token": session.token,
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
      } catch (cause) {
        const diagnostics = service?.stderr().trim();
        throw new Error(
          `Workbench request ${path} failed; child exit=${service?.child.exitCode ?? "running"}` +
            `${diagnostics ? `; stderr=${diagnostics}` : ""}: ${String(cause)}`,
        );
      }
      const text = await response.text();
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
      const contentBase64 =
        payload && typeof payload === "object" && "content_base64" in payload
          ? (payload as { content_base64?: unknown }).content_base64
          : undefined;
      requests.push({
        path,
        method: payload === undefined ? "GET" : "POST",
        status: response.status,
        ...(typeof contentBase64 === "string"
          ? { request_sha256: sha256(bytesFromBase64(contentBase64)) }
          : {}),
        response: result,
      });
      if (!response.ok) {
        const message =
          result && typeof result === "object" && "error" in result
            ? String((result as { error: unknown }).error)
            : text;
        throw new Error(`${response.status} ${path}: ${message}`);
      }
      return result as T;
    }

    stage = "creating template world";
    const world = await request<JournalWorld>("/api/template-world", {
      journal_id: "oleafly-template-acceptance",
      journal_name: "Oleafly template acceptance",
      article_type: "research_article",
      stage: "initial_submission",
      language: "en",
      original: { filename: "template.docx", content_base64: base64(templateBytes) },
      normalized: {
        filename: "template-normalized.docx",
        content_base64: base64(templateBytes),
        provenance: null,
      },
      snapshot: templateSnapshot,
      sources: [],
    });
    expect(world.version_id).toBeTruthy();
    expect(world.template).toMatchObject({
      original_sha256: initialHashes.template,
      source_sha256: initialHashes.template,
    });

    stage = "creating manuscript project";
    const project = await request<{ project_id: string; baseline_id: string }>("/api/projects", {
      name: "Template acceptance manuscript",
      filename: "manuscript.docx",
      content_base64: base64(manuscriptBytes),
    });

    stage = "querying retained template facts";
    const templateQuery = await request<unknown>("/api/docx-query", {
      target: { world_version_id: world.version_id },
      operation: "snapshot",
    });
    const queriedTemplateSnapshot = snapshotIn(templateQuery);
    expect(queriedTemplateSnapshot.source_sha256).toBe(initialHashes.template);
    const templateNodes = await request<unknown>("/api/docx-query", {
      target: { world_version_id: world.version_id },
      operation: "nodes",
      part: "/word/document.xml",
      offset: 0,
      limit: 20,
    });
    expect(JSON.stringify(templateNodes)).toContain("nodes");
    const relationships = await request<unknown>("/api/docx-query", {
      target: { world_version_id: world.version_id },
      operation: "relationships",
    });
    expect(JSON.stringify(relationships)).toContain("custom");
    const customPart = await request<unknown>("/api/docx-query", {
      target: { world_version_id: world.version_id },
      operation: "part",
      part: "/customXml/item1.xml",
    });
    const customPartFacts = queriedTemplateSnapshot.parts.find((part) =>
      part.name.endsWith("/customXml/item1.xml"),
    );
    expect(customPartFacts).toBeTruthy();
    expect(JSON.stringify(customPart)).toContain(customPartFacts!.sha256);
    stages.push({
      stage: "template-world",
      world,
      project,
      templateQuery,
      templateNodes,
      relationships,
      customPart,
    });

    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const pageErrors: string[] = [];
    const failedAssets: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && /docx-editor|harfbuzz|\.wasm|\.ttf|\.otf/.test(response.url())) {
        failedAssets.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.exposeFunction("journalTemplateRequest", request);
    await page.addInitScript(() => {
      let callback = 0;
      const recoveries = new Map<string, any>();
      Object.assign(window, {
        __journalTemplateRecovery: recoveries,
        __TAURI_INTERNALS__: {
          transformCallback: () => ++callback,
          unregisterCallback: () => {},
          invoke: async (command: string, args: any = {}) => {
            if (command === "journal_workbench_request") {
              return (window as any).journalTemplateRequest(args.path, args.payload ?? undefined);
            }
            if (command === "docx_recovery_save") {
              const input = args.request;
              const bytes = Uint8Array.from(atob(input.contentBase64), (char) => char.charCodeAt(0));
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
              const contentSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
              const metadata = {
                appProjectId: input.appProjectId,
                workbenchProjectId: input.workbenchProjectId,
                baseBaselineId: input.baseBaselineId,
                sourceSha256: input.sourceSha256,
                recoveryKey: input.recoveryKey,
                revision: input.revision,
                updatedAt: input.updatedAt,
                contentSha256,
                taskState: input.taskState,
              };
              recoveries.set(`${input.recoveryKey}:${contentSha256}`, { ...metadata, request: input });
              return metadata;
            }
            if (command === "docx_recovery_commit") {
              const key = `${args.request.recoveryKey}:${args.request.contentSha256}`;
              const recovery = recoveries.get(key);
              if (!recovery?.request.taskState?.pendingSave) {
                throw new Error(`Unknown DOCX recovery commit ${key}`);
              }
              const pending = recovery.request.taskState.pendingSave;
              const result = await (window as any).journalTemplateRequest("/api/baseline", {
                project_id: pending.projectId,
                expected_baseline_id: pending.expectedBaselineId,
                filename: pending.filename,
                content_base64: recovery.request.contentBase64,
                reason: pending.reason,
                request_id: pending.requestId,
              });
              recovery.committed = {
                baselineId: result.result_baseline_id,
                sourceSha256: recovery.contentSha256,
                revision: recovery.revision,
              };
              return recovery.committed;
            }
            if (command === "docx_recovery_read") return null;
            if (command === "docx_recovery_clear") return true;
            if (command === "docx_recovery_list") return { snapshots: [], failures: [] };
            if (command === "docx_recovery_resume") return [];
            if (command === "journal_docx_renderer") return null;
            if (command === "journal_docx_render") return null;
            if (command === "resolve_system_font_faces") {
              return { faces: [], missing: args.requests ?? [] };
            }
            if (command.startsWith("plugin:")) return 1;
            throw new Error(`Unexpected journal-template acceptance IPC: ${command}`);
          },
        },
      });
    });
    stage = "opening real DOCX dialog";
    await page.goto(`${browserBase}/e2e/journal-template-harness.html`);
    await expect(page.getByTestId("docx-workspace")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".docx-paragraph-fragment").filter({ hasText: "Synthetic body target" })).toBeVisible({
      timeout: 90_000,
    });

    const initialRead = await page.evaluate(async () =>
      (window as any).__docxTools.read_docx_document.execute({}),
    );
    expect(initialRead).toMatchObject({
      document: {
        appProjectId: "journal-template-harness",
        workbenchProjectId: project.project_id,
        baselineId: project.baseline_id,
        sessionRevision: 0,
        savedRevision: 0,
        dirty: false,
      },
    });
    const targetRead = initialRead.paragraphs.find((item: { text: string }) =>
      item.text.includes("Synthetic body target"),
    );
    expect(targetRead).toBeTruthy();
    const beforeFormat = await page.evaluate(async (paragraphRef) =>
      (window as any).__docxTools.read_docx_format.execute({
        query: { paragraph_ref: paragraphRef, kind: "objects", limit: 20 },
      }),
    targetRead.paragraphRef);
    expect(beforeFormat).toMatchObject({
      document: { dirty: false, sessionRevision: 0 },
      paragraph: {
        paragraphRef: targetRead.paragraphRef,
        font: { size: 10 },
        paragraph: { style: "Body" },
      },
    });
    expect(beforeFormat.sourceSha256).toMatch(/^[a-f0-9]{64}$/);

    stage = "checking mismatched saved template baseline";
    const beforeCheckResult = await page.evaluate(async (template) =>
      (window as any).__docxTools.check_docx_template.execute({ template }),
    world.version_id);
    const beforeCheck = beforeCheckResult.check as JournalCheck;
    expect(beforeCheck).toMatchObject({
      project_id: project.project_id,
      baseline_id: project.baseline_id,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    const beforeFontFinding = comparisonFindings(beforeCheck.template_comparison).find(
      (finding) =>
        finding.property_path === "run.fontSizePt" &&
        finding.role === "body" &&
        finding.observed === 10 &&
        finding.expected === 14,
    );
    expect(beforeFontFinding, JSON.stringify(beforeCheck, null, 2)).toBeTruthy();
    expect(beforeFontFinding!.verdict).toBe("observed_difference");
    expect(beforeFontFinding!.case_id).toEqual(expect.stringMatching(/^case-[a-f0-9]{64}$/));
    expect(beforeFontFinding!.role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "style_id", value: "Body" }),
    ]));
    expect(beforeFontFinding!.template_role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "style_id", value: "Body" }),
    ]));
    stages.push({ stage: "check-before-format", result: beforeCheckResult, finding: beforeFontFinding });

    stage = "applying direct fourteen point body format";
    const formatApplied = await page.evaluate(async ({ paragraphRef, expectedRevision }) =>
      (window as any).__docxTools.apply_docx_format.execute({
        paragraph_ref: paragraphRef,
        expected_revision: expectedRevision,
        font: { size: 14 },
      }),
    { paragraphRef: targetRead.paragraphRef, expectedRevision: beforeFormat.revision });
    expect(formatApplied).toMatchObject({
      ok: true,
      changed: true,
      document: { dirty: true, sessionRevision: 1 },
    });
    const afterFormat = await page.evaluate(async (paragraphRef) =>
      (window as any).__docxTools.read_docx_format.execute({
        query: { paragraph_ref: paragraphRef, kind: "objects", limit: 20 },
      }),
    targetRead.paragraphRef);
    expect(afterFormat).toMatchObject({
      revision: 1,
      paragraph: { font: { size: 14 }, paragraph: { style: "Body" } },
    });
    await expect(page.locator(".docx-paragraph-fragment").filter({ hasText: "Synthetic body target" })).toBeVisible();

    stage = "saving through the dialog recovery commit chain";
    const saved = await page.evaluate(async (expectedRevision) =>
      (window as any).__docxTools.save_docx_document.execute({ expected_revision: expectedRevision }),
    formatApplied.document.sessionRevision);
    expect(saved).toMatchObject({
      revision: 1,
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      document: { savedRevision: 1, sessionRevision: 1, dirty: false },
    });
    expect(saved.baselineId).not.toBe(project.baseline_id);
    await expect(page.getByTestId("docx-save-state")).toContainText(
      "Retained DOCX version loaded or saved",
      { timeout: 30_000 },
    );
    await expect(page.locator(`[title="${saved.baselineId}"]`)).toBeVisible({ timeout: 30_000 });

    stage = "rechecking saved fourteen point baseline";
    await expect.poll(async () => {
      const state = await request<any>("/api/state");
      return state.projects.find((item: any) => item.project_id === project.project_id)?.baseline_id;
    }).toBe(saved.baselineId);
    const afterCheckResult = await page.evaluate(async (template) =>
      (window as any).__docxTools.check_docx_template.execute({ template }),
    world.version_id);
    const afterCheck = afterCheckResult.check as JournalCheck;
    expect(afterCheck).toMatchObject({
      project_id: project.project_id,
      baseline_id: saved.baselineId,
      world_version_id: world.version_id,
      validity: "CURRENT",
    });
    const afterFontFinding = comparisonFindings(afterCheck.template_comparison).find(
      (finding) => finding.case_id === beforeFontFinding!.case_id,
    );
    expect(afterFontFinding, JSON.stringify(afterCheck, null, 2)).toBeTruthy();
    expect(afterFontFinding).toMatchObject({
      property_path: "run.fontSizePt",
      role: "body",
      observed: 14,
      expected: 14,
      verdict: "observed_match",
    });
    expect(afterFontFinding!.role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "style_id", value: "Body" }),
    ]));
    expect(afterFontFinding!.template_role_basis).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "style_id", value: "Body" }),
    ]));
    stages.push({ stage: "format-save-recheck", formatApplied, saved, result: afterCheckResult, finding: afterFontFinding });

    stage = "inspecting saved package preservation";
    const savedSource = await request<{ content_base64: string; source_sha256: string }>(
      `/api/manuscript-source?project_id=${encodeURIComponent(project.project_id)}&baseline_id=${encodeURIComponent(saved.baselineId as string)}`,
    );
    const savedBytes = bytesFromBase64(savedSource.content_base64);
    expect(savedSource.source_sha256).toBe(saved.sourceSha256);
    expect(sha256(savedBytes)).toBe(saved.sourceSha256);
    const sourceZip = unzipSync(manuscriptBytes);
    const savedZip = unzipSync(savedBytes);
    expect(new TextDecoder().decode(savedZip["customXml/item1.xml"])).toBe(
      new TextDecoder().decode(sourceZip["customXml/item1.xml"]),
    );
    expect(savedZip["word/media/raw.bin"]).toEqual(sourceZip["word/media/raw.bin"]);
    const savedRelationships = new TextDecoder().decode(savedZip["word/_rels/document.xml.rels"]);
    expect(savedRelationships).toContain('Id="custom"');
    expect(savedRelationships).toContain('Id="raw"');
    const savedDocumentXml = new TextDecoder().decode(savedZip["word/document.xml"]);
    expect(savedDocumentXml).toContain("Synthetic body target");
    expect(savedDocumentXml).toContain("Retained table cell");
    expect(savedDocumentXml).toContain("customXml");
    expect(savedDocumentXml).toContain("tracking");
    expect(savedDocumentXml).toContain('<w:sz w:val="28"/>');
    const manuscriptQuery = await request<unknown>("/api/docx-query", {
      target: { project_id: project.project_id, baseline_id: saved.baselineId },
      operation: "snapshot",
    });
    expect(snapshotIn(manuscriptQuery).source_sha256).toBe(saved.sourceSha256);
    const manuscriptNodes = await request<unknown>("/api/docx-query", {
      target: { project_id: project.project_id, baseline_id: saved.baselineId },
      operation: "nodes",
      part: "/word/document.xml",
      offset: 0,
      limit: 40,
    });
    expect(JSON.stringify(manuscriptNodes)).toContain("nodes");
    expect(sha256(await readFile(templatePath))).toBe(initialHashes.template);
    expect(sha256(await readFile(manuscriptPath))).toBe(initialHashes.manuscript);
    expect(sha256(await readFile(matrixPath))).toBe(initialHashes.matrix);
    await writeFile(resolve(root, "saved-source.docx"), savedBytes);
    await page.screenshot({ path: resolve(root, "template-editor-after-save.png") });

    expect(pageErrors, JSON.stringify(pageErrors)).toEqual([]);
    expect(failedAssets, JSON.stringify(failedAssets)).toEqual([]);
    report.outcome = "PASSED";
    stages.push({
      stage: "package-preservation",
      savedSha256: saved.sourceSha256,
      inputHashesUnchanged: initialHashes,
      unknownXmlPart: true,
      unknownXmlNode: savedDocumentXml.includes("customXml"),
      rawPartBytesEqual: true,
      directSizeHalfPoints: 28,
      manuscriptQuery,
      manuscriptNodes,
    });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.failedStage = report.outcome === "PASSED" ? null : stage;
    await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("journal-template-report", {
      path: resolve(root, "report.json"),
      contentType: "application/json",
    });
    await browser?.close();
    if (service) await stopWorkbench(service);
  }
});

const realAcceptance = process.env.OLEAFLY_TEMPLATE_ACCEPTANCE === "1";

test("opt-in real template and English/Chinese manuscripts use the same template contract", async ({}, testInfo) => {
  test.skip(!realAcceptance, "Set OLEAFLY_TEMPLATE_ACCEPTANCE=1 to read the authorized local inputs.");
  test.setTimeout(600_000);
  const inputs = [
    process.env.OLEAFLY_TEMPLATE_FILE ?? ".private/journal-template-acceptance/template.docx",
    process.env.OLEAFLY_REAL_DOCX_EN ??
      "/Volumes/Studio/Research/研/交付文件/英文稿/IJAM_english_working.docx",
    process.env.OLEAFLY_REAL_DOCX_ZH ??
      "/Volumes/Studio/Research/研/交付文件/中文稿/批注.docx",
  ];
  const paths = await Promise.all(inputs.map((path) => realpath(path)));
  const before = await Promise.all(paths.map((path) => readFile(path)));
  for (const path of paths) expect(existsSync(path), `${path} must be an authorized read-only input`).toBe(true);
  const browserBase = (process.env.OLEAFLY_BROWSER_TEST_URL ?? DEFAULT_BROWSER_URL).replace(/\/$/, "");
  const evidenceParent = resolve(
    process.env.OLEAFLY_TEMPLATE_OUTPUT ?? ".private/journal-template-acceptance",
  );
  await mkdir(evidenceParent, { recursive: true });
  const root = await mkdtemp(resolve(evidenceParent, "real-"));
  const report: Record<string, unknown> = {
    outcome: "RUNNING",
    inputs: paths,
    before: before.map((bytes) => sha256(bytes)),
    worldsAndChecks: [] as unknown[],
    evidence: root,
  };
  const worldsAndChecks = report.worldsAndChecks as unknown[];
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  let service: WorkbenchProcess | undefined;
  try {
    await page.goto(`${browserBase}/e2e/journal-template-core.html`);
    const snapshots = await Promise.all(before.map((bytes) => coreSnapshot(page, new Uint8Array(bytes))));
    for (let index = 0; index < paths.length; index++) {
      const source = new Uint8Array(before[index]);
      expect(snapshots[index].source_sha256).toBe(sha256(source));
      expect(snapshots[index].parts.length).toBeGreaterThan(0);
      expect(snapshots[index].objects.some((object) => object.kind === "paragraph")).toBe(true);
    }
    expect(snapshots[1].objects.some((object) => object.role === "body")).toBe(true);
    expect(snapshots[2].objects.some((object) => object.role === "body")).toBe(true);

    service = await startWorkbench(resolve(root, "library"));
    const session = await (await fetch(`${service.url}api/session`)).json();
    async function request<T>(path: string, payload?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetch(new URL(path, service!.url), {
          method: payload === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            Connection: "close",
            "X-RFW-Token": session.token,
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
      } catch (cause) {
        const diagnostics = service?.stderr().trim();
        throw new Error(
          `Workbench request ${path} failed; child exit=${service?.child.exitCode ?? "running"}` +
            `${diagnostics ? `; stderr=${diagnostics}` : ""}: ${String(cause)}`,
        );
      }
      const result = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${path}: ${result.error}`);
      return result as T;
    }
    async function findingsPage(
      checkId: string,
      options: {
        offset?: number;
        limit?: number;
        verdict?: string;
        role?: string;
        property_path?: string;
      } = {},
    ): Promise<FindingsPage> {
      try {
        return await request<FindingsPage>("/api/docx-query", {
          target: { check_id: checkId },
          operation: "findings",
          limit: 1_000,
          ...options,
        });
      } catch (cause) {
        throw new Error(
          `Findings page ${checkId} at offset ${options.offset ?? 0} failed: ${String(cause)}`,
        );
      }
    }
    const template = before[0];
    const templateSnapshot = snapshots[0];
    const world = await request<JournalWorld>("/api/template-world", {
      journal_id: "real-journal-template-acceptance",
      journal_name: "Real journal template acceptance",
      article_type: "research_article",
      stage: "initial_submission",
      language: "en",
      original: { filename: paths[0].split("/").at(-1), content_base64: base64(template) },
      normalized: {
        filename: paths[0].split("/").at(-1),
        content_base64: base64(template),
        provenance: null,
      },
      snapshot: templateSnapshot,
      sources: [],
    });
    expect(world.template.source_sha256).toBe(sha256(template));
    for (const index of [1, 2]) {
      const manuscript = before[index];
      const snapshot = snapshots[index];
      const project = await request<{ project_id: string; baseline_id: string }>("/api/projects", {
        name: `Real template acceptance ${index === 1 ? "English" : "Chinese"}`,
        filename: paths[index].split("/").at(-1),
        content_base64: base64(manuscript),
      });
      await request("/api/docx-format", {
        project_id: project.project_id,
        baseline_id: project.baseline_id,
        snapshot,
      });
      const check = await request<JournalCheck>("/api/template-check", {
        project_id: project.project_id,
        expected_baseline_id: project.baseline_id,
        world_version_id: world.version_id,
        expected_binding_id: null,
        request_id: `real-template-${randomUUID()}`,
        origin: { surface: "user" },
      });
      const repeatedCheck = await request<JournalCheck>("/api/template-check", {
        project_id: project.project_id,
        expected_baseline_id: project.baseline_id,
        world_version_id: world.version_id,
        expected_binding_id: check.binding_id ?? null,
        request_id: `real-template-repeat-${randomUUID()}`,
        origin: { surface: "user" },
      });
      expect(check).toMatchObject({
        project_id: project.project_id,
        baseline_id: project.baseline_id,
        world_version_id: world.version_id,
        validity: "CURRENT",
      });
      expect(Array.isArray(check.rule_results)).toBe(true);
      const comparison = check.template_comparison!;
      const repeatedComparison = repeatedCheck.template_comparison!;
      expect(comparison.findings.length).toBeLessThanOrEqual(100);
      expect(comparison.total).toBeGreaterThanOrEqual(comparison.findings.length);
      expect(comparison.has_more).toBe(comparison.total > comparison.findings.length);
      expect(comparison.next_offset).toBe(comparison.has_more ? comparison.findings.length : null);
      expect(comparison.findings_artifact_version_id).toMatch(/^artifact-version-[a-f0-9]{64}$/);
      assertRoleComparisonFindings(comparison.findings, templateSnapshot, snapshot);
      expect(repeatedComparison).toMatchObject({
        total: comparison.total,
        finding_summary: comparison.finding_summary,
        findings_artifact_version_id: comparison.findings_artifact_version_id,
      });
      expect(comparisonDigest(repeatedComparison.findings)).toBe(comparisonDigest(comparison.findings));
      expect(repeatedCheck.summary).toEqual(check.summary);

      const caseIds = new Set<string>();
      const caseDigest = createHash("sha256");
      const observedById = new Map(snapshot.objects.map((object) => [object.object_id, object]));
      let offset = 0;
      let pageCount = 0;
      while (true) {
        const retainedPage = await findingsPage(check.check_id, { offset, limit: 1_000 });
        expect(retainedPage).toMatchObject({
          schema_version: 1,
          operation: "findings",
          check_id: check.check_id,
          source_sha256: check.source_sha256,
          total: comparison.total,
        });
        for (const finding of retainedPage.findings) {
          const caseId = String(finding.case_id);
          if (!/^case-[a-f0-9]{64}$/.test(caseId)) {
            throw new Error(`Invalid retained case ID: ${caseId}`);
          }
          const observedObject = observedById.get(String(finding.object_id));
          if (
            !observedObject ||
            observedObject.kind !== finding.kind ||
            observedObject.role !== finding.role ||
            observedObject.part !== finding.part ||
            JSON.stringify(observedObject.path) !== JSON.stringify(finding.path)
          ) {
            throw new Error(`Finding ${caseId} does not locate its observed snapshot object`);
          }
          if (caseIds.has(caseId)) throw new Error(`Duplicate retained case ${caseId}`);
          caseIds.add(caseId);
          caseDigest.update(`${caseId}\0`);
        }
        pageCount += 1;
        if (!retainedPage.has_more) {
          expect(retainedPage.next_offset).toBeNull();
          break;
        }
        expect(retainedPage.next_offset).toBe(offset + retainedPage.findings.length);
        offset = retainedPage.next_offset!;
      }
      expect(pageCount).toBe(Math.ceil(comparison.total / 1_000));
      expect(caseIds.size).toBe(comparison.total);

      const differencePage = await findingsPage(check.check_id, {
        offset: 0,
        limit: 1_000,
        verdict: "observed_difference",
      });
      expect(differencePage.total).toBeGreaterThan(0);
      const sampleFinding = differencePage.findings.find(
        (finding) => finding.role !== "unknown" && typeof finding.property_path === "string",
      );
      expect(sampleFinding, JSON.stringify(differencePage.findings.slice(0, 10))).toBeTruthy();
      const sample = await findingsPage(check.check_id, {
        offset: 0,
        limit: 100,
        verdict: "observed_difference",
        role: String(sampleFinding!.role),
        property_path: String(sampleFinding!.property_path),
      });
      expect(sample.total).toBeGreaterThan(0);
      for (const finding of sample.findings) {
        expect(finding).toMatchObject({
          verdict: "observed_difference",
          role: sampleFinding!.role,
          property_path: sampleFinding!.property_path,
        });
        expect(caseIds.has(String(finding.case_id))).toBe(true);
      }
      assertRoleComparisonFindings(sample.findings, templateSnapshot, snapshot);
      const query = await request<unknown>("/api/docx-query", {
        target: { project_id: project.project_id, baseline_id: project.baseline_id },
        operation: "snapshot",
      });
      expect(snapshotIn(query).source_sha256).toBe(sha256(manuscript));
      worldsAndChecks.push({
        index,
        project,
        check,
        repeatedCheck,
        findingCount: comparison.total,
        findingPages: pageCount,
        findingArtifact: comparison.findings_artifact_version_id,
        caseIdDigest: caseDigest.digest("hex"),
        sample: {
          role: sampleFinding!.role,
          propertyPath: sampleFinding!.property_path,
          total: sample.total,
          cases: sample.findings.map((finding) => finding.case_id),
        },
        snapshot: snapshot.source_sha256,
      });
    }
    report.outcome = "PASSED";
  } finally {
    await browser.close();
    if (service) await stopWorkbench(service);
    await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("journal-template-real-report", {
      path: resolve(root, "report.json"),
      contentType: "application/json",
    });
  }
  const after = await Promise.all(paths.map((path) => readFile(path)));
  expect(after.map((bytes) => sha256(bytes))).toEqual(before.map((bytes) => sha256(bytes)));
});

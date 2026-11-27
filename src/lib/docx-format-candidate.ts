import {
  readOoxmlPart,
  readZip,
  WML_NAMESPACE_URI,
  type OoxmlElement,
  type OoxmlNode,
} from "@docx-editor.dev/core/store";
import { bytesToBase64 } from "@/lib/base64";
import { docxContentSha256 } from "@/lib/docx-recovery";
import type { DocxCandidateReviewRecord } from "@/lib/docx-format-candidate-review";
import { loadDocxSource, saveDocxBaseline, type DocxSource } from "@/lib/docx-workbench";
import { journalRequest, JournalWorkbenchError, type JournalBinding, type JournalProject } from "@/lib/journal-workbench";

export const DOCX_FORMAT_CANDIDATE_VALIDATION_VERSION = "docx-pure-format-1.4.0";

const MC_NAMESPACE_URI = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const OMML_NAMESPACE_URI = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W14_NAMESPACE_URI = "http://schemas.microsoft.com/office/word/2010/wordml";
const XML_NAMESPACE_URI = "http://www.w3.org/XML/1998/namespace";

const FORMAT_CACHE_ELEMENTS = new Set(["lastRenderedPageBreak", "proofErr"]);
const EDITABLE_PARAGRAPH_PROPERTIES = new Map<string, ReadonlySet<string>>([
  ["ind", new Set(["left", "right", "start", "end", "firstLine", "hanging"])],
  ["jc", new Set(["val"])],
  ["spacing", new Set(["before", "after"])],
]);
const EDITABLE_RUN_PROPERTIES = new Map<string, ReadonlySet<string>>([
  ["b", new Set(["val"])],
  ["i", new Set(["val"])],
  ["rFonts", new Set(["ascii", "hAnsi", "eastAsia", "asciiTheme", "hAnsiTheme", "eastAsiaTheme"])],
  ["sz", new Set(["val"])],
  ["szCs", new Set(["val"])],
]);
const REVISION_ELEMENTS = new Set([
  "del",
  "ins",
  "moveFrom",
  "moveTo",
  "numberingChange",
  "pPrChange",
  "rPrChange",
  "sectPrChange",
  "tblGridChange",
  "tblPrChange",
  "tblPrExChange",
  "tcPrChange",
  "trPrChange",
]);
const TEXT_ELEMENTS = new Set(["t", "delText", "instrText", "delInstrText"]);
const DRAWING_ELEMENTS = new Set(["drawing", "pict", "object"]);
const MC_PREFIX_LISTS = new Set(["Ignorable", "MustUnderstand"]);
const MC_QNAME_LISTS = new Set(["ProcessContent", "PreserveElements", "PreserveAttributes"]);

export type DocxFormatCandidateIssueCode =
  | "invalid_docx"
  | "package_entry_added"
  | "package_entry_removed"
  | "text_changed"
  | "formula_changed"
  | "image_changed"
  | "row_properties_changed"
  | "binary_part_changed"
  | "content_structure_changed"
  | "xml_unreadable";

export interface DocxFormatCandidateIssue {
  code: DocxFormatCandidateIssueCode;
  part?: string;
  detail: string;
}

export interface DocxFormatCandidateByteValidation {
  status: "accepted" | "rejected";
  methodVersion: typeof DOCX_FORMAT_CANDIDATE_VALIDATION_VERSION;
  sourceSha256: string;
  candidateSha256: string;
  changedParts: readonly string[];
  issues: readonly DocxFormatCandidateIssue[];
}

type CanonicalNode =
  | ["e", string, string, readonly (readonly [string, string, string])[], readonly CanonicalNode[]]
  | ["t", string];

interface CanonicalContext {
  insideTable: boolean;
  comments: boolean;
  namespaces: ReadonlyMap<string, string>;
}

const ROOT_CONTEXT: CanonicalContext = { insideTable: false, comments: false, namespaces: new Map() };

interface ParsedXmlPart {
  root: OoxmlElement;
  canonical: string;
  protected: string;
  text: string;
  formulas: string;
  drawings: string;
}

function nonBlank(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new Error(`${label} must be nonblank text.`);
  return value;
}

function logicalPartName(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

function isXmlPart(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xml") || lower.endsWith(".rels");
}

function isMediaPart(name: string): boolean {
  return logicalPartName(name).toLowerCase().startsWith("/word/media/");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function ignoredAttribute(namespaceUri: string, localName: string, node: OoxmlElement, comments: boolean): boolean {
  if (namespaceUri === XML_NAMESPACE_URI && localName === "space") {
    return TEXT_ELEMENTS.has(node.localName) && !node.children.some((child) =>
      child.kind !== "textValue" || /^[ \t\r\n]|[ \t\r\n]$/u.test(child.value));
  }
  if (namespaceUri === W14_NAMESPACE_URI || namespaceUri === WML_NAMESPACE_URI) {
    if (localName === "paraId") return !comments;
    if (localName === "textId") return true;
  }
  return namespaceUri === WML_NAMESPACE_URI && localName.startsWith("rsid");
}

function editableFormattingAttributes(node: OoxmlElement, parent: OoxmlElement | undefined): ReadonlySet<string> | undefined {
  if (node.namespaceUri !== WML_NAMESPACE_URI || parent?.namespaceUri !== WML_NAMESPACE_URI) return undefined;
  const properties = parent.localName === "pPr" ? EDITABLE_PARAGRAPH_PROPERTIES
    : parent.localName === "rPr" ? EDITABLE_RUN_PROPERTIES : undefined;
  return properties?.get(node.localName);
}

function compatibilityAttributeValue(
  node: OoxmlElement,
  { namespaceUri, localName, value }: OoxmlElement["attributes"][number],
  namespaces: ReadonlyMap<string, string>,
): string {
  const qnames = namespaceUri === MC_NAMESPACE_URI && MC_QNAME_LISTS.has(localName);
  const prefixes = (namespaceUri === MC_NAMESPACE_URI && MC_PREFIX_LISTS.has(localName)) ||
    (!namespaceUri && localName === "Requires" && node.namespaceUri === MC_NAMESPACE_URI && node.localName === "Choice");
  if (!qnames && !prefixes) return value;
  return stableJson((value.match(/[^ \t\r\n]+/g) ?? []).map((token) => {
    const colon = qnames ? token.indexOf(":") : -1;
    const prefix = colon < 0 ? token : token.slice(0, colon);
    return [namespaces.get(prefix) ?? prefix, colon < 0 ? "" : token.slice(colon + 1)];
  }));
}

function isTextValue(value: string, parentName: string): boolean {
  return TEXT_ELEMENTS.has(parentName) || /\S/u.test(value);
}

function elementContext(node: OoxmlElement, parent: CanonicalContext): CanonicalContext {
  const isWord = node.namespaceUri === WML_NAMESPACE_URI;
  const namespaces = node.namespaceBindings.length
    ? new Map([...parent.namespaces, ...node.namespaceBindings.map(({ prefix, namespaceUri }) => [prefix, namespaceUri] as const)])
    : parent.namespaces;
  return {
    namespaces,
    comments: parent.comments || (isWord && node.localName === "comments"),
    insideTable: parent.insideTable || (isWord && node.localName === "tbl"),
  };
}

function canonicalNode(
  node: OoxmlNode,
  mode: "full" | "protected" | "revision" | "formula" | "drawing",
  parent?: OoxmlElement,
  context = ROOT_CONTEXT,
): CanonicalNode | null {
  if (node.kind === "textValue") {
    if ((mode === "protected" || mode === "revision") && !isTextValue(node.value, parent?.localName ?? "")) return null;
    return ["t", node.value];
  }
  const isWord = node.namespaceUri === WML_NAMESPACE_URI;
  if ((mode === "protected" || mode === "revision") && isWord && FORMAT_CACHE_ELEMENTS.has(node.localName)) {
    return null;
  }
  if (mode === "protected" && isWord && node.localName === "trPr" &&
    parent?.namespaceUri === WML_NAMESPACE_URI && parent.localName === "tr") return null;
  const editable = mode === "protected" && !context.insideTable ? editableFormattingAttributes(node, parent) : undefined;
  if (mode === "formula" && node.namespaceUri !== OMML_NAMESPACE_URI) return null;
  if (mode === "drawing" && !(node.namespaceUri === WML_NAMESPACE_URI && DRAWING_ELEMENTS.has(node.localName))) return null;
  const childContext = elementContext(node, context);
  const attributes = node.attributes
    .filter(({ namespaceUri, localName }) => !(namespaceUri === WML_NAMESPACE_URI && editable?.has(localName)) &&
      !ignoredAttribute(namespaceUri, localName, node, childContext.comments))
    .map((attribute) => [attribute.namespaceUri, attribute.localName,
      compatibilityAttributeValue(node, attribute, childContext.namespaces)] as const)
    .sort((left, right) => `${left[0]}\0${left[1]}`.localeCompare(`${right[0]}\0${right[1]}`));
  const childMode = mode === "protected" && isWord && REVISION_ELEMENTS.has(node.localName) ? "revision" : mode;
  const children = node.children
    .map((child) => canonicalNode(child, mode === "formula" || mode === "drawing" ? "full" : childMode, node, childContext))
    .filter((child): child is CanonicalNode => child !== null);
  if (mode === "protected" && isWord && (editable || node.localName === "pPr" || node.localName === "rPr") &&
    attributes.length === 0 && children.length === 0) return null;
  return ["e", node.namespaceUri, node.localName, attributes, children];
}

function featureProjection(root: OoxmlElement, mode: "formula" | "drawing"): string {
  const nodes: CanonicalNode[] = [];
  const walk = (node: OoxmlNode, context: CanonicalContext): void => {
    if (node.kind === "textValue") return;
    const match = mode === "formula"
      ? node.namespaceUri === OMML_NAMESPACE_URI && (node.localName === "oMath" || node.localName === "oMathPara")
      : node.namespaceUri === WML_NAMESPACE_URI && DRAWING_ELEMENTS.has(node.localName);
    if (match) {
      const projected = canonicalNode(node, mode, undefined, context);
      if (projected) nodes.push(projected);
      return;
    }
    const childContext = elementContext(node, context);
    for (const child of node.children) walk(child, childContext);
  };
  walk(root, ROOT_CONTEXT);
  return stableJson(nodes);
}

function parseXmlPart(name: string, bytes: Uint8Array): ParsedXmlPart {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not valid UTF-8 XML.`);
  }
  const contentType = name.toLowerCase().endsWith(".rels")
    ? "application/vnd.openxmlformats-package.relationships+xml"
    : "application/xml";
  const parsed = readOoxmlPart(xml, { name: logicalPartName(name), contentType });
  if (!parsed.ok) throw new Error(`${name} could not be parsed: ${parsed.reason}.`);
  return {
    root: parsed.part.root,
    canonical: stableJson(canonicalNode(parsed.part.root, "full")),
    protected: stableJson(canonicalNode(parsed.part.root, "protected")),
    text: stableJson(parsed.part.root.children.flatMap(function collectText(node: OoxmlNode): string[] {
      if (node.kind === "textValue") return [];
      const own: string[] = node.namespaceUri === WML_NAMESPACE_URI && TEXT_ELEMENTS.has(node.localName)
        ? node.children
          .map((child) => child.kind === "textValue" ? child.value : null)
          .filter((value): value is string => value !== null)
        : [];
      return [...own, ...node.children.flatMap(collectText)];
    })),
    formulas: featureProjection(parsed.part.root, "formula"),
    drawings: featureProjection(parsed.part.root, "drawing"),
  };
}

function packageEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const archive = readZip(bytes);
  if (!archive.ok) {
    throw new Error(
      `The DOCX package could not be read: ${archive.reason}${archive.detail ? ` (${archive.detail})` : ""}.`,
    );
  }
  return new Map(Array.from(archive.entries, ([name, content]) => [logicalPartName(name), content]));
}

function isContentStoryPart(part: ParsedXmlPart): boolean {
  return part.root.namespaceUri === WML_NAMESPACE_URI &&
    ["document", "hdr", "ftr", "footnotes", "endnotes", "comments"].includes(part.root.localName);
}

function rowProperties(root: OoxmlElement) {
  const rows: { containers: OoxmlElement[]; context: CanonicalContext }[] = [];
  const walk = (node: OoxmlNode, parentContext: CanonicalContext): void => {
    if (node.kind === "textValue") return;
    const context = elementContext(node, parentContext);
    if (node.namespaceUri === WML_NAMESPACE_URI && node.localName === "tr") {
      const children: readonly OoxmlNode[] = node.children;
      rows.push({ context, containers: children.filter((entry): entry is OoxmlElement =>
        entry.kind !== "textValue" && entry.namespaceUri === WML_NAMESPACE_URI && entry.localName === "trPr") });
    }
    for (const child of node.children) walk(child, context);
  };
  walk(root, ROOT_CONTEXT);
  return rows;
}

function preservesRowProperties(source: OoxmlElement, candidate: OoxmlElement): boolean {
  const beforeRows = rowProperties(source);
  const afterRows = rowProperties(candidate);
  if (beforeRows.length !== afterRows.length) return false;
  const signature = (containers: readonly OoxmlElement[], context: CanonicalContext) =>
    stableJson(containers.map((container) => canonicalNode(container, "full", undefined, context)));
  return beforeRows.every(({ containers: before, context: beforeContext }, index) => {
    const { containers: after, context: afterContext } = afterRows[index];
    const beforeSignature = signature(before, beforeContext);
    if (after.length !== 1 || before.length > 1) return beforeSignature === signature(after, afterContext);
    const addable = new Set(["cantSplit", "tblHeader"]);
    for (const node of before[0]?.children ?? []) {
      if (node.kind !== "textValue" && node.namespaceUri === WML_NAMESPACE_URI) addable.delete(node.localName);
    }
    const kept = after[0].children.filter((node) => {
      if (node.kind === "textValue" || node.namespaceUri !== WML_NAMESPACE_URI || node.children.length ||
        node.attributes.length > 1 || node.attributes.some((entry) => entry.namespaceUri !== WML_NAMESPACE_URI ||
          entry.localName !== "val" || !["1", "true", "on"].includes(entry.value))) return true;
      return !addable.delete(node.localName);
    });
    if (kept.length === after[0].children.length) return beforeSignature === signature(after, afterContext);
    if (!before.length) return !kept.length && !after[0].attributes.length;
    return beforeSignature === signature([{ ...after[0], children: kept } as OoxmlElement], afterContext);
  });
}

/**
 * Verify that candidate bytes differ from frozen source bytes only in formatting.
 *
 * Binary package entries must match exactly. Main-document XML is compared after removing
 * only supported paragraph and run formatting attributes. Section geometry, table and cell
 * properties, existing row rules, paragraph frames, tabs and page flow, style references,
 * revisions, text, formulas, drawings, and the other stories and package parts stay protected.
 */
export async function validateDocxFormatCandidateBytes(
  sourceBytes: Uint8Array,
  candidateBytes: Uint8Array,
): Promise<DocxFormatCandidateByteValidation> {
  const sourceSha256 = await docxContentSha256(sourceBytes);
  const candidateSha256 = await docxContentSha256(candidateBytes);
  const issues: DocxFormatCandidateIssue[] = [];
  const changedParts = new Set<string>();
  let sourceParts: Map<string, Uint8Array>;
  let candidateParts: Map<string, Uint8Array>;
  try {
    sourceParts = packageEntries(sourceBytes);
    candidateParts = packageEntries(candidateBytes);
  } catch (cause) {
    return {
      status: "rejected",
      methodVersion: DOCX_FORMAT_CANDIDATE_VALIDATION_VERSION,
      sourceSha256,
      candidateSha256,
      changedParts: [],
      issues: [{ code: "invalid_docx", detail: String(cause) }],
    };
  }

  for (const name of sourceParts.keys()) {
    if (!candidateParts.has(name)) {
      issues.push({ code: "package_entry_removed", part: name, detail: `${name} was removed.` });
      if (isMediaPart(name)) {
        issues.push({ code: "image_changed", part: name, detail: `${name} is a protected media part.` });
      }
    }
  }
  for (const name of candidateParts.keys()) {
    if (!sourceParts.has(name)) {
      issues.push({ code: "package_entry_added", part: name, detail: `${name} was added.` });
      if (isMediaPart(name)) {
        issues.push({ code: "image_changed", part: name, detail: `${name} is a protected media part.` });
      }
    }
  }

  for (const [name, source] of sourceParts) {
    const candidate = candidateParts.get(name);
    if (!candidate || equalBytes(source, candidate)) continue;
    changedParts.add(name);
    if (!isXmlPart(name)) {
      issues.push(isMediaPart(name)
        ? { code: "image_changed", part: name, detail: "Media bytes changed." }
        : { code: "binary_part_changed", part: name, detail: "A package binary changed." });
      continue;
    }
    let sourceXml: ParsedXmlPart;
    let candidateXml: ParsedXmlPart;
    try {
      sourceXml = parseXmlPart(name, source);
      candidateXml = parseXmlPart(name, candidate);
    } catch (cause) {
      issues.push({ code: "xml_unreadable", part: name, detail: String(cause) });
      continue;
    }
    if (isContentStoryPart(sourceXml)) {
      const mainDocument = sourceXml.root.localName === "document";
      if (sourceXml.text !== candidateXml.text) {
        issues.push({ code: "text_changed", part: name, detail: "Document text changed." });
      }
      if (sourceXml.formulas !== candidateXml.formulas) {
        issues.push({ code: "formula_changed", part: name, detail: "A formula changed." });
      }
      if (sourceXml.drawings !== candidateXml.drawings) {
        issues.push({ code: "image_changed", part: name, detail: "A drawing or embedded object changed." });
      }
      if (mainDocument && !preservesRowProperties(sourceXml.root, candidateXml.root)) {
        issues.push({ code: "row_properties_changed", part: name,
          detail: "Existing table row properties changed, or a write went beyond adding a pagination flag." });
      }
      if (mainDocument ? sourceXml.protected !== candidateXml.protected : sourceXml.canonical !== candidateXml.canonical) {
        issues.push({
          code: "content_structure_changed",
          part: name,
          detail: mainDocument ? "Protected document structure changed beyond formatting." : "A read-only Word story changed.",
        });
      }
      continue;
    }
    if (sourceXml.canonical !== candidateXml.canonical) {
      issues.push({
        code: "content_structure_changed",
        part: name,
        detail: "A protected package part changed.",
      });
    }
  }

  return {
    status: issues.length ? "rejected" : "accepted",
    methodVersion: DOCX_FORMAT_CANDIDATE_VALIDATION_VERSION,
    sourceSha256,
    candidateSha256,
    changedParts: [...changedParts].sort(),
    issues,
  };
}

function assertSource(source: DocxSource): void {
  nonBlank(source.project_id, "Source project");
  nonBlank(source.baseline_id, "Source baseline");
  nonBlank(source.filename, "Source filename");
}

function assertProject(project: JournalProject): void {
  nonBlank(project.project_id, "Candidate project");
  nonBlank(project.baseline_id, "Candidate baseline");
  if (project.role !== "format_candidate") {
    throw new Error("Candidate operations require an isolated format candidate project.");
  }
}

async function readExactSource(projectId: string, baselineId: string): Promise<DocxSource> {
  const loaded = await loadDocxSource(projectId, baselineId);
  const actual = await docxContentSha256(loaded.bytes);
  if (loaded.source_sha256 !== actual) {
    throw new Error("Workbench retained bytes that do not match their source hash.");
  }
  return { ...loaded, source_sha256: actual };
}

async function verifyCandidateBytes(source: DocxSource, bytes: Uint8Array) {
  const validation = await validateDocxFormatCandidateBytes(source.bytes, bytes);
  if (validation.status !== "accepted") {
    const summary = validation.issues.map((issue) => issue.detail).join(" ");
    throw new Error(`The DOCX format candidate changed protected content. ${summary}`.trim());
  }
  return validation;
}

async function requestId(kind: string, projectId: string, baselineId: string, contentSha256: string): Promise<string> {
  const digest = await docxContentSha256(
    new TextEncoder().encode(`${kind}\n${projectId}\n${baselineId}\n${contentSha256}`),
  );
  return `docx-format-${digest.slice(0, 40)}`;
}

/** Create the one independent Workbench project that owns the frozen start bytes. */
export async function createDocxFormatCandidateCopy(
  name: string,
  source: DocxSource,
): Promise<JournalProject> {
  nonBlank(name, "Candidate name");
  assertSource(source);
  const project = await journalRequest<JournalProject>("/api/projects", {
    name,
    filename: source.filename,
    content_base64: bytesToBase64(source.bytes),
    role: "format_candidate",
  });
  if (project.role !== "format_candidate") {
    throw new Error("Workbench did not create an isolated format candidate project.");
  }
  const retained = await readExactSource(project.project_id, project.baseline_id);
  if (!equalBytes(retained.bytes, source.bytes)) {
    throw new Error("The candidate copy did not retain the frozen start bytes.");
  }
  return project;
}

/**
 * Save another candidate round into the same independent project.
 *
 * `source.bytes` stays frozen for the lifetime of the copy. Each round is checked
 * against those bytes before Workbench receives a compare-and-swap baseline update.
 */
export async function saveDocxFormatCandidateCopy(
  project: JournalProject,
  source: DocxSource,
  bytes: Uint8Array,
): Promise<JournalProject> {
  assertProject(project);
  assertSource(source);
  const { candidateSha256: contentSha256 } = await verifyCandidateBytes(source, bytes);
  const saved = await saveDocxBaseline({
    project_id: project.project_id,
    expected_baseline_id: project.baseline_id,
    filename: source.filename,
    content_base64: bytesToBase64(bytes),
    reason: `Saved isolated DOCX format candidate ${contentSha256.slice(0, 12)} from frozen source ` +
      `${source.source_sha256.slice(0, 12)}.`,
    request_id: await requestId("candidate-save", project.project_id, project.baseline_id, contentSha256),
    revision: 0,
  });
  const retained = await readExactSource(project.project_id, saved.baselineId);
  if (retained.source_sha256 !== contentSha256 || !equalBytes(retained.bytes, bytes)) {
    throw new Error("The candidate project did not retain the exact saved bytes.");
  }
  return { ...project, baseline_id: saved.baselineId };
}

/**
 * Apply the exact retained candidate bytes to the captured manuscript baseline.
 *
 * The caller briefly makes the active editor busy/read-only and exports afterwards.
 * This function owns candidate readback, the second content check, Workbench CAS and
 * exact save verification.
 */
export async function adoptDocxFormatCandidate(
  captured: DocxSource,
  review: Pick<DocxCandidateReviewRecord, "target_binding_id" | "input_source_sha256" | "candidate_project_id" |
    "candidate_baseline_id" | "candidate_source_sha256" | "candidate_binding_id" | "candidate_check_id">,
): Promise<{ source: DocxSource; binding: JournalBinding }> {
  assertSource(captured);
  const retainedCandidate = await readExactSource(review.candidate_project_id, review.candidate_baseline_id);
  if (retainedCandidate.source_sha256 !== review.candidate_source_sha256) {
    throw new JournalWorkbenchError({ error: "The retained candidate changed.", code: "baseline_conflict" });
  }
  const { candidateSha256, sourceSha256 } = await verifyCandidateBytes(captured, retainedCandidate.bytes);
  if (sourceSha256 !== review.input_source_sha256) {
    throw new JournalWorkbenchError({ error: "The candidate's input draft changed.", code: "baseline_conflict" });
  }
  const saved = await journalRequest<{ result_baseline_id: string; binding: JournalBinding }>("/api/template-candidate-adopt", {
    project_id: captured.project_id,
    expected_baseline_id: captured.baseline_id,
    expected_binding_id: review.target_binding_id,
    candidate_project_id: review.candidate_project_id,
    candidate_baseline_id: review.candidate_baseline_id,
    candidate_source_sha256: candidateSha256,
    expected_candidate_binding_id: review.candidate_binding_id,
    candidate_check_id: review.candidate_check_id,
    request_id: await requestId(`candidate-adoption:${review.target_binding_id ?? ""}:${review.candidate_check_id}`,
      captured.project_id, captured.baseline_id, candidateSha256),
  });
  const adopted = await readExactSource(captured.project_id, saved.result_baseline_id);
  if (adopted.source_sha256 !== candidateSha256 || !equalBytes(adopted.bytes, retainedCandidate.bytes)) {
    throw new Error("Workbench did not retain the exact adopted candidate bytes.");
  }
  return { source: adopted, binding: saved.binding };
}

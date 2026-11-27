import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { DocxFormatSnapshotV1 } from "../../src/lib/docx-format-types";

export const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const MARKUP_COMPATIBILITY_NAMESPACE =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const OFFICE_MATH_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/math";
export const WORDPROCESSING_DRAWING_NAMESPACE =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const DRAWING_MAIN_NAMESPACE =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
export const WORDPROCESSING_SHAPE_NAMESPACE =
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
export const WORDPROCESSING_GROUP_NAMESPACE =
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup";
export const WORD_2010_EXTENSION_NAMESPACE =
  "http://schemas.microsoft.com/office/word/2010/wordml";
const UNKNOWN_EXTENSION_NAMESPACE = "urn:oleafly:unknown-extension";

export interface NodeAddress {
  version: string;
  source_sha256: string;
  part: string;
  path: readonly number[];
}

export type WorkbenchNodeQuery = Record<string, unknown>;

export interface WorkbenchNodeRecord {
  node_address: NodeAddress;
  part: string;
  path: number[];
  namespace_uri: string | null;
  local_name: string;
  children: {
    kind: "element" | "text_value";
    index: number;
    path: number[];
    namespace_uri?: string | null;
    local_name?: string;
    value?: string;
  }[];
}

export type WorkbenchQueryOutcome =
  | {
      ok: true;
      status: 200;
      result: {
        nodes: WorkbenchNodeRecord[];
        total: number;
        next_offset: number | null;
        [key: string]: unknown;
      };
    }
  | { ok: false; status: number; error: string };

export interface WorkbenchTextBlock {
  part_path: string;
  node_locator: string;
  text: string;
  byte_start: number | null;
  byte_end: number | null;
}

export interface WorkbenchUnsupportedRecord {
  source_location: string;
  kind: string;
  relationship_id: string | null;
  failure_reason: string;
  related_part: string | null;
  parse_status: "partial" | "unsupported" | "failed";
  available_page_evidence: string[];
  limitations: string[];
}

export interface WorkbenchTableRecord {
  part_path: string;
  node_locator: string;
  rows: { text: string }[][];
}

export interface WorkbenchNodeAddressOracle {
  queries: Record<string, WorkbenchQueryOutcome>;
  retainedSnapshot: DocxFormatSnapshotV1 | null;
  textBlocks: WorkbenchTextBlock[];
  tables: WorkbenchTableRecord[];
  unsupportedRecords: WorkbenchUnsupportedRecord[];
  issues: string[];
}

/**
 * One synthetic package exercises preserved body whitespace, child elements in
 * mixed content, core reordering of a non-canonical pPr, and two physical
 * markup-compatibility branches. Every consumer receives these exact bytes.
 */
export function nodeAddressFixture(): Uint8Array {
  const word = `xmlns:w="${WORD_NAMESPACE}"`;
  const compatibility = `xmlns:mc="${MARKUP_COMPATIBILITY_NAMESPACE}"`;
  const wordprocessingShape = `xmlns:wps="${WORDPROCESSING_SHAPE_NAMESPACE}"`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
          "</Types>",
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          "</Relationships>",
      ),
      "word/_rels/document.xml.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          "</Relationships>",
      ),
      "word/document.xml": strToU8(
        `<w:document ${word} ${compatibility} ${wordprocessingShape}><w:body xml:space="preserve">\n` +
          "    <w:p><w:r><w:t>First</w:t></w:r></w:p>\n" +
          "    <w:p><w:r><w:t>Second</w:t></w:r>" +
          '<w:pPr><w:pStyle w:val="FixtureBody"/><w:keepNext/></w:pPr></w:p>\n' +
          "    <w:p><mc:AlternateContent>" +
          '<mc:Choice Requires="wps"><w:r><w:t>ChoiceMarker</w:t></w:r></mc:Choice>' +
          "<mc:Fallback><w:r><w:t>FallbackMarker</w:t></w:r></mc:Fallback>" +
          "</mc:AlternateContent></w:p>\n" +
          "  </w:body></w:document>",
      ),
      "word/styles.xml": strToU8(
        `<w:styles ${word}><w:style w:type="paragraph" w:styleId="FixtureBody">` +
          '<w:name w:val="Fixture Body"/></w:style></w:styles>',
      ),
    },
    { level: 9 },
  );
}

/**
 * A separate, whitespace-free package for markup-compatibility branch
 * selection: all six supported namespaces, source order, Requires forms,
 * local alias/rebinding, block paragraphs/tables, exact MC URI, and no branch.
 * Keeping it separate preserves every physical path in the original fixture.
 */
export function markupCompatibilitySelectionFixture(): Uint8Array {
  const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const table = (text: string) =>
    "<w:tbl>" +
    '<w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' +
    paragraph(text) +
    "</w:tc></w:tr></w:tbl>";
  const choice = (requires: string | null, content: string, attributes = "") =>
    `<mc:Choice${requires === null ? "" : ` Requires="${requires}"`}${attributes}>${content}</mc:Choice>`;
  const fallback = (content: string) => `<mc:Fallback>${content}</mc:Fallback>`;
  const alternate = (content: string) => `<mc:AlternateContent>${content}</mc:AlternateContent>`;
  const document = [
    alternate(
      choice("wps", paragraph("BasicChoice")) +
        fallback(paragraph("BasicFallback")),
    ),
    alternate(
      choice("w", paragraph("WordChoice")) +
        fallback(paragraph("WordFallback")),
    ),
    alternate(
      choice("m", paragraph("MathChoice")) +
        fallback(paragraph("MathFallback")),
    ),
    alternate(
      choice("wp", paragraph("WordprocessingDrawingChoice")) +
        fallback(paragraph("WordprocessingDrawingFallback")),
    ),
    alternate(
      choice("a", paragraph("DrawingMainChoice")) +
        fallback(paragraph("DrawingMainFallback")),
    ),
    alternate(
      choice("wpg", paragraph("WordprocessingGroupChoice")) +
        fallback(paragraph("WordprocessingGroupFallback")),
    ),
    alternate(
      choice("  wps   wpg  ", paragraph("MultipleRequiresChoice")) +
        choice("wps", paragraph("LaterSupportedChoice")) +
        fallback(paragraph("MultipleRequiresFallback")),
    ),
    alternate(
      choice(null, paragraph("MissingRequiresChoice")) +
        choice("", paragraph("EmptyRequiresChoice")) +
        choice("wps", paragraph("AfterMissingRequiresChoice")) +
        fallback(paragraph("MissingRequiresFallback")),
    ),
    alternate(
      choice("wps w14", paragraph("PartialUnsupportedChoice")) +
        fallback(paragraph("PartialUnsupportedFallback")),
    ),
    alternate(
      choice(
        "legacy shape",
        paragraph("LocalAliasChoice"),
        ` xmlns:legacy="${WORDPROCESSING_SHAPE_NAMESPACE}" xmlns:shape="${WORDPROCESSING_SHAPE_NAMESPACE}"`,
      ) +
        fallback(paragraph("LocalAliasFallback")),
    ),
    alternate(
      choice("wps", table("ChoiceTable")) +
        fallback(table("FallbackTable")),
    ),
    alternate(choice("w14", paragraph("NoBranchChoice"))),
    "<w:p><w:r><w:t>BeforeDecoy</w:t></w:r>" +
      '<x:AlternateContent xmlns:x="http://schemas.openxmlformats.org/markup-compatibility/2007">' +
      '<x:Choice Requires="wps"><w:r><w:t>WrongNamespaceChoice</w:t></w:r></x:Choice>' +
      "<x:Fallback><w:r><w:t>WrongNamespaceFallback</w:t></w:r></x:Fallback>" +
      "</x:AlternateContent>" +
      "<w:r><w:t>AfterDecoy</w:t></w:r></w:p>",
    alternate(fallback(paragraph("FallbackOnly"))),
    alternate(
      choice("unknown", paragraph("UnknownNamespaceChoice")) +
        fallback(paragraph("UnknownNamespaceFallback")),
    ),
    alternate(
      '<mc:Choice mc:Requires="wps">' +
        "<w:p><w:r><w:t>QualifiedRequiresChoice</w:t></w:r></w:p>" +
        "</mc:Choice>" +
        fallback(paragraph("QualifiedRequiresFallback")),
    ),
  ].join("");
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          "</Types>",
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          "</Relationships>",
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:mc="${MARKUP_COMPATIBILITY_NAMESPACE}" ` +
          `xmlns:m="${OFFICE_MATH_NAMESPACE}" xmlns:wp="${WORDPROCESSING_DRAWING_NAMESPACE}" ` +
          `xmlns:a="${DRAWING_MAIN_NAMESPACE}" xmlns:wps="${WORDPROCESSING_SHAPE_NAMESPACE}" ` +
          `xmlns:wpg="${WORDPROCESSING_GROUP_NAMESPACE}" xmlns:w14="${WORD_2010_EXTENSION_NAMESPACE}" ` +
          `xmlns:unknown="${UNKNOWN_EXTENSION_NAMESPACE}" xmlns:legacy="urn:oleafly:unsupported-legacy" ` +
          'mc:Ignorable="w14">' +
          `<w:body>${document}</w:body></w:document>`,
      ),
    },
    { level: 9 },
  );
}

function pythonExecutable(): string {
  const configured = process.env.OLEAFLY_WORKBENCH_PYTHON;
  if (configured) return configured;
  const virtualEnvironment = resolve(
    process.cwd(),
    "services/research-workbench/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return existsSync(virtualEnvironment) ? virtualEnvironment : process.platform === "win32" ? "python" : "python3";
}

export function runWorkbenchNodeAddressOracle(
  bytes: Uint8Array,
  queries: Record<string, WorkbenchNodeQuery>,
  snapshot?: DocxFormatSnapshotV1,
): WorkbenchNodeAddressOracle {
  const payload = JSON.stringify({
    content_base64: Buffer.from(bytes).toString("base64"),
    queries,
    snapshot,
  });
  const pythonPath = resolve(process.cwd(), "services/research-workbench/src");
  const inherited = process.env.PYTHONPATH;
  const output = execFileSync(
    pythonExecutable(),
    [resolve(process.cwd(), "e2e/helpers/docx-node-address-oracle.py")],
    {
      input: payload,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONPATH: inherited ? `${pythonPath}${delimiter}${inherited}` : pythonPath,
      },
    },
  );
  return JSON.parse(output) as WorkbenchNodeAddressOracle;
}

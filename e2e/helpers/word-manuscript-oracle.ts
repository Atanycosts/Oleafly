import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ManuscriptAlignment =
  | "Left"
  | "Centered"
  | "Right"
  | "Justified"
  | "Mixed"
  | "Unknown";

export interface ManuscriptRunFact {
  text: string;
  fontSizePt: number | null;
  complexScriptFontSizePt: number | null;
  bold: boolean | null;
  complexScriptBold: boolean | null;
  styleId: string | null;
}

export interface ManuscriptParagraphFact {
  index: number;
  text: string;
  textSha256: string;
  topLevel: boolean;
  insideTable: boolean;
  tableIndex: number | null;
  styleId: string | null;
  styleName: string | null;
  alignment: ManuscriptAlignment;
  runs: ManuscriptRunFact[];
  mark: ManuscriptRunFact;
  runCount: number;
  textNodeCount: number;
  plain: boolean;
}

export interface TableCellFormatExpectation {
  fill: string | null;
  verticalAlignment: "top" | "center" | "bottom";
}

export interface ManuscriptTableFact {
  index: number;
  rowCount: number;
  columnCounts: number[];
  styleId: string | null;
  firstCell: TableCellFormatExpectation;
}

export interface ManuscriptSectionFact {
  index: number;
  pageWidthTwips: number | null;
  pageHeightTwips: number | null;
  marginTopTwips: number | null;
  marginRightTwips: number | null;
  marginBottomTwips: number | null;
  marginLeftTwips: number | null;
  columns: {
    count: number;
    spaceTwips: number;
    separator: boolean;
  };
}

export interface ManuscriptPartFact {
  name: string;
  byteLength: number;
  sha256: string;
  xml: boolean;
}

export interface ManuscriptRelationshipFact {
  part: string;
  id: string;
  type: string;
  target: string;
  targetMode: string | null;
}

export interface ManuscriptSemanticInventory {
  paragraphs: Array<{
    part: string;
    index: number;
    text: string;
    sha256: string;
  }>;
  hyperlinks: Array<{
    part: string;
    index: number;
    id: string | null;
    anchor: string | null;
    text: string;
  }>;
  bookmarks: Array<{
    part: string;
    index: number;
    id: string;
    name: string;
  }>;
  fields: Array<{
    part: string;
    index: number;
    kind: "complex" | "instruction" | "simple";
    value: string;
  }>;
  formulas: Array<{
    part: string;
    index: number;
    sha256: string;
  }>;
  mediaParts: Array<{
    name: string;
    byteLength: number;
    sha256: string;
  }>;
  relationships: ManuscriptRelationshipFact[];
}

export interface ManuscriptOracle {
  sourceSha256: string;
  byteLength: number;
  partNames: string[];
  parts: ManuscriptPartFact[];
  document: {
    paragraphCount: number;
    topLevelParagraphCount: number;
    tableCount: number;
    sectionCount: number;
  };
  paragraphs: ManuscriptParagraphFact[];
  tables: ManuscriptTableFact[];
  sections: ManuscriptSectionFact[];
  semantics: ManuscriptSemanticInventory;
}

export type ControlledFormatKind = "paragraph" | "table-cell" | "section";

export interface ParagraphFormatExpectation {
  fontSizePt: number;
  bold: boolean;
  alignment: Exclude<ManuscriptAlignment, "Mixed" | "Unknown">;
}

export interface SectionFormatExpectation {
  pageWidthTwips: number;
  pageHeightTwips: number;
  marginTopTwips: number;
  marginRightTwips: number;
  marginBottomTwips: number;
  marginLeftTwips: number;
}

interface ControlledTargetBase<
  Kind extends ControlledFormatKind,
  Location,
  Expected,
> {
  id: string;
  kind: Kind;
  location: Location;
  expected: Expected;
  damaged: Expected;
}

export interface ControlledParagraphTarget
  extends ControlledTargetBase<
    "paragraph",
    {
      paragraphIndex: number;
      text: string;
      textSha256: string;
    },
    ParagraphFormatExpectation
  > {}

export interface ControlledTableCellTarget
  extends ControlledTargetBase<
    "table-cell",
    {
      tableIndex: number;
      rowIndex: number;
      columnIndex: number;
      text: string;
    },
    TableCellFormatExpectation
  > {}

export interface ControlledSectionTarget
  extends ControlledTargetBase<
    "section",
    {
      sectionIndex: number;
    },
    SectionFormatExpectation
  > {}

export type ControlledFormatTarget =
  | ControlledParagraphTarget
  | ControlledTableCellTarget
  | ControlledSectionTarget;

export interface EditorialMarker {
  text: string;
  paragraphIndex: number;
  originalText: string;
  markedText: string;
}

export interface ManuscriptIdentityNormalization {
  part: string;
  paragraphIndex: number;
  originalParaId: string | null;
  originalTextId: string | null;
  replacementParaId: string | null;
  replacementTextId: string | null;
  reason: string;
}

export interface DefaultAutoShadingRemoval {
  targetId: string;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  originalXml: string;
  reason: "explicit_direct_shading_removal";
}

export interface ControlledExpectedFacts {
  sourceSha256: string;
  templateSha256: string;
  damagedSha256: string;
  identityNormalizations: ManuscriptIdentityNormalization[];
  defaultAutoShadingRemovals: DefaultAutoShadingRemoval[];
  targets: Array<{
    id: string;
    kind: ControlledFormatKind;
    expected: ControlledFormatTarget["expected"];
  }>;
  preserved: readonly string[];
}

export interface ControlledManuscript {
  bytes: Uint8Array;
  targets: ControlledFormatTarget[];
  expected: ControlledExpectedFacts;
  editorialMarker: EditorialMarker;
}

export interface ManuscriptPackageDiff {
  sourceSha256: string;
  candidateSha256: string;
  zipBytesChanged: boolean;
  partSetPreserved: boolean;
  addedParts: string[];
  removedParts: string[];
  changedParts: string[];
}

export interface ManuscriptRepairFacts {
  passed: true;
  sourceSha256: string;
  damagedSha256: string;
  repairedSha256: string;
  damagedVsSource: ManuscriptPackageDiff;
  repairedVsSource: ManuscriptPackageDiff;
  editorialMarker: EditorialMarker;
  identityNormalizations: ManuscriptIdentityNormalization[];
  defaultAutoShadingRemovals: DefaultAutoShadingRemoval[];
  targets: Array<{
    id: string;
    kind: ControlledFormatKind;
    expected: ControlledFormatTarget["expected"];
    damaged: ControlledFormatTarget["expected"];
    repaired: ControlledFormatTarget["expected"];
  }>;
  semantics: {
    protectedXmlAndBinaryPartsEqual: true;
    targetPropertiesRemovedBeforeComparison: string[];
    markerChangeAllowedBeforeComparison: true;
    allowedNoteIdentityAdditions: Array<{
      part: string;
      paragraphIndex: number;
      paraId: string;
      textId: string;
    }>;
    redundantSpaceRemovalsAccepted: true;
  };
}

export interface ManuscriptInitialExportFacts {
  passed: true;
  sourceSha256: string;
  exportedSha256: string;
  packageDiff: ManuscriptPackageDiff;
  semantics: {
    protectedXmlAndBinaryPartsEqual: true;
    targetPropertiesRemoved: false;
    allowedNoteIdentityAdditions: Array<{
      part: string;
      paragraphIndex: number;
      paraId: string;
      textId: string;
    }>;
    redundantSpaceRemovalsAccepted: true;
  };
}

export interface CreateControlledManuscriptOptions {
  seed?: number;
  kinds?: readonly ControlledFormatKind[];
}

interface EncodedInput {
  base64: string;
}

function encoded(bytes: Uint8Array): EncodedInput {
  return { base64: Buffer.from(bytes).toString("base64") };
}

function pythonExecutable(): string {
  const configured = process.env.OLEAFLY_WORKBENCH_PYTHON;
  if (configured) return configured;
  const local = resolve(
    process.cwd(),
    "services/research-workbench/.venv/bin/python",
  );
  return existsSync(local) ? local : "python3";
}

function runOracle<T>(input: Record<string, unknown>): T {
  const directory = mkdtempSync(join(tmpdir(), "oleafly-manuscript-oracle-"));
  let inputFd: number | undefined;
  try {
    const inputPath = join(directory, "input.json");
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    inputFd = openSync(inputPath, "r");
    return JSON.parse(
      execFileSync(pythonExecutable(), ["-c", PYTHON_ORACLE], {
        // A regular file gives sys.stdin.read() a finite EOF without a pipe shutdown.
        stdio: [inputFd, "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }),
    ) as T;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer | string };
    const stderr =
      typeof failure.stderr === "string"
        ? failure.stderr
        : failure.stderr?.toString("utf8") ?? "";
    throw new Error(
      `Independent DOCX XML oracle failed.${
        stderr.trim() ? `\n${stderr.trim()}` : ""
      }`,
    );
  } finally {
    if (inputFd !== undefined) closeSync(inputFd);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readManuscriptOracle(bytes: Uint8Array): ManuscriptOracle {
  return runOracle<ManuscriptOracle>({ mode: "read", source: encoded(bytes) });
}

export function createControlledManuscript(
  sourceBytes: Uint8Array,
  templateBytes: Uint8Array,
  options: CreateControlledManuscriptOptions = {},
): ControlledManuscript {
  const output = runOracle<{
    bytesBase64: string;
    targets: ControlledFormatTarget[];
    expected: ControlledExpectedFacts;
    editorialMarker: EditorialMarker;
  }>({
    mode: "create",
    source: encoded(sourceBytes),
    template: encoded(templateBytes),
    options,
  });
  return {
    bytes: new Uint8Array(Buffer.from(output.bytesBase64, "base64")),
    targets: output.targets,
    expected: output.expected,
    editorialMarker: output.editorialMarker,
  };
}

export function assertManuscriptRepair(
  sourceBytes: Uint8Array,
  damagedBytes: Uint8Array,
  repairedBytes: Uint8Array,
  control: ControlledManuscript,
): ManuscriptRepairFacts {
  return runOracle<ManuscriptRepairFacts>({
    mode: "repair",
    source: encoded(sourceBytes),
    damaged: encoded(damagedBytes),
    repaired: encoded(repairedBytes),
    control: {
      targets: control.targets,
      expected: control.expected,
      editorialMarker: control.editorialMarker,
    },
  });
}

export function assertManuscriptInitialExport(
  sourceBytes: Uint8Array,
  exportedBytes: Uint8Array,
): ManuscriptInitialExportFacts {
  return runOracle<ManuscriptInitialExportFacts>({
    mode: "initial",
    source: encoded(sourceBytes),
    exported: encoded(exportedBytes),
  });
}

const PYTHON_ORACLE = String.raw`
import base64
import copy
import hashlib
import html
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
XML_NS = "http://www.w3.org/XML/1998/namespace"
DOCUMENT = "word/document.xml"
STYLES = "word/styles.xml"
MARKER_TEXT = " OLEAFLY_E2E_REMOVE_MARKER_20261115"

def w(local): return "{" + W + "}" + local
def r(local): return "{" + R + "}" + local
def m(local): return "{" + M + "}" + local
def w14(local): return "{" + W14 + "}" + local
def mc(local): return "{" + MC + "}" + local
def xml(local): return "{" + XML_NS + "}" + local

def sha(data): return hashlib.sha256(data).hexdigest()
def text_sha(value): return sha(value.encode("utf-8"))

def fail(message):
    raise AssertionError(message)

def decode(value):
    return base64.b64decode(value["base64"], validate=True)

def load_zip(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            entries = {}
            for info in package.infolist():
                if info.is_dir() or info.filename.endswith("/"):
                    continue
                entries[info.filename] = {
                    "data": package.read(info.filename),
                    "date_time": info.date_time,
                    "external_attr": info.external_attr,
                    "compress_type": info.compress_type,
                }
    except Exception as error:
        fail("Could not read the DOCX ZIP package: " + str(error))
    if DOCUMENT not in entries:
        fail("The package has no word/document.xml.")
    return entries

def zip_bytes(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as package:
        for name, entry in entries.items():
            info = zipfile.ZipInfo(name, entry.get("date_time", (1980, 1, 1, 0, 0, 0)))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = entry.get("external_attr", 0)
            package.writestr(info, entry["data"])
    return output.getvalue()

def parse_xml(data):
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
    return ET.fromstring(data, parser=parser)

def register_namespaces(data):
    namespaces = []
    try:
        for _, binding in ET.iterparse(io.BytesIO(data), events=("start-ns",)):
            prefix, uri = binding
            if prefix not in ("xml", "xmlns"):
                namespaces.append((prefix, uri))
    except ET.ParseError:
        pass
    for prefix, uri in namespaces:
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass

def namespace_facts(data, part_name):
    root_bindings = []
    all_bindings = []
    scopes = []
    pending = []
    depth = 0
    qname_attributes = {
        mc("Ignorable"), mc("MustUnderstand"), mc("PreserveAttributes"),
        mc("PreserveElements"), mc("Requires"),
    }
    try:
        for event, item in ET.iterparse(io.BytesIO(data), events=("start-ns", "start", "end")):
            if event == "start-ns":
                pending.append(tuple(item))
                continue
            if event == "end":
                depth -= 1
                if scopes:
                    scopes.pop()
                continue
            inherited = scopes[-1] if scopes else {}
            scope = dict(inherited)
            scope.update(dict(pending))
            if depth == 0:
                root_bindings = list(pending)
            all_bindings.extend(pending)
            for name, value in item.attrib.items():
                if name not in qname_attributes:
                    continue
                for token in value.split():
                    prefix = token.split(":", 1)[0]
                    if prefix and prefix not in ("xml",) and prefix not in scope:
                        fail(
                            "Namespace prefix referenced by "
                            + name + " is not declared in "
                            + part_name + ": " + token
                        )
            scopes.append(scope)
            depth += 1
            pending = []
    except ET.ParseError as error:
        fail("Could not read namespaces in " + part_name + ": " + str(error))
    return {
        "rootBindings": sorted(set(root_bindings)),
        "allBindings": sorted(all_bindings),
    }

def serialize_xml(root, source_data):
    register_namespaces(source_data)
    result = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    missing = []
    for prefix, uri in namespace_facts(source_data, "source XML")["rootBindings"]:
        marker = ("xmlns:" + prefix + "=").encode("utf-8") if prefix else b'xmlns="'
        if marker not in result:
            attribute = "xmlns:" + prefix if prefix else "xmlns"
            missing.append(
                " " + attribute + '="' + html.escape(uri, quote=True) + '"'
            )
    if missing:
        declaration_end = result.find(b"?>")
        root_start = declaration_end + 2 if declaration_end >= 0 else 0
        root_end = result.find(b">", root_start)
        if root_end < 0:
            fail("Serialized XML has no root element.")
        result = result[:root_end] + "".join(missing).encode("utf-8") + result[root_end:]
    return result

def child(parent, tag):
    if parent is None:
        return None
    for item in list(parent):
        if item.tag == tag:
            return item
    return None

def children(parent, tag):
    return [] if parent is None else [item for item in list(parent) if item.tag == tag]

def all_nodes(root, tag):
    return list(root.iter(tag))

def attr(element, tag):
    return None if element is None else element.get(tag)

def on_off(value, absent=True):
    if value is None:
        return absent
    return value not in ("0", "false", "off")

def remove_attr(element, name):
    if element is not None and name in element.attrib:
        del element.attrib[name]

def remove_child(parent, item):
    if parent is not None and item is not None:
        parent.remove(item)

def alignment(value):
    if value in ("left", "start", None):
        return "Left"
    if value == "center":
        return "Centered"
    if value in ("right", "end"):
        return "Right"
    if value in ("both", "distribute"):
        return "Justified"
    return "Unknown"

def paragraph_text(paragraph):
    def walk(item):
        if item is not paragraph and item.tag == w("p"):
            return ""
        if item.tag == w("t"):
            return item.text or ""
        if item.tag == w("tab"):
            return "\t"
        if item.tag in (w("br"), w("cr")):
            return "\n"
        if item.tag == w("noBreakHyphen"):
            return "\u2011"
        return "".join(walk(node) for node in list(item))
    return walk(paragraph)

def paragraph_runs(paragraph):
    result = []
    def walk(item):
        if item is not paragraph and item.tag == w("p"):
            return
        if item.tag == w("r"):
            result.append(item)
        for node in list(item):
            walk(node)
    walk(paragraph)
    return result

def paragraph_text_nodes(paragraph):
    result = []
    def walk(item):
        if item is not paragraph and item.tag == w("p"):
            return
        if item.tag == w("t"):
            result.append(item)
        for node in list(item):
            walk(node)
    walk(paragraph)
    return result

def cell_text(cell):
    return "".join(paragraph_text(paragraph) for paragraph in cell.iter(w("p")))

def is_plain(paragraph):
    forbidden_w = {
        w("hyperlink"), w("fldChar"), w("fldSimple"), w("instrText"),
        w("bookmarkStart"), w("drawing"), w("pict"), w("object"),
    }
    if any(item.tag in forbidden_w for item in paragraph.iter()):
        return False
    return not any(item.tag == m("oMath") for item in paragraph.iter())

def read_styles(entries):
    definitions = {}
    defaults = None
    default_id = None
    if STYLES in entries:
        root = parse_xml(entries[STYLES]["data"])
        defaults = child(root, w("docDefaults"))
        for style in root.iter(w("style")):
            style_id = style.get(w("styleId"))
            if not style_id:
                continue
            definitions[style_id] = {
                "id": style_id,
                "name": attr(child(style, w("name")), w("val")),
                "type": style.get(w("type")) or "paragraph",
                "based_on": attr(child(style, w("basedOn")), w("val")),
                "pPr": child(style, w("pPr")),
                "rPr": child(style, w("rPr")),
            }
            if (
                default_id is None
                and style.get(w("type")) == "paragraph"
                and style.get(w("default")) not in (None, "0", "false", "off")
            ):
                default_id = style.get(w("styleId"))
    return {
        "definitions": definitions,
        "by_name": {
            definition["name"].lower(): definition
            for definition in definitions.values()
            if definition["name"]
        },
        "default_id": default_id,
        "pPr": child(child(defaults, w("pPrDefault")), w("pPr")),
        "rPr": child(child(defaults, w("rPrDefault")), w("rPr")),
    }

def style_chain(styles, style_id):
    result = []
    seen = set()
    while style_id and style_id not in seen:
        seen.add(style_id)
        definition = styles["definitions"].get(style_id)
        if not definition:
            break
        result.append(definition)
        style_id = definition["based_on"]
    return result

def style_property(styles, style_id, container, name):
    for definition in style_chain(styles, style_id):
        found = child(definition[container], w(name))
        if found is not None:
            return found
    return child(styles[container], w(name))

def rpr_format(styles, paragraph_style_id, direct, value):
    character_style_id = attr(child(direct, w("rStyle")), w("val"))
    chains = []
    if character_style_id:
        chains.append(character_style_id)
    if paragraph_style_id or styles["default_id"]:
        chains.append(paragraph_style_id or styles["default_id"])
    def prop(name):
        direct_value = child(direct, w(name))
        if direct_value is not None:
            return direct_value
        for style_id in chains:
            found = style_property(styles, style_id, "rPr", name)
            if found is not None:
                return found
        return child(styles["rPr"], w(name))
    size = attr(prop("sz"), w("val"))
    size_cs = attr(prop("szCs"), w("val"))
    bold_node = prop("b")
    bold_cs_node = prop("bCs")
    return {
        "text": value,
        "fontSizePt": int(size) / 2 if size and size.isdigit() else None,
        "complexScriptFontSizePt": int(size_cs) / 2 if size_cs and size_cs.isdigit() else None,
        "bold": on_off(attr(bold_node, w("val"))) if bold_node is not None else False,
        "complexScriptBold": on_off(attr(bold_cs_node, w("val"))) if bold_cs_node is not None else False,
        "styleId": character_style_id,
    }

def run_format(styles, paragraph_style_id, run):
    return rpr_format(
        styles, paragraph_style_id, child(run, w("rPr")), paragraph_text(run),
    )

def paragraph_mark_format(styles, paragraph_style_id, paragraph):
    return rpr_format(
        styles,
        paragraph_style_id,
        child(child(paragraph, w("pPr")), w("rPr")),
        "",
    )

def paragraph_alignment(styles, style_id, paragraph):
    direct = child(paragraph, w("pPr"))
    found = child(direct, w("jc"))
    if found is None:
        found = style_property(styles, style_id or styles["default_id"], "pPr", "jc")
    return alignment(attr(found, w("val")))

def cell_format(cell):
    properties = child(cell, w("tcPr"))
    shade = child(properties, w("shd"))
    raw_fill = attr(shade, w("fill"))
    fill = None if not raw_fill or raw_fill.lower() == "auto" else raw_fill.upper()
    raw_alignment = attr(child(properties, w("vAlign")), w("val"))
    vertical = raw_alignment if raw_alignment in ("center", "bottom") else "top"
    return {"fill": fill, "verticalAlignment": vertical}

def default_auto_shading_xml(cell):
    shade = child(child(cell, w("tcPr")), w("shd"))
    if shade is None or list(shade) or len(shade.attrib) != 3:
        return None
    if (
        shade.get(w("val")) != "clear"
        or shade.get(w("color")) != "auto"
        or shade.get(w("fill")) != "auto"
    ):
        return None
    return '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>'

def section_fields(section):
    page_size = child(section, w("pgSz"))
    margin = child(section, w("pgMar"))
    columns = child(section, w("cols"))
    def number(node, name):
        value = attr(node, w(name))
        return int(value) if value and re.fullmatch(r"-?\d+", value) else None
    return {
        "pageWidthTwips": number(page_size, "w"),
        "pageHeightTwips": number(page_size, "h"),
        "marginTopTwips": number(margin, "top"),
        "marginRightTwips": number(margin, "right"),
        "marginBottomTwips": number(margin, "bottom"),
        "marginLeftTwips": number(margin, "left"),
        "columns": {
            "count": number(columns, "num") or 1,
            "spaceTwips": number(columns, "space") or 720,
            "separator": on_off(attr(columns, w("sep")), False),
        },
    }

def table_cell_from_root(root, table_index, row_index, column_index):
    tables = all_nodes(root, w("tbl"))
    if table_index >= len(tables):
        fail("Missing table " + str(table_index))
    rows = children(tables[table_index], w("tr"))
    if row_index >= len(rows):
        fail("Missing table row " + str(row_index))
    cells = children(rows[row_index], w("tc"))
    if column_index >= len(cells):
        fail("Missing table cell " + str(column_index))
    return cells[column_index]

def table_cell(entries, table_index, row_index, column_index):
    return table_cell_from_root(
        parse_xml(entries[DOCUMENT]["data"]),
        table_index,
        row_index,
        column_index,
    )

def read_oracle(data, entries=None):
    entries = entries or load_zip(data)
    root = parse_xml(entries[DOCUMENT]["data"])
    styles = read_styles(entries)
    body = child(root, w("body"))
    if body is None:
        fail("word/document.xml has no w:body.")
    paragraphs = all_nodes(root, w("p"))
    tables = all_nodes(root, w("tbl"))
    table_by_paragraph = {}
    for table_index, table in enumerate(tables):
        for paragraph in table.iter(w("p")):
            table_by_paragraph[paragraph] = table_index
    top_level = {item for item in list(body) if item.tag == w("p")}
    paragraph_facts = []
    for index, paragraph in enumerate(paragraphs):
        style_element = child(child(paragraph, w("pPr")), w("pStyle"))
        style_id = attr(style_element, w("val"))
        definition = styles["definitions"].get(style_id)
        value = paragraph_text(paragraph)
        runs = paragraph_runs(paragraph)
        text_nodes = paragraph_text_nodes(paragraph)
        paragraph_facts.append({
            "index": index,
            "text": value,
            "textSha256": text_sha(value),
            "topLevel": paragraph in top_level,
            "insideTable": paragraph in table_by_paragraph,
            "tableIndex": table_by_paragraph.get(paragraph),
            "styleId": style_id,
            "styleName": definition["name"] if definition else None,
            "alignment": paragraph_alignment(styles, style_id, paragraph),
            "runs": [run_format(styles, style_id, run) for run in runs
                     if paragraph_text(run)],
            "mark": paragraph_mark_format(styles, style_id, paragraph),
            "runCount": len(runs),
            "textNodeCount": len(text_nodes),
            "plain": is_plain(paragraph),
        })
    table_facts = []
    for index, table in enumerate(tables):
        rows = children(table, w("tr"))
        first_cell = children(rows[0], w("tc"))[0] if rows and children(rows[0], w("tc")) else None
        table_facts.append({
            "index": index,
            "rowCount": len(rows),
            "columnCounts": [len(children(row, w("tc"))) for row in rows],
            "styleId": attr(child(child(table, w("tblPr")), w("tblStyle")), w("val")),
            "firstCell": cell_format(first_cell) if first_cell is not None else {
                "fill": None, "verticalAlignment": "top",
            },
        })
    sections = [
        {"index": index, **section_fields(section)}
        for index, section in enumerate(root.iter(w("sectPr")))
    ]
    semantics = {
        "paragraphs": [], "hyperlinks": [], "bookmarks": [], "fields": [],
        "formulas": [], "mediaParts": [], "relationships": [],
    }
    for part_name in sorted(entries):
        part_data = entries[part_name]["data"]
        if part_name.startswith("word/media/"):
            semantics["mediaParts"].append({
                "name": part_name, "byteLength": len(part_data), "sha256": sha(part_data),
            })
            continue
        if not (part_name.endswith(".xml") or part_name.endswith(".rels")):
            continue
        try:
            part_root = parse_xml(part_data)
        except ET.ParseError:
            continue
        if part_name.endswith(".rels"):
            for relationship in part_root.iter("{" + RELS + "}Relationship"):
                semantics["relationships"].append({
                    "part": part_name,
                    "id": relationship.get("Id") or "",
                    "type": relationship.get("Type") or "",
                    "target": relationship.get("Target") or "",
                    "targetMode": relationship.get("TargetMode"),
                })
            continue
        for index, paragraph in enumerate(part_root.iter(w("p"))):
            value = paragraph_text(paragraph)
            semantics["paragraphs"].append({
                "part": part_name, "index": index, "text": value, "sha256": text_sha(value),
            })
        for index, hyperlink in enumerate(part_root.iter(w("hyperlink"))):
            semantics["hyperlinks"].append({
                "part": part_name,
                "index": index,
                "id": hyperlink.get(r("id")),
                "anchor": hyperlink.get(w("anchor")),
                "text": paragraph_text(hyperlink),
            })
        for index, bookmark in enumerate(part_root.iter(w("bookmarkStart"))):
            semantics["bookmarks"].append({
                "part": part_name,
                "index": index,
                "id": bookmark.get(w("id")) or "",
                "name": bookmark.get(w("name")) or "",
            })
        field_index = 0
        for field in part_root.iter(w("fldChar")):
            semantics["fields"].append({
                "part": part_name, "index": field_index, "kind": "complex",
                "value": field.get(w("fldCharType")) or "",
            })
            field_index += 1
        for instruction in part_root.iter(w("instrText")):
            semantics["fields"].append({
                "part": part_name, "index": field_index, "kind": "instruction",
                "value": instruction.text or "",
            })
            field_index += 1
        for simple in part_root.iter(w("fldSimple")):
            semantics["fields"].append({
                "part": part_name, "index": field_index, "kind": "simple",
                "value": simple.get(w("instr")) or "",
            })
            field_index += 1
        for index, formula in enumerate(part_root.iter(m("oMath"))):
            semantics["formulas"].append({
                "part": part_name, "index": index,
                "sha256": text_sha(ET.tostring(formula, encoding="unicode")),
            })
    semantics["relationships"].sort(key=lambda item: item["part"] + "\0" + item["id"])
    part_names = sorted(entries)
    return {
        "sourceSha256": sha(data),
        "byteLength": len(data),
        "partNames": part_names,
        "parts": [{
            "name": name,
            "byteLength": len(entries[name]["data"]),
            "sha256": sha(entries[name]["data"]),
            "xml": name.endswith(".xml") or name.endswith(".rels"),
        } for name in part_names],
        "document": {
            "paragraphCount": len(paragraph_facts),
            "topLevelParagraphCount": len(top_level),
            "tableCount": len(table_facts),
            "sectionCount": len(sections),
        },
        "paragraphs": paragraph_facts,
        "tables": table_facts,
        "sections": sections,
        "semantics": semantics,
    }, entries, root, styles

def template_format(styles, name):
    definition = styles["by_name"].get(name.lower())
    if definition is None:
        fail("Template has no " + name + " paragraph style.")
    size = style_property(styles, definition["id"], "rPr", "sz")
    bold = style_property(styles, definition["id"], "rPr", "b")
    justify = style_property(styles, definition["id"], "pPr", "jc")
    raw_size = attr(size, w("val"))
    if not raw_size or not raw_size.isdigit():
        fail("Template style " + name + " has no readable w:sz.")
    result_alignment = alignment(attr(justify, w("val")))
    if result_alignment in ("Mixed", "Unknown"):
        fail("Template style " + name + " has no supported alignment.")
    return {
        "fontSizePt": int(raw_size) / 2,
        "bold": on_off(attr(bold, w("val"))) if bold is not None else False,
        "alignment": result_alignment,
    }

def role_markers(oracle):
    top_level = [
        paragraph for paragraph in oracle["paragraphs"]
        if paragraph["topLevel"] and re.search(r"[A-Za-z0-9\u3400-\u9fff]", paragraph["text"])
    ]
    abstract_position = next((
        index for index, paragraph in enumerate(top_level)
        if re.match(r"^(?:abstract|\u6458\u8981)\s*[:\uff1a\u2014\u2013-]", paragraph["text"].strip(), re.I)
    ), None)
    if abstract_position is None:
        fail("Could not identify the abstract paragraph.")
    abstract = top_level[abstract_position]
    title = next((
        paragraph for paragraph in top_level[:abstract_position]
        if paragraph["styleName"] and "title" in paragraph["styleName"].lower()
    ), top_level[0])
    references_position = next((
        index for index, paragraph in enumerate(top_level)
        if paragraph["index"] > abstract["index"]
        and re.fullmatch(r"(?:references?|bibliography|\u53c2\u8003\u6587\u732e)\s*[:\uff1a]?", paragraph["text"].strip(), re.I)
    ), None)
    reference_start = top_level[references_position]["index"] if references_position is not None else abstract["index"]
    references = next((
        paragraph for paragraph in reversed(top_level)
        if paragraph["index"] > reference_start
        and len(paragraph["text"].strip()) >= 20
    ), None)
    if references is None:
        fail("Could not identify the references tail.")
    midpoint = (oracle["document"]["paragraphCount"] - 1) / 2
    body_candidates = [
        paragraph for paragraph in top_level
        if paragraph["index"] > abstract["index"]
        and paragraph["index"] < (top_level[references_position]["index"] if references_position is not None else references["index"])
        and paragraph["plain"] and len(paragraph["text"].strip()) >= 80
    ]
    body = min(body_candidates, key=lambda paragraph: (abs(paragraph["index"] - midpoint), paragraph["index"]), default=None)
    if body is None:
        fail("Could not identify a distributed body paragraph.")
    for name, paragraph in (("title", title), ("abstract", abstract), ("body", body)):
        if not paragraph["plain"]:
            fail(name + " target contains a protected object.")
    return title, abstract, body, references

def distributed_indexes(count):
    return list(dict.fromkeys([0, count // 2, count - 1])) if count else []

def paragraph_target(identifier, paragraph, expected, seed):
    return {
        "id": identifier,
        "kind": "paragraph",
        "location": {
            "paragraphIndex": paragraph["index"],
            "text": paragraph["text"],
            "textSha256": paragraph["textSha256"],
        },
        "expected": expected,
        "damaged": {
            "fontSizePt": expected["fontSizePt"] + 2 + seed % 3,
            "bold": not expected["bold"],
            "alignment": "Left" if expected["alignment"] == "Centered" else "Centered",
        },
    }

# ECMA-376 property sequences. Insert fixture properties without sorting source nodes.
PROPERTY_ORDER = {
    w("pPr"): "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange".split(),
    w("rPr"): "ins del moveFrom moveTo rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange".split(),
    w("tcPr"): "cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers cellIns cellDel cellMerge tcPrChange".split(),
    w("sectPr"): "headerReference footerReference footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings sectPrChange".split(),
}

def insert_property(parent, name):
    order = [w(item) for item in PROPERTY_ORDER[parent.tag]]
    rank = order.index(w(name))
    element = ET.Element(w(name))
    for index, existing in enumerate(parent):
        if existing.tag in order and order.index(existing.tag) > rank:
            parent.insert(index, element)
            return element
    parent.append(element)
    return element

def apply_paragraph_format(paragraph, value):
    ppr = child(paragraph, w("pPr"))
    if ppr is None:
        ppr = ET.Element(w("pPr"))
        paragraph.insert(0, ppr)
    remove_child(ppr, child(ppr, w("jc")))
    jc = insert_property(ppr, "jc")
    jc.set(w("val"), {"Left":"left","Centered":"center","Right":"right","Justified":"both"}[value["alignment"]])
    def apply_properties(rpr):
        for name in ("b", "sz", "szCs"):
            remove_child(rpr, child(rpr, w(name)))
        insert_property(rpr, "b").set(w("val"), "1" if value["bold"] else "0")
        half_points = str(round(value["fontSizePt"] * 2))
        insert_property(rpr, "sz").set(w("val"), half_points)
        insert_property(rpr, "szCs").set(w("val"), half_points)

    for run in paragraph_runs(paragraph):
        rpr = child(run, w("rPr"))
        if rpr is None:
            rpr = ET.Element(w("rPr"))
            run.insert(0, rpr)
        apply_properties(rpr)
    mark_rpr = child(ppr, w("rPr"))
    if mark_rpr is None:
        mark_rpr = insert_property(ppr, "rPr")
    apply_properties(mark_rpr)

def apply_cell_format(cell, value):
    tcpr = child(cell, w("tcPr"))
    if tcpr is None:
        tcpr = ET.Element(w("tcPr"))
        cell.insert(0, tcpr)
    shade = child(tcpr, w("shd"))
    if value["fill"] is not None:
        if shade is None:
            shade = insert_property(tcpr, "shd")
        shade.set(w("fill"), value["fill"].lstrip("#").upper())
    elif shade is not None:
        remove_attr(shade, w("fill"))
        if not list(shade) and not shade.attrib:
            remove_child(tcpr, shade)
    vertical = child(tcpr, w("vAlign"))
    if vertical is None:
        vertical = insert_property(tcpr, "vAlign")
    vertical.set(w("val"), value["verticalAlignment"])

def apply_section_format(section, value):
    page_size = child(section, w("pgSz"))
    if page_size is None:
        page_size = insert_property(section, "pgSz")
    page_size.set(w("w"), str(value["pageWidthTwips"]))
    page_size.set(w("h"), str(value["pageHeightTwips"]))
    margin = child(section, w("pgMar"))
    if margin is None:
        margin = insert_property(section, "pgMar")
    for name, key in (
        ("top","marginTopTwips"), ("right","marginRightTwips"),
        ("bottom","marginBottomTwips"), ("left","marginLeftTwips"),
    ):
        margin.set(w(name), str(value[key]))

def find_marker_paragraph(oracle):
    top_level = [paragraph for paragraph in oracle["paragraphs"] if paragraph["topLevel"]]
    abstract_position = next((
        index for index, paragraph in enumerate(top_level)
        if re.match(r"^(?:abstract|\u6458\u8981)\s*[:\uff1a\u2014\u2013-]", paragraph["text"].strip(), re.I)
    ), None)
    if abstract_position is None:
        fail("Marker selection needs a readable abstract.")
    abstract_index = top_level[abstract_position]["index"]
    for paragraph in oracle["paragraphs"]:
        if (
            paragraph["topLevel"]
            and paragraph["index"] > abstract_index
            and paragraph["plain"]
            and paragraph["runCount"] == 1
            and paragraph["textNodeCount"] == 1
            and len(paragraph["text"].strip()) >= 20
        ):
            return paragraph
    fail("Could not find a plain single-run paragraph for the editorial marker.")

def find_paragraph(root, index):
    paragraphs = all_nodes(root, w("p"))
    if index >= len(paragraphs):
        fail("Missing paragraph " + str(index))
    return paragraphs[index]

def marker_locate(root, marker):
    paragraph = find_paragraph(root, marker["paragraphIndex"])
    runs = paragraph_runs(paragraph)
    text_nodes = paragraph_text_nodes(paragraph)
    if len(runs) != 1 or len(text_nodes) != 1:
        fail("Editorial marker paragraph no longer has one run and one w:t.")
    return paragraph, text_nodes[0]

def marker_state(root, marker):
    paragraph, text_node = marker_locate(root, marker)
    return paragraph_text(paragraph), text_node.text or ""

def apply_marker(root, marker):
    _, text_node = marker_locate(root, marker)
    text_node.text = marker["markedText"]

def normalize_marker(root, marker):
    _, text_node = marker_locate(root, marker)
    text_node.text = marker["originalText"]

def target_value(oracle, entries, target):
    kind = target["kind"]
    if kind == "paragraph":
        index = target["location"]["paragraphIndex"]
        if index >= len(oracle["paragraphs"]):
            fail(target["id"] + ": missing paragraph.")
        paragraph = oracle["paragraphs"][index]
        if paragraph["text"] != target["location"]["text"] or paragraph["textSha256"] != target["location"]["textSha256"]:
            fail(target["id"] + ": paragraph text changed or moved.")
        runs = [run for run in paragraph["runs"] if run["text"]]
        if not runs:
            fail(target["id"] + ": paragraph has no text runs.")
        formatting = runs + [paragraph["mark"]]
        for item in formatting:
            if item["fontSizePt"] != item["complexScriptFontSizePt"]:
                fail(target["id"] + ": primary and complex-script font sizes differ.")
        visible = {
            (run["fontSizePt"], run["bold"])
            for run in runs
        }
        if len(visible) != 1:
            fail(target["id"] + ": visible run formatting is mixed.")
        if (paragraph["mark"]["fontSizePt"], paragraph["mark"]["bold"]) not in visible:
            fail(target["id"] + ": paragraph mark formatting differs from visible text.")
        return {
            "fontSizePt": runs[0]["fontSizePt"],
            "bold": runs[0]["bold"],
            "alignment": paragraph["alignment"],
        }
    if kind == "table-cell":
        if target["location"]["tableIndex"] >= len(oracle["tables"]):
            fail(target["id"] + ": missing table.")
        cell = table_cell(entries, target["location"]["tableIndex"], target["location"]["rowIndex"], target["location"]["columnIndex"])
        if cell_text(cell) != target["location"]["text"]:
            fail(target["id"] + ": table cell text changed.")
        return cell_format(cell)
    section_index = target["location"]["sectionIndex"]
    if section_index >= len(oracle["sections"]):
        fail(target["id"] + ": missing section.")
    return {
        key: value for key, value in oracle["sections"][section_index].items()
        if key != "index" and key != "columns"
    }

def remove_paragraph_targets(root, targets):
    paragraphs = all_nodes(root, w("p"))
    for target in targets:
        if target["kind"] != "paragraph":
            continue
        paragraph = paragraphs[target["location"]["paragraphIndex"]]
        ppr = child(paragraph, w("pPr"))
        remove_child(ppr, child(ppr, w("jc")))
        for properties_owner in paragraph_runs(paragraph):
            rpr = child(properties_owner, w("rPr"))
            if rpr is None:
                continue
            for name in ("b", "sz", "szCs"):
                remove_child(rpr, child(rpr, w(name)))
            if not list(rpr) and not rpr.attrib:
                remove_child(properties_owner, rpr)
        mark = child(ppr, w("rPr"))
        if mark is not None:
            for name in ("b", "sz", "szCs"):
                remove_child(mark, child(mark, w(name)))
            if not list(mark) and not mark.attrib:
                remove_child(ppr, mark)
        if ppr is not None and not list(ppr) and not ppr.attrib:
            remove_child(paragraph, ppr)

def remove_cell_targets(
    root,
    targets,
    default_auto_shading_removals=None,
    allow_default_auto_shading_removal=False,
):
    registered = {
        item["targetId"]: item
        for item in (default_auto_shading_removals or [])
    }
    for target in targets:
        if target["kind"] != "cell" and target["kind"] != "table-cell":
            continue
        cell = table_cell_from_root(
            root,
            target["location"]["tableIndex"],
            target["location"]["rowIndex"],
            target["location"]["columnIndex"],
        )
        tcpr = child(cell, w("tcPr"))
        if tcpr is None:
            continue
        if allow_default_auto_shading_removal and target["id"] in registered:
            registration = registered[target["id"]]
            original_xml = default_auto_shading_xml(cell)
            if (
                registration["tableIndex"] != target["location"]["tableIndex"]
                or registration["rowIndex"] != target["location"]["rowIndex"]
                or registration["columnIndex"] != target["location"]["columnIndex"]
                or (
                    original_xml is not None
                    and registration["originalXml"] != original_xml
                )
            ):
                fail(
                    target["id"]
                    + ": source shading differs from the registered default-auto removal: "
                    + json.dumps({
                        "registered": registration["originalXml"],
                        "actual": original_xml,
                    })
                )
            if original_xml is not None:
                remove_child(tcpr, child(tcpr, w("shd")))
        shade = child(tcpr, w("shd"))
        if shade is not None:
            remove_attr(shade, w("fill"))
            if not list(shade) and not shade.attrib:
                remove_child(tcpr, shade)
        vertical = child(tcpr, w("vAlign"))
        if vertical is not None:
            remove_attr(vertical, w("val"))
            if not list(vertical) and not vertical.attrib:
                remove_child(tcpr, vertical)
        if not list(tcpr) and not tcpr.attrib:
            remove_child(cell, tcpr)

def remove_section_targets(root, targets):
    sections = all_nodes(root, w("sectPr"))
    for target in targets:
        if target["kind"] != "section":
            continue
        section = sections[target["location"]["sectionIndex"]]
        page_size = child(section, w("pgSz"))
        remove_attr(page_size, w("w"))
        remove_attr(page_size, w("h"))
        margin = child(section, w("pgMar"))
        for name in ("top", "right", "bottom", "left"):
            remove_attr(margin, w(name))

def normalize_targets(
    root,
    targets,
    default_auto_shading_removals=None,
    allow_default_auto_shading_removal=False,
):
    remove_paragraph_targets(root, targets)
    remove_cell_targets(
        root,
        targets,
        default_auto_shading_removals,
        allow_default_auto_shading_removal,
    )
    remove_section_targets(root, targets)

def canonical_element(element, allow_space=False, parent_has_elements=False):
    if element.tag is ET.Comment:
        return ["comment", element.text or ""]
    if element.tag is ET.ProcessingInstruction:
        return ["pi", element.text or ""]
    attributes = []
    text_value = element.text if element.tag == w("t") else None
    for name, value in element.attrib.items():
        if allow_space and name == xml("space") and text_value is not None and text_value == text_value.strip():
            continue
        attributes.append([name, value])
    attributes.sort()
    parts = []
    if element.text and (element.text.strip() or not len(element)):
        parts.append(["text", element.text])
    for node in list(element):
        parts.append(canonical_element(node, allow_space, len(element) > 0))
        if node.tail and node.tail.strip():
            parts.append(["tail", node.tail])
    return ["element", element.tag, attributes, parts]

def valid_paragraph_id(value):
    return (
        value is not None
        and re.fullmatch(r"[0-9A-F]{8}", value.upper()) is not None
        and 0 < int(value, 16) <= 0x7fffffff
    )

def normalize_paragraph_identities(entries, source_sha256):
    reserved = set()
    for part_name in sorted(entries):
        if not part_name.endswith(".xml"):
            continue
        try:
            root = parse_xml(entries[part_name]["data"])
        except ET.ParseError:
            continue
        for element in root.iter():
            for attribute in (w14("paraId"), w14("textId")):
                value = element.get(attribute)
                if value:
                    reserved.add(value.upper())

    used = {"paraId": set(), "textId": set()}
    normalizations = []
    nonce = 0

    def replacement_id(part_name, paragraph_index):
        nonlocal nonce
        while True:
            material = (
                source_sha256 + "\0" + part_name + "\0"
                + str(paragraph_index) + "\0" + str(nonce)
            ).encode("utf-8")
            nonce += 1
            value = (int(sha(material)[:8], 16) & 0x7fffffff) or 1
            candidate = format(value, "08X")
            if candidate not in reserved:
                reserved.add(candidate)
                return candidate

    for part_name in sorted(entries):
        if not part_name.endswith(".xml"):
            continue
        try:
            root = parse_xml(entries[part_name]["data"])
        except ET.ParseError:
            continue
        changed = False
        for paragraph_index, paragraph in enumerate(root.iter(w("p"))):
            original_para = paragraph.get(w14("paraId"))
            original_text = paragraph.get(w14("textId"))
            invalid = []
            duplicate = []
            for lane, attribute, value in (
                ("paraId", w14("paraId"), original_para),
                ("textId", w14("textId"), original_text),
            ):
                if value is None:
                    continue
                normalized = value.upper()
                if not valid_paragraph_id(normalized):
                    invalid.append(lane + "=" + value)
                elif normalized in used[lane]:
                    duplicate.append(lane + "=" + value)
            if not invalid and not duplicate:
                if original_para is not None:
                    used["paraId"].add(original_para.upper())
                if original_text is not None:
                    used["textId"].add(original_text.upper())
                continue

            replacement_para = None
            replacement_text = None
            if "paraId" in [item.split("=", 1)[0] for item in invalid + duplicate]:
                replacement_para = replacement_id(part_name, paragraph_index)
                paragraph.set(w14("paraId"), replacement_para)
            elif original_para is not None:
                used["paraId"].add(original_para.upper())
            if "textId" in [item.split("=", 1)[0] for item in invalid + duplicate]:
                if replacement_para is not None and original_text == original_para:
                    replacement_text = replacement_para
                else:
                    replacement_text = replacement_id(part_name, paragraph_index)
                paragraph.set(w14("textId"), replacement_text)
            elif original_text is not None:
                used["textId"].add(original_text.upper())
            if replacement_para is not None:
                used["paraId"].add(replacement_para)
            if replacement_text is not None:
                used["textId"].add(replacement_text)
            reason_parts = []
            if invalid:
                reason_parts.append("invalid: " + ", ".join(invalid))
            if duplicate:
                reason_parts.append("duplicate: " + ", ".join(duplicate))
            normalizations.append({
                "part": part_name,
                "paragraphIndex": paragraph_index,
                "originalParaId": original_para,
                "originalTextId": original_text,
                "replacementParaId": paragraph.get(w14("paraId")),
                "replacementTextId": paragraph.get(w14("textId")),
                "reason": "; ".join(reason_parts),
            })
            changed = True
        if changed:
            entries[part_name]["data"] = serialize_xml(
                root, entries[part_name]["data"],
            )
    return normalizations

def apply_identity_normalizations(entries, normalizations):
    by_part = {}
    for item in normalizations:
        by_part.setdefault(item["part"], []).append(item)
    for part_name, items in by_part.items():
        if part_name not in entries:
            fail("Identity normalization part is missing: " + part_name)
        root = parse_xml(entries[part_name]["data"])
        paragraphs = list(root.iter(w("p")))
        for item in items:
            paragraph_index = item["paragraphIndex"]
            if paragraph_index >= len(paragraphs):
                fail("Identity normalization paragraph is missing: " + part_name + " " + str(paragraph_index))
            paragraph = paragraphs[paragraph_index]
            if (
                paragraph.get(w14("paraId")) != item["originalParaId"]
                or paragraph.get(w14("textId")) != item["originalTextId"]
            ):
                fail("Source identity differs from the controlled normalization map: " + part_name + " " + str(paragraph_index))
            if item["replacementParaId"] is None:
                if paragraph.get(w14("paraId")) is not None:
                    del paragraph.attrib[w14("paraId")]
            else:
                paragraph.set(w14("paraId"), item["replacementParaId"])
            if item["replacementTextId"] is None:
                if paragraph.get(w14("textId")) is not None:
                    del paragraph.attrib[w14("textId")]
            else:
                paragraph.set(w14("textId"), item["replacementTextId"])
        entries[part_name]["data"] = serialize_xml(
            root, entries[part_name]["data"],
        )

def validate_source_paragraph_ids(entries):
    used = {"paraId": set(), "textId": set()}
    reasons = []
    for part_name in sorted(entries):
        if not (part_name.endswith(".xml") or part_name.endswith(".rels")):
            continue
        try:
            root = parse_xml(entries[part_name]["data"])
        except ET.ParseError:
            continue
        for paragraph_index, paragraph in enumerate(root.iter(w("p"))):
            for lane, attribute in (
                ("paraId", w14("paraId")),
                ("textId", w14("textId")),
            ):
                value = paragraph.get(attribute)
                if value is None:
                    continue
                normalized = value.upper()
                if not valid_paragraph_id(normalized):
                    reasons.append(
                        "source identity is invalid: "
                        + part_name + " paragraph " + str(paragraph_index)
                        + " " + lane + "=" + value
                    )
                elif normalized in used[lane]:
                    reasons.append(
                        "source identity is duplicated: "
                        + part_name + " paragraph " + str(paragraph_index)
                        + " " + lane + "=" + value
                    )
                else:
                    used[lane].add(normalized)
    return used, reasons

def paragraph_identity_changes(source, candidate):
    reasons = []
    for part_name in sorted(set(source) & set(candidate)):
        if not (part_name.endswith(".xml") or part_name.endswith(".rels")):
            continue
        try:
            source_root = parse_xml(source[part_name]["data"])
            candidate_root = parse_xml(candidate[part_name]["data"])
        except ET.ParseError:
            continue
        source_paragraphs = list(source_root.iter(w("p")))
        candidate_paragraphs = list(candidate_root.iter(w("p")))
        for paragraph_index, (before, after) in enumerate(
            zip(source_paragraphs, candidate_paragraphs)
        ):
            for lane, attribute in (
                ("paraId", w14("paraId")),
                ("textId", w14("textId")),
            ):
                source_value = before.get(attribute)
                candidate_value = after.get(attribute)
                if source_value != candidate_value:
                    reasons.append(
                        part_name + " paragraph " + str(paragraph_index)
                        + " " + lane + ": "
                        + (source_value or "(absent)")
                        + " -> " + (candidate_value or "(absent)")
                    )
    return reasons

def strip_note_ids(candidate, source, part_name, used_ids):
    allowed = []
    source_paragraphs = list(source.iter(w("p")))
    candidate_paragraphs = list(candidate.iter(w("p")))
    if len(source_paragraphs) != len(candidate_paragraphs):
        return allowed
    for index, (before, after) in enumerate(zip(source_paragraphs, candidate_paragraphs)):
        source_id = before.get(w14("paraId"))
        source_text = before.get(w14("textId"))
        candidate_id = after.get(w14("paraId"))
        candidate_text = after.get(w14("textId"))
        if source_id is None and source_text is None and candidate_id and candidate_text:
            identity = candidate_id.upper()
            text_identity = candidate_text.upper()
            if (
                valid_paragraph_id(identity)
                and valid_paragraph_id(text_identity)
                and text_identity == identity
                and identity not in used_ids["paraId"]
                and text_identity not in used_ids["textId"]
            ):
                del after.attrib[w14("paraId")]
                del after.attrib[w14("textId")]
                used_ids["paraId"].add(identity)
                used_ids["textId"].add(text_identity)
                allowed.append({
                    "part": part_name, "paragraphIndex": index,
                    "paraId": identity, "textId": text_identity,
                })
    return allowed

def fingerprint(
    entries,
    targets=None,
    marker=None,
    normalize_marked=False,
    allow_space=False,
    source_entries=None,
    used_note_ids=None,
    default_auto_shading_removals=None,
    allow_default_auto_shading_removal=False,
):
    normalized = []
    allowed_note_ids = []
    for name in sorted(entries):
        data = entries[name]["data"]
        if name.endswith(".xml") or name.endswith(".rels"):
            try:
                root = parse_xml(data)
                if name == DOCUMENT and targets:
                    normalize_targets(
                        root,
                        targets,
                        default_auto_shading_removals,
                        allow_default_auto_shading_removal,
                    )
                    if marker is not None and normalize_marked:
                        normalize_marker(root, marker)
                if allow_space and source_entries is not None and name in ("word/footnotes.xml", "word/endnotes.xml"):
                    if name in source_entries:
                        allowed_note_ids.extend(strip_note_ids(
                            root,
                            parse_xml(source_entries[name]["data"]),
                            name,
                            used_note_ids or {"paraId": set(), "textId": set()},
                        ))
                normalized.append([
                    name,
                    "xml",
                    namespace_facts(data, name),
                    canonical_element(root, allow_space),
                ])
            except ET.ParseError:
                normalized.append([name, "binary", sha(data)])
        else:
            normalized.append([name, "binary", sha(data)])
    return text_sha(json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))), allowed_note_ids

def changed_semantic_parts(
    source,
    candidate,
    targets=None,
    marker=None,
    normalize_marked=False,
    allow_space=False,
    default_auto_shading_removals=None,
    allow_default_auto_shading_removal=False,
    allow_note_ids=False,
    used_note_ids=None,
):
    changed = []
    for name in sorted(set(source) | set(candidate)):
        if name not in source or name not in candidate:
            changed.append(name)
            continue
        source_fingerprint, _ = fingerprint(
            {name: source[name]},
            targets=targets,
            marker=marker,
            allow_space=allow_space,
            default_auto_shading_removals=default_auto_shading_removals,
            allow_default_auto_shading_removal=allow_default_auto_shading_removal,
        )
        candidate_fingerprint, _ = fingerprint(
            {name: candidate[name]},
            targets=targets,
            marker=marker,
            normalize_marked=normalize_marked,
            allow_space=allow_space,
            default_auto_shading_removals=default_auto_shading_removals,
            allow_default_auto_shading_removal=allow_default_auto_shading_removal,
            source_entries={name: source[name]} if allow_note_ids else None,
            used_note_ids=used_note_ids,
        )
        if source_fingerprint != candidate_fingerprint:
            changed.append(name)
    return changed

def package_diff(source_data, candidate_data):
    source = load_zip(source_data)
    candidate = load_zip(candidate_data)
    source_names = set(source)
    candidate_names = set(candidate)
    return {
        "sourceSha256": sha(source_data),
        "candidateSha256": sha(candidate_data),
        "zipBytesChanged": sha(source_data) != sha(candidate_data),
        "partSetPreserved": source_names == candidate_names,
        "addedParts": sorted(candidate_names - source_names),
        "removedParts": sorted(source_names - candidate_names),
        "changedParts": sorted(
            name for name in source_names & candidate_names
            if sha(source[name]["data"]) != sha(candidate[name]["data"])
        ),
    }

def create(payload):
    source_data = decode(payload["source"])
    template_data = decode(payload["template"])
    source = load_zip(source_data)
    template = load_zip(template_data)
    identity_normalizations = normalize_paragraph_identities(
        source, sha(source_data),
    )
    oracle, _, document_root, _ = read_oracle(source_data, source)
    template_oracle, _, template_root, template_styles = read_oracle(template_data, template)
    title, abstract, body, references = role_markers(oracle)
    options = payload.get("options") or {}
    enabled = set(options.get("kinds") or ["paragraph", "table-cell", "section"])
    seed = abs(int(options.get("seed") or 0))
    targets = []
    default_auto_shading_removals = []
    if "paragraph" in enabled:
        targets.extend([
            paragraph_target("title", title, template_format(template_styles, "Heading"), seed),
            paragraph_target("abstract", abstract, template_format(template_styles, "Abstract"), seed),
            paragraph_target("body-middle", body, template_format(template_styles, "Text"), seed),
            paragraph_target("references-tail", references, template_format(template_styles, "References"), seed),
        ])
    if "table-cell" in enabled:
        if not all_nodes(document_root, w("tbl")):
            fail("No tables in source.")
        expected = cell_format(table_cell(template, 0, 0, 0))
        tables = all_nodes(document_root, w("tbl"))
        for table_index in distributed_indexes(len(tables)):
            cell = table_cell_from_root(document_root, table_index, 0, 0)
            suffix = "first" if table_index == 0 else ("middle" if table_index == len(tables) // 2 else "last")
            target = {
                "id": "table-" + suffix,
                "kind": "table-cell",
                "location": {
                    "tableIndex": table_index, "rowIndex": 0, "columnIndex": 0,
                    "text": cell_text(cell),
                },
                "expected": dict(expected),
                "damaged": {
                    "fill": "FCE4D6" if expected["fill"] == "D9EAF7" else "D9EAF7",
                    "verticalAlignment": "top" if expected["verticalAlignment"] == "bottom" else "bottom",
                },
            }
            targets.append(target)
            if target["id"] == "table-last":
                original_xml = default_auto_shading_xml(cell)
                if original_xml is not None and expected["fill"] is None:
                    default_auto_shading_removals.append({
                        "targetId": target["id"],
                        "tableIndex": target["location"]["tableIndex"],
                        "rowIndex": target["location"]["rowIndex"],
                        "columnIndex": target["location"]["columnIndex"],
                        "originalXml": original_xml,
                        "reason": "explicit_direct_shading_removal",
                    })
    if "section" in enabled:
        section = template_oracle["sections"][0]
        fields = {key: section[key] for key in (
            "pageWidthTwips", "pageHeightTwips", "marginTopTwips",
            "marginRightTwips", "marginBottomTwips", "marginLeftTwips",
        )}
        if any(value is None for value in fields.values()):
            fail("Template section geometry is incomplete.")
        targets.append({
            "id": "section-first", "kind": "section", "location": {"sectionIndex": 0},
            "expected": fields,
            "damaged": {
                "pageWidthTwips": fields["pageWidthTwips"] + 200,
                "pageHeightTwips": fields["pageHeightTwips"] + 200,
                "marginTopTwips": fields["marginTopTwips"] + 120,
                "marginRightTwips": fields["marginRightTwips"] + 120,
                "marginBottomTwips": fields["marginBottomTwips"] + 120,
                "marginLeftTwips": fields["marginLeftTwips"] + 120,
            },
        })
    paragraphs = all_nodes(document_root, w("p"))
    sections = all_nodes(document_root, w("sectPr"))
    for target in targets:
        if target["kind"] == "paragraph":
            paragraph = paragraphs[target["location"]["paragraphIndex"]]
            if paragraph_text(paragraph) != target["location"]["text"]:
                fail(target["id"] + " paragraph no longer resolves.")
            apply_paragraph_format(paragraph, target["damaged"])
        elif target["kind"] == "table-cell":
            apply_cell_format(
                table_cell_from_root(
                    document_root,
                    target["location"]["tableIndex"],
                    target["location"]["rowIndex"],
                    target["location"]["columnIndex"],
                ),
                target["damaged"],
            )
        else:
            apply_section_format(sections[0], target["damaged"])
    marker_paragraph = find_marker_paragraph(oracle)
    if marker_paragraph["index"] in {target["location"].get("paragraphIndex") for target in targets if target["kind"] == "paragraph"}:
        fail("Editorial marker conflicts with a paragraph target.")
    marker = {
        "text": MARKER_TEXT,
        "paragraphIndex": marker_paragraph["index"],
        "originalText": marker_paragraph["text"],
        "markedText": marker_paragraph["text"] + MARKER_TEXT,
    }
    apply_marker(document_root, marker)
    source[DOCUMENT]["data"] = serialize_xml(
        document_root, source[DOCUMENT]["data"],
    )
    damaged_data = zip_bytes(source)
    expected = {
        "sourceSha256": sha(source_data),
        "templateSha256": sha(template_data),
        "damagedSha256": sha(damaged_data),
        "identityNormalizations": identity_normalizations,
        "defaultAutoShadingRemovals": default_auto_shading_removals,
        "targets": [{"id": target["id"], "kind": target["kind"], "expected": target["expected"]} for target in targets],
        "preserved": [
            "paragraph text and order except exact editorial marker",
            "hyperlinks", "bookmarks", "fields", "formulas",
            "media", "relationships", "non-target formatting",
            "all source w:bCs nodes and attributes, including target runs and paragraph marks",
        ],
    }
    return {
        "bytesBase64": base64.b64encode(damaged_data).decode("ascii"),
        "targets": targets, "expected": expected, "editorialMarker": marker,
    }

def repair(payload):
    source_data = decode(payload["source"])
    damaged_data = decode(payload["damaged"])
    repaired_data = decode(payload["repaired"])
    control = payload["control"]
    targets = control["targets"]
    marker = control["editorialMarker"]
    identity_normalizations = control["expected"].get("identityNormalizations", [])
    default_auto_shading_removals = control["expected"].get(
        "defaultAutoShadingRemovals", [],
    )
    if sha(source_data) != control["expected"]["sourceSha256"]:
        fail("Source hash differs from controlled fixture.")
    if sha(damaged_data) != control["expected"]["damagedSha256"]:
        fail("Damaged hash differs from controlled fixture.")
    source = load_zip(source_data)
    damaged = load_zip(damaged_data)
    repaired = load_zip(repaired_data)
    apply_identity_normalizations(source, identity_normalizations)
    source_oracle, _, source_root, _ = read_oracle(source_data, source)
    damaged_oracle, _, damaged_root, _ = read_oracle(damaged_data, damaged)
    repaired_oracle, _, repaired_root, _ = read_oracle(repaired_data, repaired)
    damaged_paragraph_text, _ = marker_state(damaged_root, marker)
    repaired_paragraph_text, repaired_text = marker_state(repaired_root, marker)
    if damaged_paragraph_text != marker["markedText"]:
        fail("Controlled damage does not contain the exact editorial marker.")
    if repaired_paragraph_text != marker["originalText"] or repaired_text != marker["originalText"]:
        fail("Repair must remove only the editorial marker and restore exact original text.")
    source_note_ids, _ = validate_source_paragraph_ids(source)
    source_fingerprint, _ = fingerprint(
        source, targets=targets, allow_space=True,
    )
    damaged_fingerprint, _ = fingerprint(
        damaged,
        targets=targets,
        marker=marker,
        normalize_marked=True,
        allow_space=True,
        source_entries=source,
        used_note_ids={
            "paraId": set(source_note_ids["paraId"]),
            "textId": set(source_note_ids["textId"]),
        },
    )
    if source_fingerprint != damaged_fingerprint:
        damaged_semantics = changed_semantic_parts(
            source, damaged, targets=targets, marker=marker,
            normalize_marked=True, allow_space=True,
        )
        fail(
            "Controlled damage changed protected content, relationships, media, or non-target formatting: "
            + ", ".join(damaged_semantics)
        )
    repaired_fingerprint, allowed_note_ids = fingerprint(
        repaired,
        targets=targets,
        allow_space=True,
        source_entries=source,
        used_note_ids={
            "paraId": set(source_note_ids["paraId"]),
            "textId": set(source_note_ids["textId"]),
        },
        default_auto_shading_removals=default_auto_shading_removals,
        allow_default_auto_shading_removal=True,
    )
    repaired_source_fingerprint, _ = fingerprint(
        source,
        targets=targets,
        allow_space=True,
        default_auto_shading_removals=default_auto_shading_removals,
        allow_default_auto_shading_removal=True,
    )
    if repaired_source_fingerprint != repaired_fingerprint:
        repaired_semantics = changed_semantic_parts(
            source,
            repaired,
            targets=targets,
            allow_space=True,
            default_auto_shading_removals=default_auto_shading_removals,
            allow_default_auto_shading_removal=True,
        )
        fail(
            "Repair changed content outside the exact marker/format allowlist: "
            + ", ".join(repaired_semantics)
        )
    damaged_values = []
    repaired_values = []
    for target in targets:
        actual_damage = target_value(damaged_oracle, damaged, target)
        if actual_damage != target["damaged"]:
            fail(target["id"] + " controlled damage mismatch: " + json.dumps({"expected": target["damaged"], "actual": actual_damage}))
        damaged_values.append(actual_damage)
        actual_repair = target_value(repaired_oracle, repaired, target)
        if actual_repair != target["expected"]:
            fail(target["id"] + " repair mismatch: " + json.dumps({"expected": target["expected"], "actual": actual_repair}))
        repaired_values.append(actual_repair)
    for removal in default_auto_shading_removals:
        cell = table_cell(
            repaired,
            removal["tableIndex"],
            removal["rowIndex"],
            removal["columnIndex"],
        )
        if child(child(cell, w("tcPr")), w("shd")) is not None:
            fail(
                removal["targetId"]
                + ": registered default-auto direct shading was not removed."
            )
    return {
        "passed": True,
        "sourceSha256": sha(source_data),
        "damagedSha256": sha(damaged_data),
        "repairedSha256": sha(repaired_data),
        "damagedVsSource": package_diff(source_data, damaged_data),
        "repairedVsSource": package_diff(source_data, repaired_data),
        "editorialMarker": marker,
        "identityNormalizations": identity_normalizations,
        "defaultAutoShadingRemovals": default_auto_shading_removals,
        "targets": [{
            "id": target["id"], "kind": target["kind"],
            "expected": target["expected"],
            "damaged": damaged_values[index],
            "repaired": repaired_values[index],
        } for index, target in enumerate(targets)],
        "semantics": {
            "protectedXmlAndBinaryPartsEqual": True,
            "targetPropertiesRemovedBeforeComparison": [
                "target paragraph visible runs and paragraph mark w:sz/w:szCs/w:b/w:jc; w:bCs remains protected",
                "target table cell w:shd/@w:fill and w:vAlign/@w:val with exact empty-node boundary",
                "one registered target table-last direct default-auto w:shd removal",
                "target section w:pgSz/@w,@w:h and w:pgMar/@w:top,@w:right,@w:bottom,@w:left",
                "only pre-registered invalid or duplicate paragraph identities",
            ],
            "markerChangeAllowedBeforeComparison": True,
            "allowedNoteIdentityAdditions": allowed_note_ids,
            "redundantSpaceRemovalsAccepted": True,
        },
    }

def initial(payload):
    source_data = decode(payload["source"])
    exported_data = decode(payload["exported"])
    source = load_zip(source_data)
    exported = load_zip(exported_data)
    source_note_ids, source_identity_reasons = validate_source_paragraph_ids(source)
    source_fingerprint, _ = fingerprint(source, allow_space=True)
    exported_fingerprint, allowed_note_ids = fingerprint(
        exported,
        allow_space=True,
        source_entries=source,
        used_note_ids={
            "paraId": set(source_note_ids["paraId"]),
            "textId": set(source_note_ids["textId"]),
        },
    )
    if source_fingerprint != exported_fingerprint:
        changed_parts = changed_semantic_parts(
            source,
            exported,
            allow_space=True,
            allow_note_ids=True,
            used_note_ids={
                "paraId": set(source_note_ids["paraId"]),
                "textId": set(source_note_ids["textId"]),
            },
        )
        reasons = source_identity_reasons + paragraph_identity_changes(source, exported)
        details = []
        if changed_parts:
            details.append("changed XML parts: " + ", ".join(changed_parts))
        details.extend(reasons)
        fail(
            "Initial export changed XML attributes or structure, text, links, bookmarks, fields, formulas, media, relationships, or binary parts."
            + ("\n" + "\n".join("- " + detail for detail in details) if details else "")
        )
    elif source_identity_reasons:
        fail(
            "Initial export source contains abnormal paragraph identity data."
            + "\n" + "\n".join("- " + detail for detail in source_identity_reasons)
        )
    return {
        "passed": True,
        "sourceSha256": sha(source_data),
        "exportedSha256": sha(exported_data),
        "packageDiff": package_diff(source_data, exported_data),
        "semantics": {
            "protectedXmlAndBinaryPartsEqual": True,
            "targetPropertiesRemoved": False,
            "allowedNoteIdentityAdditions": allowed_note_ids,
            "redundantSpaceRemovalsAccepted": True,
        },
    }

try:
    payload = json.loads(sys.stdin.read())
    if payload["mode"] == "read":
        result, _, _, _ = read_oracle(decode(payload["source"]))
    elif payload["mode"] == "create":
        result = create(payload)
    elif payload["mode"] == "repair":
        result = repair(payload)
    elif payload["mode"] == "initial":
        result = initial(payload)
    else:
        fail("Unknown oracle mode.")
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
except AssertionError as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(2)
`;

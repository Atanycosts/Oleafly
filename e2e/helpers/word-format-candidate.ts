import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { unzipSync } from "fflate";

export const WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES =
  Number(process.env.OLEAFLY_WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES ?? 25);
export const WORD_FORMAT_CANDIDATE_TIMEOUT_MS =
  WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES * 60_000;

export interface WordPackageIdentity {
  sha256: string;
  byteLength: number;
  partNames: readonly string[];
  binaryParts: readonly { name: string; byteLength: number; sha256: string }[];
}

export interface WordFormatCandidateVerification {
  passed: true;
  methodVersion: "independent-docx-format-2.6.0";
  sourceSha256: string;
  candidateSha256: string;
  package: {
    partSetPreserved: true;
    changedParts: readonly string[];
    changedStoryParts: readonly string[];
    binaryPartsPreserved: true;
    protectedXmlPreserved: true;
    pageFlowPreserved: true;
    tableFormattingPreserved: true;
    actualFormatChange: true;
  };
  ignoredNormalizations: readonly string[];
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function readWordPackageIdentity(bytes: Uint8Array): WordPackageIdentity {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error(`The DOCX package is not a readable ZIP archive: ${String(error)}`);
  }
  const partNames = Object.keys(entries).sort();
  return {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    partNames,
    binaryParts: partNames
      .filter((name) => !/\.(?:xml|rels)$/i.test(name))
      .map((name) => ({
        name,
        byteLength: entries[name].byteLength,
        sha256: sha256(entries[name]),
      })),
  };
}

function pythonExecutable(): string {
  const configured = process.env.OLEAFLY_WORKBENCH_PYTHON;
  if (configured) return configured;
  return resolve(process.cwd(), "services/research-workbench/.venv/bin/python");
}

export function verifyWordFormatCandidateBytes(input: {
  sourceBytes: Uint8Array;
  candidateBytes: Uint8Array;
}): WordFormatCandidateVerification {
  const payload = {
    source: { base64: Buffer.from(input.sourceBytes).toString("base64") },
    candidate: { base64: Buffer.from(input.candidateBytes).toString("base64") },
  };
  try {
    const output = execFileSync(pythonExecutable(), ["-c", PYTHON_ORACLE], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const result = JSON.parse(output) as WordFormatCandidateVerification;
    if (result.passed !== true || result.package.actualFormatChange !== true) {
      throw new Error("The independent verifier did not establish a format-only change.");
    }
    return result;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer | string };
    const stderr = typeof failure.stderr === "string"
      ? failure.stderr
      : failure.stderr?.toString("utf8") ?? "";
    throw new Error(
      `Independent DOCX format-candidate verification failed.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }
}

const PYTHON_ORACLE = String.raw`
import base64
import hashlib
import io
import json
import sys
import zipfile
from xml.dom import Node
from xml.dom import minidom

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XMLNS_NS = "http://www.w3.org/2000/xmlns/"
TEXT_ELEMENTS = {"t", "delText", "instrText", "delInstrText"}
FORMAT_CONTAINERS = {"pPr", "rPr", "tblPr", "trPr", "tcPr", "sectPr", "tblGrid"}
IGNORED_W_ELEMENTS = {"lastRenderedPageBreak", "proofErr"}
DIRECT_PARAGRAPH_FORMATS = {
    "ind": {"left", "right", "start", "end", "firstLine", "hanging"},
    "jc": {"val"},
    "spacing": {"before", "after"},
}
DIRECT_RUN_FORMATS = {
    "b": {"val"},
    "i": {"val"},
    "rFonts": {"ascii", "hAnsi", "eastAsia", "asciiTheme", "hAnsiTheme", "eastAsiaTheme"},
    "sz": {"val"},
    "szCs": {"val"},
}
MC_PREFIX_LISTS = {"Ignorable", "MustUnderstand"}
MC_QNAME_LISTS = {"PreserveElements", "PreserveAttributes", "ProcessContent"}

def fail(message):
    raise AssertionError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def decode(value):
    return base64.b64decode(value["base64"], validate=True)

def logical(name):
    return "/" + name.lstrip("/")

def load_zip(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            return {
                logical(info.filename): package.read(info.filename)
                for info in package.infolist()
                if not info.is_dir() and not info.filename.endswith("/")
            }
    except Exception as error:
        fail("Could not read the DOCX ZIP package: " + str(error))

def parse_xml(data, part):
    try:
        return minidom.parseString(data).documentElement
    except Exception as error:
        fail("Could not parse " + part + ": " + str(error))

def is_xml(name):
    return name.lower().endswith(".xml") or name.lower().endswith(".rels")

def attr_parts(attribute):
    name = attribute.name
    namespace = attribute.namespaceURI or ""
    local = attribute.localName or name.split(":")[-1]
    return namespace, local

def ignored_attribute(attribute, comments):
    namespace, local = attr_parts(attribute)
    if namespace == XMLNS_NS:
        return True
    if namespace == XML_NS and local == "space":
        return True
    if namespace == W14 or namespace == W:
        if local == "paraId":
            return not comments
        if local == "textId":
            return True
    return namespace == W and local.startswith("rsid")

def namespace_prefix(attribute):
    if attribute.name == "xmlns":
        return ""
    return attribute.localName or attribute.name.split(":")[-1]

def has_xml_edge_space(value):
    return bool(value) and (
        value[0] in " \t\r\n" or value[-1] in " \t\r\n"
    )

def context_for_node(node):
    chain = []
    current = node
    while current is not None:
        if current.nodeType == Node.ELEMENT_NODE:
            chain.append(current)
        current = current.parentNode

    namespaces = {}
    xml_space = "default"
    comments = False
    for element in reversed(chain):
        for attribute in element.attributes.values():
            namespace, local = attr_parts(attribute)
            if namespace == XMLNS_NS:
                namespaces[namespace_prefix(attribute)] = attribute.value
            elif namespace == XML_NS and local == "space":
                xml_space = attribute.value
        if element.namespaceURI == W and element.localName == "comments":
            comments = True
    namespaces.setdefault("xml", XML_NS)
    return {
        "namespaces": namespaces,
        "xml_space": xml_space,
        "comments": comments,
    }

def compatibility_value(node, attribute, namespaces):
    namespace, local = attr_parts(attribute)
    qnames = namespace == MC and local in MC_QNAME_LISTS
    prefixes = (namespace == MC and local in MC_PREFIX_LISTS) or (
        not namespace
        and local == "Requires"
        and node.namespaceURI == MC
        and node.localName == "Choice"
    )
    if not qnames and not prefixes:
        return attribute.value

    resolved = []
    for token in attribute.value.split():
        if qnames:
            prefix, separator, local_name = token.partition(":")
            if separator:
                resolved.append([namespaces.get(prefix, prefix), local_name])
            else:
                resolved.append(["", token])
        else:
            resolved.append([namespaces.get(token, token), ""])
    return json.dumps(resolved, ensure_ascii=False, separators=(",", ":"))

def ignored_element(node):
    if node.nodeType != Node.ELEMENT_NODE:
        return False
    namespace = node.namespaceURI or ""
    local = node.localName or node.tagName.split(":")[-1]
    return namespace == W and local in IGNORED_W_ELEMENTS

def canonical(node, strip_formatting, context=None):
    if node.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE):
        value = node.data or ""
        parent = node.parentNode
        meaningful_space = (
            context
            and context["xml_space"] == "preserve"
            and has_xml_edge_space(value)
            and parent is not None
            and parent.nodeType == Node.ELEMENT_NODE
            and (parent.localName or parent.tagName.split(":")[-1]) in TEXT_ELEMENTS
        )
        if meaningful_space:
            return ["t", value, "preserve"]
        return ["t", value]
    if node.nodeType == Node.COMMENT_NODE:
        return ["comment", node.data or ""]
    if node.nodeType == Node.PROCESSING_INSTRUCTION_NODE:
        return ["pi", node.target or "", node.data or ""]
    if node.nodeType != Node.ELEMENT_NODE or ignored_element(node):
        return None
    if context is None:
        context = context_for_node(node)
    namespace = node.namespaceURI or ""
    local = node.localName or node.tagName.split(":")[-1]
    if strip_formatting and namespace == W and local in FORMAT_CONTAINERS:
        return None
    namespaces = dict(context["namespaces"])
    xml_space = context["xml_space"]
    comments = context["comments"]
    for attribute in node.attributes.values():
        attribute_namespace, attribute_local = attr_parts(attribute)
        if attribute_namespace == XMLNS_NS:
            namespaces[namespace_prefix(attribute)] = attribute.value
        elif attribute_namespace == XML_NS and attribute_local == "space":
            xml_space = attribute.value
    if namespace == W and local == "comments":
        comments = True
    attributes = sorted(
        [
            [
                attr_parts(attribute)[0],
                attr_parts(attribute)[1],
                compatibility_value(node, attribute, namespaces),
            ]
            for attribute in node.attributes.values()
            if not ignored_attribute(attribute, comments)
        ],
        key=lambda item: (item[0], item[1]),
    )
    child_context = {
        "namespaces": namespaces,
        "xml_space": xml_space,
        "comments": comments,
    }
    children = []
    for child in node.childNodes:
        projected = canonical(child, strip_formatting, child_context)
        if projected is not None:
            children.append(projected)
    return ["e", namespace, local, attributes, children]

def canonical_json(node, strip_formatting):
    return json.dumps(
        canonical(node, strip_formatting),
        ensure_ascii=False,
        separators=(",", ":"),
    )

def protected_property_children(children, editable, paragraph=False):
    result = []
    for child in children:
        if child[0] == "t" and not child[1].strip():
            continue
        if child[0] == "e" and child[1] == W:
            if child[2] in editable:
                allowed = editable[child[2]]
                attributes = [attr for attr in child[3] if attr[0] != W or attr[1] not in allowed]
                if not attributes and not child[4]:
                    continue
                child = child[:3] + [attributes, child[4]]
            elif paragraph and child[2] == "rPr":
                mark = protected_property_children(child[4], DIRECT_RUN_FORMATS)
                if not child[3] and not mark:
                    continue
                child = child[:4] + [mark]
        result.append(child)
    return result

def protected_properties(parent, name, editable):
    result = []
    for container in parent.childNodes:
        if container.namespaceURI != W or container.localName != name:
            continue
        projected = canonical(container, False)
        children = protected_property_children(projected[4], editable, name == "pPr")
        if projected[3] or children:
            result.append(projected[:4] + [children])
    return result

def page_flow(root):
    return (
        [canonical(node, False) for node in root.getElementsByTagNameNS(W, "sectPr")],
        [protected_properties(node, "pPr", DIRECT_PARAGRAPH_FORMATS)
            for node in root.getElementsByTagNameNS(W, "p")],
        [protected_properties(node, "rPr", DIRECT_RUN_FORMATS)
            for node in root.getElementsByTagNameNS(W, "r")],
    )

def table_format_preserved(source, candidate):
    before_tables = source.getElementsByTagNameNS(W, "tbl")
    after_tables = candidate.getElementsByTagNameNS(W, "tbl")
    if len(before_tables) != len(after_tables):
        return False
    for before, after in zip(before_tables, after_tables):
        after_context = context_for_node(after)
        after = after.cloneNode(deep=True)
        before_rows = before.getElementsByTagNameNS(W, "tr")
        after_rows = after.getElementsByTagNameNS(W, "tr")
        if len(before_rows) != len(after_rows):
            return False
        for old_row, new_row in zip(before_rows, after_rows):
            old = [node for node in old_row.childNodes if node.namespaceURI == W and node.localName == "trPr"]
            new = [node for node in new_row.childNodes if node.namespaceURI == W and node.localName == "trPr"]
            if len(old) > 1 or len(new) != 1:
                continue
            for name in ("cantSplit", "tblHeader"):
                if old and any(node.namespaceURI == W and node.localName == name for node in old[0].childNodes):
                    continue
                additions = [node for node in new[0].childNodes if node.namespaceURI == W and node.localName == name]
                if len(additions) != 1:
                    continue
                flag = additions[0]
                shape = canonical(flag, False)
                if not shape[4] and (not shape[3] or shape[3] in ([[W, "val", value]] for value in ("1", "true", "on"))):
                    new[0].removeChild(flag)
                    if not old and not new[0].childNodes and not canonical(new[0], False)[3]:
                        new_row.removeChild(new[0])
                        break
        if canonical(before, False) != canonical(after, False, after_context):
            return False
    return True

def main(payload):
    source_data = decode(payload["source"])
    candidate_data = decode(payload["candidate"])
    source_parts = load_zip(source_data)
    candidate_parts = load_zip(candidate_data)
    source_names = set(source_parts)
    candidate_names = set(candidate_parts)
    added = sorted(candidate_names - source_names)
    removed = sorted(source_names - candidate_names)
    if added or removed:
        fail(
            "The adopted package changed its part set: added="
            + json.dumps(added) + ", removed=" + json.dumps(removed)
        )

    changed_parts = sorted(
        name for name in source_names
        if source_parts[name] != candidate_parts[name]
    )
    changed_story_parts = []
    actual_format_change = False

    for name in changed_parts:
        source = source_parts[name]
        candidate = candidate_parts[name]
        if not is_xml(name):
            fail("A binary package part changed: " + name)
        source_root = parse_xml(source, name)
        candidate_root = parse_xml(candidate, name)
        if source_root.namespaceURI == W and source_root.localName == "document":
            if canonical_json(source_root, True) != canonical_json(candidate_root, True):
                fail("A story part changed text, formulas, drawings, relationships or protected structure: " + name)
            if page_flow(source_root) != page_flow(candidate_root):
                fail("A story part changed sections or protected paragraph and run properties: " + name)
            if not table_format_preserved(source_root, candidate_root):
                fail("A story part changed an existing table's formatting: " + name)
            if canonical_json(source_root, False) != canonical_json(candidate_root, False):
                changed_story_parts.append(name)
                actual_format_change = True
            continue
        if canonical_json(source_root, False) != canonical_json(candidate_root, False):
            fail("A protected package part changed: " + name)

    if not actual_format_change:
        fail("The candidate has no actual XML format change.")

    return {
        "passed": True,
        "methodVersion": "independent-docx-format-2.6.0",
        "sourceSha256": sha(source_data),
        "candidateSha256": sha(candidate_data),
        "package": {
            "partSetPreserved": True,
            "changedParts": changed_parts,
            "changedStoryParts": changed_story_parts,
            "binaryPartsPreserved": True,
            "protectedXmlPreserved": True,
            "pageFlowPreserved": True,
            "tableFormattingPreserved": True,
            "actualFormatChange": True,
        },
        "ignoredNormalizations": [
            "w:rsid* and w:textId/w14:textId attributes; w:paraId/w14:paraId outside w:comments; redundant xml:space where text has no edge whitespace",
            "w:lastRenderedPageBreak and w:proofErr cache nodes",
            "XML prefix, namespace declaration and attribute order; expanded names remain compared",
            "w:pPr, w:rPr, w:tblPr, w:trPr, w:tcPr, w:sectPr and w:tblGrid are compared separately in main-document XML",
        ],
    }

try:
    result = main(json.loads(sys.stdin.read()))
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
except AssertionError as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(2)
`;

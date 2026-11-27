import { readXml, type XmlNode } from "@docx-editor.dev/core/store";
import { strFromU8, unzipSync } from "fflate";

export const STRICT_WORD_NAMESPACE =
  "http://purl.oclc.org/ooxml/wordprocessingml/main";
export const TRANSITIONAL_WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
export const DOCX_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

type XmlElement = Extract<XmlNode, { type: "element" }>;

function readPackagePart(parts: Record<string, Uint8Array>, name: string) {
  const part = parts[name];
  if (!part) throw new Error(`DOCX package is missing ${name}.`);
  return strFromU8(part);
}

function rootElement(xml: string, partName: string): XmlElement {
  const parsed = readXml(xml);
  if (!parsed.ok) {
    throw new Error(`${partName} is not well-formed XML: ${parsed.reason}.`);
  }
  const root = parsed.nodes.find(
    (node): node is XmlElement => node.type === "element",
  );
  if (!root) throw new Error(`${partName} has no document element.`);
  return root;
}

function localName(name: string) {
  const separator = name.lastIndexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

function elementNamespace(element: XmlElement, root: XmlElement) {
  const separator = element.name.lastIndexOf(":");
  const declaration = separator === -1
    ? "xmlns"
    : `xmlns:${element.name.slice(0, separator)}`;
  return element.attributes[declaration] ??
    (element === root ? null : root.attributes[declaration]) ??
    null;
}

export function strictIeeePackageFacts(bytes: Uint8Array) {
  const parts = unzipSync(bytes);
  const documentXml = readPackagePart(parts, "word/document.xml");
  const contentTypes = readPackagePart(parts, "[Content_Types].xml");
  const documentRoot = rootElement(documentXml, "word/document.xml");
  if (localName(documentRoot.name) !== "document") {
    throw new Error("word/document.xml does not have a document root element.");
  }
  const namespace = elementNamespace(documentRoot, documentRoot);
  const contentTypesRoot = rootElement(contentTypes, "[Content_Types].xml");
  if (
    localName(contentTypesRoot.name) !== "Types" ||
    elementNamespace(contentTypesRoot, contentTypesRoot) !== CONTENT_TYPES_NAMESPACE
  ) {
    throw new Error("[Content_Types].xml does not have a content-types Types root.");
  }
  const documentOverrides = contentTypesRoot.children.filter(
    (node): node is XmlElement =>
      node.type === "element" &&
      localName(node.name) === "Override" &&
      elementNamespace(node, contentTypesRoot) === CONTENT_TYPES_NAMESPACE &&
      node.attributes.PartName === "/word/document.xml",
  );
  return {
    strict: namespace === STRICT_WORD_NAMESPACE,
    namespace,
    mainContentType:
      documentOverrides.length === 1 &&
      documentOverrides[0]?.attributes.ContentType === DOCX_MAIN_CONTENT_TYPE,
  };
}

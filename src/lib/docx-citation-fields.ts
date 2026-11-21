import { parseRefInstruction } from "@docx-editor.dev/core/layout";
import { CUSTOM_XML_REL, relationshipsOf, resolveInternalTarget, type OoxmlElement, type OoxmlNode, type OoxmlPackage, type OoxmlPart } from "@docx-editor.dev/core/store";
import { docxCitationIdentity, docxDoiUrl } from "./docx-citation-doi";
import type { DocxInlineAtom, DocxModelRange, DocxParagraphSemantics } from "./docx-session";
import { safeHttpUrl } from "./system-browser";

export type DocxFieldKind =
  | "citation"
  | "bibliography"
  | "cross-reference"
  | "unknown";

export type DocxFieldFamily =
  | "word"
  | "zotero"
  | "csl"
  | "mendeley"
  | "endnote";

export interface DocxFieldClassification {
  readonly kind: DocxFieldKind;
  readonly family: DocxFieldFamily | null;
  readonly editable: false;
}

export interface DocxParagraphFieldClassification
  extends DocxFieldClassification {
  readonly objectRef: string;
}

const unknownField: DocxFieldClassification = {
  kind: "unknown",
  family: null,
  editable: false,
};

const zoteroCitation =
  /^ADDIN\s+ZOTERO_ITEM\s+CSL_CITATION(?=\s|\{|$)/iu;
const zoteroBibliography =
  /^ADDIN\s+ZOTERO_BIBL\b[\s\S]*\sCSL_BIBLIOGRAPHY\s*$/iu;
const cslCitation = /^ADDIN\s+CSL_CITATION(?=\s|\{|$)/iu;
const mendeleyBibliography =
  /^ADDIN\s+Mendeley\s+Bibliography\s+CSL_BIBLIOGRAPHY(?=\s|$)/iu;
const endNoteCitation = /^ADDIN\s+EN\.CITE(?=\s|<|$)/iu;
const endNoteBibliography = /^ADDIN\s+EN\.REFLIST(?=\s|$)/iu;
export const WORD_BIBLIOGRAPHY = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
const citationValueSwitches = new Set(["\\f", "\\l", "\\p", "\\s", "\\v", "\\*"]);
const citationFlagSwitches = new Set(["\\n", "\\t", "\\y", "\\*mergeformat"]);

function field(
  kind: Exclude<DocxFieldKind, "unknown">,
  family: DocxFieldFamily,
): DocxFieldClassification {
  return { kind, family, editable: false };
}

function hasArgument(rest: string | undefined): boolean {
  const argument = rest?.trim() ?? "";
  return argument.length > 0 && !argument.startsWith("\\");
}

function atomFieldCode(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function classifyDocxFieldCode(
  code: string,
): DocxFieldClassification {
  const instruction = code.trim();
  const native = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/u.exec(instruction);
  const name = native?.[1]?.toUpperCase();
  if (name) {
    const rest = native?.[2];
    if (name === "CITATION" && hasArgument(rest))
      return field("citation", "word");
    if (name === "BIBLIOGRAPHY")
      return field("bibliography", "word");
    if ((name === "REF" || name === "PAGEREF") && hasArgument(rest))
      return field("cross-reference", "word");
  }

  if (zoteroCitation.test(instruction)) return field("citation", "zotero");
  if (zoteroBibliography.test(instruction))
    return field("bibliography", "zotero");
  if (cslCitation.test(instruction)) return field("citation", "csl");
  if (mendeleyBibliography.test(instruction))
    return field("bibliography", "mendeley");
  if (endNoteCitation.test(instruction)) return field("citation", "endnote");
  if (endNoteBibliography.test(instruction))
    return field("bibliography", "endnote");
  return unknownField;
}

export function readParagraphFieldClassifications(
  paragraph: DocxParagraphSemantics,
): readonly DocxParagraphFieldClassification[] {
  return paragraph.atoms.flatMap(
    (atom): DocxParagraphFieldClassification[] => {
      if (atom.kind !== "field") return [];
      const code = atomFieldCode(atom.payload);
      return [
        {
          objectRef: atom.objectRef,
          ...(code === null
            ? unknownField
            : classifyDocxFieldCode(code)),
        },
      ];
    },
  );
}

interface DocxCitationSource {
  readonly title: string;
  readonly url: string | null;
}

type DocxFieldAction =
  | { readonly kind: "citation"; readonly sources: readonly DocxCitationSource[] }
  | { readonly kind: "reference"; readonly bookmark: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function citationSource(titleValue: unknown, doiValue: unknown, urlValue: unknown): DocxCitationSource | null {
  const title = typeof titleValue === "string" ? titleValue.trim() : "";
  const link = typeof urlValue === "string" ? urlValue : "";
  const { dois, conflict } = docxCitationIdentity(typeof doiValue === "string" ? doiValue : "", link);
  if (conflict) return title ? { title, url: null } : null;
  const [doi] = dois;
  const explicitUrl = safeHttpUrl(link);
  const parsed = explicitUrl && new URL(explicitUrl);
  const url = doi ? docxDoiUrl(doi) : parsed && !parsed.username && !parsed.password ? explicitUrl : null;
  const label = title || doi || url;
  return label ? { title: label, url } : null;
}

export function bibliographyText(element: OoxmlElement, name: string): string {
  const children: readonly OoxmlNode[] = element.children;
  const child = children.find((node): node is OoxmlElement =>
    node.kind !== "textValue" && node.namespaceUri === WORD_BIBLIOGRAPHY && node.localName === name);
  return child?.children.map((node) => node.kind === "textValue" ? node.value : "").join("").trim() ?? "";
}

export function bibliographyParts(pkg: OoxmlPackage): OoxmlPart[] {
  const parts = new Map<string, OoxmlPart>();
  for (const relationship of relationshipsOf(pkg, pkg.mainDocumentPart)) {
    if (relationship.type !== CUSTOM_XML_REL || relationship.targetMode !== "Internal") continue;
    const target = resolveInternalTarget(pkg.mainDocumentPart, relationship.rawTarget);
    if (!target.ok || parts.has(target.partName)) continue;
    const part = pkg.parts.get(target.partName);
    if (part?.root.namespaceUri === WORD_BIBLIOGRAPHY && part.root.localName === "Sources") {
      parts.set(target.partName, part);
    }
  }
  return [...parts.values()];
}

export function bibliographySources(part: OoxmlPart): OoxmlElement[] {
  const children: readonly OoxmlNode[] = part.root.children;
  return children.filter((child): child is OoxmlElement =>
    child.kind !== "textValue" && child.namespaceUri === WORD_BIBLIOGRAPHY && child.localName === "Source");
}

function nativeCitationSources(code: string, pkg: OoxmlPackage): DocxCitationSource[] | null {
  const tokens = code.match(/"[^"\r\n]*"(?=\s|$)|[^\s"]+(?=\s|$)|\S+/gu) ?? [];
  const tagValue = (token = "") => /^(?:"[^"\\]+"|[^"\\\s]+)$/u.test(token) ? token.replace(/^"|"$/gu, "") : "";
  const firstTag = tagValue(tokens[1]);
  if (!firstTag) return null;
  const tags = new Set([firstTag]);
  for (let index = 2; index < tokens.length; index++) {
    const name = tokens[index].toLowerCase();
    if (name === "\\m") {
      const tag = tagValue(tokens[++index]);
      if (!tag) return null;
      tags.add(tag);
    } else if (citationValueSwitches.has(name)) {
      const value = tokens[++index];
      if (!value || !/^(?:"[^"\r\n]*"|[^"\\\s]+)$/u.test(value)) return null;
    } else if (!citationFlagSwitches.has(name)) return null;
  }
  const byTag = new Map<string, DocxCitationSource | null>();
  for (const part of bibliographyParts(pkg)) {
    for (const child of bibliographySources(part)) {
      const tag = bibliographyText(child, "Tag");
      if (!tags.has(tag)) continue;
      byTag.set(tag, byTag.has(tag) ? null : citationSource(
        bibliographyText(child, "Title"), bibliographyText(child, "DOI"), bibliographyText(child, "URL"),
      ));
    }
  }
  const sources: DocxCitationSource[] = [];
  for (const tag of tags) {
    const source = byTag.get(tag);
    if (!source) return null;
    sources.push(source);
  }
  return sources;
}

function fieldAction(atom: DocxInlineAtom, getPackage?: () => OoxmlPackage): DocxFieldAction | null {
  const code = atomFieldCode(atom.payload)?.trim();
  if (!code) return null;
  const classification = classifyDocxFieldCode(code);
  if (classification.kind === "cross-reference") {
    const bookmark = parseRefInstruction(code)?.bookmark;
    return bookmark ? { kind: "reference", bookmark } : null;
  }
  if (classification.kind === "citation" && classification.family === "word") {
    const sources = getPackage && nativeCitationSources(code, getPackage());
    return sources ? { kind: "citation", sources } : null;
  }
  const prefix = (zoteroCitation.exec(code) ?? cslCitation.exec(code))?.[0];
  if (!prefix) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(code.slice(prefix.length));
  } catch {
    return null;
  }
  const items = record(payload)?.citationItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  const sources: DocxCitationSource[] = [];
  for (const item of items) {
    const data = record(record(item)?.itemData);
    const source = data && citationSource(data.title, data.DOI, data.URL);
    if (!source) return null;
    sources.push(source);
  }
  return { kind: "citation", sources };
}

export function readDocxFieldAction(paragraph: DocxParagraphSemantics, range: DocxModelRange, getPackage?: () => OoxmlPackage) {
  const fields = paragraph.atoms.filter((atom) => atom.kind === "field" && (
    range.start === range.end
      ? atom.modelRange.start <= range.start && range.end <= atom.modelRange.end
      : atom.modelRange.start === range.start && atom.modelRange.end === range.end
  ));
  if (fields.length !== 1) return null;
  const atom = fields[0];
  const action = fieldAction(atom, getPackage);
  return action ? { action, range: atom.modelRange, revision: paragraph.revision } : null;
}

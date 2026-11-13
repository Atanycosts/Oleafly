import {
  buildNumberingIndex,
  buildStyleCascadeTable,
  cascadeParagraphFormatting,
  cascadeRunProperties,
  enumerateDocumentSectionsBounded,
  geometryOfSection,
  parseSectionProperties,
  readTableStructure,
  resolveParagraphLayoutInputs,
  resolveRunStyle,
  resolveStoryListItems,
  storyBlocks,
  type ParagraphLayoutInputs,
  type SectionProperties,
  type StyleCascadeTable,
  type TableCellStyleFormatting,
} from "@docx-editor.dev/core/layout";
import {
  openHeadlessDocument,
  readOoxmlPart,
  resolveContentTypeOf,
  type OoxmlElement,
  type OoxmlNode,
  type OoxmlProperty,
} from "@docx-editor.dev/core/store";
import corePackage from "@docx-editor.dev/core/package.json";
import type {
  DocxFormatFacts,
  DocxFormatJson,
  DocxFormatObject,
  DocxFormatProperties,
  DocxFormatQueryRequest,
  DocxFormatQueryResult,
  DocxFormatRegionRole,
  DocxFormatRole,
  DocxFormatRoleBasis,
  DocxFormatSnapshotV1,
} from "./docx-format-types";

export type * from "./docx-format-types";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STORY_NAMES = new Set(["document", "hdr", "ftr", "footnote", "endnote"]);
const STRUCTURAL_NAMES = new Set(["tbl", "tr", "tc", "sectPr", "drawing", "pict", "object", "sdt", "txbxContent", "footnotes", "endnotes", "comment"]);

function clean(value: unknown): DocxFormatJson {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Map ? Object.fromEntries(item) : item,
  )) as DocxFormatJson;
}

function record(value: unknown): DocxFormatProperties {
  return clean(value) as DocxFormatProperties;
}

function child(node: OoxmlElement, name: string): OoxmlElement | undefined {
  for (const candidate of node.children) {
    if (candidate.kind !== "textValue" && candidate.namespaceUri === W && candidate.localName === name) return candidate;
  }
  return undefined;
}

function attr(node: OoxmlElement | undefined, name: string): string | undefined {
  return node?.attributes.find((attribute) => attribute.namespaceUri === W && attribute.localName === name)?.value;
}

function properties(container: OoxmlElement | undefined): readonly OoxmlProperty[] {
  return container?.children.flatMap((node) => node.kind === "textValue" || node.namespaceUri !== W ? [] : [{
    localName: node.localName,
    attributes: Object.fromEntries(node.attributes.map((attribute) => [attribute.localName, attribute.value])),
  }]) ?? [];
}

function declared(node: OoxmlElement): DocxFormatProperties {
  return record({
    namespace_uri: node.namespaceUri,
    local_name: node.localName,
    attributes: node.attributes,
    namespace_bindings: node.namespaceBindings,
    properties: node.children.filter((candidate) => candidate.kind !== "textValue" && candidate.namespaceUri === W &&
      ["pPr", "rPr", "tblPr", "trPr", "tcPr", "tblGrid"].includes(candidate.localName)),
  });
}

function textOf(node: OoxmlNode): string {
  if (node.kind === "textValue") return node.value;
  if (node.namespaceUri === W && ["tab", "br", "cr"].includes(node.localName)) return node.localName === "tab" ? "\t" : "\n";
  if (node.namespaceUri === W && ["pPr", "rPr", "tblPr", "trPr", "tcPr", "instrText"].includes(node.localName)) return "";
  return node.children.map(textOf).join("");
}

function scriptUsage(text: string): DocxFormatProperties {
  return {
    latin: /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}0-9]/u.test(text),
    east_asian: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u.test(text),
    complex: /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Thai}\p{Script=Tamil}]/u.test(text),
    other: /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Thai}\p{Script=Tamil}\p{Script=Common}\p{Script=Inherited}]/u.test(text),
  };
}

function styleChain(table: StyleCascadeTable, id: string | null): DocxFormatProperties[] {
  const result: DocxFormatProperties[] = [];
  const seen = new Set<string>();
  for (let current = id; current && !seen.has(current);) {
    seen.add(current);
    const style = table.styles.get(current);
    if (!style) break;
    result.push(record({ style_id: current, name: style.name, based_on: style.basedOn, type: style.type }));
    current = style.basedOn;
  }
  return result;
}

function roleFor(
  table: StyleCascadeTable,
  styleId: string | null,
  layout: ParagraphLayoutInputs,
  text: string,
  story: DocxFormatRole,
): { role: DocxFormatRole; basis: DocxFormatRoleBasis[] } {
  const name = styleId ? table.styles.get(styleId)?.name : undefined;
  const basis: DocxFormatRoleBasis[] = [];
  if (styleId) basis.push({ source: "style_id", value: styleId, certainty: "uncertain" });
  if (name) basis.push({ source: "style_name", value: name, certainty: "uncertain" });
  if (["header", "footer", "footnote", "endnote"].includes(story)) {
    return { role: story, basis: [...basis, { source: "story", value: story, certainty: "explicit" }] };
  }
  const content = text.trim();
  const fromContent = (role: DocxFormatRole, value: string) => ({
    role, basis: [...basis, { source: "content" as const, value, certainty: "inferred" as const }],
  });
  if (/^(abstract|摘要)\s*[:：—–-]?$/i.test(content)) return fromContent("abstract_heading", content);
  if (/^(abstract|摘要)\s*[:：—–-]\s*\S/i.test(content)) return fromContent("abstract", content.slice(0, 60));
  if (/^(key\s*words?|index\s*terms|关键词|关键字)\s*[:：—–-]/i.test(content)) return fromContent("keywords", content.slice(0, 60));
  if (/^(references?|bibliography|参考文献|appendix(?:\s+[A-Z0-9]+)?|appendices|acknowledg(?:e)?ments?|附录|致谢)\s*[:：]?$/i.test(content)) return fromContent("heading", content);
  if (/^\[?affiliations?(?:\(s\))?\]?\s*[:：]?$/i.test(content) ||
      /^(?:corresponding\s+author|e-?mail|通讯作者|通信作者|作者单位|单位)\s*[:：]/i.test(content) ||
      /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(content) ||
      /^(?:department|school|faculty|institute|university|laboratory|college)\s+(?:of\s+)?/i.test(content)) return fromContent("affiliation", content.slice(0, 80));
  if (layout.outlineLevel !== null) {
    return { role: "heading", basis: [...basis, { source: "outline_level", value: String(layout.outlineLevel), certainty: "explicit" }] };
  }
  if (/^(figure|fig\.|table|图|表)\s*(?:\d+|[一二三四五六七八九十]+|[IVXLCDM]+)(?:\s*[.:：—–-]\s*\S|\.?\s*$)/i.test(content)) return fromContent("caption", content.slice(0, 60));
  const labels = [styleId, name].filter((label): label is string => !!label)
    .map((label) => label.replace(/^ijam[ _-]*/i, "").replace(/[ _-]/g, "").toLowerCase());
  const matching: [RegExp, DocxFormatRole][] = [
    [/^(?:(?:figure|table)(?:caption|title)|caption|图题|表题|题注)$/, "caption"],
    [/^(?:title|documenttitle|papertitle|articletitle|论文标题|文章标题|标题)$/, "document_title"],
    [/^(?:affiliations?|institutions?|address|单位|机构)$/, "affiliation"],
    [/^(?:authors?|作者)$/, "author"],
    [/^(?:abstract(?:heading|title)|摘要标题)$/, "abstract_heading"],
    [/^(?:abstract|摘要)$/, "abstract"],
    [/^(?:keywords?|indexterms|关键词|关键字)$/, "keywords"],
    [/^(?:referencehead(?:ing)?|bibliographyhead(?:ing)?)$/, "heading"],
    [/^(?:bibliography|references?|参考文献)$/, "reference"],
    [/^(?:(?:heading|head)[1-9]?|标题[1-9一二三四五六七八九])$/, "heading"],
    [/^(?:normal|body|bodytext|text|正文)$/, "body"],
  ];
  for (const [pattern, role] of matching) {
    if (labels.some((label) => pattern.test(label))) return { role, basis: basis.map((entry) => ({ ...entry, certainty: "inferred" })) };
  }
  return { role: "unknown", basis: [...basis, { source: "context", value: "No supported semantic role evidence", certainty: "uncertain" }] };
}

function refineBodyRoles(objects: DocxFormatObject[], mainPart: string): void {
  const paragraphs = objects.filter((object) => object.kind === "paragraph" && object.part === mainPart &&
    object.evidence.top_level_body === true && /[\p{L}\p{N}]/u.test(object.text ?? ""));
  const runsByParagraph = new Map<string, DocxFormatObject[]>();
  for (const object of objects) {
    if (object.kind !== "run") continue;
    const paragraphId = object.evidence.paragraph_object_id as string;
    const runs = runsByParagraph.get(paragraphId) ?? [];
    runs.push(object);
    runsByParagraph.set(paragraphId, runs);
  }
  const assign = (paragraph: DocxFormatObject, role: DocxFormatRole, evidence: string) => {
    paragraph.role = role;
    paragraph.role_basis = [...paragraph.role_basis, { source: "context", value: evidence, certainty: "inferred" }];
  };
  const presentation = (paragraph: DocxFormatObject) => {
    const runs = (runsByParagraph.get(paragraph.object_id) ?? []).filter((run) => /[\p{L}\p{N}]/u.test(run.text ?? ""));
    const length = runs.reduce((sum, run) => sum + (run.text?.length ?? 0), 0);
    return {
      size: length ? runs.reduce((sum, run) => sum + ((run.properties.run as DocxFormatProperties).fontSizePt as number) * (run.text?.length ?? 0), 0) / length : 0,
      bold: length ? runs.reduce((sum, run) => sum + ((run.properties.run as DocxFormatProperties).bold ? run.text?.length ?? 0 : 0), 0) / length > 0.8 : false,
      centered: (paragraph.properties.paragraph as DocxFormatProperties).alignment === "center",
    };
  };
  let reachedBody = false;
  let abstractBody = false;
  let references = false;
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const text = paragraph.text?.trim() ?? "";
    const props = paragraph.properties.paragraph as DocxFormatProperties;
    const next = paragraphs[index + 1];
    const upcoming = paragraphs.slice(index + 1, index + 5);
    const abstractAhead = upcoming.find((candidate) => candidate.role === "abstract" || candidate.role === "abstract_heading");
    if (!reachedBody && abstractAhead && ["body", "unknown", "heading"].includes(paragraph.role) && props.outlineLevel === null && text.length <= 240) {
      const display = presentation(paragraph);
      const abstractDisplay = presentation(abstractAhead);
      const frontMatterChain = upcoming.slice(0, upcoming.indexOf(abstractAhead)).every((candidate) =>
        ["author", "affiliation"].includes(candidate.role));
      const authorAhead = upcoming.some((candidate) => candidate.role === "author");
      const isUnnumberedHeading = paragraph.role === "heading" && paragraph.role_basis.some((entry) =>
        (entry.source === "style_name" || entry.source === "style_id") && /^(?:ijam[ _-]*)?heading$/i.test(entry.value));
      const emphasized = display.centered && (display.size > abstractDisplay.size * 1.15 || display.bold && !abstractDisplay.bold);
      if (frontMatterChain && (index === 0 || next === abstractAhead) &&
          (emphasized || isUnnumberedHeading && authorAhead)) assign(paragraph, "document_title", "Short front-matter paragraph before author/abstract sequence with distinct title presentation");
    }
    if (references && ["body", "unknown"].includes(paragraph.role) &&
        /(?:\b(?:19|20)\d{2}\b|https?:\/\/|\bdoi\b|\[[JMCNDR]\])/i.test(text)) {
      assign(paragraph, "reference", "Bibliographic entry following an explicit references heading");
    }
    if (abstractBody && ["body", "unknown"].includes(paragraph.role)) {
      assign(paragraph, "abstract", "Prose following an explicit abstract heading before keywords or a section heading");
    }
    if (paragraph.role === "abstract_heading") abstractBody = true;
    else if (["keywords", "heading", "document_title", "author", "affiliation"].includes(paragraph.role)) abstractBody = false;
    if (paragraph.role === "heading") {
      references = /^(?:references?|bibliography|参考文献)\s*[:：]?$/i.test(text);
      if (!references) reachedBody = true;
    } else if (paragraph.role === "body" || paragraph.role === "unknown") reachedBody = true;
  }
  for (const paragraph of paragraphs) {
    for (const run of runsByParagraph.get(paragraph.object_id) ?? []) {
      run.role = paragraph.role;
      run.role_basis = paragraph.role_basis;
    }
  }
}

type RegionCategory = Exclude<DocxFormatRegionRole, "mixed" | "unknown">;
type SpecialRegion = Extract<RegionCategory, "references" | "appendix">;

function preview(object: DocxFormatObject): string {
  const text = (object.text ?? "").trim().replace(/\s+/g, " ");
  if (text.length > 80) return `${text.slice(0, 77)}...`;
  return text || object.kind;
}

function specialHeading(object: DocxFormatObject): SpecialRegion | null {
  const text = object.text?.trim() ?? "";
  if (object.role !== "heading") return null;
  if (/^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:appendix(?:\s+[A-Z0-9]+)?|appendices|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)(?:\s*[:：]\s*.*)?$/i.test(text)) {
    return "appendix";
  }
  if (/^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:references?|bibliography|参考文献)\s*[:：]?$/i.test(text)) {
    return "references";
  }
  return null;
}

function headingLevel(object: DocxFormatObject): number | null {
  const paragraph = object.properties.paragraph as DocxFormatProperties | undefined;
  return typeof paragraph?.outlineLevel === "number" ? paragraph.outlineLevel : null;
}

function inferSectionRegions(objects: DocxFormatObject[]): void {
  const evidenceBySection = new Map<string, Map<RegionCategory, string>>();
  let currentSectionId: string | undefined;
  let specialContext: { role: SpecialRegion; level: number | null } | undefined;
  for (const object of objects) {
    if (!object.region) continue;
    const sectionId = object.region.section_object_id;
    if (sectionId !== currentSectionId) {
      currentSectionId = sectionId;
      specialContext = undefined;
    }
    if (object.evidence.top_level_body !== true || !["paragraph", "table"].includes(object.kind)) continue;
    const text = object.text?.trim() ?? "";
    if (object.kind === "paragraph" && !/[\p{L}\p{N}]/u.test(text)) continue;
    let category: RegionCategory | null = null;
    if (["document_title", "author", "affiliation", "abstract_heading", "abstract", "keywords"].includes(object.role)) {
      category = "front_matter";
      specialContext = undefined;
    } else {
      const explicitRegion = specialHeading(object);
      if (explicitRegion) {
        category = explicitRegion;
        specialContext = { role: explicitRegion, level: headingLevel(object) };
      } else if (object.role === "reference") {
        category = "references";
        specialContext = { role: "references", level: headingLevel(object) };
      } else if (object.role === "heading" && specialContext) {
        const level = headingLevel(object);
        if (level === null || specialContext.level === null || level <= specialContext.level) {
          specialContext = undefined;
          category = "body";
        } else {
          category = specialContext.role;
        }
      } else if (specialContext && ["body", "heading", "caption", "table", "unknown"].includes(object.role)) {
        category = specialContext.role;
      } else if (["body", "heading", "caption", "table"].includes(object.role)) {
        category = "body";
      }
    }
    if (!category) continue;
    const evidence = evidenceBySection.get(sectionId) ?? new Map<RegionCategory, string>();
    if (!evidence.has(category)) evidence.set(category, `${category}: ${object.role}: ${preview(object)}`);
    evidenceBySection.set(sectionId, evidence);
  }
  const inferenceBySection = new Map<string, Pick<NonNullable<DocxFormatObject["region"]>, "role" | "role_basis">>();
  for (const object of objects) {
    if (!object.region) continue;
    const evidence = evidenceBySection.get(object.region.section_object_id);
    if (!evidence || evidence.size === 0) {
      inferenceBySection.set(object.region.section_object_id, {
        role: "unknown",
        role_basis: [{ source: "context", value: "unknown: no supported semantic category evidence in section", certainty: "uncertain" }],
      });
      continue;
    }
    const role_basis = Array.from(evidence.values(), (value) => ({ source: "context" as const, value, certainty: "inferred" as const }));
    if (evidence.size === 1) {
      const role = evidence.keys().next().value as RegionCategory;
      inferenceBySection.set(object.region.section_object_id, { role, role_basis });
      continue;
    }
    inferenceBySection.set(object.region.section_object_id, {
      role: "mixed",
      role_basis: [
        ...role_basis,
        { source: "context", value: `mixed: ${Array.from(evidence.keys()).join(", ")}`, certainty: "uncertain" },
      ],
    });
  }
  for (const object of objects) {
    if (!object.region) continue;
    const inferred = inferenceBySection.get(object.region.section_object_id);
    if (inferred) object.region = { section_object_id: object.region.section_object_id, role: inferred.role, role_basis: inferred.role_basis };
  }
}

function storyRole(node: OoxmlElement, inherited: DocxFormatRole): DocxFormatRole {
  if (node.namespaceUri !== W) return inherited;
  return ({ hdr: "header", ftr: "footer", footnote: "footnote", endnote: "endnote" } as const)[node.localName as "hdr" | "ftr" | "footnote" | "endnote"] ?? inherited;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function openDocxFormatFacts(sourceBytes: Uint8Array): Promise<DocxFormatFacts> {
  const bytes = new Uint8Array(sourceBytes);
  const opened = openHeadlessDocument(bytes);
  if (!opened.ok) throw new Error(`DOCX facts could not open package: ${opened.reason}${opened.detail ? ` (${opened.detail})` : ""}`);
  const view = opened.view;
  const pkg = view.currentPackage();
  const sourceSha256 = await sha256(bytes);
  const table = buildStyleCascadeTable(view.stylesRoot(), view.documentThemeFonts(), view.settingsRoot());
  const numbering = buildNumberingIndex(view.numberingRoot());
  const trees = new Map(pkg.parts);
  for (const [name, partBytes] of pkg.partBytes) {
    if (trees.has(name)) continue;
    const contentType = resolveContentTypeOf(pkg, name);
    if (name.endsWith(".xml") || name.endsWith(".rels") || contentType?.includes("xml")) {
      const parsed = readOoxmlPart(new TextDecoder().decode(partBytes), { name, contentType: contentType ?? "application/xml" });
      if (parsed.ok) trees.set(name, parsed.part);
    }
  }
  const nodes: { part: string; path: number[]; node: OoxmlElement }[] = [];
  const nodesById = new Map<string, OoxmlElement>();
  const nodePaths = new Map<string, number[]>();
  const pathsByNode = new WeakMap<OoxmlNode, number[]>();
  const indexNode = (part: string, node: OoxmlNode, path: number[]): void => {
    nodePaths.set(`${part}\0${node.id}`, path);
    pathsByNode.set(node, path);
    if (node.kind === "textValue") return;
    nodesById.set(`${part}\0${node.id}`, node);
    nodes.push({ part, path, node });
    node.children.forEach((nested, index) => { indexNode(part, nested, [...path, index]); });
  };
  for (const [name, part] of trees) indexNode(name, part.root, [0]);
  const idOf = (part: string, node: OoxmlNode) => `${part}#${nodePaths.get(`${part}\0${node.id}`)?.join(".") ?? "synthetic"}`;
  const objects: DocxFormatObject[] = [];
  const unsupported: DocxFormatSnapshotV1["unsupported"] = [];
  const noteUnsupported = (code: string, detail: string, objectId: string) => {
    const existing = unsupported.find((entry) => entry.code === code);
    if (existing) existing.object_ids.push(objectId);
    else unsupported.push({ code, detail, object_ids: [objectId] });
  };
  const mainDocumentPart = view.part();
  const sectionEnumeration = enumerateDocumentSectionsBounded(mainDocumentPart);
  const bodyBlocks = storyBlocks(mainDocumentPart);
  const bodyBlockIds = new Set(bodyBlocks.map((block) => block.id));
  type SectionBinding = {
    index: number;
    properties: SectionProperties;
    blockStart: number;
    blockEndExclusive: number;
    boundary: "paragraph_properties" | "body_section" | "implicit";
    boundaryNode?: OoxmlElement;
    objectId: string;
  };
  const bodyNode = child(mainDocumentPart.root, "body");
  const bodySectionNode = bodyNode && child(bodyNode, "sectPr");
  const finalSectionIndex = sectionEnumeration.sections.at(-1)?.index;
  const sectionBindings: SectionBinding[] = sectionEnumeration.sections.map((section) => {
    const terminalId = section.blockStart < section.blockEndExclusive ? bodyBlocks[section.blockEndExclusive - 1]?.id : undefined;
    const terminal = terminalId ? nodesById.get(`${mainDocumentPart.name}\0${terminalId}`) : undefined;
    const paragraphProperties = terminal?.kind === "paragraph" ? child(terminal, "pPr") : undefined;
    const paragraphSectPr = paragraphProperties ? child(paragraphProperties, "sectPr") : undefined;
    const boundaryNode = paragraphSectPr ?? (
      section.index === finalSectionIndex && !sectionEnumeration.truncated ? bodySectionNode : undefined
    );
    const boundary = paragraphSectPr ? "paragraph_properties" as const :
      boundaryNode ? "body_section" as const : "implicit" as const;
    return {
      ...section,
      boundary,
      boundaryNode,
      objectId: boundaryNode ? idOf(mainDocumentPart.name, boundaryNode) : `${mainDocumentPart.name}#implicit-section-${section.index}`,
    };
  });
  const sectionsByBlockId = new Map<string, SectionBinding>();
  const sectionsByBoundaryNodeId = new Map<string, SectionBinding>();
  for (const binding of sectionBindings) {
    for (const block of bodyBlocks.slice(binding.blockStart, binding.blockEndExclusive)) sectionsByBlockId.set(block.id, binding);
    if (binding.boundaryNode) sectionsByBoundaryNodeId.set(binding.boundaryNode.id, binding);
  }
  const defaultSection = parseSectionProperties(undefined);
  type Context = {
    story: DocxFormatRole;
    section: SectionProperties;
    sectionBinding?: SectionBinding;
    width: number;
    paragraph?: { object: DocxFormatObject; layout: ParagraphLayoutInputs };
    cellStyle?: TableCellStyleFormatting;
    inCell: boolean;
    tableDepth: number;
    storyContent: boolean;
  };
  const makeObject = (part: string, node: OoxmlElement, kind: string, role: DocxFormatRole): DocxFormatObject => ({
    object_id: idOf(part, node), part, path: pathsByNode.get(node) as number[], kind,
    role, role_basis: [], properties: {}, declared: declared(node), evidence: {},
  });
  const bindToSection = (object: DocxFormatObject, binding: SectionBinding): void => {
    object.region = { section_object_id: binding.objectId, role: "unknown", role_basis: [] };
    object.evidence.core_section = record({
      index: binding.index,
      block_start: binding.blockStart,
      block_end_exclusive: binding.blockEndExclusive,
      boundary: binding.boundary,
      membership: "enumerateDocumentSectionsBounded",
    });
  };
  for (const [partName, part] of trees) {
    const rootIsStory = part.root.namespaceUri === W && ["document", "hdr", "ftr", "footnotes", "endnotes", "comments"].includes(part.root.localName);
    if (!rootIsStory) continue;
    const blocks = storyBlocks(part);
    const listItems = resolveStoryListItems(blocks, numbering, table);
    const cellContexts = new Map<string, { style: TableCellStyleFormatting; width: number; properties: DocxFormatProperties }>();
    const rowProperties = new Map<string, DocxFormatProperties>();
    const walk = (node: OoxmlNode, incoming: Context) => {
      if (node.kind === "textValue") return;
      const directSectionBinding = partName === mainDocumentPart.name ?
        sectionsByBoundaryNodeId.get(node.id) ?? sectionsByBlockId.get(node.id) :
        undefined;
      const sectionBinding = directSectionBinding ?? incoming.sectionBinding;
      const section = sectionBinding?.properties ?? incoming.section;
      const geometry = geometryOfSection(section);
      const fullWidth = geometry.width - geometry.margin.left - geometry.margin.right;
      const columnWidths = section.columns.definitions?.map((column) => column.widthTwips / 20);
      const sectionWidth = columnWidths?.[0] ?? (fullWidth - (section.columns.count - 1) * section.columns.gapTwips / 20) / section.columns.count;
      const context: Context = {
        ...incoming,
        story: storyRole(node, incoming.story), section, sectionBinding,
        width: directSectionBinding && !incoming.inCell ? sectionWidth : incoming.width,
        storyContent: incoming.storyContent || STORY_NAMES.has(node.localName),
      };
      const cell = cellContexts.get(node.id);
      if (cell) Object.assign(context, { cellStyle: cell.style, width: cell.width, inCell: true });
      let object: DocxFormatObject | undefined;
      if (node.namespaceUri === W && node.localName === "p" && context.storyContent) {
        const pPr = child(node, "pPr");
        const cascade = cascadeParagraphFormatting(table, pPr, context.cellStyle);
        const layout = resolveParagraphLayoutInputs(node, context.width, table, listItems.get(node.id), context.cellStyle, context.inCell, section.gridLinePitchTwips === undefined ? undefined : section.gridLinePitchTwips / 20);
        const text = textOf(node);
        const role = roleFor(table, cascade.styleId, layout, text, context.story);
        object = makeObject(partName, node, "paragraph", role.role);
        object.role_basis = role.basis;
        object.text = text;
        if (cascade.styleId) object.style_id = cascade.styleId;
        object.properties = record({ paragraph: layout, paragraph_mark: resolveRunStyle(cascade.markRunProperties, table.themeFonts), script_usage: scriptUsage(text) });
        object.evidence = record({ style_chain: styleChain(table, cascade.styleId), doc_defaults: true, theme: table.themeFonts, in_table_cell: context.inCell, top_level_body: partName === pkg.mainDocumentPart && bodyBlockIds.has(node.id), container_width_pt: context.width });
        context.paragraph = { object, layout };
      } else if (node.namespaceUri === W && node.localName === "r" && context.paragraph) {
        const inherited = context.paragraph.layout.inheritedRunProperties;
        const rPr = child(node, "rPr");
        const runProperties = cascadeRunProperties(inherited, properties(rPr), table);
        object = makeObject(partName, node, "run", context.paragraph.object.role);
        object.role_basis = context.paragraph.object.role_basis;
        object.text = textOf(node);
        const characterStyle = attr(rPr && child(rPr, "rStyle"), "val") ?? table.defaultCharacterStyleId;
        if (characterStyle) object.style_id = characterStyle;
        object.properties = record({ run: resolveRunStyle(runProperties, table.themeFonts), run_properties: runProperties, script_usage: scriptUsage(object.text) });
        object.evidence = record({ paragraph_object_id: context.paragraph.object.object_id, character_style_chain: styleChain(table, characterStyle), paragraph_style_id: context.paragraph.layout.styleId });
      } else if (node.namespaceUri === W && node.localName === "tbl" && context.storyContent) {
        object = makeObject(partName, node, "table", "table");
        object.role_basis = [{ source: "context", value: "w:tbl", certainty: "explicit" }];
        object.evidence = record({ top_level_body: partName === pkg.mainDocumentPart && bodyBlockIds.has(node.id) });
        const structure = readTableStructure(node, context.width, context.tableDepth, table);
        if (structure) {
          const { rows, ...tableProps } = structure;
          object.properties = record({ table: tableProps });
          for (const row of rows) {
            const { cells, ...rowProps } = row;
            rowProperties.set(row.id, record({ row: rowProps }));
            for (const resolvedCell of cells) {
              const { blocks: _blocks, styleFormatting, ...cellProps } = resolvedCell;
              const width = structure.columnWidthsPt.slice(resolvedCell.gridColumn, resolvedCell.gridColumn + resolvedCell.gridSpan).reduce((sum, value) => sum + value, 0) - resolvedCell.margins.left - resolvedCell.margins.right;
              cellContexts.set(resolvedCell.id, { style: styleFormatting, width, properties: record({ cell: cellProps, table_style: styleFormatting }) });
            }
          }
        } else noteUnsupported("table_structure_unresolved", "Core did not resolve this table structure. Declared XML remains queryable.", object.object_id);
        context.tableDepth++;
      } else if (node.namespaceUri === W && node.localName === "sectPr" && context.storyContent &&
          (partName !== mainDocumentPart.name || sectionBinding?.boundaryNode?.id === node.id)) {
        object = makeObject(partName, node, "section", "unknown");
        object.properties = record({ section: parseSectionProperties(node) });
        object.declared = record({ node });
      } else if (STORY_NAMES.has(node.localName) && node.namespaceUri === W) {
        object = makeObject(partName, node, "story", context.story);
        object.role_basis = [{ source: "story", value: node.localName, certainty: "explicit" }];
      } else if (context.storyContent && ((node.namespaceUri !== W) || STRUCTURAL_NAMES.has(node.localName))) {
        object = makeObject(partName, node, node.namespaceUri === W ? node.localName : "unsupported_node", context.story);
        object.properties = cell?.properties ?? rowProperties.get(node.id) ?? {};
        object.declared = record({ namespace_uri: node.namespaceUri, local_name: node.localName, attributes: node.attributes, namespace_bindings: node.namespaceBindings });
        if (node.namespaceUri !== W || ["drawing", "pict", "object"].includes(node.localName)) noteUnsupported("structural_only", "Structural facts are retained. This adapter does not compute drawing, equation, or extension rendering.", object.object_id);
      }
      if (object) {
        if (partName === mainDocumentPart.name && sectionBinding) bindToSection(object, sectionBinding);
        objects.push(object);
      }
      for (const nested of node.children) walk(nested, context);
    };
    const geometry = geometryOfSection(defaultSection);
    walk(part.root, { story: "unknown", section: defaultSection, width: geometry.width - geometry.margin.left - geometry.margin.right, inCell: false, tableDepth: 0, storyContent: rootIsStory });
  }
  refineBodyRoles(objects, pkg.mainDocumentPart);
  if (sectionEnumeration.truncated) unsupported.push({ code: "section_limit", detail: "Core section enumeration reached its documented bound.", object_ids: [] });
  for (const binding of sectionBindings) {
    if (binding.boundaryNode || objects.some((object) => object.kind === "section" && object.region?.section_object_id === binding.objectId)) continue;
    const object: DocxFormatObject = {
      object_id: binding.objectId,
      part: mainDocumentPart.name,
      path: [],
      kind: "section",
      role: "unknown",
      role_basis: [],
      properties: record({ section: binding.properties }),
      declared: {},
      evidence: { implicit: true },
    };
    bindToSection(object, binding);
    objects.push(object);
  }
  inferSectionRegions(objects);
  const parts = await Promise.all(Array.from(pkg.partBytes, async ([name, partBytes]) => {
    const parsed = trees.get(name);
    const type = resolveContentTypeOf(pkg, name);
    const xml = !!parsed || name.endsWith(".xml") || name.endsWith(".rels") || !!type?.includes("xml");
    return { name, content_type: type, byte_length: partBytes.byteLength, sha256: await sha256(partBytes), xml, status: parsed ? "parsed" as const : xml ? "unparsed" as const : "binary" as const, node_count: nodes.filter((entry) => entry.part === name).length };
  }));
  const snapshot: DocxFormatSnapshotV1 = {
    schema_version: 1, source_sha256: sourceSha256,
    engine: { name: "@docx-editor.dev/core", version: corePackage.version }, parts, objects,
    capabilities: { package_entries: "all", raw_part_bytes: true, xml_tree_query: true, relationship_query: true, effective_paragraphs: true, effective_runs: true, effective_sections: true, effective_tables: "semantic_structure", role_assignment: "evidence_with_uncertainty", rendered_pagination: false, journal_compliance: false, path_addressing: "canonical_tree_child_indices" },
    unsupported,
  };
  const query = (request: DocxFormatQueryRequest): DocxFormatQueryResult => {
    const bound = { schema_version: 1 as const, source_sha256: sourceSha256 };
    if (request.kind === "part") {
      const partBytes = pkg.partBytes.get(request.part);
      if (!partBytes) throw new Error(`Unknown DOCX part: ${request.part}`);
      if (request.format === "bytes") return { ...bound, kind: "part", part: request.part, format: "bytes", data: new Uint8Array(partBytes) };
      if (request.format === "text") return { ...bound, kind: "part", part: request.part, format: "text", data: new TextDecoder().decode(partBytes) };
      const part = trees.get(request.part);
      if (!part) throw new Error(`DOCX part has no parsed XML tree: ${request.part}`);
      return { ...bound, kind: "part", part: request.part, format: "tree", data: clean(part.root) };
    }
    if (request.kind === "relationships") {
      return { ...bound, kind: "relationships", relationships: Array.from(pkg.relationships).filter(([part]) => !request.part || part === request.part).flatMap(([, relationships]) => relationships.map(record)) };
    }
    const requestedAttribute = request.attribute;
    const matches = nodes.filter((entry) =>
      (!request.part || entry.part === request.part) &&
      (!request.path || request.path.length === entry.path.length && request.path.every((index, position) => entry.path[position] === index)) &&
      (!request.namespace_uri || entry.node.namespaceUri === request.namespace_uri) &&
      (!request.local_name || entry.node.localName === request.local_name) &&
      (!requestedAttribute || entry.node.attributes.some((attribute) => attribute.localName === requestedAttribute.local_name &&
        (!requestedAttribute.namespace_uri || attribute.namespaceUri === requestedAttribute.namespace_uri) &&
        (requestedAttribute.value === undefined || attribute.value === requestedAttribute.value))),
    );
    const offset = Math.max(0, Math.trunc(request.offset ?? 0));
    const limit = Math.max(1, Math.min(1000, Math.trunc(request.limit ?? 100)));
    return { ...bound, kind: "nodes", nodes: matches.slice(offset, offset + limit).map((entry) => ({ part: entry.part, path: [...entry.path], node: record(entry.node) })), total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null };
  };
  return { snapshot, query };
}

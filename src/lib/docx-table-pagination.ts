import {
  createNodeIdAllocator, WML_NAMESPACE_URI, type OoxmlElement, type OoxmlGenericElementNode,
  type OoxmlNode, type OoxmlPart,
} from "@docx-editor.dev/core/store";
import type { DocxFormatFacts, DocxFormatJson } from "./docx-format-types";

export interface DocxTableHeaderTemplate {
  column_count: number;
  rows: readonly { object_id: string; location: string }[];
}

const flags = { cantSplit: "row.cantSplit", tblHeader: "row.isHeader" } as const;
type RowFlag = keyof typeof flags;

export interface DocxTablePaginationChange {
  flag: RowFlag;
  property: typeof flags[RowFlag];
  rowId: string;
  row: number;
  tableNumber: number;
  templateRow?: DocxTableHeaderTemplate["rows"][number];
}

const isWord = <Name extends string>(node: OoxmlNode | undefined, name: Name): node is OoxmlElement & { localName: Name } =>
  !!node && node.kind !== "textValue" && node.namespaceUri === WML_NAMESPACE_URI && node.localName === name;
function child(node: OoxmlElement | undefined, name: string): OoxmlElement | undefined {
  for (const entry of node?.children ?? []) if (isWord(entry, name)) return entry;
}
const attribute = (node: OoxmlElement | undefined, name: string) =>
  node?.attributes.find((entry) => entry.namespaceUri === WML_NAMESPACE_URI && entry.localName === name)?.value;
const fields = (value: DocxFormatJson | undefined) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const number = (value: DocxFormatJson | undefined, fallback = 0) => typeof value === "number" ? value : fallback;

function elementAt(root: OoxmlElement, path: readonly number[]) {
  let element = root;
  for (const index of path.slice(1)) {
    const node = element.children[index];
    if (!node || node.kind === "textValue") return;
    element = node;
  }
  return element;
}

function tableStyleFlags(styles: OoxmlElement | null) {
  const byId = new Map<string, OoxmlElement>();
  let defaultId: string | undefined;
  for (const node of styles?.children ?? []) {
    if (!isWord(node, "style") || attribute(node, "type") !== "table") continue;
    const id = attribute(node, "styleId");
    if (!id) continue;
    byId.set(id, node);
    if (["1", "true", "on"].includes(attribute(node, "default") ?? "")) defaultId = id;
  }
  return (table: OoxmlElement) => {
    const result = new Set<RowFlag>();
    const seen = new Set<string>();
    const namedId = attribute(child(child(table, "tblPr"), "tblStyle"), "val");
    let id = namedId && byId.has(namedId) ? namedId : defaultId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const style = byId.get(id);
      for (const container of style?.children ?? []) {
        const properties = isWord(container, "trPr") ? container :
          isWord(container, "tblStylePr") ? child(container, "trPr") : undefined;
        for (const flag of ["cantSplit", "tblHeader"] as const) {
          if (child(properties, flag)) result.add(flag);
        }
      }
      id = attribute(child(style, "basedOn"), "val");
    }
    return result;
  };
}

export function planDocxTablePagination(facts: DocxFormatFacts, templates: readonly DocxTableHeaderTemplate[]) {
  const tables = facts.snapshot.objects.filter((object) => object.kind === "table");
  if (!tables.length) return [];
  const { root, name } = facts.documentPart;
  const body = child(root, "body");
  const byId = new Map(facts.snapshot.objects.map((object) => [object.object_id, object]));
  const fontSizes = new Map<string, number>();
  for (const object of facts.snapshot.objects) {
    const owner = object.evidence.paragraph_object_id;
    if (object.kind !== "run" || typeof owner !== "string") continue;
    const run = fields(object.properties.run);
    const size = Math.max(number(run?.fontSizePt), number(fields(run?.complexLane)?.fontSizePt), number(fields(run?.latinLane)?.fontSizePt));
    fontSizes.set(owner, Math.max(fontSizes.get(owner) ?? 0, size));
  }
  const styleFlags = tableStyleFlags(facts.stylesRoot);
  const templatesByWidth = new Map(templates.map((template) => [template.column_count, template.rows]));
  const changes: DocxTablePaginationChange[] = [];

  for (const [tableIndex, table] of tables.entries()) {
    if (table.part !== name || table.path.length !== 3 || table.evidence.top_level_body !== true) continue;
    const tableNode = body?.children[table.path[2]];
    const layout = fields(table.properties.table);
    const widths = layout?.columnWidthsPt;
    if (!isWord(tableNode, "tbl") || layout?.float || !Array.isArray(widths) || widths.length < 2) continue;
    const columnCount = widths.length;
    const section = fields(byId.get(table.region?.section_object_id ?? "")?.properties.section);
    if (!section) continue;
    const margins = fields(section.margins);
    const height = (number(fields(section.pageSize)?.heightTwips) -
      Math.abs(number(margins?.topTwips)) - Math.abs(number(margins?.bottomTwips))) / 20;
    if (height <= 0) continue;
    if (tableNode.children.some((node) => node.kind !== "textValue" &&
      !isWord(node, "tblPr") && !isWord(node, "tblGrid") && !isWord(node, "tr"))) continue;
    const inherited = styleFlags(tableNode);
    const rows = tableNode.children.flatMap((node, index) => {
      if (!isWord(node, "tr")) return [];
      const path = [...table.path, index];
      const id = `${name}#${path.join(".")}`;
      const object = byId.get(id);
      const properties = fields(object?.properties.row);
      const direct = child(node, "trPr");
      const editable = !properties?.revisionKind && !child(direct, "trPrChange") &&
        !direct?.children.some((entry) => entry.kind !== "textValue" && entry.localName === "AlternateContent");
      return [{ node, id, object, properties, direct, editable }];
    });
    if (rows.length < 2 || rows.some(({ properties, object }, index) =>
      !properties || object?.table_context?.row_index !== index || object.table_context.row_count !== rows.length)) continue;

    function simpleRowHeight(row: typeof rows[number]) {
      if (!row.editable || child(row.node, "tblPrEx") || child(row.direct, "hidden")) return Infinity;
      const explicitHeight = fields(row.properties?.height);
      if (explicitHeight?.rule === "exact") return Infinity;
      const cells = row.node.children.flatMap((node, index) => isWord(node, "tc") ? [{ node, index }] : []);
      if (cells.length !== columnCount || row.node.children.some((node) => node.kind !== "textValue" &&
        !isWord(node, "tc") && !isWord(node, "trPr"))) return Infinity;
      let estimate = number(explicitHeight?.valuePt);
      for (const { node, index } of cells) {
        const cell = fields(byId.get(`${row.id}.${index}`)?.properties.cell);
        if (cell?.gridSpan !== 1 || cell.vMergeContinue || cell.headsVerticalMerge || cell.textDirection !== "horizontal") return Infinity;
        const paragraphs = node.children.flatMap((entry, position) => isWord(entry, "p") ? [{ node: entry, position }] : []);
        if (paragraphs.length !== 1 || node.children.some((entry) => entry.kind !== "textValue" &&
          !isWord(entry, "tcPr") && !isWord(entry, "p"))) return Infinity;
        const [paragraph] = paragraphs;
        if (paragraph.node.children.some((entry) => entry.kind !== "textValue" && !isWord(entry, "pPr") &&
          !(isWord(entry, "r") && entry.children.every((leaf) => isWord(leaf, "rPr") || isWord(leaf, "t"))))) return Infinity;
        const paragraphId = `${row.id}.${index}.${paragraph.position}`;
        const fact = byId.get(paragraphId);
        const props = fields(fact?.properties.paragraph);
        const size = Math.max(12, fontSizes.get(paragraphId) ?? 0, number(fields(fact?.properties.paragraph_mark)?.fontSizePt));
        const spacing = fields(props?.spacing);
        const line = fields(props?.lineSpacing);
        const indent = fields(props?.indent);
        const available = number(props?.available) - Math.max(0, number(indent?.firstLine));
        const text = fact?.text ?? "";
        if (!props || props.framePresent || props.pageBreakBefore || props.listItem || available <= 0 ||
          /[\r\n\t]/u.test(text) || [...text].length * 1.5 * size > available) return Infinity;
        const pitch = Math.max(2 * size, number(section?.gridLinePitchTwips) / 20);
        const lineHeight = line?.rule === "auto" ? pitch * Math.max(1, number(line.value) / 240) : Math.max(pitch, number(line?.value));
        const cellMargins = fields(cell.margins);
        estimate = Math.max(estimate, lineHeight + number(spacing?.before) + number(spacing?.after) +
          number(cellMargins?.top) + number(cellMargins?.bottom) + 8);
      }
      return estimate;
    }

    const append = (index: number, flag: RowFlag, templateRow?: DocxTablePaginationChange["templateRow"]) => {
      changes.push({ rowId: rows[index].node.id, row: index + 1, tableNumber: tableIndex + 1, flag, property: flags[flag], templateRow });
    };
    const template = templatesByWidth.get(columnCount);
    const authoredHeaderCount = rows.findIndex(({ properties }) => properties?.isHeader !== true);
    let bodyStart = Math.max(1, authoredHeaderCount === -1 ? rows.length : authoredHeaderCount);
    if (template?.length && template.length < rows.length && !inherited.has("tblHeader") &&
      !rows.slice(template.length).some(({ properties }) => properties?.isHeader === true)) {
      const header = rows.slice(0, template.length);
      if (header.every((row) => row.properties?.isHeader === true || (row.editable && !child(row.direct, "tblHeader") &&
        row.object?.table_context?.conditions.includes("firstRow"))) &&
        header.reduce((total, row) => total + simpleRowHeight(row), 0) <= height / 4) {
        bodyStart = template.length;
        for (const [index, example] of template.entries()) {
          if (header[index].properties?.isHeader === false) append(index, "tblHeader", example);
        }
      }
    }
    if (inherited.has("cantSplit")) continue;
    for (let index = bodyStart; index < rows.length; index++) {
      const row = rows[index];
      const conditions = row.object?.table_context?.conditions ?? [];
      if (row.properties?.isHeader !== false || row.properties.cantSplit !== false || child(row.direct, "cantSplit") ||
        conditions.some((condition) => !/^band[12](Vert|Horz)$/.test(condition))) continue;
      if (simpleRowHeight(row) <= Math.min(72, height / 6)) append(index, "cantSplit");
    }
  }
  return changes;
}

const rowPropertiesOrder = ["cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter", "cantSplit", "trHeight",
  "tblHeader", "tblCellSpacing", "jc", "hidden", "ins", "del", "trPrChange"];

export function applyDocxTablePagination(part: OoxmlPart, changes: readonly DocxTablePaginationChange[]): OoxmlPart {
  const requested = new Map(changes.map((change) => [change.rowId, change]));
  const mint = createNodeIdAllocator(part);
  const element = (localName: string, children: readonly OoxmlNode[] = []): OoxmlGenericElementNode =>
    ({ id: mint(), kind: "generic", namespaceUri: WML_NAMESPACE_URI, localName, prefix: "w", children, attributes: [], namespaceBindings: [] });
  const rewrite = (node: OoxmlElement): OoxmlElement => {
    const change = requested.get(node.id);
    if (change) {
      const direct = child(node, "trPr");
      if (!isWord(node, "tr") || child(direct, change.flag)) throw new Error("The planned DOCX table row no longer matches.");
      requested.delete(node.id);
      const properties = [...(direct?.children ?? [])];
      const rank = rowPropertiesOrder.indexOf(change.flag);
      const next = properties.findIndex((entry) => entry.kind !== "textValue" && entry.namespaceUri === WML_NAMESPACE_URI &&
        rowPropertiesOrder.indexOf(entry.localName) > rank);
      properties.splice(next < 0 ? properties.length : next, 0, element(change.flag));
      const children = direct ? node.children.map((entry) => entry === direct ? { ...direct, children: properties } : entry)
        : [...node.children.slice(0, isWord(node.children[0], "tblPrEx") ? 1 : 0), element("trPr", properties),
          ...node.children.slice(isWord(node.children[0], "tblPrEx") ? 1 : 0)];
      return { ...node, children } as OoxmlElement;
    }
    const children = node.children.map((entry) => entry.kind === "textValue" ? entry : rewrite(entry));
    return children.some((entry, index) => entry !== node.children[index]) ? { ...node, children } as OoxmlElement : node;
  };
  const root = rewrite(part.root);
  if (requested.size) throw new Error("The planned DOCX table row is missing from the edit tree.");
  return { ...part, root };
}

export function verifyDocxTablePagination(facts: DocxFormatFacts, changes: readonly DocxTablePaginationChange[]) {
  const { root, name } = facts.documentPart;
  const tables = facts.snapshot.objects.filter(({ kind }) => kind === "table");
  const rows = new Map<string, (typeof facts.snapshot.objects)[number]>();
  const anchors = new Map<string, (typeof facts.snapshot.objects)[number]>();
  const key = (tableId: string, index: number) => `${tableId}\0${index}`;
  for (const object of facts.snapshot.objects) {
    const context = object.table_context;
    if (object.part !== name || !context) continue;
    const rowKey = key(context.table_object_id, context.row_index);
    if (object.kind === "tr") rows.set(rowKey, object);
    if (object.kind === "paragraph" && object.text?.trim() && !anchors.has(rowKey)) anchors.set(rowKey, object);
  }
  return changes.map((change) => {
    const table = tables[change.tableNumber - 1];
    const rowKey = table?.part === name ? key(table.object_id, change.row - 1) : "";
    const object = rows.get(rowKey);
    const row = object && elementAt(root, object.path);
    const direct = child(child(row, "trPr"), change.flag);
    const property = change.flag === "tblHeader" ? "isHeader" : "cantSplit";
    const confirmed = isWord(row, "tr") && !!direct && fields(object?.properties.row)?.[property] === true;
    const anchor = anchors.get(rowKey);
    return { change, id: object?.object_id ?? `table-${change.tableNumber}-row-${change.row}`, confirmed, text: anchor?.text?.trim().slice(0, 80),
      paraId: anchor && facts.addressableParagraphIds.get(anchor.object_id) };
  });
}

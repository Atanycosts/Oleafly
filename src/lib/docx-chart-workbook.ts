import {
  findNode, parentNodeOf, relationshipsOf, resolveContentTypeOf, resolveInternalTarget,
  type OoxmlElement, type OoxmlNode, type OoxmlPackage, type OoxmlPart,
} from "@docx-editor.dev/core/store";

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
const chart = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const chartEx = "http://schemas.microsoft.com/office/drawing/2014/chartex";
const mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isElement(node: OoxmlNode | null, uri: string, name: string): node is OoxmlElement {
  return node !== null && node.kind !== "textValue" && node.namespaceUri === uri && node.localName === name;
}

function children(node: OoxmlElement, uri: string, name: string) {
  const elements: readonly OoxmlNode[] = node.children;
  return elements.filter((child) => isElement(child, uri, name));
}

function relationshipId(node: OoxmlElement) {
  return node.attributes.find(({ namespaceUri, localName }) => namespaceUri === rel && localName === "id")?.value;
}

function chartReferences(node: OoxmlNode) {
  if (!isElement(node, word, "drawing")) return [];
  return [...children(node, wp, "inline"), ...children(node, wp, "anchor")]
    .flatMap((anchor) => children(anchor, drawing, "graphic"))
    .flatMap((graphic) => children(graphic, drawing, "graphicData"))
    .flatMap((data) => {
      const uri = data.attributes.find(({ namespaceUri, localName }) => !namespaceUri && localName === "uri")?.value;
      return uri === chart || uri === chartEx ? children(data, uri, "chart") : [];
    });
}

function branchChartReference(branch: OoxmlElement) {
  const content = branch.children.filter((node) => node.kind !== "textValue");
  if (content.length !== 1) return null;
  const references = chartReferences(content[0]);
  return references.length === 1 ? references[0] : null;
}

function referencesForDrawing(part: OoxmlPart, drawingId: string) {
  const node = findNode(part, drawingId);
  if (!node || node.kind === "textValue") return [];
  const own = chartReferences(node);
  if (own.length > 0) return own;
  const parent = parentNodeOf(part, node.id);
  const wrapper = isElement(node, mc, "AlternateContent") ? node :
    isElement(parent, mc, "Fallback") ? parentNodeOf(part, parent.id) : null;
  if (!isElement(wrapper, mc, "AlternateContent")) return [];
  const choices = children(wrapper, mc, "Choice").map(branchChartReference);
  const [reference] = choices;
  if (!reference) return [];
  const id = relationshipId(reference);
  const sameChart = (candidate: OoxmlElement | null) => candidate !== null &&
    candidate.namespaceUri === reference.namespaceUri && relationshipId(candidate) === id;
  if (!choices.every(sameChart)) return [];
  for (const fallback of children(wrapper, mc, "Fallback")) {
    const drawings = children(fallback, word, "drawing");
    const references = drawings.flatMap(chartReferences);
    if (references.length > 0 && !sameChart(branchChartReference(fallback))) return [];
  }
  return [reference];
}

function internalPart(pkg: OoxmlPackage, owner: string, id: string | undefined, type: string) {
  if (!id) return null;
  const relationship = relationshipsOf(pkg, owner).find((entry) => entry.id === id);
  if (relationship?.targetMode !== "Internal" || relationship.type !== type) return null;
  const target = resolveInternalTarget(owner, relationship.rawTarget);
  return target.ok ? target.partName : null;
}

function readWorkbook(pkg: OoxmlPackage, owner: OoxmlPart, reference: OoxmlElement): Uint8Array | null {
  const chartName = internalPart(pkg, owner.name, relationshipId(reference), `${rel}/chart`);
  if (!chartName) return null;
  const root = pkg.parts.get(chartName)?.root;
  if (!root || !isElement(root, chart, "chartSpace")) return null;
  const externalData = children(root, chart, "externalData");
  if (externalData.length !== 1) return null;
  const workbook = internalPart(pkg, chartName, relationshipId(externalData[0]), `${rel}/package`);
  if (!workbook || resolveContentTypeOf(pkg, workbook) !== XLSX_MEDIA_TYPE) return null;
  return pkg.partBytes.get(workbook) ?? null;
}

export function resolveDocxChartWorkbook(pkg: OoxmlPackage, owner: OoxmlPart, drawingId: string) {
  const references = referencesForDrawing(owner, drawingId);
  if (references.length === 0) return null;
  const [reference] = references;
  return { workbook: references.length === 1 && reference.namespaceUri === chart
    ? readWorkbook(pkg, owner, reference) : null };
}

import { readFileSync } from "node:fs";
import {
  readOoxmlPackage, writeOoxmlPackage,
  type OoxmlElement, type OoxmlNode, type OoxmlPackage, type OoxmlPart,
} from "@docx-editor.dev/core/store";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, it } from "vitest";
import { resolveDocxChartWorkbook } from "./docx-chart-workbook";

const fixture = new URL("../../services/research-workbench/tests/fixtures/docx/native/s1-native-complex-objects/s1-native-complex-objects.docx", import.meta.url);
const chartPart = "word/charts/chart1.xml";
const chartRelationships = "word/charts/_rels/chart1.xml.rels";
const workbookPart = "word/embeddings/Workbook1.xlsx";
const documentPart = "word/document.xml";
const mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const chart = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const contentTypes = "[Content_Types].xml";

function elements(node: OoxmlNode): OoxmlElement[] {
  return node.kind === "textValue" ? [] : [node, ...(node.children as readonly OoxmlNode[]).flatMap(elements)];
}

function readPackage(parts: Record<string, Uint8Array>) {
  const result = readOoxmlPackage(zipSync(parts));
  if (!result.ok) throw new Error(result.reason);
  const pkg = result.package;
  const owner = pkg.parts.get(pkg.mainDocumentPart);
  if (!owner) throw new Error("Missing main document");
  return { pkg, owner };
}

function drawingTarget(owner: OoxmlPart, compatibility: false | "wrapper" | "fallback" = false) {
  const drawings = elements(owner.root);
  const target = compatibility === "wrapper"
    ? drawings.find((node) => node.namespaceUri === mc && node.localName === "AlternateContent")
    : compatibility === "fallback"
      ? drawings.find((node) => node.namespaceUri === mc && node.localName === "Fallback")?.children[0]
    : drawings.find((node) => node.kind === "drawing" && elements(node).some(({ localName }) => localName === "chart"));
  if (!target) throw new Error("Missing fixture drawing");
  return target;
}

function resolveDrawing(pkg: OoxmlPackage, owner: OoxmlPart, compatibility?: Parameters<typeof drawingTarget>[1]) {
  return resolveDocxChartWorkbook(pkg, owner, drawingTarget(owner, compatibility).id);
}

function readDrawing(parts: Record<string, Uint8Array>, compatibility?: Parameters<typeof drawingTarget>[1]) {
  const { pkg, owner } = readPackage(parts);
  return resolveDrawing(pkg, owner, compatibility);
}

function parts() { return unzipSync(readFileSync(fixture)); }

function edit(parts: Record<string, Uint8Array>, name: string, update: (xml: string) => string) {
  const original = strFromU8(parts[name]);
  const next = update(original);
  expect(next).not.toBe(original);
  parts[name] = strToU8(next);
}

it("reads the exact workbook bytes via the WPS chart's package relationship", () => {
  const archive = parts();
  expect(readDrawing(archive)).toEqual({ workbook: archive[workbookPart] });
});

it("keeps the exact workbook bytes through a package save and reopen", () => {
  const archive = parts();
  const { pkg, owner } = readPackage(archive);
  const before = resolveDrawing(pkg, owner);
  const reopened = readPackage(unzipSync(writeOoxmlPackage(pkg)));

  expect(resolveDrawing(reopened.pkg, reopened.owner)).toEqual(before);
  expect(before).toEqual({ workbook: archive[workbookPart] });
});

it("follows relationship aliases and content types instead of part names", () => {
  const archive = parts();
  const aliasedChart = "word/charts/chart-source.xml";
  const aliasedChartRelationships = "word/charts/_rels/chart-source.xml.rels";
  const aliasedWorkbook = "word/embeddings/source.data";
  archive[aliasedChart] = archive[chartPart];
  archive[aliasedChartRelationships] = archive[chartRelationships];
  archive[aliasedWorkbook] = archive[workbookPart];
  delete archive[chartPart];
  delete archive[chartRelationships];
  delete archive[workbookPart];

  edit(archive, "word/_rels/document.xml.rels", (xml) => xml.replace(
    'Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"',
    'Id="sourceChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart-source.xml"',
  ));
  edit(archive, documentPart, (xml) => xml.replace(/<c:chart\b[^>]*r:id="rId6"\/>/u,
    `<xr:chart xmlns:xr="${chart}" xmlns:rr="${rel}" rr:id="sourceChart"/>`));
  edit(archive, aliasedChart, (xml) => xml.replace(/<c:externalData\b[^>]*>.*?<\/c:externalData>/su,
    `<xr:externalData xmlns:xr="${chart}" xmlns:rr="${rel}" rr:id="sourceWorkbook"><xr:autoUpdate val="0"/></xr:externalData>`));
  edit(archive, aliasedChartRelationships, (xml) => xml
    .replace('Id="rId1"', 'Id="sourceWorkbook"')
    .replace('Target="../embeddings/Workbook1.xlsx"', 'Target="../embeddings/source.data"'));
  edit(archive, contentTypes, (xml) => xml
    .replace('/word/charts/chart1.xml', '/word/charts/chart-source.xml')
    .replace("</Types>", `<Override PartName="/${aliasedWorkbook}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>`));

  expect(readDrawing(archive)).toEqual({ workbook: archive[aliasedWorkbook] });
});

it.each([
  ["external", (archive: Record<string, Uint8Array>) => edit(archive, chartRelationships, (xml) =>
    xml.replace('Target="../embeddings/Workbook1.xlsx"', 'Target="https://example.invalid/chart.xlsx" TargetMode="External"'))],
  ["wrong relationship type", (archive: Record<string, Uint8Array>) => edit(archive, chartRelationships, (xml) =>
    xml.replace('/relationships/package"', '/relationships/oleObject"'))],
  ["wrong content type", (archive: Record<string, Uint8Array>) => edit(archive, contentTypes, (xml) =>
    xml.replace('ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"',
      'ContentType="application/vnd.ms-excel.sheet.macroEnabled.12"'))],
  ["missing part", (archive: Record<string, Uint8Array>) => { delete archive[workbookPart]; }],
  ["workbook not linked from the chart", (archive: Record<string, Uint8Array>) => edit(archive, chartPart, (xml) =>
    xml.replace(/<c:externalData\b.*?<\/c:externalData>/su, ""))],
  ["more than one external-data element", (archive: Record<string, Uint8Array>) => edit(archive, chartPart, (xml) =>
    xml.replace("</c:externalData>", '</c:externalData><c:externalData r:id="rId1"/>'))],
] as const)("does not guess a workbook when the relationship is %s", (_reason, modify) => {
  const archive = parts();
  modify(archive);
  expect(readDrawing(archive)).toEqual({ workbook: null });
});

it("uses a selected fallback chart's own relationship instead of the choice's chart", () => {
  const archive = parts();
  archive["word/charts/chart2.xml"] = strToU8(strFromU8(archive[chartPart])
    .replace(/<c:externalData\b.*?<\/c:externalData>/su, ""));
  edit(archive, "word/_rels/document.xml.rels", (xml) => xml.replace("</Relationships>",
    '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart2.xml"/></Relationships>'));
  edit(archive, contentTypes, (xml) => xml.replace("</Types>",
    '<Override PartName="/word/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  edit(archive, documentPart, (xml) => xml.replace(/<w:drawing>.*?<\/w:drawing>/su, (drawing) =>
    `<mc:AlternateContent xmlns:mc="${mc}"><mc:Choice Requires="wp">${drawing}</mc:Choice>` +
    `<mc:Fallback>${drawing.replace('r:id="rId6"', 'r:id="rId11"')}</mc:Fallback></mc:AlternateContent>`));

  expect(readDrawing(archive, "fallback")).toEqual({ workbook: null });
  expect(readDrawing(archive, "wrapper")).toBeNull();
});

it("resolves a compatibility drawing using its own chart choice, even when the fallback is an image", () => {
  const archive = parts();
  edit(archive, documentPart, (xml) => xml.replace(/<w:drawing>.*?<\/w:drawing>/su, (drawing) => {
    const picture = drawing.replace(/<a:graphic\b.*?<\/a:graphic>/su,
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic>');
    return `<mc:AlternateContent xmlns:mc="${mc}"><mc:Choice Requires="wp">${drawing}</mc:Choice><mc:Fallback>${picture}</mc:Fallback></mc:AlternateContent>`;
  }));
  expect(readDrawing(archive, "fallback")).toEqual({ workbook: archive[workbookPart] });
  expect(readDrawing(archive, "wrapper")).toEqual({ workbook: archive[workbookPart] });
  edit(archive, chartRelationships, (xml) => xml.replace('Target="../embeddings/Workbook1.xlsx"',
    'Target="https://example.invalid/chart.xlsx" TargetMode="External"'));
  expect(readDrawing(archive, "fallback")).toEqual({ workbook: null });
});

it("does not infer a chart workbook when a compatibility choice can show a different object", () => {
  const archive = parts();
  edit(archive, documentPart, (xml) => xml.replace(/<w:drawing>.*?<\/w:drawing>/su, (drawing) => {
    const picture = drawing.replace(/<a:graphic\b.*?<\/a:graphic>/su,
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic>');
    return `<mc:AlternateContent xmlns:mc="${mc}"><mc:Choice Requires="wp">${picture}</mc:Choice>` +
      `<mc:Choice Requires="wp">${drawing}</mc:Choice><mc:Fallback>${picture}</mc:Fallback></mc:AlternateContent>`;
  }));
  expect(readDrawing(archive, "wrapper")).toBeNull();
  expect(readDrawing(archive, "fallback")).toBeNull();
});

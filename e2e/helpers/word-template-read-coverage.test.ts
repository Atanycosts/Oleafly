import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  collectTemplateReadCoverage,
  type TemplateReadPage,
} from "./word-template-read-coverage";

const source = "b".repeat(64);
const world = "world";
const metadata = {
  capabilities: { raw_part_bytes: true },
  engine: { name: "core", version: "1" },
  method_version: "1",
  parts: [{ name: "/word/document.xml", sha256: source }],
  schema_version: 1,
  source_sha256: source,
  unknown_metadata: { preserved: false },
  unsupported: [{ code: "kept", object_ids: ["object-0"] }],
};
// Deliberately hand-authored effective values: this test does not call a production projector.
const properties = {
  paragraph: { alignment: "center", unknown_effective: false },
  paragraph_mark: { bold: false, complex_script_size: 10 },
  script_usage: { complex: true },
  cell: { vAlign: "center", shading: null },
  section: { marginTop: 100 },
  table_style: { unknown_style_value: null },
  unknown_effective: { keep: "unknown" },
};
const rawProperties = {
  ...properties,
  paragraph: { ...properties.paragraph, props: { omitted: 1 }, inheritedRunProperties: [],
    markRunProperties: [], tabStopsCacheToken: "omitted" },
  run_properties: [{ omitted: true }],
};
const roleBasis = [{ source: "style_id", value: "Text", certainty: "explicit" }];
const region = { section_object_id: "section", role: "body", role_basis: [] };
const evidence = { unsupported_fact: false, unknown_evidence: null };
const rows = [0, 1].map(index => ({ object_id: `object-${index}`, kind: "paragraph",
  part: "/word/document.xml", path: [index], text: index ? "" : "Template 🐼",
  role: "body", style_id: "Text", table_context: { row_index: 0, column_index: index },
  properties: rawProperties, role_basis: roleBasis, region, evidence,
  declared: { omitted: "raw" }, unknown_top_level: { must_keep: false },
}));
const styles = [{ object_id: "style", part: "/word/styles.xml", path: [0], style_id: "Text",
  name: "Text", effective_status: "declaration_only", properties: { unknown_style: false },
  role_basis: [], declared: { omitted: "declaration is not read" } }];
const inventory = { ...metadata, objects: rows, style_definitions: styles };
const metadataSha = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
const omitted = ["/declared", "/properties/paragraph/props", "/properties/paragraph/inheritedRunProperties",
  "/properties/paragraph/markRunProperties", "/properties/paragraph/tabStopsCacheToken", "/properties/run_properties"];

function pages(): TemplateReadPage[] {
  return ["objects", "objects", "style_definitions"].map((collection, pageIndex) => {
    const offset = pageIndex === 1 ? 1 : 0;
    const request = { operation: "format", format_operation: "snapshot", world_version_id: world,
      collection, detail: "effective", offset, limit: 50 };
    const stylePage = collection === "style_definitions";
    const raw = stylePage ? styles[0] : rows[offset];
    const { properties: _properties, role_basis: _roleBasis, declared: _declared, ...identity } = raw;
    const row: Record<string, unknown> = stylePage ? { ...identity, properties_ref: 0, role_basis_ref: 0 } : {
      ...identity, region: undefined, evidence: undefined, region_ref: 0, evidence_ref: 0,
      properties_ref: 0, role_basis_ref: 0,
    };
    if (!stylePage) { delete row.region; delete row.evidence; }
    const total = stylePage ? 1 : 2;
    const readArgs = { ...request, expected_source_sha256: source };
    return { request, callIds: [`page-${pageIndex}`], data: {
      operation: "snapshot", source_sha256: source, projection: "effective", projection_version: 1,
      collection, offset, delivered: 1, total, has_more: offset + 1 < total,
      next_offset: offset + 1 < total ? offset + 1 : null, omitted_fields: omitted,
      metadata_sha256: metadataSha,
      ...(offset ? { metadata_ref: { source_sha256: source, projection: "effective", projection_version: 1,
        metadata_sha256: metadataSha, read: { tool: "journal_read", arguments: { ...readArgs, offset: 0 } } } } : {}),
      full_read: { tool: "journal_read", arguments: { ...readArgs, detail: "full", limit: 1 }, end_offset: offset + 1 },
      snapshot: { ...(offset === 0 ? metadata : {}), [collection]: [row], shared: {
        properties: [stylePage ? { unknown_style: false } : properties],
        role_basis: [stylePage ? [] : roleBasis], region: stylePage ? [] : [region], evidence: stylePage ? [] : [evidence],
      } },
    } };
  });
}

describe("effective template reading coverage", () => {
  it("decodes per-page dictionaries against the complete object/style inventory and metadata", () => {
    const receipt = collectTemplateReadCoverage(pages(), inventory, world);
    expect(receipt.complete, JSON.stringify(receipt)).toBe(true);
    expect(receipt.rejectedPages).toEqual([]);
    expect(receipt.collections.map(collection => [collection.expected, collection.observed])).toEqual([[2, 2], [1, 1]]);
  });

  it.each(["missing ref", "missing dictionary", "wrong source", "wrong metadata", "metadata absent", "first page missing",
    "metadata ref missing", "metadata ref source", "metadata ref version", "metadata ref digest",
    "metadata ref page digest", "full read page digest", "lying total", "missing object",
    "wrong identity", "wrong text", "lost false", "lost table style", "lost unknown", "expanded omission", "missing styles"])(
    "rejects incomplete or changed effective evidence: %s", scenario => {
      const input = structuredClone(pages());
      const first = input[0].data;
      const snapshot = first.snapshot as Record<string, unknown>;
      const shared = snapshot.shared as Record<string, Record<string, unknown>[]>;
      const firstRow = (snapshot.objects as Record<string, unknown>[])[0];
      const reference = input[1].data.metadata_ref as Record<string, unknown>;
      switch (scenario) {
        case "missing ref": firstRow.properties_ref = 9; break;
        case "missing dictionary": delete shared.evidence; break;
        case "wrong source": first.source_sha256 = "c".repeat(64); break;
        case "wrong metadata": first.metadata_sha256 = "c".repeat(64); break;
        case "metadata absent": delete snapshot.unsupported; break;
        case "first page missing": input.shift(); break;
        case "metadata ref missing": delete input[1].data.metadata_ref; break;
        case "metadata ref source": reference.source_sha256 = "c".repeat(64); break;
        case "metadata ref version": reference.projection_version = 2; break;
        case "metadata ref digest": reference.metadata_sha256 = "c".repeat(64); break;
        case "metadata ref page digest": ((reference.read as Record<string, unknown>).arguments as Record<string, unknown>)
          .expected_json_sha256 = "effective-page-digest"; break;
        case "full read page digest": ((first.full_read as Record<string, unknown>).arguments as Record<string, unknown>)
          .expected_json_sha256 = "effective-page-digest"; break;
        case "lying total": first.total = 1; break;
        case "missing object": input.splice(1, 1); break;
        case "wrong identity": firstRow.path = [99]; break;
        case "wrong text": firstRow.text = "Changed"; break;
        case "lost false": delete (shared.properties[0].paragraph_mark as Record<string, unknown>).bold; break;
        case "lost table style": delete shared.properties[0].table_style; break;
        case "lost unknown": delete shared.properties[0].unknown_effective; break;
        case "expanded omission": first.omitted_fields = [...omitted, "/properties/unknown_effective"]; break;
        case "missing styles": input.pop(); break;
      }
      const receipt = collectTemplateReadCoverage(input, inventory, world);
      expect(receipt.complete, scenario).toBe(false);
      expect(receipt.gaps.length).toBeGreaterThan(0);
      if (!["missing styles", "missing object"].includes(scenario)) expect(receipt.rejectedPages.length).toBeGreaterThan(0);
    },
  );

  it("requires the metadata page even for an empty style collection", () => {
    const emptyInventory = { ...inventory, style_definitions: [] };
    const input = pages();
    const stylesPage = input[2].data;
    stylesPage.delivered = 0;
    stylesPage.total = 0;
    (stylesPage.full_read as Record<string, unknown>).end_offset = 0;
    (stylesPage.snapshot as Record<string, unknown>).style_definitions = [];
    (stylesPage.snapshot as Record<string, unknown>).shared = {
      properties: [], region: [], evidence: [], role_basis: [],
    };
    expect(collectTemplateReadCoverage(input, emptyInventory, world).complete).toBe(true);
    expect(collectTemplateReadCoverage(input.slice(0, 2), emptyInventory, world).complete).toBe(false);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const contractFile = new URL("../../src/research_file_workbench/workbench/web/transport/contracts.js", import.meta.url);
const contractSource = readFileSync(contractFile, "utf8");
const { validateResponse } = await import(`data:text/javascript;base64,${Buffer.from(contractSource).toString("base64")}`);
const responses = JSON.parse(readFileSync(process.env.RFW_BROWSER_RESPONSES, "utf8"));

for (const [name, { path, response }] of Object.entries(responses)) {
  test(`accepts the live ${name} response unchanged`, () => {
    const before = structuredClone(response);
    assert.equal(validateResponse(path, response), response);
    assert.deepEqual(response, before);
  });
}

function rejects(name, fixtureName, damage) {
  test(name, () => {
    const { path, response } = structuredClone(responses[fixtureName]);
    damage(response);
    assert.throws(() => validateResponse(path, response), Error);
  });
}

rejects("rejects a table without rows", "table_read", (response) => { delete response.items[0].content.rows; });
rejects("rejects a table cell without its column span", "table_read", (response) => { delete response.items[0].content.rows[0][0].grid_span; });
rejects("rejects missing read selection", "table_read", (response) => { delete response.query_scope; });
rejects("rejects a boolean physical page number", "page_read", (response) => { response.query_scope.page_number = true; });
rejects("rejects missing continuation cursor", "paged_read", (response) => { response.pagination.next_cursor = null; });
rejects("rejects pagination beyond the selected range", "paged_read", (response) => { response.pagination.page_number = response.pagination.total_ranges + 1; });
rejects("rejects an inconsistent receipt page", "paged_read", (response) => { response.read_receipt.pagination.page_number += 1; });
rejects("rejects a false complete-read claim", "paged_read", (response) => { response.read_receipt.truncation = false; });
rejects("rejects a continuation claim that contradicts its own pagination", "paged_read", (response) => { response.selection_delivery = response.pagination.has_more ? "continuation_exhausted" : "continuation_available"; });
rejects("rejects an undeclared continuation value", "paged_read", (response) => { response.selection_delivery = "delivered"; });
rejects("rejects a receipt for different content", "table_read", (response) => { response.read_receipt.ranges[0].locator = "different-node"; });
rejects("rejects a mismatched saved record identity", "table_read", (response) => { response.delivery.read_record_id = "different-read"; });
rejects("rejects content outside its requested type", "table_read", (response) => { response.query_scope.object_type = "image"; });
rejects("rejects a missing page bundle", "page_read", (response) => { delete response.render_bundle; });
rejects("rejects a physical page outside its bundle", "page_read", (response) => { response.query_scope.page_number = response.render_bundle.page_count + 1; });
rejects("rejects a missing manuscript catalog context", "manuscript", (response) => { delete response.catalog.project; });
rejects("rejects a manuscript catalog from another baseline", "manuscript", (response) => { response.catalog.project.baseline_id = "different-baseline"; });
rejects("rejects another project's baseline", "manuscript", (response) => { response.baseline.project_id = "different-project"; });
rejects("rejects duplicate baseline identities", "manuscript", (response) => { response.baselines.push(structuredClone(response.baselines[0])); });
rejects("rejects a read outside the manuscript baseline", "manuscript", (response) => { response.reads[0].baseline_id = "different-baseline"; });
rejects("rejects a missing page manifest", "rendered_manuscript", (response) => { delete response.render_bundles[0].manifest; });
rejects("rejects a negative page count", "render_bundle", (response) => { response.manifest.page_count = -1; });
rejects("rejects a page bundle from another baseline", "render_bundle", (response) => { response.manifest.baseline_id = "different-baseline"; });
rejects("rejects a reviewed bundle without mapping", "render_bundle", (response) => { response.manifest.mapping = null; });
rejects("rejects an unsuccessful baseline update", "baseline_update", (response) => { response.status = "BASELINE_CONFLICT"; });
rejects("rejects an update without a saved baseline", "baseline_update", (response) => { response.result_baseline_id = null; });
rejects("rejects a malformed historical read selection", "history", (response) => { response.reads[0].query_scope = {}; });
rejects("rejects another project's historical check", "history", (response) => { response.checks[0].project_id = "different-project"; });
rejects("rejects inconsistent historical coverage", "history", (response) => { response.checks[0].rule_results[0].coverage.total_sections += 1; });
rejects("rejects duplicate historical reads", "history", (response) => { response.reads.push(structuredClone(response.reads[0])); });
rejects("rejects a source without its identity", "review", (response) => { delete response.sources[0].source_id; });
rejects("rejects cyclic source fragments", "review", (response) => { response.fragments[0].parent_fragment_id = response.fragments[0].fragment_id; });
rejects("rejects invalid fragment offsets", "review", (response) => { response.fragments.find((item) => item.kind === "sentence").char_end += 1; });
rejects("rejects source fragments attributed to another source", "review", (response) => { response.fragments[0].source_id = "different-source"; });
rejects("rejects inaccurate source fragment counts", "review", (response) => { response.sources[0].fragment_count += 1; });
rejects("rejects a false exact-source link", "review", (response) => { response.rule_links[0].locator = "different-location"; });
rejects("rejects unavailable links with matched fragments", "review", (response) => { response.rule_links[0].link_status = "unavailable"; });
rejects("rejects relations to nonexistent objects", "review", (response) => { response.relations[0].to_id = "missing-rule"; });

test("rejects an unregistered response route", () => {
  assert.throws(() => validateResponse("/api/unknown", {}), /无法识别/);
});

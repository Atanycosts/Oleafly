/** Replay the product's JSON-value equality condition; this is a byte probe, not a model evaluation. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';

function modelView(event) {
  const view = structuredClone(event);
  if (event.evidence !== undefined) {
    let parsed;
    try { parsed = JSON.parse(event.detail); } catch { return view; }
    if (isDeepStrictEqual(parsed, event.evidence)) {
      delete view.detail;
      view.detailRepeatedInEvidence = true;
    }
  }
  return view;
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const evidence = {currentComment: {text: 'Keep the unfavorable result. 保留反例'}, referencedSource: {kind: 'historical evidence'}};
const fixture = {id: 'fixture', detail: JSON.stringify(evidence, null, 2), evidence};
const projected = modelView(fixture);
assert.deepEqual(projected.evidence, evidence);
assert(!Object.hasOwn(projected, 'detail'));
assert.equal(fixture.detail, JSON.stringify(evidence, null, 2));
for (const detail of ['ordinary text', '{"different":true}']) {
  const event = {...fixture, detail};
  assert.deepEqual(modelView(event), event);
}

const paths = process.argv.slice(2);
const rows = [];
for (const file of paths) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = Array.isArray(value) ? value : value.group?.events ?? value.events;
  if (!Array.isArray(events)) throw Error(`Expected events or group.events in ${file}`);
  for (const event of events) {
    const view = modelView(event);
    if (view.detailRepeatedInEvidence) rows.push({file, id: event.id, originalBytes: bytes(event), projectedBytes: bytes(view), savedBytes: bytes(event) - bytes(view)});
  }
}
if (!paths.length) rows.push({file: 'built-in fixture', id: fixture.id, originalBytes: bytes(fixture), projectedBytes: bytes(projected), savedBytes: bytes(fixture) - bytes(projected)});
console.log(JSON.stringify({scope: 'compact UTF-8 JSON event bytes; no token, quality or cost estimate', rows}, null, 2));

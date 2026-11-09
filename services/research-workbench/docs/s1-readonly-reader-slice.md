# S1 read-only reader slice

The first S1 implementation now provides a bounded, read-only DOCX package reader in
`src/research_file_workbench/docx/reader.py`.

This is an unreleased implementation spike. The S1 capability contract remains the target
boundary; passing focused tests does not promote every capability to implemented or verified.

It currently covers:

- ZIP part inventory with content types, byte sizes and SHA-256 hashes;
- package and document relationships, including external and unresolved targets;
- paragraph text from body, header, footer, footnote and endnote parts;
- textbox region identification;
- table grids, repeated header rows, grid spans and vertical merge markers;
- inline and anchored image relationships, EMU dimensions and wrap type;
- inline and display OMML with its raw XML subtree;
- nested field boundary events and raw field instructions;
- simple fields and cross-paragraph field results, with independent stacks for textboxes and notes;
- declared section properties and explicit page/column breaks;
- chart, OLE and grouped-drawing registration with related parts and previews, without executing
  or semantically interpreting embedded objects;
- explicit hidden-text, field-code, OMML and revision markers;
- invalid-package and malformed-part visibility through typed errors and issue records.

It does not claim automatic page-coordinate inference, complete computed style semantics, semantic
complex-object parsing or manuscript modification. Page mappings are accepted only from independent
reviewed evidence; unverified page indexes remain explicitly unverified.

For `mc:AlternateContent`, the text projection uses the fallback branch when one is present because
the reader cannot claim support for an unknown `Requires` namespace. Complex-object registration
still inspects the package branches so that an unsupported Choice object is not silently omitted.

Drawing registration is not exhaustive for every schema shape. For a `<w:drawing>`, image
registration requires a direct `wp:inline` or `wp:anchor` child and a picture resource
(`a:blip`); a drawing that has a blip but no such direct child is skipped, as is one that has
neither a blip nor a recognized embedded-object element (`chart`, `OLEObject`, `wgp`,
`unknownObject`). Image registration reads only the selected `mc:AlternateContent` branch, and
both registration paths skip parts with no known region. No reviewed fixture under
`tests/fixtures/docx/` exercises an unregistered drawing, so the gap is recorded rather than
measured; `tests/docx/test_drawing_coverage.py` fails if a fixture drawing becomes unaccounted
for.

The `run_s1_readonly` orchestration in `pipeline.py` creates an application-owned source snapshot,
writes the structure report, optionally joins independent page evidence, validates a process-verified
render record, and compares the author-workspace fingerprint before and after the run. A run without
page evidence is intentionally reported as `partial`.

Each run also writes a minimum-schema read receipt with a stable `read_record_id`, task,
actor/client, returned artifact version, exact package ranges, parse status and limitations. The
receipt does not claim that a directory listing or a returned range proves semantic understanding.

The same operation is available as `rfw-s1-read`:

```powershell
rfw-s1-read <source.docx> `
  --application-root <app-root> `
  --output-directory <app-root>\var\s1-run `
  --author-workspace-root <author-root> `
  --render-record <process-verified-render-record.json> `
  --page-image-directory <application-owned-pages>
```

The command separates an executed run from a failed one: `0` for a run that completed without
unresolved items, `1` for a run that executed and reported limitations, `2` for a refusal or a run
whose integrity check failed (a changed author workspace or a drifted source hash). While the
reader declares unconditional limits, every current run carries at least one limitation, so `0` is
reachable only for a run with no unresolved items at all. It never writes beside the author source.
The run report separates stage status: structural reading can be
`completed_with_limitations` while page mapping remains `pending_independent_review` until an
independent annotation and page-evidence pair is supplied. A page image index is reported as
`indexed_unverified`; it is not an object-to-page mapping. A top-level `partial` status does not
mean that structural reading failed.

Existing run snapshots can be queried with `rfw-s1-query` for object discovery and bounded reads.
See [on-demand reading](s1-on-demand-reading.md) for region/object/page filters, pagination,
response receipts and evidence requirements. Reader method `s1-readonly-reader-1.4.0` assigns
distinct occurrence numbers to repeated fields within a paragraph and records each paragraph's
byte range inside its part; older mapping reports must
be rebuilt against the current reader before they can support page queries.

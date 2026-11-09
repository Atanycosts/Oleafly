# S1 persistent page evidence

Status: implemented and locally verified on 2026-09-25. This page describes the persistent
page-evidence slice; full S1 independent acceptance remains incomplete.

## Scope

This change retains previously produced PDF pages and independent mapping inputs inside an
existing single-DOCX project. It extends persistent structural reads with explicit page-evidence
selection. It does not render a manuscript, launch WPS, change the current baseline, or create
independent human annotations.

The existing SQLite schema is reused: content-addressed artifact BLOBs retain the PDF, page PNGs
and supplied evidence bytes; a versioned source-observation record describes the render bundle;
the existing baseline-evidence relation binds it to one baseline. Existing project databases must
remain readable without migration, reset or reconstruction.

## Registration and retained identity

- The operator selects a baseline, a declared read-only input root and the files to register.
  Every input must remain inside that root after path validation. Inputs are captured as bytes,
  hashed and validated before publication; originals are not edited or moved.
- A bundle identifies its exact source version, baseline, PDF hash, render profile, physical page
  count, page-image hashes, raw input-record hashes, reader version and mapping method version.
  A document annotation and page-evidence pair remains independent expected evidence.
- The raw annotation records and the derived join report are retained separately. The join may
  preserve reviewed, ambiguous and unmapped entries; it must not create a human review status or
  a precise coordinate that the input did not establish.
- Artifact BLOBs, the complete bundle manifest and its baseline relation are published in one
  transaction. A failed write must leave no partially registered bundle. Re-registering identical
  bundle content returns the existing immutable record.
- Registering a bundle does not switch the reading baseline. A project may retain multiple bundles;
  there is no implicit latest bundle for page queries.

## Trust boundary

A supplied render record may state that its original export used a process-verified WPS instance.
Registration checks the record and its file bindings. It does not observe that historical process
again and must not claim a new renderer attestation.

Hashes bind the captured bytes; they do not prove scientific correctness, reviewer identity or
visual completeness. A PNG's presence does not alone establish that it depicts the declared PDF
page. The validator must either establish the declared relationship with supported evidence or
retain its unverified limitation. A page image index never supplies object-to-page mappings.

PDF metadata checks may use an application-owned temporary copy inside the project. Temporary
files must be removed on success and failure, and must not appear beside the input evidence or
author manuscript. Validation failures remain explicit; no fallback may silently turn a failed
page operation into an unfiltered structural read.

## Page queries and byte access

PNG validation supports static, non-interlaced, 8-bit grayscale, RGB, grayscale-alpha and RGBA.
It verifies chunk structure/checksums, a complete compressed stream, scanline lengths and filter
bytes. Unsupported bit depths, indexed/interlaced images and animation are refused explicitly.
The limits are 64 MiB encoded and 256 MiB decoded per image, processed in bounded chunks. This
establishes supported encoded-image integrity; it does not establish that the pixels came from
the selected PDF or that the page was visually reviewed.

Current bundle validation is `s1-render-bundle-1.1.0`; old bundles are retained and method changes
make them stale for new page queries. Re-registration creates a current binding without rewriting
saved records. An identical-byte new source baseline also invalidates an old bundle's applicability
to that new baseline; listing, invalidated-reference records and page queries use the same rule.

- A physical-page query requires an explicit `render_bundle_id` bound to the requested baseline.
  Source, reader, mapping method and actual PDF bindings must match before the mapping is used.
  A same-byte source under another baseline does not authorize reuse of that baseline's bundle.
- Page filtering returns only uniquely mapped source observations. Ambiguous, unmapped and
  unreviewed coverage remains visible. The receipt covers returned observations; it does not
  claim that the model saw a page image or understood its visual content.
- Query cursors bind the selected bundle and mapping as well as the baseline, source, method and
  selection. Changing any relevant version invalidates the cursor instead of reusing its offset.
- Structural queries remain independent of page evidence. Adding or replacing a render bundle
  cannot invalidate an otherwise applicable structural query merely because render data changed.
- Byte access returns explicitly selected retained PDF or PNG artifacts for a future viewer.
  It does not automatically export new files, open a host application, or record a visual read.
- Saved responses and old bundle records remain immutable. A later baseline, renderer or method
  change can make them inapplicable to a new request without rewriting historical evidence.

## Verified behavior

1. Open a project created before this change, register a bundle, reopen it and recover the same
   retained PDF/PNG bytes and manifest without a schema rebuild.
2. Remove or change the original input files after successful registration; retained evidence
   remains recoverable and continues to identify the captured versions.
3. Reject wrong-source, wrong-baseline, wrong-PDF, out-of-range page and stale-method inputs before
   publishing a bundle or a successful page-query receipt.
4. Inject a failure after artifact insertion but before manifest publication; the transaction
   leaves neither a registered bundle nor newly orphaned artifacts from that operation.
5. Repeat identical registration, including concurrent attempts, without changing the original
   record, duplicating baseline links or switching the current baseline.
6. Query with no explicit bundle, another baseline's bundle, an invalid cursor or incomplete page
   evidence; the result must refuse or preserve partial coverage rather than fabricate a page read.
7. Confirm input-root and author-workspace fingerprints remain unchanged, and temporary PDF checks
   leave no files in the read-only input directories on success or failure.
8. Run the required Ruff formatting, Ruff static checks, mypy, pytest and Phase 0 validation gates;
   record the actual integration results before changing this document's status.

## Validation status

The full suite passed **337 tests** in 91.97 seconds, including 80 new page-evidence tests.
Ruff formatting passed for 89 files, Ruff lint passed, mypy passed for 42 source files, and
Phase 0 validation returned `CONTRACT_VALID` and `PHASE0_COMPLETE`.

An actual schema-1 test project from the preceding implementation was reopened and extended
without modifying its schema or current baseline. Copies of the existing IJAM PDF, render record
and ten page images were registered, then recovered after the input copies were removed. Duplicate
registration returned the same record; a separate process listed the retained bundle. Original
evidence hashes remained unchanged and SQLite integrity checked `ok`.

IJAM remains `pending_independent_review`. Its physical-page query was refused without a saved
read receipt. Reviewed page-query behavior is covered by the fixed independently annotated fixtures;
their synthetic process metadata tests validation and does not claim another WPS execution.

See `reports/s1/render-persistence-smoke.json` and `reports/s1/render-verification.json`.
This change does not establish full S1 acceptance, scientific correctness or new human annotations.

## Commands

Use the project initialized with `rfw-project` and its exact baseline ID. The declared evidence
input root must contain the input records and every PDF/PNG path referenced by them, and must not
overlap writable project storage. All paths below are operator-selected examples.

```powershell
$env:PYTHONPATH = "src"
$projectRoot = "D:/ResearchWorkbench/projects/my-manuscript"
$evidenceRoot = "D:/ResearchEvidence/manuscript-render"
$baselineId = "baseline-<actual-id>"

python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot register-render `
  --baseline-id $baselineId --input-root $evidenceRoot `
  --render-record "$evidenceRoot/render-record.json" --page-index "$evidenceRoot/page-index.json" `
  --document-annotation "$evidenceRoot/document-annotation.json" `
  --page-evidence "$evidenceRoot/page-evidence.json" `
  --actor-id local-operator --reason "Retain this exact independently reviewed evidence version"

python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot renders `
  --baseline-id $baselineId

python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot read `
  --baseline-id $baselineId --page-number 1 --render-bundle-id "render-bundle-<actual-id>"
```

Omit both annotation options to register unreviewed material. Supplying an incomplete or unreviewed
pair is refused; registration never fills in review metadata. A registration result identifies saved
evidence, not complete reading or semantic verification. Page content responses remain `partial`
and exit 1, while refused page requests exit 2.

The baseline identifies source bytes; the bundle records the reader/mapping method used for this
registration. A historical baseline may receive evidence rebuilt with the current method without
changing that baseline or overwriting its old evidence. Method changes make affected bundles stale.

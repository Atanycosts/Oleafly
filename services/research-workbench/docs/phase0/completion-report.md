# Phase 0 completion report

Phase 0 verification date: 2026-09-24

Status reviewed: 2026-09-25

## Outcome

The Phase 0 contract and frozen-evidence gates passed after the 2026-09-24 audit repairs.
The historical `phase0-v1` tag remains the recorded release baseline; the later S1 work remains
unreleased. A subsequent live WPS export is recorded in `reports/phase0/live-wps-smoke.json` with
`renderer_identity_status: process_verified`, bound to WPS Writer `12.1.0.28505` and the exact
source and PDF hashes. This status review did not rerun WPS. The S1 reader and real IJAM run remain
partial; the live export alone does not complete S1 acceptance or reseal the release baseline.

## Completed deliverables

- A responsibility-separated Python project with `contracts`, `annotations`, `docs`, `schemas`,
  `src`, `tests`, `tools`, `reports`, and disposable `var` storage.
- Source inventory for all nine existing project inputs, with file hashes and limitations.
- A pinned WPS Writer `12.1.0.28505` profile and a dedicated ten-page English manuscript baseline.
- Observed field, revision, hidden-text, font, and PDF-export behavior.
- Seven deterministic DOCX fixtures plus one fixed WPS-native complex-object fixture.
- Independently reviewed structure and page annotations bound to source and PDF hashes.
- Native Chart, embedded workbook, OLE package and preview, grouped DrawingML, unknown extension,
  broken relationship, missing font, pagination ambiguity, and layout fixtures.
- Renderer-unavailable, controlled render-failure, and boundary-bypass scenarios.
- Minimum S1 entity contracts, capability boundary, cache dependency contract, and acceptance
  fixtures.
- A read-only vertical-slice implementation plan.
- Author-workspace fingerprint evidence showing the source workspace remained unchanged.

## Verification gates

Repair verification on 2026-09-24: 86 tests passed; Ruff formatting/static checks passed;
mypy passed for 23 source files; frozen-contract validation reported `CONTRACT_VALID` and
`PHASE0_COMPLETE`; the original author-workspace fingerprint comparison reported `UNCHANGED`.
This historical test total includes safe PowerShell guard tests. Live WPS execution is separate
evidence: `reports/phase0/live-wps-smoke.json` records a renderer process started on
2026-09-24 at 15:06:44 UTC (23:06:44 Asia/Shanghai), a process-verified export, and an unchanged
source hash. The corresponding S1 run records an unchanged author-workspace fingerprint.

The completion baseline requires all of the following:

```text
mypy
ruff format --check --no-cache .
ruff check --no-cache .
python -m pytest
rfw-phase0 validate
rfw-phase0 compare-workspace reports/phase0/author-workspace-baseline.json <author-root>
```

The expected validator result is:

```text
CONTRACT_VALID
PHASE0_COMPLETE
```

## Known constraints

- Baskerville is missing and may be substituted.
- Microsoft Word is not available in the current environment.
- WPS export refreshes PAGE fields and applies its recorded revision/hidden-text display behavior.
- The WPS-native complex fixture is a fixed reviewed snapshot because rebuilding it changes package
  bytes; regression checks semantic parts, relationships, reopening and page appearance.
- Scientific correctness of manuscript claims and embedded chart data is outside Phase 0.
- Historical PDF records bind fixed file hashes to the declared WPS profile, but do not contain
  process-attested renderer identity. Their history is not rewritten to claim that identity.
- Native export has a process-verified smoke record for the pinned WPS profile and exact IJAM
  source version. Unit tests separately cover identity mismatch and invalid window handles; an
  active-user-session test proves refusal before output. This does not establish another renderer
  version, Microsoft Word compatibility, or complete object-to-page mapping.
- Reparse-point rejection protects declared producer paths. No OS-level Agent isolation or
  protection against hostile concurrent directory replacement is claimed by Phase 0.
- Locator prose is checked for actual package-part existence, mapping IDs and source versions.
  It is not a general semantic verifier for every independently authored annotation sentence.

## Audit repair coverage

1. Required contracts reject empty content, missing fields, missing IDs and conflicting dependencies.
2. Actual PDFs and all registered PNGs are hashed; PDF page counts are inspected independently.
   Source-to-render bindings, annotation identities, object references and review states are checked.
3. The WPS exporter obtains identity from the process owning the COM document window and refuses
   mismatches. Reports no longer infer execution identity from an unrelated configured EXE.
4. Shared PowerShell output guards reject linked parent directories, author roots and overwrites.
5. S1 contracts include extraction methods, scoped verification records, actual-read provenance,
   reading-baseline request/result semantics, and persistent dependencies. Digest boundaries and
   fixed canonicalization vectors are in `contracts/phase0/digest-contract.json`.
6. Incomplete phases return nonzero exit status with the failing check details.
7. Layout mapping IDs are unique.
8. Style inheritance has independently specified font, size, italic and paragraph-spacing values
   with their source styles; neither expected values nor labels come from an S1 reader.
9. Negative tests start from a complete passing copied project and assert the intended failed check.

Contract-check code is deliberately bounded to the Phase 0 vocabulary. It is not a home-built
general JSON Schema processor. No new runtime dependency, database or Agent orchestration was added.

## S1 entry condition

S1 structural work may use the frozen samples and corrected contracts. The recorded live export
establishes execution of the controlled rendering path for its pinned profile and source version.
For another source version, renderer profile or new sealed baseline, retain a matching controlled
export record, verify source/workspace hashes and review the resulting pages. Do not replace the old
visual expectations merely to make a new render pass.
Independent annotations remain external expected results and must never be regenerated by the
reader under test.

The current S1 implementation is an unreleased partial spike. A real IJAM run has produced an
application-owned snapshot, structural report, process-verified render record and unchanged
author-workspace comparison. Full S1 acceptance remains open until page mappings and all required
object-level evidence are reviewed together. The IJAM annotation files exist as pending templates:
`document-annotation.json` has an empty `objects` array and `page-evidence.json` has an empty
`mappings` array. The recorded whole-document visual review does not replace these independent
expected results. See `docs/s1-progress.md` for the current implementation and acceptance status.

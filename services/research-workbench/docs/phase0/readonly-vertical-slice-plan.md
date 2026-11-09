# First DOCX read-only vertical slice

## Objective

Process one registered DOCX through a controlled read-only pipeline and produce enough evidence to
evaluate coverage without modifying the source or author workspace.

## Fixed input

- Artifact: `ijam-english-working-docx`
- Source path and hash: taken from the Phase 0 source inventory
- Renderer candidate: WPS Writer `12.1.0.28505`
- Render settings: must be locked before the S1 run
- Exporter precondition: complete a controlled idle-WPS smoke test of the process-identity checks;
  historical declared-profile records do not substitute for a live test of the changed script.

## S1 implementation sequence

1. Create an immutable application-owned snapshot and verify its hash.
2. Enumerate every ZIP part, relationship, content type, and external target.
3. Parse the first required regions and object classes from the capability contract.
4. Produce a render copy inside application storage.
5. Export PDF and page images with the locked renderer profile.
6. Associate known structural objects with page evidence without inventing precise coordinates.
7. Generate coverage, limitations, and actual-read records.
8. Re-hash the author source and compare the author-workspace fingerprint.

## Required outputs

- immutable source snapshot record;
- package and relationship inventory;
- structural object index;
- render environment and PDF hash;
- page evidence index;
- coverage and limitation report;
- zero-pollution comparison report.

## Refusal and partial-completion cases

- Missing renderer or required fonts: structure may complete; layout status is partial/unverified.
- Unknown object: preserve its part, relationship, and available appearance; report unsupported semantics.
- Ambiguous mapping: report candidates or page-only association, never a fabricated verified coordinate.
- Source hash drift: invalidate the run and establish a new artifact version.

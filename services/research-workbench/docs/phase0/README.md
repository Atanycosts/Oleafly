# Phase 0 deliverables

Phase 0 converts the v1.2 contract into an executable S1 development boundary. It does not claim
that the DOCX reader exists or has passed acceptance.

## Deliverables

1. Source and environment inventories with hashes and limitations.
2. A locked S1 capability boundary.
3. Independent annotation instructions and templates.
4. A complex-object fixture matrix with expected support levels.
5. Minimum S1 data contracts and identifier semantics.
6. Cache dependency and invalidation rules.
7. Author-workspace fingerprinting and zero-pollution comparison tooling.
8. A first DOCX read-only vertical-slice implementation plan.
9. Objective acceptance fixtures and expected results.

## Generated reports

`rfw-phase0 build-reports` writes only to `reports/phase0/`:

- `source-inventory.json`
- `render-environment.json`
- `author-workspace-baseline.json`
- `contract-validation.json`

The command reads the author workspace but does not write to it.

## Completion rule

Phase 0 is complete when the samples, annotations, capability boundary, render environment, minimum
schemas, acceptance fixtures, and first vertical-slice plan are all reviewable and have no unresolved
blocking contract errors. Actual DOCX parsing and rendering execution are S1 work.

The repository now contains an unreleased partial S1 reader and controlled read pipeline under
`src/research_file_workbench/docx/`. Phase 0 completion remains separate from S1 acceptance.

The validator also checks contract content, actual fixture PDF/PNG hashes, page counts, source
bindings, mapping uniqueness and explicit style expectations. Empty JSON cannot satisfy a contract.
Both CLI validation and report-building return nonzero on an incomplete phase.

See the completion report for the separate live-verification status of changes to the rendering
tool. Passing frozen-evidence checks does not imply a changed exporter has been run successfully.

The current completion evidence is summarized in `completion-report.md` and
`reports/phase0/contract-validation.json`.

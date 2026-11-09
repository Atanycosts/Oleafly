# Layout and naming standard

## One responsibility per top-level directory

| Directory | Responsibility | Must not contain |
|---|---|---|
| `contracts/` | Reviewed machine-readable inputs and boundaries | Generated reports or temporary data |
| `docs/` | Explanations, plans, and review guidance | Runtime state |
| `annotations/` | Independent expected results and templates | Parser-produced answers |
| `schemas/` | Schemas for report exchange | Product orchestration |
| `src/` | Reusable implementation | Project-specific generated evidence |
| `tests/` | Deterministic regression checks | Production source data |
| `tools/` | Bounded operator and fixture-building scripts | Product state or duplicated core logic |
| `reports/` | Generated evidence intended for review | Caches or scratch files |
| `var/` | Rebuildable cache and temporary files | Unique evidence or recovery state |

## Module boundaries

| Package/module | Responsibility | Allowed project dependencies |
|---|---|---|
| `common/` | Hashes, strict JSON, paths, workspace fingerprints, PDF/PNG inspection | `common` |
| `phase0/` | Requirements, source/environment inventory, acceptance specifications and gates | `common`, `phase0` |
| `phase0/contract_primitives.py` | Strict scalar, object, array, identity and hash validators shared by contract checks | `common`, `phase0` |
| `phase0/contract_schema.py` | Minimum-schema entity, reference and semantic declaration validation | `common`, `phase0` |
| `phase0/contract_semantics.py` | Frozen Phase 0 collection, capability, acceptance and cache semantics | `common`, `phase0` |
| `phase0/contract_checks.py` | Stable public contract-validation entry point and compatibility exports | `common`, `phase0` |
| `phase0/validation.py` | Phase 0 validation orchestration and stable report assembly | `common`, `phase0` |
| `phase0/validation_contracts.py` | Contract loading, acceptance fixtures, non-DOCX scenarios and completion blockers | `common`, `phase0` |
| `phase0/validation_fixtures.py` | Fixture source, annotation and page-evidence validation | `common`, `phase0` |
| `phase0/validation_baselines.py` | Render-baseline identity and PDF/page evidence validation | `common`, `phase0` |
| `phase0/render_reports.py` | Validate existing fixture renders and build new evidence reports | `common`, `phase0` |
| `docx/models.py` | Immutable source observations and reader errors | Standard library |
| `docx/xml_support.py` | Shared namespace-aware XML traversal and source text projection | Standard library |
| `docx/parsing/` | Package, fields, objects, layout, style, text, table and reference parsing | `common`, `docx` |
| `docx/parsing/text.py`, `tables.py`, `references.py` | Focused text, table and relationship/reference parsing; `content.py` retains paragraph-scope coordination | `common`, `docx` |
| `docx/reader.py` | Source consistency, ZIP entry and parsing coordination | `common`, `docx` |
| `docx/report.py` | Structure report envelope and model collection coordination | `common`, `docx` |
| `docx/report_serializers.py`, `report_coverage.py` | Observation serialization, explicit coverage limits and actual read ranges | `common`, `docx` |
| `docx/mapping_candidates.py` | Bounded source-locator matching | `common`, `docx` |
| `docx/page_mapping.py` | Independent annotation join and mapping status | `common`, `docx` |
| `docx/query.py` | Query request validation, selection orchestration and response assembly | `common`, `docx` |
| `docx/query_index.py` | Source observation identity, region resolution and query index construction | `common`, `docx` |
| `docx/query_selection.py` | Independent reviewed physical-page mapping validation and object selection | `common`, `docx` |
| `docx/query_validation.py`, `query_validation_*.py` | Response delivery validation, source/selection/receipt/pagination checks and cursor bindings | `common`, `docx` |
| `docx/read_receipt.py` | Public receipt builder and filesystem persistence boundary | `common`, `docx` |
| `docx/read_receipt_models.py`, `read_receipt_validation.py` | Immutable receipt models, JSON parsing and strict scalar validation | `common`, `docx` |
| `docx/pipeline.py`, `query_run.py` | Application-owned snapshot and response orchestration | `common`, `docx` |
| `docx/pipeline_snapshot.py`, `pipeline_evidence.py`, `pipeline_report*.py` | Snapshot capture, supplied evidence verification, range parsing and run report assembly | `common`, `docx` |
| `projects/store.py` | Public storage operations and transaction boundaries | `common`, `docx`, `projects` |
| `projects/project_database.py` | SQLite schema, connection and project identity | `common`, `projects` |
| `projects/*_records.py` | Artifact, baseline, evidence and read SQL on an existing connection | `common`, `docx`, `projects` |
| `projects/service.py`, `render_service.py` | Input capture and operation coordination | `common`, `docx`, `projects` |
| `projects/render_validation.py` | Captured render bundle validation | `common`, `docx`, `projects` |
| `journals/models.py` | Source input records, world shape/identity validation and current execution prerequisites | `common`, `docx`, `journals` |
| `journals/analysis.py`, `guide_rules.py`, `components.py` | Deterministic source analysis and strict declarative component ingestion | `common`, `docx`, `journals` |
| `journals/checker.py`, `revisions.py` | Page-geometry checks and immutable rule corrections | `common`, `docx`, `journals` |
| `journals/pdf_analysis.py` | Deterministic PDF text-layer analysis: reading-ordered blocks, font-derived headings, page and point-unit bbox binding | `journals` |
| `journals/store.py` | Public journal storage facade, SQLite schema, connection and transaction boundaries | `common`, `docx`, `journals` |
| `journals/store_records.py` | Shared journal row integrity, identity, source-link and dependency validation on a caller-owned connection | `common`, `docx`, `journals` |
| `journals/store_worlds.py` | Atomic world version and captured source persistence on a caller-owned connection | `common`, `docx`, `journals` |
| `journals/store_bindings.py` | Atomic project-to-world binding persistence and binding history queries | `common`, `docx`, `journals` |
| `journals/store_checks.py` | Atomic check, immutable verdict and operator disposition persistence | `common`, `docx`, `journals` |
| `journals/evidence.py`, `evidence_fragments.py`, `evidence_relations.py`, `evidence_world.py` | Source-bound review fragments, lexical retrieval associations and world evidence envelope | `common`, `docx`, `journals` |
| `workbench/service.py`, `project_facade.py`, `manuscripts.py` | Compose journal and retained manuscript workflows and project presentation | `common`, `docx`, `projects`, `journals`, `workbench` |
| `workbench/server.py` | Local HTTP server lifecycle, static asset snapshot and public compatibility exports | `common`, `workbench` |
| `workbench/request_handler.py`, `get_routes.py` | HTTP request framing, session/origin refusal, route dispatch and response encoding | `common`, `docx`, `projects`, `journals`, `workbench` |
| `workbench/http_boundary.py` | Shared HTTP field, upload, framing, session and static-asset boundary rules | `common`, `workbench` |
| `workbench/cli.py`, `launcher.py` | Operator and agent command surface and owned desktop service lifecycle | `common`, `workbench` |
| `workbench/mcp.py` | Local Model Context Protocol transport identity, startup and error boundary | `common`, `docx`, `journals`, `workbench`, `mcp`, `pydantic` |
| `workbench/mcp_tools.py` | Registration of the local read and write MCP tool handlers over `WorkbenchService` | `common`, `docx`, `workbench`, `mcp`, `pydantic` |
| `workbench/web/` | Browser views, transport validation and semantic styles; no source of truth | Browser APIs only |
| `tools/desktop/` | Retained packaging helpers covered by existing tests | Product state or an active second shell |
| Each `cli.py` | Arguments, output and exit codes | Its owning capability |

Journal check records reference the retained world by `world_version_id`. The service joins the
world for presentation and derives current validity, update availability and disposition history;
neither the browser nor an embedded duplicate manifest is a second world authority. The current
world/HTTP boundary is maintained in `contracts/journals/world-contract.json`.

Common helpers need actual callers. They must not import domain packages; DOCX runtime must not
depend on Phase 0 or persistent project orchestration. SQL helpers accept one connection and never
commit independently. `ProjectStore` owns the atomic operation. `tests/engineering/` checks package
dependencies, runtime imports and CLI entry points.

Split by independent behavior and data ownership, not a target number of lines. New abstract base
classes, mixins, registries and general service layers require current consumers. Models are imported
from their owning modules; do not add compatibility aliases merely to preserve an unreleased import.

## File naming

- Markdown and JSON contract filenames use lowercase `kebab-case`.
- Python files and symbols use `snake_case`.
- Generated reports use a stable purpose name such as `source-inventory.json`, not timestamps or
  names such as `final-v2-new.json`.
- Versions belong inside report content and Git history, not filenames.

## Reuse rules

1. Search for an existing function before adding a new one.
2. Extend a function only when the existing contract remains coherent.
3. Extract a shared helper after a second real use appears.
4. Do not introduce a general plugin or service abstraction during Phase 0.
5. Standard-library functionality is preferred for hashing, JSON, paths, dates, and temporary data.

## Error rules

Errors are explicit. A missing required input, unreadable file, escaped path, or incomplete report is
a failed command. Optional inputs are recorded as unavailable with a reason; they are not converted
to empty successful results.

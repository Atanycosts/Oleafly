# S1 persistent project storage

Status: implemented and locally verified on 2026-09-25. This is the single-DOCX persistent
project slice, not full S1 acceptance. The verified pre-change checkpoint is `622c52d`.

## Scope

The change adds a persistent local project for one DOCX input. It implements part of the reading
baseline and retention requirements in sections 4.11 and 19 of `方案文档.md`, using the entity
semantics in `contracts/phase0/minimum-schema.json`.

The entry point is `rfw-project`, a local operator command with an explicit confirmation reason. Actor
and client labels record the supplied local identity; they do not establish authenticated access
or a trusted remote management interface. Ordinary document content cannot authorize a baseline
change. The project also records explicitly confirmed `DOCUMENT` and `PROJECT` author decisions as
immutable versions. `LOCAL`, `SECTION` and `PROFILE` decisions, rule bindings, manuscript editing
and remote access remain outside this change.

## Durable boundary

- The caller selects an application-owned persistent directory separate from the author workspace.
  Both ancestor and descendant overlap must be rejected, along with symbolic links and reparse
  points in relevant path chains.
- A project SQLite database stores the source DOCX bytes, immutable source identity, baseline
  manifests, extracted evidence, tasks, baseline requests and results, and returned read content
  with its receipt. References must not depend on a disposable `var/` run remaining present.
- Source content is registered from actual read-only bytes and its SHA-256 digest. Import success
  identifies a source version; it does not verify the manuscript's scientific claims.
- Historical render PDFs, page images and mapping inputs can be registered as immutable bundles
  using the [page-evidence extension](s1-page-evidence.md). A stored DOCX alone does not provide
  reviewed page coordinates; page queries require an explicitly selected reviewed mapping bundle.
- The database is persistent project data. Cache cleanup does not authorize removing its source
  bytes, historical evidence, requests, results or read receipts. The schema-1 to schema-2
  author-decision migration is implemented in place; project deletion and retention cleanup remain
  separate, unimplemented operations.
- Author decisions are stored in the schema-version-2 `author_decision` table. A trusted local
  operator confirmation is required; an agent proposal is refused. Updates append a version with a
  `supersedes` reference, and an optional retained baseline ID is checked before commit. Decision
  versions are not included in the baseline request digest or silently applied to evidence.

## Baseline changes

The request identity is scoped by project, actor and request ID. Its semantic digest uses the
shared canonical digest implementation and the existing reading-baseline digest contract.

Within one transaction, a repeated request ID is checked before the current-baseline comparison:
an equal digest returns the saved result, while a different digest yields an idempotency conflict.
For a new request, `expected_baseline_id` is compared with the single current pointer. Only a
matching expectation may create the immutable baseline and switch that pointer. The decision,
request, result, baseline and pointer change share the commit boundary.

A rejected or conflicting change keeps the previous pointer. A committed request retry returns
its original result even if another request has since advanced the project. A storage exception
must not be reported as an applied request. The implementation must distinguish durable rejection
records from transactions that never committed.

## Evidence, queries and history

- Source bytes are parsed through the same DOCX engine used by the existing reader. This change
  does not add a second parser or a lower-fidelity fallback.
- Extracted observations retain the source version, locator, extraction method and method version,
  parse status, limitations and dependencies. Unsupported objects remain unsupported.
- Baseline and source version references remain immutable. Historical reads and receipts preserve
  their original content and method bindings; a new baseline does not rewrite earlier responses.
- Source and method changes are separate invalidation causes. Matching source bytes cannot make an
  observation current after its extraction method changes. Freshness must remain separate from
  verification, and no applicable verification record means no scientific or semantic PASS.
- A catalog lists available objects without claiming they have been read. A query persists exactly
  the returned observations and associated receipt with its task. The receipt identifies returned
  content, versions, ranges, pagination and unread ranges; it does not prove model understanding.
- Page filtering requires a registered bundle whose source, PDF and independent mapping agree.
  Missing page evidence is refused and never becomes an unfiltered structural read.

## Verified behavior

1. Two competing requests with the same expected baseline cannot both advance the pointer.
2. Equal retries return the original result; changed-content retries conflict without changing
   that original record or the current pointer. Project and actor scopes remain distinct.
3. A failure between SQL writes rolls back the baseline and pointer together. Reopening the
   database must reveal either the previous state or the complete committed state.
4. Removing the external source or disposable run after import does not prevent historical reads
   of the retained source bytes and previously saved responses.
5. A changed parser or extraction method makes dependent evidence stale without rewriting its
   historical content or manufacturing a verification PASS.
6. Invalid source bytes, invalid queries and failed storage writes do not create an applied result
   or a receipt claiming a response that was not durably returned.
7. Source workspaces remain unchanged; storage path overlap, linked paths and accidental database
   replacement are refused before writing.
8. The repository's Ruff formatting, Ruff static checks, mypy, pytest and Phase 0 validation gates
   pass. Record the actual results here after integration rather than treating this list as proof.

## Validation status

The full suite passed 257 tests, including 50 project tests and the shared parser/digest regression.
Ruff formatting passed for 84 files, Ruff lint passed, and mypy passed for 40 source files.
Phase 0 validation returned `CONTRACT_VALID` and `PHASE0_COMPLETE`.

The lifecycle smoke ran ten separate CLI processes: initialization, source inspection, import,
read, response recovery, a second import, old-evidence inspection, original-response recovery,
idempotent replay after deleting the test source, and an explicit historical read. It retained
two baselines and 606 old observations from the application-owned IJAM snapshot. Old observations
became STALE while remaining NOT_REVIEWED. SQLite `integrity_check` returned `ok`.

The 2026-09-25 `project-lifecycle-smoke.json` and `project-storage-verification.json` records are
retained as local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/s1/`, outside the
public clean checkout. The smoke project was disposable test data under the original `var/`;
its simulated external revision and deletion affected only its copied test input. No author
manuscript, live WPS run, independent IJAM annotation or full S1 acceptance was changed.

## Local commands

Choose a new, durable project directory outside the author workspace. The following locations
are examples to replace; a real project must not use the repository's disposable `var/` directory.

```powershell
$env:PYTHONPATH = "src"
$projectRoot = "D:/ResearchWorkbench/projects/my-manuscript"
$authorRoot = "D:/ResearchInputs"
$source = Join-Path $authorRoot "manuscript.docx"

python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot init `
  --author-workspace-root $authorRoot

$inspection = python -X utf8 -m research_file_workbench.projects.cli `
  --project-root $projectRoot inspect-import $source | ConvertFrom-Json
```

Review the inspected source and hash before submitting the explicit management decision:

```powershell
python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot import $source `
  --source-sha256 $inspection.source_sha256 --request-id request-first-import --initial `
  --actor-id local-operator --reason "Use this inspected manuscript as the initial baseline"

python -X utf8 -m research_file_workbench.projects.cli --project-root $projectRoot read `
  --region body --object-type text_block --page-size 10
```

For an update, inspect again and replace `--initial` with
`--expected-baseline $inspection.expected_baseline_id`, using a new request ID. Reusing a request
ID with different semantic content conflicts. A known hash/path/parse rejection is saved as
REJECTED; fixing the input requires a new request. Storage or indeterminate I/O failures do not
manufacture a terminal result. The `request` command recovers the saved management decision.

Use `status`, `baselines`, `catalog`, `evidence`, and `reads` to inspect project state. Use
`response <read_record_id>` to retrieve the original persisted response; use `read --baseline-id`
for a new explicitly historical read. Partial content responses exit 1, completed management
commands exit 0, and refusals/conflicts exit 2. A partial response is not a storage failure.

`-X utf8` makes JSON piping deterministic on Windows. The database is the retained project
content; query delivery does not create sidecar response files in the author workspace.

# Development guide

## Sources of authority

- Module-local `方案文档.md` is the frozen v1.3 requirements baseline, including historical
  planning language.
- `contracts/` contains machine-readable requirements and supported runtime contracts.
- `docs/s1-progress.md` identifies the current Workbench-domain implementation and acceptance
  limits; it is not the system-wide Agent status.
- The repository-level `docs/research-workbench-integration.md` describes cross-system
  integration. Current Agent status and architecture are in `docs/agent/status.md` and
  `docs/agent/architecture.md`.
- `docs/fused-research-agent-architecture.md` is frozen 2026-11-05 historical design input;
  current contracts and verified status govern what is implemented.
- Current tests and generated verification reports identify the checks actually executed.
- Independent `annotations/` are expected evidence, not parser-generated output.
- `backend-standards.md` defines the current Python package boundaries, persistence rules and
  verification expectations for backend changes.

Passing Phase 0 means the implemented contract/evidence gates passed. Acceptance specifications
for planned S1 features do not demonstrate that those runtime features exist. Old reports remain
historical evidence and must not be edited to claim a new execution.

## Work sequence

1. Inspect Git state, applicable contracts, callers and existing tests. Keep unrelated changes.
2. Establish a named baseline before structural refactoring. Use `codex/` branches for agent work.
3. State the supported behavior and a reproducible failing case. Changes to existing contracts
   must identify affected source, method, cursor, evidence and storage dependencies.
4. Fix the owning module and migrate every caller. Remove obsolete implementations and aliases.
   Reuse shared filesystem, hashing, JSON and media inspection instead of duplicating them.
5. Add regressions for changed observable behavior, failure paths and integrity boundaries.
   Tests use controlled copies and temporary directories; they never generate expected independent
   manuscript annotations from the implementation under test.
6. Run focused checks during development, then the full gate below. Update the verification
   result in `docs/s1-progress.md` with actual exit codes, counts and remaining acceptance.
   Keep routine logs in `var/` and remove them after inspection; a new report is not required
   for each iteration. Retain raw evidence for acceptance, significant experiments and useful
   failure diagnoses in `reports/` without duplicating the same result across several files.
7. Update current contracts and guidance in place. Preserve frozen acceptance evidence and
   domain records; use Git for source history rather than backup copies. Remove temporary
   backups, test data and downloaded build archives after verification. Keep the working
   application, dependencies and selected libraries. Review `git diff --check` and the final
   diff before publishing a commit or release.

## Local setup and verification

The primary development and acceptance platform is macOS (operator decision, 2026-10-31);
the PowerShell gates below remain the recorded Windows evidence procedure and historical
artifacts are never rewritten. Use Python 3.12 or later. The gates run inside the repository
virtual environment, because the project declares runtime dependencies; verifying against a
bare interpreter would exercise a different package set from the one that ships. Fixture-building libraries are developer tools,
not the DOCX reader.
Poppler `pdfinfo`, Node.js and PowerShell 7 must be available for the current Windows evidence gate.
The browser response tests use Node's built-in runner against real HTTP responses and damaged
copies. Node is a verification dependency; the shipped application needs no npm packages.
Pinned author inputs and renderer identities are environment-bound requirements: their absence
must be reported, not silently skipped or replaced with new hashes.

Choose the best available component for a layer rather than the cheapest one. Bespoke work is
reserved for the evidence, versioning, staleness and handoff layer, which is the product
differentiator; everything else prefers a maintained upstream component over a reimplementation.
Every runtime import must be declared in `pyproject.toml`: the architecture test accepts the
standard library, this project, or a declared dependency, and nothing else. The operator confirmed
on 2026-11-02 that this checkout is a private local-use tool. AGPL/GPL components are acceptable;
a hypothetical proprietary distribution is not a component-selection constraint. Keep upstream
licence and attribution notices, and reassess scope if distribution or hosting for others is
later requested. PyMuPDF (AGPL-3.0) for PDF text-layer extraction is an existing example.
PyMuPDF is pinned to a minor range because block
segmentation feeds `journal-pdf-source-1.0.0`; a pymupdf upgrade that changes extraction
results must bump that method version in the same change.

```powershell
python -m venv .venv
uv pip install -e ".[dev,fixture-building]"
pwsh -NoProfile -File tools/verify.ps1
```

`uv` is only the installer here; any environment at `.venv` works. The verification script refuses
to start without it, and the interpreter can be overridden with `-Python`. It runs Ruff, mypy,
pytest and Phase 0 validation and stops on any failed gate. Each test run uses a new
`var/verification-<id>` directory.

Nine tests skip on `OSError` when the process cannot create a symbolic link, and several of them
are the reparse-point boundary tests. Whether a given process holds `SeCreateSymbolicLinkPrivilege`
is not guaranteed here and has been observed to differ between processes, so the gate probes it
up front and fails loudly rather than reporting a green run in which those boundaries were never
checked. `pytest` also runs with `-rs` so any remaining skip is named in the output. The script
restores its working directory and `PYTHONPATH`; it does not rebuild reports, run an Office
renderer, or modify author inputs.

Equivalent individual gates remain documented in `AGENTS.md`. An environment-bound validation
failure must remain distinct from a deterministic unit-test failure. Do not call a release portable
until author-input paths, rendering environments and fonts have been independently verified there.

### DOCX font and render integration

Native font setup on this Mac requires the Homebrew `sevenzip` package and `tar`; both are
installed. The native application is the sole production source of `OLEAFLY_FONT_DIRS`, passing
its existing font-cache roots as a `os.pathsep`-separated launch value. HTTP and MCP callers do
not choose font directories.

Every LibreOffice render uses its own temporary profile and stages the current TTF/OTF cache bytes
into `profile/user/fonts`, deduplicating by SHA-256 and verifying available source receipts.
`supplied_fonts` records those supplied bytes and hashes; `pdf_font_names` records the names
observed in the resulting PDF. These are different evidence and neither establishes complete
font embedding, the version selected in the live editor or visual equivalence. The current
derived-render response also reports the current cache-content identity, while each render retains
the identity actually supplied to it. Clients compare those identities after service restart so a
PDF from an older cache is not reused as current; a historical render without that identity is not
a current-cache match. The current response contract is `journal-http-1.10.0`. The render HTTP
request adds no profile, font-directory or cache-identity path fields; the service owns the profile
location and derives the identity from the configured native cache roots. See
[`contracts/s1/render-bundle.json`](../../contracts/s1/render-bundle.json) for the authoritative
method and boundary.

The local LibreOffice 26.8.2.2 profile/font probe succeeded. On 2026-11-13 the final isolated
macOS app also passed real Chinese/English manuscript acceptance in `run-ilC23E` / `run-oknADL`
under the repository's ignored `.private/docx-font-layout/` directory. Those runs separately
verify exact cached-package extraction, same-session font use, compatible-render reopen, actual
edit/save and regenerated source-matching PDFs; they do not follow from the probe or portable
suite alone. Microsoft archives were preverified cache inputs, PT Serif used real network
downloads, and Word/WPS visual equivalence remains unverified. See the owning
[application status](../../../../docs/agent/status.md#docx-准确字体获取2026-11-13) for full scope.

## Oleafly application and MCP connection

Since 2026-11-09 this service lives in `services/research-workbench/` within the Oleafly
repository. From the repository root run `pnpm workbench:setup`; `pnpm tauri dev` selects
that environment unless `OLEAFLY_WORKBENCH_PYTHON` is set. A packaged application still uses
its existing saved interpreter selector. The HTTP/MCP versions and library ownership are
unchanged. The earlier standalone shell is frozen local history, outside the active build.

Portable tests use committed synthetic fixtures and test-only Phase 0 contracts. Private author
catalogs, real render baselines, annotations, reports and libraries remain local. Actual Phase 0
validation continues to fail if those environment requirements are missing. The following dated
execution descriptions retain their historical paths and scope.

The 2026-11-07 **期刊检查 / Journal checks** rail panel in the Oleafly
application uses this repository's existing Python HTTP service for operator actions.
Oleafly starts `research_file_workbench.workbench.launcher`, retains its session
token and stops the child when the application exits. The service owns captured
bytes, journal worlds, bindings, checks and reads; the existing Oleafly
research-workspace metadata stores the manuscript association and the linked research
task, selected world and optional check IDs.

The operator excluded a complete journal submission workflow and comprehensive
submission acceptance on 2026-11-07. Develop the retained requirement-research,
source-review, rule-versioning and supported manuscript-checking capabilities;
do not list complete submission as unfinished product work.

On first connection choose this environment's Python executable, or set
`OLEAFLY_WORKBENCH_PYTHON`. Oleafly stores the runtime setting in
`<OLEAFLY_DATA_DIR>/workbench-python.json` and uses
`<OLEAFLY_DATA_DIR>/journal-library`. Imported DOCX updates create retained
versions; select **使用此版本 / Use this version** to bind the current manuscript
before rerunning a check. **交给代理分析 / Analyze with agent** opens an editable
draft in the existing assistant, using its existing supplier/model/effort controls.

**研究期刊要求 / Research journal requirements** starts an existing Oleafly ResearchTask
with the selected provider, model, reasoning effort and budget. The host supplies the
selected world, complete source fragments and saved check in the task's
`journal-context.json`. The task researches official pages and returns one
`journal-review.json`; the panel loads it automatically. Review the summary, quoted
candidates and conditions, select values in mm/pt/count, and explicitly confirm their
applicability. Adoption retains captured pages, original sources and decisions in one
new version. The selected option then binds that version and runs the existing check.
Manual **导入候选 JSON / Import candidate JSON** remains available. Handling notes keep
the original verdict. These operations use the HTTP surface declared by the
[journal world contract](../../contracts/journals/world-contract.json).

The application defaults to Simplified Chinese on first launch and after a settings
reset. An explicit language choice remains saved. Built-in skill names and descriptions,
research controls and fixed Workbench diagnostics use the active UI language; retained
source quotations, user text and model output keep their original content. Language
switches update the active locale before notifying React so dictionary and regional
labels do not retain the previous language. Sidebar research actions wrap within their
card in both Chinese and English.

Chat provides web tools directly without a web switch. ResearchTask web tools are
independent of command-network permissions. Page reading uses the existing upstream
reader; search through the custom-provider runtime still requires a configured
Brave/Tavily/Serper key. A task saves the reader's complete returned text before
shortening its model-visible response, then uses the existing file reader for the rest.
This preserves extracted text, not the original HTML or JavaScript-rendered page.

In the Oleafly checkout, build this local application with Vite's `--mode workbench`
and Tauri's `--config src-tauri/tauri.workbench.conf.json`. The checked-in flavor
configuration identifies the local app and removes the official updater endpoints.
Its manual update window explains that it is updated from the local checkout.

The local app is at `~/Applications/Oleafly Workbench.app` and embeds its frontend;
it does not need Vite running. Its bundle selects the existing isolated preview
library. This local installation uses the repository virtual environment rather
than bundling another Python runtime. If the checkout moves behind a symlink,
refresh its editable install using the physical checkout path, for example:

```sh
uv pip install --python /Volumes/Studio/Projects/Oleafly/services/research-workbench/.venv/bin/python \
  --no-deps --reinstall -e /Volumes/Studio/Projects/Oleafly/services/research-workbench
```

The path check remains in force. The actual desktop workflow test is
`../../e2e/tests/116-journal-checks.spec.ts`; set
`OLEAFLY_WORKBENCH_PYTHON` when running it against the adjacent native test app.
Development and packaged runs passed. The operator HTTP bridge does not register
management tools for the Agent; agent-facing MCP still has the following boundary.
The real-provider extension requires `OLEAFLY_JOURNAL_RESEARCH_LIVE=1`,
`OLEAFLY_JOURNAL_MANUSCRIPT` and `OLEAFLY_JOURNAL_GUIDE`. It uses the saved provider
credentials and is opt-in because it consumes model usage.

The product now also absorbs the reviewed HelloAGENTS workflow rules through
Oleafly's existing prompts and skill loader. Shared instructions are maintained
at `../../crates/oleafly-agent/src/workflow.md` relative to this checkout;
`oleafly-development` adds code-change guidance on demand. These are product
instructions, not a second task runtime or an installation into the operator's
coding assistant. Oleafly retains task state and execution; this service retains
source, version and evidence authority. The adjacent integration guide records
delivery paths and current verification limits. As of 2026-11-07, the shared
rules and four skills use task-dependent methods instead of a mandatory
router-first process. CLI commands reuse ResearchTask's existing runtime
discovery, including project Python environments, rather than relying on a
fixed sandbox PATH. The bounded real-provider comparison and its instruction
injection limits are recorded in `docs/s1-progress.md`.

The official Oleafly 0.4.9 application completed the first real-provider native ResearchTask
over Workbench manuscript content on 2026-11-04. The integration branch now also builds and
runs as an isolated macOS source application. See the repository-level
[Agent status](../../../../docs/agent/status.md) and
[Agent architecture](../../../../docs/agent/architecture.md) for current integration state and
runtime boundaries. The 2026-11-05 source-build report is retained only as local historical
evidence under `.private/workspace-consolidation-20261109/workbench-original-source/reports/`;
it is not part of the public clean checkout.
Use an application-owned library and start the agent-facing server with explicit read-only scope:

```sh
PYTHONPATH=src .venv/bin/python -m research_file_workbench.workbench.mcp \
  --library-root /absolute/path/to/library --read-only
```

`--read-only` omits the seven management tools; the remaining 11 tools still persist normal
read receipts. The default operator entry retains all 18 tools. Both modes reject unknown
top-level tool argument names before any service operation; the SDK still validates values.
This small argument-name check uses the official SDK's public middleware hook, whose 2.x
signature is provisional. Real-stdio tests exercise the hook and direct calls to omitted tools.
There is no new runtime dependency, permission service or retry layer.

Read-only scope covers the selected library, not one project or task. Oleafly now sends
project/task/generation as optional `_meta` on `read_objects` calls to the Workbench MCP server;
the values are retained for local receipt correlation only, not authentication or access control.
The desktop native task path preserves `readOnlyHint`, so a configured server's read-only
tools work with task commands turned off; other MCP tools retain the existing approval gate.
The server enforces the 11-tool surface independently of these client hints. Both legacy and
modern MCP request paths retain caller metadata; modern protocol metadata is preserved alongside
it. The recorded native run uses the modern `2026-07-28` protocol.

Native ResearchTask exposes supported reasoning-effort choices for custom suppliers. If an older
stored model list has no reasoning metadata, refresh it through Settings, AI, the supplier's model
list, then select the desired effort. The current direct-supplier task persists `max`; affected
wire/component tests verify explicit effort propagation and Auto omission. This source-build run
does not capture the outgoing supplier request, so it does not independently attest the gateway's
wire field or internal reasoning. The earlier experiment's temporary forwarding server is stopped.

## Python and data rules

- Public boundaries use explicit types. Validate external JSON once at a boundary and report
  malformed or ambiguous data. Do not silently discard invalid fields, duplicate keys or errors.
- Core functions return meaningful results or raise specific errors. Cleanup may re-raise an
  error; a catch returning an empty successful result is prohibited.
- Runtime JSON is decoded and encoded through `common/json_io.py`. Request digests use the
  restricted canonicalization in `common/digests.py`; ordinary report serialization is not a
  replacement for that digest contract.
- Dataclasses represent immutable observations or validated requests; JSON remains an interchange
  boundary. Do not create an abstract framework for one concrete implementation.
- Library modules do not print. CLI boundaries present a failure reason and nonzero exit status.
- Use explicit absolute package imports. Follow module boundaries in `layout-and-naming.md`.
- Shared styles, historical method versions and schema versions have separate meanings. A method
  change is not authorization to rewrite stored blobs, reset SQLite or fabricate a migration.

## Version and evidence changes

Change the relevant method version when behavior or meaning changes, including correction of a
previously wrong observation. Source hashes alone cannot invalidate a corrected parser or mapper.
New queries use the current reader; saved response recovery returns the exact original response.
Old page bundles remain retained, but new page reads reject incompatible method dependencies.
Re-register independently authored inputs to create a current bundle; do not relabel an old record.

The current query method is `s1-read-query-1.7.0` and read receipts are `s1-read-receipt-1.2.0`.
Optional Oleafly task metadata is retained as local correlation in new read receipts only; it is
not authentication. Cursor decoding uses the shared strict JSON
boundary: duplicate keys, non-finite values, malformed Base64 or an unexpected cursor shape are
refused. A 1.6.0 cursor cannot continue a 1.7.0 query because the method is part of the cursor binding.
Recovering an already saved response still returns its original method and bytes; it does not call
an older query engine.

A query response carries two independent axes. `status` is the coverage axis: `partial` on a
content response while the reader declares limits, and `catalog_only` on a catalog response.
`selection_delivery` is the continuation axis for the requested selection
(`continuation_exhausted` or `continuation_available`) and is what the command's exit code follows.
It reports whether another page exists, never how much of the selection one response holds. Never
report one axis as if it were the other.

Source observations can remain applicable across identical-byte baselines. Render bundles bind
an exact baseline as well as source/method identity, so rebasing identical bytes still invalidates
their applicability to the new baseline. Historical access remains explicit.

## Journal integration boundaries

The [journal world contract](../../contracts/journals/world-contract.json) is the current
machine-readable owner of the world data, method identities and local HTTP surface. Update this
existing contract when changing a boundary instead of creating a second authoritative endpoint or
client schema document.

World discovery uses `journal_name`. Manuscript import separates a display `name` from the original
DOCX `filename` and `content_base64`; filenames are labels, not an API for reading arbitrary paths.
`GET /api/manuscript-source` requires `project_id` and an explicit `baseline_id`; it returns that
retained artifact and its recorded hash, never reads the original author path and does not create a
read receipt.
The server enforces the exact JSON request fields. Keep browser payloads, server parsing, service
arguments, CLI callers and regression cases aligned in the same change; no alias or extension-based
fallback should silently reinterpret the display name.
GET query fields are exact as well. Repeated or unknown parameters fail with 400. Unsupported HTTP
methods return JSON 405 with an Allow header; storage corruption returns generic 500 text without
local paths or database details. Persisted display metadata is validated on recovery with the same
label and filename rules used during import.

New checks reference one retained world by `world_version_id`; only the HTTP presentation joins
that world into a response. Rule basis and original verdict are retained facts. Validity and update
availability are derived from current dependencies; disposition is queried from its own immutable
records. Applicability remains a separate scope decision. Neither a note nor a new world version
may rewrite the historical verdict or move the current binding.

Retained historical validation is distinct from execution. World identity validation permits
supported historical records to be read; new checks and revisions require current analysis
semantics. Historical checker records can retain their original aggregation, but new saves cannot
claim an older checker version. Do not add a selectable legacy engine to support recovery.

The local HTTP server captures its static asset bytes once at startup and exposes their digest as
`asset_version` with a per-process token from `/api/session`. The browser checks the HTTP contract,
tracks the served asset identity and refuses to continue mutations after a changed asset identity
until reloaded. Source edits require a service restart and page reload. Do not describe the digest as
proof that a running process contains the latest uncommitted source.

For interface changes, run `node --check` for every JavaScript module below
`src/research_file_workbench/workbench/web/`, then test
the real browser flow against the current service. Cover a display name without a file extension,
same-journal scope-only differences, stale results, partial section coverage, response failures and
1024/1280/1920-pixel layouts. A Node DOM/API substitute can exercise logic, but does not establish
browser layout, upload controls or end-to-end persistence.

## File safety and acceptance

Author workspaces are read-only. Internal output stays in declared application storage, never
beside manuscripts. Check the original path chain before resolving links. Path checks are not
an operating-system sandbox against a hostile concurrent actor.

Hash, size and validation must refer to the same captured bytes. A matching digest proves identity,
not semantic correctness, rendering provenance or human review. Page queries require a unique typed
object occurrence supported by independent reviewed annotations and matching source/PDF versions.

Do not launch Word/WPS as part of ordinary tests. Test refusal and failure paths with controlled
substitutes before COM construction. Live rendering, font substitution, cross-renderer compatibility
and independent IJAM object-to-page acceptance are separate evidence scopes.

Workspace fingerprint 2.0.0 retains the original content manifest and adds a separate protection
digest. It covers observable Windows protection flags or POSIX permission mode, including the
root directory, but not full ACL/ownership semantics. A version-1 content-only baseline cannot
prove unchanged attributes; capture a new baseline instead of relabeling historical evidence.

## Bounded generation tools

`tools/fixture_building/build_docx_fixtures.py --project-root <new-generation-root>` requires an
explicit root and refuses if any fixture, annotation draft or catalog target already exists.
Rebuild into `var/` or another declared test workspace and compare; never regenerate over reviewed
repository annotations. Fixture generation produces pending drafts, not independent review.

`tools/phase0/build_render_behavior_probe.py --output <new-output.docx>` also refuses overwrites.
The report builders `build_fixture_page_index.py` and `build_fixture_render_catalog.py` require
`--output` under application `reports/` or `var/`; select a fresh file, then explicitly review it.
`inspect_rendered_pages.py` only inspects existing PDF/PNG outputs. Python scripts use snake_case;
PowerShell operator script names remain kebab-case. Set `PYTHONPATH=src` when calling Python tools
from a checkout without an editable install.

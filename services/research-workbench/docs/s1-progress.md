# S1 implementation and acceptance status

Status date: 2026-11-09

The service now lives in Oleafly at `services/research-workbench/`. Its current
source snapshot includes the former checkout's uncommitted work; the original
history and private evidence are retained locally. Oleafly is the active application
shell. The old root retains only existing `var/` data and a migration pointer; data
paths and manuscript records were not rewritten. Use `pnpm workbench:setup` from
the Oleafly root and this service's `.venv` for development.

Consolidation verification passed Ruff format (213 Python files), Ruff lint, mypy
(118 source files), and the complete Python suite (1034 passed, 33 existing platform
skips, five PyMuPDF/SWIG warnings). The original synthetic fixture bytes are retained;
Phase 0 regression projects now use explicit controlled test inputs rather than real
manuscript renders. The real native Oleafly journal workflow passed with the new
interpreter (1 passed, 1 opt-in live-provider scenario skipped). These results prove
source/environment integration, not new model reasoning or portable real-WPS
acceptance. A staged-source-only copy without private catalogs or manuscript evidence
also passed 68 focused Phase 0, architecture and launcher tests. Actual historical
Phase 0 validation still fails for the nine missing
author inputs and fixed WPS environment. Earlier dated results below retain their
original scope and paths.

Scope decision (2026-11-07): the operator excludes a complete journal submission
workflow and comprehensive submission acceptance from the product scope. They are
not pending deliverables. Journal-requirement research, source review, versioned
rules and supported manuscript checks remain in scope.

S1 is unreleased and partial: manuscript analysis is read-only, while project and journal
management expose local writes. The latest complete Workbench gate run on 2026-11-07
passed Ruff format (248 Python files), Ruff lint, mypy (118 source files), and
pytest (1034 passed, 33 skipped, five PyMuPDF/SWIG warnings). The preceding test cleanup's
Oleafly frontend checks passed 184 cases; full frontend lint and TypeScript checks passed. See the
[verification log](../reports/engineering/test-cleanup-20261105.log), which consolidates
the eight command results. Four mechanical scans were removed, MCP discovery checks were
merged, and parameterized read/recovery cases retain caller metadata and server-restart
coverage. Daily updates revise this status in place rather than add per-turn reports.

Phase 0 remains `CONTRACT_INVALID` / `PHASE0_INCOMPLETE` on this Mac: nine registered author
inputs and the pinned Windows WPS profile are unavailable. Current validation resolves
retained Windows paths through matching fixture/report-relative identities, checks retained
hashes and complete render output, and rejects another fixture's source. Earlier `Render
record points to another source` output was a cross-platform path-comparison false positive.
Historical source identities, render bytes and acceptance results were not rewritten.

The current [desktop workbench](desktop/workbench.md) has
[execution evidence](../reports/desktop/workbench/verification.json). The
[MCP boundary experiment](../reports/integration-investigation/mcp-read-only-boundary.md)
verified 11 read-only tools, write/typo refusals and persisted recovery. The
[source-app task](../reports/integration-investigation/oleafly-native-research-task-2026-11-05.md)
then verified real-provider native execution, caller correlation and exact structured-response
recovery, ending in `awaiting_review`. Full product and independent S1/IJAM acceptance remain
pending.

Earlier execution counts remain in their original evidence:
[2026-11-02 investigation](../reports/integration-investigation/verification.json),
[environment gate](../reports/engineering/environment-gate-20261010.md),
[integration audit](../reports/engineering/integration-audit-review.md), and
[standardization review](../reports/engineering/project-standardization-review.md).

## Oleafly integration status (2026-11-05)

The operator confirmed that the project is for private local use and requested
an Oleafly checkout as a potential primary application foundation. The upstream
source is checked out separately in the adjacent `Oleafly` directory at
`1b6521943ea567a4e5df02c99a588b4e49737623`, with development branch
`codex/research-workbench`. Its `docs/research-workbench-integration.md` records
the integration proposal and first validation slice.

The official Apple Silicon Oleafly 0.4.9 release was launched with a separate
preview library on 2026-11-02, and its welcome screen was visually verified.
The archive digest matched its published value and the bundle passed code-signature
verification. That release is not a build of the integration branch. The first stdio
MCP handshake, real-provider CLI Agent calls and native ResearchTask used this release
in a separate synthetic library. The branch has since built and run as an isolated
macOS source application; no existing user library was migrated.

The [native ResearchTask experiment](../reports/integration-investigation/oleafly-native-research-task-2026-11-04.md)
read a hand-authored synthetic DOCX with `read_objects`, recovered the same response
with `saved_read`, and produced a report citing all delivered objects, source hash,
baseline and receipt. Its calculations and original-file preservation passed the
recorded checks. It finished in `awaiting_review`, not applied or completed. The
model was the supplier's `gpt-6.1-sol`; a temporary real-response forwarder sent
`reasoning_effort=max` on all 14 requests because native custom-provider requests
contained no effort. The forwarder is stopped and the supplier is restored to direct
configuration. Reported usage was 259734 input and 8322 output tokens; cost is unknown.

The original release-app ResearchTask advertised all 18 MCP tools, unlike CLI Agent's
11-tool filter. The MCP contract is now `workbench-mcp-0.4.1`: `--read-only` registers only the 11
reading/discovery tools, and both modes reject unknown top-level argument names.
The default operator surface retains its 18 tools. Read receipts still persist;
library-wide read scope is not project/task authorization. The isolated preview's
configured MCP launcher passes `--read-only`.

The [2026-11-05 source-app task](../reports/integration-investigation/oleafly-native-research-task-2026-11-05.md),
`task-005dd6cfb25a3b2d4101911087c6a6ab`, generation `1`, ran directly against the real
supplier with `gpt-6.1-sol`. With task commands off, it called `method_versions`,
`read_objects` and `saved_read` once each. Modern MCP discovery advertised exactly
11 read-only tools. The original response, recovered response and SQLite record are
structurally equal; the persisted caller matches the actual Oleafly project, task
and generation. The Workbench receipt keeps its own task ID and `client_id=workbench-mcp`.
Source and original project hashes are unchanged. The report cites all six delivered
objects, correct calculations and coverage limits. It ended in `awaiting_review`;
no project changes were applied. Usage was 180088 input and 10828 output tokens;
cost remains unknown.

This runtime exercise found and fixed two integration defects: native MCP conversion
dropped `readOnlyHint`, causing read calls to hit the command gate, and modern discovery
did not retain the server identity needed to attach caller metadata. Both desktop and
daemon paths now preserve the existing read-only flag; legacy and modern call paths
retain caller metadata without replacing protocol metadata. The fresh native task
verifies the desktop path. CLI/research library tests (666 and 506), including new-session
ACP resume prompt coverage and fresh-retry record recovery after a failed carry-over; desktop MCP tests
(101), task-runtime tests (12), scoped Rust Clippy, frontend lint/typecheck and 187
affected frontend tests passed. This is not a full-workspace all-target Rust or full
frontend test-suite result.

Custom-supplier reasoning effort is now selectable and this task persists `max`.
Local component tests cover effort propagation; this direct-supplier run did not
capture the outgoing inference request, so it does not independently prove its wire
field or supplier computation. Read-only registration and receipt correlation are
verified for this synthetic run; full integration acceptance, independent manuscript
review and application remain separate. The preview and its Vite server were stopped
after verification; disposable compiler caches were removed while keeping the current
binary, app and isolated task library.

The [formal product and system architecture](fused-research-agent-architecture.md) is the
consolidated design entry for the Oleafly integration. It merges the two external design inputs,
source investigation and review decisions, with one execution owner, the retained domain core,
enforceable tool admission, explicit budget/recovery semantics, and staged acceptance criteria.
It is a design document, not a new runtime contract or evidence that integration has shipped.
The [three-project investigation](oleafly-superagent-research-workbench-investigation.md) and
its three source reviews remain the fixed-revision research evidence. Task/project-scoped MCP
access and human-confirmation attribution still require enforcement before autonomous use;
the existing trusted local-operator boundary is not that contract.

The reviewed HelloAGENTS ideas are integrated into the adjacent Oleafly branch through its
existing prompts and skill loader. On 2026-11-07, shared rules and four skills were simplified:
no mandatory router-first sequence, repeated general workflow or automatic extra reports.
Oleafly TaskStore, the scheduler and existing approvals still own execution; this Workbench
owns source, version and evidence records. No second runtime or Stop gate was added.

The bounded CLI comparison at `../agent-behavior-experiment/round-4/README.md` completed four
real-provider runs on extracted receipt code and cross-repository source research. Both code
outputs passed external checks; both research outputs traced persistence/recovery and correctly
distinguished read-only tools, task correlation and model understanding. Concise instructions
did not eliminate extra files: one run appended progress to the task input and another retained
five supporting files. The generic shared progress-recording sentence was removed. An actual
CLI sandbox runtime gap was fixed by reusing ResearchTask's existing runtime discovery; a
separate final CLI run then executed its own 20 tests and README example, with 12 independent
checks also passing. Magpie's enabled memory plugin added instructions during these calls, so
this small sample does not isolate the rule change or establish stable behavioral improvement.
The experiments used disposable code copies and source slices; this update does not change
Workbench contracts, its receipt identity algorithm, or the desktop acceptance status.

## Oleafly journal workflow (2026-11-07)

The Oleafly integration now includes a usable **期刊检查 / Journal checks** panel.
It imports captured manuscript and journal-source bytes, associates one retained
manuscript with the Oleafly project, explicitly binds a world version, runs the
existing checker, and opens rule quotes, source fragments and exact manuscript
section reads. PDF source text opens its retained page and highlighted region.
The selected check and linked sources can be handed to Oleafly's existing Agent
composer for analysis. The panel initially reused the existing HTTP surface; its
source-to-candidate workflow now adds the bounded operation described below.
Oleafly manages the existing HTTP launcher's lifetime and session token.
Association metadata lives with Oleafly; source/version/check/read authority stays
in this service.

The actual desktop flow passed in development and again from a packaged app with
its frontend embedded: a synthetic Letter/single-column manuscript produced three
violations, then a revised A4/two-column version passed seven requirements. The old
check became stale, a new binding was explicit, and the two saved checks and one
section read survived reloading. A PDF guide's original page and text-region
highlight were also opened. The real custom supplier returned Chinese analysis
with `max` selected, citing rule IDs, `word/document.xml#sectPr[1]` and guide line
locations; the chat retains that selection. Supplier-internal computation is not
measured. The synthetic guide exercises the existing narrow recognizer, not
arbitrary journal-prose interpretation.

Oleafly TypeScript, scoped lint, four affected frontend suites (19 cases), 18 native
research-workspace tests, native Clippy and frontend/native builds passed. Its new
real-service E2E is one complete workflow test and requires an explicitly selected
Workbench Python installation. The Workbench full checks were rerun with the
counts at the top of this document; Windows Phase 0 still fails for the recorded
missing host inputs/profile. The editable install was refreshed at the physical
`/Volumes/Studio/Projects/research-file-workbench` path after the SSD move; no
symlink boundary was relaxed.

The installed local preview is `~/Applications/Oleafly Workbench.app`, using the
existing isolated application data. The retained demonstration is named
`期刊检查 · 完整流程演示`; its project association, original/revised manuscript and
chat remain in that library. Disposable debugging projects, test outputs and
compiler caches are cleaned after verification. Reopening the app restores data;
the user opens the demonstration from the library and selects **期刊检查**.
The companion Oleafly integration guide documents runtime selection and ownership.
The retained [desktop view](../reports/integration-investigation/oleafly-journal-workflow.png)
shows the check panel, demonstration and saved supplier analysis. The final app
omits test hooks and was reopened through Finder; the retained check and Chinese
chat were recovered in its normal interface. Compiler output (about 43 GB), the
old preview bundle, temporary logs and seven disposable Oleafly projects were
removed; that initial slice retained the complete workflow demonstration. The
following increment adds a second project using the retained real manuscript.
Captured DOCX editing and computed layout remain future product work. A complete
journal submission workflow and comprehensive submission acceptance are excluded
by the scope decision above.

The next product increment on the same date connects existing rule correction,
version comparison and check disposition operations to the Oleafly panel. Numeric
edits use mm, pt or column counts and convert to the existing integer units. A
correction creates a version; existing manuscript bindings stay unchanged. Notes
and deferrals attach to the selected current or historical check without changing
its verdict. Comparison includes sources and operator decisions even at equal values.

The existing assistant can now draft declarative candidate rules from retained
guide fragments. The operator pastes the returned JSON into the panel. HTTP
`journal-http-1.4.0` adds `POST /api/world-component`, reusing the component parser,
world analyzer and store. It retains original source bytes, reapplies prior
operator decisions, and saves a new version; it does not switch bindings. A
numeric-leading UUID exposed a real DOCX-update failure in native testing; the
Oleafly caller now prefixes generated request IDs with `request-`.

The expanded packaged native E2E passed through notes, mm and pt edits, same-value
candidate confirmation, new versions, source retention, comparison, explicit binding
and rerun. TypeScript, all frontend lint (3325 files) and five affected frontend
suites (57 cases) passed. One new HTTP scenario verifies component import with
retained sources, earlier decisions and an unchanged binding; malformed input saves
no version. Workbench full checks have the counts at the top of this document.

The retained project **期刊检查 · 真实稿件与 TDSC 对照** uses the existing IJAM
manuscript (11 sections) and two operator-supplied TDSC guide excerpts captured
2026-10-14. This is a cross-journal format comparison, not IJAM acceptance. Actual
checks find four rule-level differences (page dimensions, columns and body type)
and one undetermined spacing rule. An exact section read shows 11907 by 16839
twips, two columns and 9-point body type in section 1. The supplier's
`gpt-6.1-sol`, with `max` selected and saved, returned five cited candidate values;
an initial over-restrictive prompt was corrected and one component unit required a
follow-up correction. The corrected model JSON imported successfully. The resulting
version retains three sources; five provenance changes are visible despite equal
numeric values. Explicit rebinding makes the earlier check historical. A handling
note leaves `cannot_determine` unchanged. The successful review chat is retained;
reported usage for its two turns is 68697 input and 5013 output tokens, with cost
unknown. This run does not independently validate publisher currency or resolve
whether the page-format definition applies to every manuscript section.

Local Workbench builds now have checked-in Vite/Tauri flavor settings, no official
updater endpoints, and an explicit local-build message in the update window.
The final installed app was reopened in its normal Chinese interface without test
hooks; the real project, check history and supplier chat were recovered. The retained
desktop view now shows this project. This increment's compiler output, disposable
test library, scripts and logs were removed, freeing 19.46 GiB; both demonstrations,
the installed app and its selected application library remain available.

The next increment connects **研究期刊要求** to the existing ResearchTask, retains
complete journal context in its task files and automatically loads the cited result.
The operator selects numeric candidates and confirms their applicability; HTTP
`journal-http-1.5.0` previews and adopts captured sources and decisions in one version,
then explicitly binds and checks when selected. Chat offers the existing web tools
directly; page fetching works independently of command-network access, while search
still needs its separate configured service key.

The real-provider automatic flow completed in the separate retained
`var/journal-flow-test` library: task `task-ab8d5a4e24cf6d2440b68b00e6c549c5`,
generation 3, returned four captured sources and five numeric candidates. The native
panel adopted all five with an explicit IJAM/TDSC format-comparison reason. Its new
world retains six sources; check `check-714e2cd6bbe5411386bce843fc5d5cf4` is current
with four differences and one undetermined result, and the prior check is historical.
The task remains `awaiting_review`. A cancelled broad run, interrupted generation and
invalid-JSON output preceded the valid result; their retained task records are not
reported as successful research. JavaScript-only TDSC guidance still leaves the exact
submission condition unresolved. The main installed library retains the earlier real
manuscript comparison; the automatic-run records stay in the selected test library.

Simplified Chinese is now the default for fresh settings and resets. Built-in skills,
research phases, task starter instructions, journal diagnostics and regional language
labels are localized; source text and model results retain their original content.
Saved success notices
translate on a live language switch. Locale state updates before React is notified,
fixing dictionary labels that otherwise lagged by one language. The research button
wraps inside a narrow sidebar in both languages. Chat quick starts and existing
visual spelling labels also refresh on language changes. Chinese validation passed across
24 namespaces with no errors or warnings. TypeScript, scoped lint, 453 affected
frontend cases, 110 settings/provider/transfer cases and native locale tests passed;
41 focused locale/dictionary/settings cases and 38 task-composer cases passed after
the final locale-order and starter fixes.
Another 102 chat/visual-proofreading cases passed after the live-label fixes.
The real-service native E2E passed its full workflow, live-language notice and
Chinese/English button containment checks (13.4 s). Other locales still have missing
new keys; the Chinese/English result is not an all-language completion claim.

The final installed app was launched through the normal macOS application entry and
reopened the retained real-manuscript project. Live English-to-Chinese switching
updated the native menus, skill cards, quick starts, dictionaries and existing visual
spelling labels together. The English research action wrapped within the roughly
250-pixel sidebar. The app is left in Chinese. This increment's compiler cache,
frontend build and 37 temporary log/diagnosis files were removed (37.35 GiB); the
installed app, main library and selected real research/adoption library remain.

## Desktop workbench integration

The desktop now composes journal review, source fragments and retained manuscript capabilities
through `workbench/`. Native lifecycle code lives in `desktop/shell/`; browser transport,
views and styles have one active implementation below `workbench/web/`.

- The bubble map supports world, component and rule navigation. Rule review presents current
  question, source candidates and manuscript observations with exact source-unit drill-down.
- Paragraph, sentence, table-cell and DOCX-node fragments are derived from retained bytes.
  Journal PDF guide sources yield page- and region-bound text blocks and font-derived headings
  (`journal-pdf-source-1.0.0`) and feed the same narrow requirement recognizer as text guidance
  (`journal-world-analyzer-1.4.0`); conditional or unparsed blocks stay explicit gaps.
  Lexical cosine associations rank related expressions and potential component duplicates;
  they do not merge sources or produce probability or compliance conclusions.
- Manuscript object/region queries, continuations, exact saved responses, baseline updates,
  historical checks/bindings/reads and captured page evidence are available in the UI.
- The desktop package includes an isolated Python/application/PDF-inspection runtime. The shell
  owns a dynamically bound loopback service through its lifecycle pipe, without a checkout path
  or attaching to another process on a fixed port.
- Verification is recorded in `reports/desktop/workbench/verification.json`. Independent S1/IJAM
  acceptance, full DOCX layout semantics and broader renderer coverage remain separate requirements.

## Implemented

- A bounded DOCX package reader inventories ZIP parts, content types and relationships; reads text
  regions, basic table grids, image relationships, OMML, fields and declared section properties;
  and registers complex embedded objects with explicit limitations.
- The read-only pipeline creates an application-owned snapshot, writes a structure report and
  actual-read receipt, validates supplied process-verified render records, accepts independent
  page evidence, and compares the author-workspace fingerprint before and after a run.
- `rfw-s1-read` exposes the pipeline as a local operator command. Runs with incomplete evidence
  retain a partial status and return nonzero.
- `rfw-s1-query` provides object discovery, region/type/ID selection, reviewed physical-page
  selection, source-bound pagination, and exact response receipts. Catalog access does not count
  as content read. Inputs and outputs stay within the recorded application and author boundaries.
- Repeated fields within one paragraph have distinct source occurrence numbers. Current reader method
  `s1-readonly-reader-1.4.0` locates each paragraph in its part's source bytes and invalidates
  earlier object IDs and query cursors; page queries refuse
  mappings whose originating structure report uses another reader version.
- The single-DOCX project slice retains immutable source bytes, baselines, source-observation
  EvidenceItems, local operator decisions, management results, tasks and exact read responses.
  It supports idempotent import, concurrent expected-baseline checks, history and dependency-based
  staleness. This is a local operator boundary, not authenticated desktop/MCP management.
- Registered render bundles now retain PDF/PNG bytes, historical process metadata and independent
  annotation inputs with exact baseline/source/PDF/method bindings. Page queries require an
  explicit bundle; unreviewed mappings are refused and ambiguity remains visible.
- The reader has separate immutable models, XML helpers and parsing modules. Package identity,
  missing dependencies, numbering zero, inherited styles, cross-paragraph/simple fields, source
  paragraph ancestry and alternate-content text have explicit regression coverage.
- Page mapping matches declared source constraints and typed object occurrences. Missing or
  contradictory locators do not become reviewed mappings merely because one object has that kind.
- Storage validates the delivered items, read ranges, unread coverage, pagination and cursor
  against retained source bytes before committing a task and response. Render bundle applicability
  includes its exact baseline binding; ordinary unchanged source observations remain reusable.
- Workspace fingerprint 2.0.0 adds observable protection attributes without changing frozen
  content identity hashes. Old content-only fingerprints remain historical, not current protection proof.
- Phase 0 includes 21 fixed v1.2 handoff acceptance-specification cases. These validate planned
  inputs and expected results; they do not implement the corresponding S1 runtime features.
- The journal-world slice now provides a local versioned source analyzer, SQLite library, explicit
  DOCX project binding, page-geometry checking, rule correction history, dispositions and a static
  browser workbench. It is an implemented local slice, not full S2A rule processing: PDF guide
  semantics, complete paragraph/run formatting, remote authentication and full journal acceptance
  remain outside its declared scope.
- The journal HTTP, browser and service now share one upload contract: display name, original DOCX
  filename and captured bytes. Static browser files are included in the wheel and captured at server
  startup; a served asset identity does not silently change when local source files are edited.
- New checks retain one world reference, not a second embedded authority or mutable validity cache.
  Known violations remain visible alongside missing section observations. Historical checks retain
  their original basis/verdict and become stale after relevant method, source or binding changes.
- Baseline reads cross-check SQL identity, payload, artifact hash and retained bytes. Dependent
  journal commits hold the source baseline stable. Query method `s1-read-query-1.7.0` rejects duplicate
  cursor keys and separates the coverage axis (`status`: `partial` on a content response while the
  reader declares limits, `catalog_only` on a catalog response) from the continuation axis
  (`selection_delivery`, which its exit codes follow and which reports only whether another page
  exists). Saved historical responses remain unchanged.

The supported structures and deliberate limits are described in `s1-readonly-reader-slice.md`.
Passing focused reader tests does not establish the full S1 capability contract.

## Saved execution evidence

- `reports/phase0/contract-validation.json` records passing Phase 0 contract and completion checks
  on 2026-09-24. The 86-test result in `phase0/completion-report.md` is the historical repair run.
- `reports/phase0/live-wps-smoke.json` binds a successful process-verified export to WPS Writer
  `12.1.0.28505`, source SHA-256 `778b76e7abcd01fbd68fa3e09a75bf07a726c6febeb18f758131e2c562027c2d`,
  and live PDF SHA-256 `06c84a02865a53615a481deae42e8973ef3d208babf2a18560946f7b7b62f1d5`.
  This document update did not run WPS again.
- The historical `reports/phase0/s1-ijam-stage-status.json` records its IJAM run as `partial`: structural
  reading is `completed_with_limitations`, page mapping is `pending_independent_review`, and
  page evidence is `indexed_unverified`. It records ten pages and an unchanged author workspace.
- `annotations/s1/ijam-english-working/review-notes.md` retains the initial whole-document visual
  review and page-raster provenance check, then the later 80-object Agent review and macOS render
  chain. Those later records establish retained mappings, not independent human S1 acceptance.

The live PDF and frozen Phase 0 PDF have different hashes. Their roles and the recorded raster
comparison are explained in the IJAM review notes; neither file replaces the other implicitly.

## Query slice verification on 2026-09-25

- Full regression: **205 tests passed**, including 88 tests added since the inspected 117-test
  baseline. Ruff formatting passed for 74 files; Ruff lint and mypy passed (34 source files).
  Phase 0 validation returned `CONTRACT_VALID` and `PHASE0_COMPLETE`.
- Existing IJAM snapshot: 606 indexed objects, including 490 body text blocks. Two successive
  response pages returned five objects each with no overlap and matching receipt ranges.
- The source hash and author-workspace fingerprint were unchanged during the checked catalog,
  continuation and refusal operations. The smoke report states that exact scope.
- IJAM physical-page selection was refused because independent mapping is absent; no rejected
  response directory was published. WPS was not launched again.
- Independent code review led to regression checks for stale mapping methods, mismatched source
  evidence, incorrect author-root declarations, and storage failure before response publication.

Commands and limits: [on-demand reading](s1-on-demand-reading.md). Evidence:
[`reports/s1/on-demand-smoke.json`](../reports/s1/on-demand-smoke.json) and
[`reports/s1/query-verification.json`](../reports/s1/query-verification.json).

## Acceptance still required

- An independent human reviewer must verify the IJAM object observations and page mappings
  against their exact source snapshot and PDF. The tracked `document-annotation.json` and
  `page-evidence.json` now contain 80 objects and 80 mappings, marked reviewed by
  `agent-review-cli-20261031`. These Agent-assisted records are not independent human S1
  acceptance; their retained Windows PDF binding is not silently replaced by the Mac binding.
- The OOXML snapshot and object-level page evidence must be reviewed together. A page image index
  or a visually plausible PDF cannot supply the missing independent expected results.
- The reader must be evaluated against the required S1 capabilities and frozen fixture
  annotations, with unsupported behavior and incomplete evidence kept visible.
- This query slice passed the checks above; full S1 acceptance and a release decision still need
  the remaining capabilities and independent evidence. Local working-tree completion is not a
  release tag or a claim that 0.1 is complete.

## First real journal check (2026-11-01)

The first end-to-end check against real journal requirements ran on this host: the TDSC
author-information requirements (hash-receipted evidence capture from 2026-10-14) were
supplied as operator-curated `guide_text` sources, analyzer 1.4.0 recognized the
page-format definition sentence including its qualifiers (columns 2, page 11340x15480
twips, body type 19 half-points = 9.5pt, line spacing 230 twips = 11.5pt — all confirmed),
and the bound IJAM manuscript checked with real verdicts under reader 1.4.0 and checker
1.1.0: A4 page-size violations, per-section column findings across the eleven declared
sections, and a body-type violation (the manuscript declares 9pt where TDSC requires
9.5pt). Line spacing stays cannot_determine because the manuscript declares none, and
unparseable requirements (page limits) stayed explicit coverage gaps. The section-scope
question for column rules (title areas versus body columns) is recorded as S2A rule-scope
work.

## Platform decision (2026-10-31)

Development, verification and acceptance continue on macOS; the original Windows workstation
is retired. The Windows-only evidence — the pinned `wps-writer-12.1.0.28505` process-verified
live render, the phase 0 environment inventory and the Windows desktop packaging — remains
retained historical evidence and is never rewritten. The later review notes record a completed
macOS WPS 7.2.1 (8947) process-verified export, render-bundle registration and page-6 reading
chain on 2026-11-01. The 2026-11-02 investigation verified the retained PDF and all ten PNG
hashes and inspected the current library's saved bundle/read records; it did not rerun WPS.
Those records remain partial and Agent-reviewed, not independent human acceptance. See
[the workbench evidence review](../reports/integration-investigation/workbench-source-review.md).
The Mac chain does not clear the separate frozen Windows Phase 0 failures. Broader renderer
portability and a supported macOS delivery/verification path remain separate platform work.

## Not implemented or not established

- The three local surfaces — the browser workbench, the operator CLI (`rfw-workbench`,
  `rfw-project`), and the local MCP entry (`rfw-workbench-mcp`, `workbench-mcp-0.4.1`) — project
  the same `WorkbenchService` operations: MCP and CLI agents can import worlds and manuscripts,
  update a manuscript as a new retained baseline, review, revise, bind, run checks, record
  dispositions, read with receipts, and preview retained PDF pages. Retained refusals (baseline
  compare-and-swap, idempotency reuse, unreadable input) surface as typed reasons on every
  surface, and bindings, checks and dispositions record which local surface drove them, per
  `s1-project-storage-1.3.0`. Two capabilities stay operator-only on purpose: author decisions
  refuse agent proposals by design, and render-bundle registration records independent human
  evidence through the CLI or browser. The MCP layer holds no business rule; its declared
  boundary, versions and limits are in `contracts/s1/mcp-surface.json`. The local MCP write
  scope follows the 方案文档 v1.3 amendment (trusted local single-operator entry sharing the
  process token). Authenticated MCP (remote or multi-user callers), task-material directories,
  handoff bookmarks and cache governance remain S1 work. Multiple independently authored source
  documents per project are not implemented; derived render artifacts for one DOCX source are
  retained.
- Explicit author decisions are recorded rather than inferred. `rfw-project decide`, `decision` and
  `decisions` store one only on a trusted user confirmation, keep an update as a new version naming
  the version it replaces, and refuse an agent proposal, an undeclared kind and a blank required
  field. The storage rules live in `projects/author_decision_records.py`. Section 3.3.1's `DOCUMENT`
  and `PROJECT` scopes are open; `LOCAL`, `SECTION` and `PROFILE` are refused with the stage that
  opens them instead of being stored without the artifact-version and locator binding they need.
  Project storage is now version 2 and upgrades a version-1 database in place, so the rows it
  already holds keep their original bytes. Binding a decision into a baseline's
  `author_decision_version_ids` (section 4.11) is not implemented: the frozen request digest still
  carries an empty list, and widening it would change the digest of an already recorded request, so
  it needs its own versioned change.
- Automatic inference of verified page coordinates, complete computed style semantics, and
  semantic interpretation of complex embedded objects are not current reader capabilities.
- Manuscript editing, S2A journal template and rule-pack processing, and S2B proposal preflight
  with approved DOCX text replacement remain later-stage work.
- Microsoft Word compatibility and general renderer portability are not established by the
  retained Windows and Mac WPS chains. The frozen Windows environment uses a pinned executable;
  its missing Baskerville font and English-baseline substitution limitation remain historical
  constraints, not a fresh diagnosis of every Mac rendering.
- Scientific correctness of manuscript claims, formulas and embedded chart data is not established
  by hashes, structural extraction or render evidence.

## Persistent project verification on 2026-09-25

- Pre-change checkpoint: `622c52d`, with 205 tests and all required checks passing.
- Completed storage slice: 257 tests passed, including 50 project tests; Ruff formatting (84 files),
  lint, mypy (40 source files) and Phase 0 validation passed.
- A ten-process lifecycle smoke retained two baselines, recovered the exact original response,
  marked 606 old observations STALE without changing NOT_REVIEWED, replayed the original import
  after test-source deletion, and read the old retained version. SQLite integrity checked `ok`.
- Deterministic tests cover concurrent submissions, transaction abort/rollback, malformed or
  tampered sources, durable refusals, wrong baseline receipt bindings, hard links and reparse paths.

See [project storage](s1-project-storage.md),
[`project-lifecycle-smoke.json`](../reports/s1/project-lifecycle-smoke.json) and
[`project-storage-verification.json`](../reports/s1/project-storage-verification.json).

## Persistent page-evidence verification on 2026-09-25

- Full regression: 337 tests passed, adding 80 page-evidence cases. Formatting (89 files), Ruff,
  mypy (42 source files), and Phase 0 validation passed.
- An existing schema-1 project retained an IJAM render bundle with ten pages; schema and current
  baseline were unchanged. PDF/PNG bytes remained accessible after input-copy cleanup and reopen.
- Unreviewed IJAM mappings remain pending and page selection correctly refuses. Reviewed fixture
  page queries retain partial coverage and exact bundle dependencies; no new WPS run was performed.
- Fault tests cover transaction rollback, concurrent duplicate registration, corrupt PNGs/blobs,
  wrong source/PDF/profile/baseline, stale methods and cursors, and incomplete review metadata.

See [page evidence](s1-page-evidence.md),
[`render-persistence-smoke.json`](../reports/s1/render-persistence-smoke.json) and
[`render-verification.json`](../reports/s1/render-verification.json).

# S1 implementation and acceptance status

Status date: 2026-11-13

This document records the Workbench-domain slice only. Current cross-system entry points are
the [Oleafly integration guide](../../../docs/research-workbench-integration.md),
[Agent status](../../../docs/agent/status.md) and
[Agent architecture](../../../docs/agent/architecture.md). This file does not define
system-wide Agent status or task-group behavior.

The service now lives in Oleafly at `services/research-workbench/`. Its current
source snapshot includes the former checkout's uncommitted work; the original
history and private evidence are retained locally. Oleafly is the active application
shell. The old root retains only existing `var/` data and a migration pointer; data
paths and manuscript records were not rewritten. Use `pnpm workbench:setup` from
the Oleafly root and this service's `.venv` for development.

On 2026-11-12 the local `.venv` was rebuilt from Homebrew Python 3.12. The normal
`pnpm workbench:setup` entry and `uv pip check` passed; 167 focused reader, render,
validation, server and workspace tests passed with one existing skip and the existing
PyMuPDF/SWIG warnings. This environment check did not rerun Office or alter author inputs.

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

The 2026-11-13 fixed-save recovery increment preserves a manuscript update's exact
persisted refusal result across the HTTP boundary. Baseline conflicts remain HTTP 409;
rejected input and idempotency conflicts remain HTTP 400, with the existing error text
and recorded request identity, digest, status and null result baseline. An idempotency
conflict can reference another request's successful baseline, which is not a saved
result for the submitted bytes. Ordinary read/binding conflicts keep their existing
sanitized errors. The recovery increment used `journal-http-1.8.0`, synchronized
with the browser and native application connection check. Application checkpoint
and task-attribution behavior is owned by the linked Agent status and architecture.

For this change, Ruff format (212 Python files), Ruff lint, mypy (118 source files)
and the full Python suite passed (1050 passed, 33 existing platform skips, five
PyMuPDF/SWIG warnings). Real HTTP regressions exercise all three persisted refusals
and replay against the retained ledger. Phase 0 still exits 1 with
`CONTRACT_INVALID` / `PHASE0_INCOMPLETE` for the missing registered source identities
and pinned Windows WPS environment; those historical requirements and evidence were
not rewritten. This does not block the separately scoped macOS DOCX workflow.

The 2026-11-13 exact-font correction retains body-font family requirements through the
existing guide/component, evidence, decision and immutable world flow. Exact English/Chinese
body-font instructions can be recognized deterministically. Model research still returns
candidates for applicability review. Manuscript font declarations alone do not establish
journal requirements. The machine-readable contract above owns the current method and
transport versions. New checks require reanalysis under the current analyzer; retained older
worlds/checks remain readable without re-executing an older method. Font rules return
`not_checked`: the geometry checker neither audits declared run fonts nor certifies downloaded
fonts or rendered glyphs. Exact font acquisition and live editor refresh belong to the
[application status](../../../docs/agent/status.md#docx-准确字体获取2026-11-13), not this service.

Document structure and journal rules have different coverage. The current
[reader](../src/research_file_workbench/docx/reader.py) extracts package parts and
relationships, text, tables, images, OMML and fields, sections, references, styles and
numbering. Its [report](../src/research_file_workbench/docx/report.py) explicitly remains
partial. Style observations follow `basedOn` for a few properties; they do not compute
every paragraph/run's effective format through document defaults, theme, table,
paragraph and character styles and direct formatting. Section body-size/spacing
observations are dominant explicit declarations, not a resolved body-role model.
The [journal property vocabulary](../src/research_file_workbench/journals/models.py)
and [checker](../src/research_file_workbench/journals/checker.py) own the supported
comparisons; retaining XML and editing with the full document engine does not expand
those checks. Template observations remain candidates rather than mandatory rules.
The next format-analysis increment should reuse the installed engine's public style
cascade for a retained source version, preserve the applicable paragraph/run and
property provenance, and distinguish role-specific requirements from template examples.
That derived-format/checker connection is not implemented by the font/frame correction.

The current private-font render gates passed Ruff format (213 Python files), Ruff lint,
mypy (118 source files), and the full suite (1084 passed, 33 existing platform skips, five
PyMuPDF/SWIG warnings). `node --check` passed for `app.js`, and all 18 contract JSON files parsed.
Regressions cover exact family/source retention, multi-font and
script-scoped guidance remaining gaps, real family names containing Latin/English/CJK,
component decisions, unchecked font verdicts, CLI/browser string values, launcher path-list
delivery, private profile font staging, persisted render metadata and receipt symlink refusal.
Phase 0 still exits 1 with `CONTRACT_INVALID` / `PHASE0_INCOMPLETE` for the previously recorded
missing source identities and pinned Windows WPS environment; it does not provide new macOS
rendering evidence.

Scope decision (2026-11-07): the operator excludes a complete journal submission
workflow and comprehensive submission acceptance from the product scope. They are
not pending deliverables. Journal-requirement research, source review, versioned
rules and supported manuscript checks remain in scope.

The 2026-11-11 DOCX working-copy increment exposes exact retained source bytes for an explicit
baseline through `GET /api/manuscript-source`. It verifies the source hash, returns a display
filename and bytes, and neither reads an author path nor records a structured read receipt.
The Oleafly frontend now edits and paginates that managed copy, streams one paragraph proposal,
exports actual DOCX bytes and reuses the existing baseline/check services. The frontend invokes the
renderer after a saved baseline is available through the native bridge, and the service records the
resulting PDF as a derived render. The service does not own the live editing session. Current contracts remain in
[`world-contract.json`](../contracts/journals/world-contract.json).

The same date adds the backend foundation for post-save rendering. `POST /api/render-baseline`
requires an exact retained baseline, an absolute LibreOffice executable and an explicit reason.
The service selects its own profile parent below the Workbench library's `var/libreoffice-profile`
and creates a private temporary profile for each conversion; HTTP callers cannot select a profile
path. The native application supplies its download and exact-resolved font-cache roots through
`OLEAFLY_FONT_DIRS`; HTTP and MCP callers do not choose font directories. Each render stages
current TTF/OTF bytes into that private profile's `user/fonts` directory, deduplicates identical
bytes by SHA-256, verifies available source receipts and refuses reparse-point roots, files and
receipts. It identifies the executable as LibreOffice, reads only the baseline artifact into a
disposable project-local directory, runs headless PDF conversion, and checks the output page count
before committing the PDF and render record through the existing project transaction. The manifest
records the LibreOffice version, executable hash/path, private profile path, source/PDF identities
and render times as `derived_render` evidence under the method in the
[render contract](../contracts/s1/render-bundle.json). Its `supplied_fonts` records the cache bytes copied by hash;
`pdf_font_names` records names actually observed in the PDF. They are separate observations and
do not establish that the PDF embedded the same complete bytes or version used by the live editor.
The derived-render response also identifies the current font-cache content set, while each render
retains the identity of the bytes actually supplied to it. Comparing those identities after a
service restart prevents a PDF rendered against an older cache from being presented as current.
Older records without that identity remain readable and are not treated as current-cache matches.
The current method also invalidates earlier records that predate native system-font staging.
The application retains exact resolved system faces and waits for font resolution before
requesting a saved PDF. This gives the isolated renderer the same supplied Latin font bytes;
PDF font names and embedded subset versions remain separate observations.
`GET /api/derived-renders` lists those records for an explicit project baseline without mixing
them into historical page bundles. The renderer deliberately keeps page images and page mapping
absent and does not add the PDF to the interactive historical page-bundle list. A missing or
non-LibreOffice capability returns `renderer_unavailable`; no WPS or other renderer is tried. The
saved-version panel supplies the explicit renderer path and invokes this route automatically after
a saved baseline. Focused fake-runner coverage verifies retained-source conversion, private font
staging, PDF font-name persistence, PDF registration, listing, capability failure, unreadable
output and HTTP routing. The derived bundle contract is
[`s1-render-bundle-1.2.0`](../contracts/s1/render-bundle.json); only the pre-existing page-bundle
`1.1.0` remains readable as historical evidence. The cache identity is a response fact and adds no
HTTP request path fields; the current HTTP contract is `journal-http-1.10.0`.

The earlier Chinese macOS native run `run-XJihrW` passed extraction of four exact families
from two official Microsoft packages, same-session font use, unchanged-DOCX saving and PDF
generation using SimSun 5.04i and SimHei 5.03i. Earlier isolated E2E-packaged macOS runs `run-ilC23E` (Chinese)
and `run-oknADL` (English) passed the cache-identity and actual-edit/save increment:
normal reopen reused a completed compatible render without another conversion, then one supported
Agent-host text edit was saved through the UI to a new baseline and regenerated as a PDF matching
that saved source hash. The PDFs had 26/10 pages and actual SimSun 5.04i subsets; the Chinese
PDF also used SimHei 5.03i. Both saved DOCX packages preserved parts, media, relationship semantics and
protected nodes, with one intended text change and unchanged author hashes. The runner restored
E2E WebKit storage and stopped its app/Workbench processes. Evidence remains local and ignored
under `.private/docx-font-layout/` at the repository root. These deterministic edits do not validate
model quality. Microsoft archives were reused from verified complete cache, while PT Serif was
downloaded over the network. These runs predate exact system-font staging and the editor's
multi-column frame correction. Current native results and the remaining LibreOffice
title-frame and formula-font limits are owned by the linked application status.
KaiTi and DengXian were supplied but were not observed as fonts actually used by these PDFs.
Cross-engine visual equivalence remains unverified.

Current observation IDs still bind the exact source hash, reader method and locator. A synthetic
ZIP-comment-only update retained all package parts and text while changing all 32 catalog IDs;
the existing baseline transaction retained both versions, rejected a stale expected baseline,
and recovered the old read exactly. These are snapshot evidence identities, not live editor
anchors. Four focused baseline/conflict/staleness/replay regressions passed. The cross-system
[current verified slice](../../../docs/agent/status.md#docx-工作副本首个闭环2026-11-11),
[session contract](../../../docs/agent/architecture.md#docx-实时工作表面)
and [component choices](../../../docs/agent/reuse.md#docx-编辑与实时工作机制) own the cross-system integration;
baseline semantics remain unchanged, while the reader method version below records the added VML observation.

The migrated real English and Chinese manuscripts were then run through the production React
editor and the real Workbench browser harness after the large-document session readiness fix.
Both first reads returned an active session without a user-edit workaround; no-change exports
preserved all package parts, media, relationship semantics and protected nodes, while each
edited export changed only its intended paragraph. Mixed-format, field, OMML and image
paragraph replacements were refused with `unsupported-target` and no revision change.
This verifies the controlled structure round trip, not Word/WPS visual fidelity: the two
documents at that stage reported substitute-font/fixed-measurer warnings, and the independent LibreOffice
render of the English manuscript has a first-page two-column title difference.

The reader now reports selected VML `w:pict/v:imagedata` as an explicit `vml_picture` unsupported
record under `s1-readonly-reader-1.5.0`, retaining its relationship and resource locator;
VML geometry and page placement remain outside the reader's interpretation.

The source-byte increment passed the 58 focused workspace/server/architecture tests with one
existing macOS loopback-alias skip and five PyMuPDF/SWIG warnings. Scoped Python format/lint and
mypy across 118 source files passed. The actual browser workflow also used the real Python
baseline/bind/check endpoints and reopened the saved version. Its Tauri transport and token
provider were scripted; native-app and real-model DOCX editing remain unverified. Current
cross-system results and local-only evidence are recorded in the linked Agent status.

Scope decision (2026-11-11): new DOCX UI keys are maintained in Chinese and English only.
Complete coverage and validation for other application languages are outside this round's
product scope and are not pending Workbench deliverables. Chinese and English catalog checks
passed for the affected frontend. The verified DOCX browser flow ran on macOS. This round does
not perform native Windows validation, so that validation is outside its scope rather than a
pending check; the native app and real-model DOCX editing remain unverified.

S1 is unreleased and partial: manuscript analysis is read-only, while project and journal
management expose local writes. Before consolidation, the complete Workbench gate run on 2026-11-07
passed Ruff format (248 Python files), Ruff lint, mypy (118 source files), and
pytest (1034 passed, 33 skipped, five PyMuPDF/SWIG warnings). The preceding test cleanup's
Oleafly frontend checks passed 184 cases; full frontend lint and TypeScript checks passed. Its
verification log consolidates the eight command results and is retained as local historical
evidence under `.private/workspace-consolidation-20261109/workbench-original-source/reports/`.
Four mechanical scans were removed, MCP discovery checks were merged, and parameterized
read/recovery cases retain caller metadata and server-restart coverage. Daily updates revise
this status in place rather than add per-turn reports.

Phase 0 remains `CONTRACT_INVALID` / `PHASE0_INCOMPLETE` on this Mac: nine registered author
inputs and the pinned Windows WPS profile are unavailable. Current validation resolves
retained Windows paths through matching fixture/report-relative identities, checks retained
hashes and complete render output, and rejects another fixture's source. Earlier `Render
record points to another source` output was a cross-platform path-comparison false positive.
Historical source identities, render bytes and acceptance results were not rewritten.

The current [desktop workbench](desktop/workbench.md) has local execution evidence retained
under `.private/workspace-consolidation-20261109/workbench-original-source/reports/`. The
historical MCP boundary experiment verified 11 read-only tools, write/typo refusals and
persisted recovery; the 2026-11-05 source-app task then verified real-provider native
execution, caller correlation and exact structured-response recovery, ending in
`awaiting_review`. Those private reports remain historical evidence and are not available in
the public clean checkout. The current machine-readable MCP surface is
[`contracts/s1/mcp-surface.json`](../contracts/s1/mcp-surface.json); current source and the
[Agent status](../../../docs/agent/status.md) govern present behavior. Full product and
independent S1/IJAM acceptance remain pending.

Earlier execution counts remain in their original local evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/`. They are
historical evidence, not files linked from this clean checkout.

## Oleafly integration history (2026-11-05, frozen)

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

The native ResearchTask experiment of 2026-11-04 read a hand-authored synthetic DOCX with
`read_objects`, recovered the same response with `saved_read`, and produced a report citing
all delivered objects, source hash, baseline and receipt. Its calculations and original-file
preservation passed the recorded checks. It finished in `awaiting_review`, not applied or
completed. The model was the supplier's `gpt-6.1-sol`; a temporary real-response forwarder
sent `reasoning_effort=max` on all 14 requests because native custom-provider requests
contained no effort. The forwarder is stopped and the supplier is restored to direct
configuration. Reported usage was 259734 input and 8322 output tokens; cost is unknown. The
full experiment record remains local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/`.

The original release-app ResearchTask advertised all 18 MCP tools, unlike CLI Agent's
11-tool filter. The MCP contract is now `workbench-mcp-0.4.1`: `--read-only` registers only the 11
reading/discovery tools, and both modes reject unknown top-level argument names.
The default operator surface retains its 18 tools. Read receipts still persist;
library-wide read scope is not project/task authorization. The isolated preview's
configured MCP launcher passes `--read-only`.

The 2026-11-05 source-app task, `task-005dd6cfb25a3b2d4101911087c6a6ab`, generation `1`, ran
directly against the real supplier with `gpt-6.1-sol`. With task commands off, it called `method_versions`,
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

The [fused product and system architecture](fused-research-agent-architecture.md) is a frozen
2026-11-05 historical design input. It consolidated the two external design inputs, source
investigation and review decisions, but it is not a current runtime contract or evidence that
integration has shipped. The
[three-project investigation](oleafly-superagent-research-workbench-investigation.md) and its
three source reviews remain frozen fixed-revision research evidence. Current Agent status and
architecture are in `../../../docs/agent/status.md` and
`../../../docs/agent/architecture.md`. Task/project-scoped MCP access and
human-confirmation attribution still require enforcement before autonomous use; the existing
trusted local-operator boundary is not that contract.

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
The retained desktop view is stored as local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/`;
it shows the check panel, demonstration and saved supplier analysis. The final app omits test
hooks and was reopened through Finder; the retained check and Chinese chat were recovered in
its normal interface. Compiler output (about 43 GB), the
old preview bundle, temporary logs and seven disposable Oleafly projects were
removed; that initial slice retained the complete workflow demonstration. The
following increment adds a second project using the retained real manuscript.
At that historical stage captured DOCX editing and computed layout remained future product work;
the current increment is described at the top of this document. A complete
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

## Historical desktop package integration (2026-11-05, frozen)

The standalone desktop package composed journal review, source fragments and retained manuscript
capabilities through `workbench/`. Its native lifecycle code lived in `desktop/shell/`; that
shell is frozen history. Oleafly is now the active application shell and owns the native window,
Agent runtime and service lifecycle. Browser transport, views and styles still have one active
implementation below `workbench/web/`.

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
- The historical desktop package included an isolated Python/application/PDF-inspection runtime.
  Its shell owned a dynamically bound loopback service through its lifecycle pipe, without a
  checkout path or attaching to another process on a fixed port.
- Verification is retained as local historical evidence under
  `.private/workspace-consolidation-20261109/workbench-original-source/reports/desktop/workbench/`.
  Independent S1/IJAM acceptance, full DOCX layout semantics and broader renderer coverage remain
  separate requirements.

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
  `s1-readonly-reader-1.5.0` locates each paragraph in its part's source bytes and invalidates
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

Commands and limits: [on-demand reading](s1-on-demand-reading.md). The 2026-09-25 execution
evidence (`on-demand-smoke.json` and `query-verification.json`) is retained as local historical
evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/s1/`, outside the
public clean checkout.

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
Those records remain partial and Agent-reviewed, not independent human acceptance. The
workbench evidence review is retained as local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/integration-investigation/`.
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
  `s1-project-storage-1.4.0`. Two capabilities stay operator-only on purpose: author decisions
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

See [project storage](s1-project-storage.md). The lifecycle smoke and storage verification
records are retained as local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/s1/`, outside the
public clean checkout.

## Persistent page-evidence verification on 2026-09-25

- Full regression: 337 tests passed, adding 80 page-evidence cases. Formatting (89 files), Ruff,
  mypy (42 source files), and Phase 0 validation passed.
- An existing schema-1 project retained an IJAM render bundle with ten pages; schema and current
  baseline were unchanged. PDF/PNG bytes remained accessible after input-copy cleanup and reopen.
- Unreviewed IJAM mappings remain pending and page selection correctly refuses. Reviewed fixture
  page queries retain partial coverage and exact bundle dependencies; no new WPS run was performed.
- Fault tests cover transaction rollback, concurrent duplicate registration, corrupt PNGs/blobs,
  wrong source/PDF/profile/baseline, stale methods and cursors, and incomplete review metadata.

See [page evidence](s1-page-evidence.md). The render persistence and verification records are
retained as local historical evidence under
`.private/workspace-consolidation-20261109/workbench-original-source/reports/s1/`, outside the
public clean checkout.

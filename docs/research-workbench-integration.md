# Private research workbench integration

Decision date: 2026-11-02. Current verification: 2026-11-08.

## Direction and current state

Use Oleafly as the primary application foundation for a private research
workbench. Adapt the useful ideas and verified domain capabilities from the
adjacent `research-file-workbench` repository rather than transplanting its
entire application or recreating Oleafly's editor and agent infrastructure.

The operator confirmed private local use. AGPL/GPL components are acceptable
for this scope. Preserve upstream licence and attribution files. Publishing
or operating a service for others is not part of this task.

On 2026-11-07, the operator excluded a complete journal submission workflow and
comprehensive submission acceptance from the product scope. Journal-requirement
research, source review, versioned rules and supported manuscript checks remain
in scope; complete submission is not a pending deliverable.

Current checkout:

- Upstream: `https://github.com/Oleafly/Oleafly.git`, remote `upstream`.
- Inspected revision: `1b6521943ea567a4e5df02c99a588b4e49737623`.
- Local development branch: `codex/research-workbench`.
- Git history is retained; the clone is non-shallow with lazy historical blobs.
- The official Apple Silicon 0.4.9 release was launched on 2026-11-02 in an
  isolated preview library; its Chinese welcome screen was visually verified.
  The release archive SHA-256 matched GitHub's asset digest, and the extracted
  application passed `codesign --verify --deep --strict`.
- The preview application is at
  `~/Library/Caches/research-file-workbench/oleafly-preview/0.4.9/Oleafly.app`;
  its adjacent `library/` is selected through `OLEAFLY_DATA_DIR`. It is the
  upstream release, not a build of this branch or an integrated workbench.
- The branch builds with pinned Rust 1.98.1 and the frozen pnpm lockfile. An
  isolated source application, bundle ID `com.oleafly.workbench.preview`, runs
  against its own `OLEAFLY_DATA_DIR`. The 2026-11-07 local app also embeds its
  frontend and runs without the Vite server.
  A real-provider native task has called Workbench MCP 0.4.1's three read methods;
  its persisted receipt matches the actual Oleafly project/task/generation.
  The original synthetic source bytes remain separate from the staged task files.
  See the adjacent Workbench repository's
  `reports/integration-investigation/oleafly-native-research-task-2026-11-05.md`.
  No existing user library was migrated.

This document separates the integration direction from the verified product slice.
The original workbench remains intact as the source of its current code,
contracts, tests and historical evidence. Its root requirements document
describes planned capabilities; `docs/s1-progress.md` distinguishes current
implementation from pending acceptance.

## Reuse instead of duplication

| Area | Initial owner and integration choice |
| --- | --- |
| Editor, compile, preview and document navigation | Keep Oleafly's existing engines and UI. |
| Agents, task scheduling, task isolation and reviewed file application | Keep Oleafly's existing owners; do not add a second task queue or approval system. |
| Projects and compile history | Keep Oleafly's project identity and history; explicitly associate retained workbench manuscript baselines instead of pretending both stores represent the same object. |
| DOCX observations and read receipts | Reuse the bounded workbench reader and its declared limitations. A converted document is a derived artifact, not a verified representation of every original DOCX object. |
| Journal sources and rules | Reuse retained source bytes, world versions, explicit bindings and rule-source locations. Generic publication profiles do not replace journal-specific requirements. |
| Check results and review | Preserve rule basis, verdict, validity and operator disposition as distinct fields. Presentation must not create a second authoritative copy of checks. |
| Changes to source or rules | Use recorded dependencies to mark affected results stale; do not rewrite old records or silently rebind a manuscript. |

Port proven behavior, not every existing abstraction. Do not translate all
Python code into Rust or merge databases before a concrete workflow requires it.
Do not carry generic framework scaffolding into Oleafly merely because it exists
in the earlier project. Follow Oleafly's existing package ownership and ports.

## Journal Checks product slice (2026-11-07)

The review rail now includes **Journal checks** (Chinese: **期刊检查**). It imports
captured DOCX manuscripts and journal text/DOCX/PDF/template/rule-component sources,
binds a retained rule version, runs the existing checker and opens exact guide
quotes, source fragments and retained manuscript section reads. PDF fragments open
their retained page with the source region highlighted. Updating a DOCX keeps the
old check visible as stale and requires explicit rebinding before another check.
History and the project association survive reopening the app. The existing
assistant receives the selected check and linked source fragments as an editable
draft; the user sends it through their existing provider configuration.

Ownership remains small and explicit:

- `src-tauri/src/journal_workbench.rs` starts the existing Python HTTP launcher,
  holds its session token and stops its child with the application. This is an
  operator UI connection, not an agent management-tool registration.
- Oleafly's existing research-workspace metadata stores `journalProjectId` and
  `journalResearch` (task, selected world and optional check IDs). Python stores
  captured bytes, worlds, bindings, checks, reads and history.
- `JournalChecksPanel.tsx` projects those records; `journal-workbench.ts` supplies
  typed request shapes and the existing assistant handoff. No new dependency,
  database, checker, parser, scheduler or model-routing layer was added.

Choose the Python executable from an installed Workbench environment on first
connection, or set `OLEAFLY_WORKBENCH_PYTHON`. A successful connection stores it at
`<OLEAFLY_DATA_DIR>/workbench-python.json`; the managed library is
`<OLEAFLY_DATA_DIR>/journal-library`. If the checkout was moved behind a symlink,
reinstall the editable Python package using its canonical physical path: the
Workbench path boundary deliberately rejects a symlinked source root.

The local preview is installed at `~/Applications/Oleafly Workbench.app`. Its
bundle environment selects the existing isolated preview data directory. It embeds
the frontend, uses the saved Python runtime and can be opened from Finder without
starting Vite. The final local debug preview omits the native E2E feature and
frontend test hooks; the packaged verification used the corresponding test build.
This is not a published release or a bundled Python distribution.

The real native end-to-end test (`e2e/tests/116-journal-checks.spec.ts`) passed
against both the development app and the packaged app. A synthetic Letter,
single-column manuscript had three violations; its revised A4, two-column version
passed all seven supplied rules. The original check became stale; two checks and
one exact section read remained recoverable after reloading. A separate real PDF
guide import displayed its original page and matching highlighted text block.
The existing custom supplier returned analysis in Chinese with `max` selected in
the composer; it cited rules, manuscript section and guide locations. The saved
chat records the selected effort; this does not attest the supplier's internal
reasoning computation. The smaller handoff payload avoids sending the joined
world and storage metadata twice.

Scoped verification passed: TypeScript, frontend lint, 19 tests across four
affected frontend suites, 18 research-workspace native tests, native Clippy and
frontend/native builds. The companion Workbench gates passed Ruff, mypy and
1033 pytest cases (33 skipped); the historical Windows Phase 0 requirements remain
unavailable on this Mac. The new E2E requires `OLEAFLY_WORKBENCH_PYTHON` and skips
when that optional external installation is not selected.

This slice checks the reader's supported declared DOCX section settings. It does
not edit the captured DOCX, compute rendered layout, interpret arbitrary journal
prose or establish full journal acceptance. The existing bounded guide recognizer
still reports unrecognized/conditional context and absent requirements as coverage
gaps. The panel displays font-size and line-spacing units as points where the
existing analyzer establishes those properties.

The same-date product increment adds rule confirmation/correction in mm, pt or
column counts, source-aware version comparison, and handling notes/deferrals on
current or historical checks. These call the existing Python operations. The
original verdict stays separate from handling; edits save a new rule version and
never move a manuscript binding automatically. DOCX updates now prefix request
UUIDs with `request-`, fixing numeric-leading UUID refusals found in native E2E.

**Research journal requirements** starts the existing ResearchTask runtime with
the configured provider/model/effort and the operator's research focus. Workspace
metadata records its task, selected world and optional check IDs. At task start,
the native bridge obtains their complete retained content from Workbench and writes
`journal-context.json` inside the task record directory. The short prompt identifies
that file instead of duplicating a whole guide and check in the task's 32,000-character
prompt field. The task returns one `journal-review.json`, containing a readable report,
cited component, captured source paths, questions and manuscript actions. The panel
uses the existing task-file preview to load completed output and the existing Python
component analyzer to preview candidates. No second task scheduler or model client
was introduced.

Review candidates in mm, pt or column counts; select and optionally confirm their
applicability with a reason. HTTP `journal-http-1.5.0` extends `/api/world-component`
with optional captured sources, decisions and no-write preview. Adoption saves one
immutable version, with source text and prior decisions retained. The selected
option explicitly binds the adopted version and runs the existing manuscript check.
Manual **Import candidate JSON** remains available. Imported assertions alone do
not authenticate publisher identity or confirm applicability.

Chat always offers web access and no longer has a per-chat web button, including
historical chats saved with web disabled. ResearchTask web tools are independent
of command-network permissions. Both native and daemon task hosts use the existing
web reader. `web_fetch` can retain its complete returned extraction before shortening
the response; the task can read subsequent slices with `read_file`. The extraction
can itself be limited by an upstream fetch cap or a JavaScript-only page. Custom
provider search still needs a configured Brave/Tavily/Serper key; enabling tools
does not supply that service credential.

The expanded packaged E2E passed notes, mm/pt corrections, same-value candidate
confirmation, source retention, version comparison, binding and rerun. TypeScript,
frontend lint (3325 files), and five affected frontend suites (57 cases) passed.
Workbench has 1034 passing tests, 33 skips and the unchanged historical Windows
Phase 0 availability limits.

The installed library also retains **期刊检查 · 真实稿件与 TDSC 对照**, using the
existing 11-section IJAM manuscript and two TDSC guide excerpts captured
2026-10-14. The checker returns four rule differences and one undetermined line
spacing rule. This is a cross-journal format comparison. The existing custom
supplier (`gpt-6.1-sol`, selected `max`) produced five cited numeric candidates;
an overly restrictive first prompt was corrected, and a follow-up corrected one
JSON unit. That actual JSON imported successfully. Version comparison shows five
source changes with equal values; explicit rebinding and saved handling leave the
original checks recoverable. The successful Chinese chat is retained in the
project. Its two turns report 68697 input and 5013 output tokens; cost is unknown.

Build this local flavor with `vite build --mode workbench` and Tauri's
`--config src-tauri/tauri.workbench.conf.json`. The flavor removes official update
endpoints and explains local updates in the manual update window, preventing the
official release flow from replacing this integrated preview.
The final installed app was reopened without test hooks in its normal Chinese UI;
the real project, saved checks, supplier chat and local-update explanation were
verified there. This increment's compiler cache, disposable test library, scripts
and logs were removed (19.46 GiB); the installed app and selected data remain.

The automatic research-to-check path subsequently ran against the real supplier
in the separate `../research-file-workbench/var/journal-flow-test` library. Project
`witty-teal-tiger`, task `task-ab8d5a4e24cf6d2440b68b00e6c549c5`, generation 3
returned four captured sources and five cited numeric candidates. The panel loaded
that output, accepted the operator's explicit comparison-only applicability reason,
saved a version containing six sources, bound it and ran the existing checker:
check `check-714e2cd6bbe5411386bce843fc5d5cf4` is current, with four differences
and one undetermined result. The prior check remains historical. The task stays
`awaiting_review`; adopting journal requirements does not apply its workspace files.
The task library and source files are retained separately from the main app library.

This run also exposed actual failures: the broader Max run was cancelled without
usable output, one generation was interrupted by a development-app exit, and another
returned invalid JSON. A fresh generation delivered the valid envelope; malformed
output was not treated as success. The readable Computer Society guidance supports
the numeric comparison, while TDSC-specific JavaScript pages leave the exact submission
condition unresolved. No search-key-backed search or universal venue acceptance is
established by this exercise.

The UI now defaults to Simplified Chinese on first launch and settings reset, while
honoring an explicitly saved language. The narrow research card wraps its English
button rather than overflowing. Built-in skill cards, phase/category labels, journal
notices, fixed coverage messages, task starter instructions and English-region names
are localized. Success notices retain translation keys, and the current locale updates before React's
language-change render; live Chinese/English switching therefore updates these labels
together. Chat quick starts are rebuilt on that render, and existing visual spelling
decorations refresh their translated labels on locale application. Source text, user
skills and model results retain their original content.
Chinese catalog validation passed across 24 namespaces with no errors or warnings;
the all-language audit still reports missing keys in other languages. TypeScript,
scoped lint, 453 affected frontend cases, 110 settings/provider/transfer cases and
native locale checks passed. After the final locale-order correction, 41 focused
locale/dictionary/settings cases and 38 task-composer cases passed. Another 102
chat/visual-proofreading cases passed after the final live-label corrections.
The native real-service workflow E2E passed with live notice switching and
Chinese/English button containment checks (13.4 s). The final installed app opened
through the normal macOS entry and its retained real-manuscript project was checked
again in both UI languages. It is left in Chinese. The compiler cache, frontend
build and 37 temporary log/diagnosis files were removed (37.35 GiB); the installed
app, main library and selected automatic-research library remain.

## Shared workflow rules and development skill

The operator confirmed on 2026-11-05 that the reviewed HelloAGENTS ideas belong
inside this product. Use Oleafly's task lifecycle, tool execution, skills and
storage. The shared workflow text lives in
`crates/oleafly-agent/src/workflow.md`: Rust consumers embed the same bytes that
the chat frontend imports. Built-in chat, CLI Agent, ResearchTask prompts and
the task's spawned readers receive it. Native and daemon ACP research tasks
receive it in their initial task prompt. Existing external sessions retain
their own history; this change does not retroactively replace their context
or add instructions to ordinary external ACP chat. ACP children spawned from
ordinary chat are also outside this integration: their current bridge forwards
the delegated user request, not the assembled shared workflow prompt.

On 2026-11-07, the shared text was reduced to the requested outcome,
permissions, task-dependent methods and artifacts, investigation of failures,
and verification of the actual result. Code-specific guidance is loaded through
the bundled `oleafly-development` skill using the existing selector and loader;
it retains its HelloAGENTS source and attribution. Chat no longer mandates a
numbered workflow or compilation after every section. Skill discovery retains
the catalog without requiring the research router first. Development, data
analysis, research and experiment skills retain tool and domain knowledge but
drop repeated process requirements and automatic extra artifacts.

New ResearchTasks initialize `brief.md` and `handoff.md`. `ledger_append`
already creates the experiment ledger when it is used; plans, hypothesis
queues and source notes are created for the task that needs them. Existing
records are preserved, including ledgers and handoffs used by resume.
This does not delete meaningful experiment or manuscript evidence.

This is an instruction and skill integration. TaskStore and the scheduler
remain the execution owners, existing tool permissions and plan approval
still apply, and Workbench remains the source of domain evidence. No
HelloAGENTS hooks, installer, Stop gate, auto-commit or second session store
is enabled. Model compliance, new task-completion enforcement and real
desktop/provider behavior are not established by prompt-delivery tests.

The bounded CLI comparison in the adjacent
`agent-behavior-experiment/round-4/` ran the old and concise rules on a receipt
code task and a cross-repository source investigation, using the same requested
model and effort. Both code outputs passed independent checks after the runs;
both research outputs followed the save/recovery chain and correctly rejected
project/task authorization and model-understanding claims. The concise research
run still created five supporting files, and the concise code run appended
progress to the task input. The generic shared instruction to record progress
was subsequently removed; native ResearchTasks still name their actual handoff
file. This small sample does not establish a stable improvement.

The runs also exposed a concrete CLI environment problem: its command sandbox
discarded the supplied Python PATH and did not use ResearchTask runtime
discovery. CLI commands now reuse `oleafly-sandbox`'s runtime discovery and run
profile, preserving workspace write scope. Local command/tool tests passed.
One separately labeled run with the final concise prompt and repaired runtime
then completed the code task, executed its own 20 tests and README example,
and passed 12 independent checks; its task input was unchanged. This validates
that task's CLI execution path, not a general behavioral improvement.
Magpie's enabled Respire plugin injected additional memory policy into these
requests despite isolated Oleafly libraries; the comparison therefore does not
isolate this product's instructions from all other instruction sources. No
global gateway configuration was changed.

## Provider and model metadata: Magpie comparison

Inspected `yetone/magpie` at `2f726b1f95efd68070246b5e71917b65ae46d807`
on 2026-11-04. Its provider/model catalog is a useful reference for separating
provider identity, model identity, model-family facts, supported APIs, and
per-model overrides. Relevant upstream code includes
[`internal/catalog/catalog.go`](https://github.com/yetone/magpie/blob/2f726b1f95efd68070246b5e71917b65ae46d807/internal/catalog/catalog.go),
which records model provider, API support, reasoning efforts, modalities,
context/output limits and pricing, and
[`internal/catalog/family.go`](https://github.com/yetone/magpie/blob/2f726b1f95efd68070246b5e71917b65ae46d807/internal/catalog/family.go),
which normalizes model families for comparison and ordering.

Oleafly already owns the part needed for this integration: its models.dev
snapshot, stored per-model metadata, and provider-specific wire adapters. For
custom OpenAI-compatible endpoints, resolve exact provider/model metadata in
this order: a matching endpoint-specific entry, an exact provider-qualified
model ID (for example `anthropic/claude-sonnet-5-5`), then a unique exact ID
in the catalog. If the current catalog has no match, use the endpoint's saved
metadata copy. Do not infer provider from loose model-name prefixes or infer a
missing model by family similarity; a near match can have different context,
billing, tool, or reasoning capabilities. Catalog trust is not inherited
across providers: a custom endpoint's model remains untested unless that
endpoint has its own probe or trust evidence.

Reasoning capabilities describe a model, but the request field belongs to the
selected wire protocol. Oleafly's custom provider currently uses its existing
OpenAI Chat-compatible wire, so send `reasoning_effort` only when the user
explicitly selects an effort. Auto must leave it out. Catalog metadata alone
does not prove that a particular gateway accepts this field; real requests
through the selected endpoint remain an integration check, not something a
unit test can establish. Do not add Magpie's catalog, provider plugins, or
family-matching implementation as another runtime dependency.

## Initial integration sequence (completed)

1. Establish a reproducible Oleafly development launch in an isolated data
   directory; leave installed application state and author inputs untouched.
2. Connect the existing workbench MCP server through Oleafly's supported MCP
   client. First verify initialization, tool discovery and read-only metadata
   calls. This is the smallest compatibility experiment, not a new transport.
3. Use an explicitly selected test library and copies of one DOCX manuscript
   and one journal guide. Import captured bytes, bind a specific retained world
   version, run the existing check, and read its exact source-bound result.
4. Change the retained manuscript baseline or a relevant rule version and
   verify that applicability changes without rewriting the old check.
5. Only after this works end to end, design a small native journal/evidence
   panel using Oleafly's internal contribution registry and typed host ports.
   The registry is not an external plugin SDK.

The MCP compatibility step and native panel now work. The local preview starts
the existing domain service as a child process and presents one application.
Bundling its Python runtime for installation on other machines remains delivery
work; this host uses the selected existing environment.

## Native task observations, wave 1 (2026-11-08)

Implemented on `codex/research-workbench`, based on
`553c72d48b583e85549ca4e45721805181b67c00`. The source changes are uncommitted.
The separately built test application uses `com.oleafly.app.e2e` and its own
library. The installed application and existing author projects were not updated.

The current **Activity** tab now shows **Recorded run** / **本次运行记录**.
It reads the existing TaskStore, links calls to the existing timeline, and links
the initial baseline and check summary to **Review**. The retained
facts distinguish selected skills, exact injected section hashes, successful
dynamic skill loads, failed loads, actual offered tool schemas, requests and
returned outcomes. Provider/model identifiers come from the resolved native
runtime. They identify the configured endpoint and requested model; they do not
attest which weights an upstream gateway ran.

`TaskObservation` variants live in the existing `research_task_events` table.
Their identity is `(task_id, execution_generation, sequence)`, with the existing
timestamp. They retain hashes and locators instead of another copy of prompts,
source bodies or conversation history. Runtime snapshots include the native
session ID and the effective tool set after builtin, research-bridge and MCP
merging. The set stays fixed across that native invocation's ordinary, wake-up
and wrap-up turns. MCP discovery errors now fail explicitly rather than silently
removing those capabilities. Selected skill snapshots establish prompt delivery;
dynamic `load_skill` success establishes that the loader returned instructions.
Neither establishes model adoption.

The existing transcript can grow in place at the same sequence and later lose
old text or tool bodies. New observation rows are immutable and excluded from
that shortening. `TaskStore::observations` takes one read transaction, returns
the latest runtime/usage summary and 1–50 committed observations, and supplies
`nextSequence`, `throughSequence` and `hasMore`. At the end of a page sequence
can advance past transcript-only rows. A subsequent query cannot miss an
observation by skipping a mutable streamed text row. Desktop reads first flush
the existing writer; Agent reads can lag its normal commit interval and should
query again. No new event database, session store or retention service was added.

`task_observations` accepts only `after_sequence` and `limit`. Trusted task
binding supplies project, task and current generation. Unknown fields, another
project, obsolete generation, future cursor and out-of-range limits fail.
An unbound MCP session neither advertises nor executes it. UI IPC and the bound
Agent tool use the same query and event IDs. The summary also carries the goal,
success criteria, retained isolation, at most 50 file changes and existing check
results with at most 10 items per check; shortened results declare coverage gaps.

Git-backed isolation captures the initial porcelain dirty/untracked status.
The bounded capture reads one extra byte to detect its 64 KiB limit. On overflow
it retains only complete status lines and saves `initialGitStatusComplete=false`;
the summary and UI explicitly show that the list is incomplete. A complete empty
capture alone means clean. Older captures have unknown completeness; non-Git
snapshots have no Git status. **Recorded run** also shows `file_list_shortened`
and `check_items_shortened`, alongside Git and skipped-file gaps. The check-summary
button opens **Review**, where the evidence checklist actually lives. File changes still compare the
existing starting snapshot against the isolated result, with before/after
hashes, so preexisting dirty work is not counted as a task change. Existing
skipped-file and review limits remain. Changes describe workspace differences;
external authorship is unknown, and rename identity is not inferred from an
add/delete pair.

Native `read_file` outcomes retain the relative path, full read-version SHA-256,
byte interval and truncation state. **Read recorded source range** derives its
locator from the stored event and uses the existing secure preview reader. It
returns the interval only when retained baseline or execution bytes match that
hash. A missing intermediate revision is an explicit unavailable result. Other
context retrieval tools currently retain the paired call/hash, not this exact
source-range contract. Skill support reads retain skill identity and result hash;
only `load_skill` retains an instruction-body hash.

Usage observations accumulate the main native agent's reported counters across
wake-up/wrap-up turns; missing counters stay unknown and reported zero stays zero.
The native usage record now accumulates those turns too. Helper calls still share
the older host usage sink and are not separately attributed; helper observations
and a complete parent/child usage reconciliation are outside this slice. No cost
or model-quality claim is inferred from the counters.

| Runtime path | Evidence owner and current coverage | Remaining gap / verification level |
| --- | --- | --- |
| Builtin desktop chat | Existing live Agent events, chat/session state and usage records. | No new task observation ingestion or task baseline. |
| Standalone CLI Agent | Existing `RunEvent` output and usage spool; bounded/redacted tool arguments and result status/bytes. | No new ResearchTask observation history. |
| Native desktop ResearchTask | New immutable observations plus existing transcript, isolation, diff/review and evidence checks. | Isolated real-provider desktop and packaged UI run verified below. Helpers and non-`read_file` source ranges remain gaps. |
| Native daemon ResearchTask | Same builtin adapter and TaskStore query; CLI skill assembly records exact injected sections. | Rust contract/lifecycle tests passed; no separate real-provider daemon run in this increment. |
| ACP ResearchTask, desktop/daemon | Existing mapped ACP transcript and task isolation/review; task-bound MCP can read the shared observation summary. | No new attested provider/tool/skill snapshot from the external ACP agent. Historical/uncollected UI state remains explicit. |
| External MCP callers | Existing session-scoped tool boundary; new query only with trusted task binding. | Does not observe an external client's arbitrary calls or context. Unbound refusal tested. |
| Agents, shells and Computer Use outside Oleafly | No automatic capture in this slice. | External log import and tracing adapters remain future work. |

Existing build, references, bibliography, numbers and figures checks are reused
as saved. They have check IDs/status/items, not a complete new checker-version,
command and exit-status provenance contract. Their pass result covers their
existing analyzers, not arbitrary assertions in a report. Wave 1 itself did not
include findings or dispositions; the following bounded wave-2 slice adds those
contracts for the numeric checker only.

### Real task and retained evidence

The synthetic run used project `amber-lavender-panther`, task
`task-f771ae2b47f594bec640ffed8e5ad976`, generation 1, native provider `xiaobai`,
model `gpt-6.1-sol`, selected effort `low`. It finished `awaiting_review` with
24 immutable observations through sequence 80, 35 offered tools and reported
92283 input / 839 output tokens. The task read `main.md` (#10 request / #13
result), loaded `observation-fixture` successfully (#20 / #23), and received the
explicit disabled-skill error for `disabled-fixture` (#30 / #33). It called the
bound query twice (#40 / #43 and #50 / #53); its report names the actual returned
task/project/generation, model and event sequences. It correctly calculated
50%, 75% and a 25 percentage-point difference from synthetic counts. The model
itself did not have an independent UI view; the native E2E compared those IDs.

The original dirty `main.md` and untracked `preexisting.md` hashes stayed
unchanged, and the latter is absent from result changes. Captured initial status
also includes `.oleafly/build.lock`; its presence is recorded without attributing
it to the agent. The proposed result has four files: `main.md`, the requested
report and the framework's brief/handoff. No files were applied. All five
existing evidence checks returned pass after their completion.

The packaged UI recovered the hash-matched original byte range [0, 151) from
event #13. After stopping the isolated application and launching a new process,
all 24 observation rows had the same content digest; native query rows matched
SQLite independently. Webview reload also preserved the same query results.
Safe synthetic evidence, screenshot and process-recovery digest are retained
under `.private/observations-smoke/evidence/`; the original task database and
isolated workspaces remain under `.private/observations-smoke/library/`.
Selected check logs are kept with that evidence. The test application is stopped;
its copied credentials, credential key and supplier configuration were deleted
after verification. The retained task can be inspected without those secrets.
Downloaded comparison sources were removed after recording the pinned revisions
and decisions below.

The first UI attempt exposed a real refresh bug: completion of evidence checks
reset already-loaded observation pages. Refresh now appends from the retained
cursor, and a regression test covers retention of earlier calls and rejection
of a superseded pending response. A later test failure came from the native
driver's text-locator `.first()` implementation; the source button was visible.
Using its direct locator completed source recovery. An earlier dirty-baseline
test kept the old clean-file expectation; that fixture expectation was corrected.
The failed attempts are recorded here rather than described as successful runs.
The combined failed attempt is explicitly named
`rust-tests-before-baseline-fixture-fix.log` (CLI 667 passed; ResearchTask 509 passed,
1 failed). Its bytes are unchanged, SHA-256
`0791eb250c8c7192a1ee5c88b8a6169121c6f677c055886a0924ca1e44317cd4`.
`research-tests.log` is the final wave-1 ResearchTask run, 510/510 passed;
`checks.json.logRoles` identifies the historical and final logs. Follow-up findings
validation uses `.private/findings-smoke/evidence/` and does not replace this history.

Verification commands used Rust 1.98.1 and the existing Node 22 dependency tree:

```sh
cargo fmt --all -- --check
cargo clippy -p oleafly-research -p oleafly-cli -p oleafly --all-targets -- -D warnings
cargo test -p oleafly-research --lib
cargo test -p oleafly-cli --lib
cargo test -p oleafly --lib research_tasks::
cargo test -p oleafly --lib agent::usage::tests
cargo test -p oleafly --lib agent::task_runtime::tests
cargo test -p oleafly --lib agent::task_runtime::behavior_tests
node node_modules/typescript/bin/tsc -b
node node_modules/@biomejs/biome/bin/biome lint src packages
node node_modules/vitest/vitest.mjs run src/components/research/tasks src/lib/research-tasks.test.ts --maxWorkers=4
NODE_OPTIONS=--max-old-space-size=12288 VITE_E2E_HOOKS=1 node node_modules/vite/bin/vite.js build --mode workbench
node node_modules/@tauri-apps/cli/tauri.js build --debug --features e2e-testing --bundles app --config src-tauri/tauri.workbench.conf.json --config src-tauri/tauri.e2e.conf.json
node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.ts e2e/tests/117-research-observations.spec.ts
git diff --check
```

Cargo used `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=4`. The live E2E requires its explicit
`OLEAFLY_OBSERVATIONS_LIVE=1` opt-in, isolated supplier library and native socket;
`OLEAFLY_OBSERVATIONS_RESUME=1` rechecks a retained task without another model call.
Research tests passed 510/510, CLI 667/667, desktop task tests 45/45, usage 8/8,
task-runtime mapping 5/5 and behavior/skill/ACP tests 7/7, and affected frontend
tests 341/341. TypeScript, lint (3325 files), Rust formatting,
scoped Clippy, frontend/native packaging and the real-provider E2E passed. The
large debug binary has the existing macOS compact-unwind linker warning, and
Vite reports large chunks. The first frontend build exhausted the default Node
heap; the explicit heap setting above completed it. The local pnpm executable
was missing its platform package, so checks used the already-installed binaries.
These scoped checks do not claim a full workspace test, coverage or dependency
advisory audit.

### Numeric findings and feedback, wave 2 first slice (2026-11-08)

The existing numeric checker now captures `numbers-1` provenance from the same
UTF-8 bytes it inspects: relative file path, full-file SHA-256, one-based line
range, retained line quote and quote SHA-256, referenced run ID and the hash of
its command/metrics/state/exit status, and whether the checked ledger contains
that run. These checks still cover decimal/percentage values with explicit run
markers in changed text files. They do not verify arbitrary claims, identify the
intended metric by name or inspect unchanged files. Other checkers still use
their existing reports without the new provenance contract.

`TaskStore::set_evidence` saves the report and retains numeric `ReviewFinding`
records atomically in the same SQLite database (schema 6). Each finding has a
stable ID derived from task, execution generation and the complete check item,
including provenance. Rechecking the same basis preserves the ID, original verdict,
creation time and dispositions. A changed basis produces another record; earlier
records remain available in that generation. Historical check items without
provenance are never promoted. Lines over 8192 bytes remain ordinary check items
with an explicit coverage gap. Unavailable run or ledger reads produce a skipped
numeric check, rather than being interpreted as an unknown run or absent ledger row.
A genuinely missing ledger is the checker's known empty-ledger basis. Evidence
reads inspect the whole ledger within the existing 1 MiB text limit, including
rows older than the 2000-row UI/reasoning window; a missing `id` header is an error.

`research_task_findings` and append-only
`research_task_finding_dispositions` belong to the existing TaskStore. They are
not an external review database. Findings retain the checked line needed for later
source recovery; they do not archive the whole source file or transcript.
The **Review** tab lists the recorded warning, rule version, source line and
three independent states: check verdict, dependency validity and operator
disposition. Operators can accept, reject, defer or reopen a finding with a reason
of 1–2000 characters. Each decision retains its commit sequence, actor/source,
timestamp and rationale. A decision neither applies project files nor changes
the recorded verdict, and does not add a task-completion gate.

Validity is derived when queried, never saved as an authoritative flag. Current
file bytes, the referenced run basis, ledger membership and current rule version
are compared with the retained basis. A changed or missing cited file, changed run,
changed membership or rule version marks the finding stale. Unrelated files,
other runs and unrelated ledger rows do not. Inaccessible dependencies yield
unknown when no known change already establishes staleness; all known changes and
unavailable reasons are returned. A stale accepted finding stays accepted and
stale. Rechecking invokes only the current checker and preserves old records;
no obsolete checker is revived to validate history.

The UI and bound read-only Agent tool `task_findings` use the same query.
Trusted binding supplies project/task/current generation; caller-supplied IDs or
unknown fields are rejected. An unbound MCP session omits the tool. The query
accepts `after_sequence`, `limit` (1–50), exact file, rule code and disposition.
Finding sequences are independent of transcript/observation sequences. Pagination
returns new immutable findings; to refresh prior findings' validity or dispositions,
query from 0 with the same filters. Decision summaries show the latest 20 records
and their full count, explicitly indicating shortened history; all records remain
in SQLite. Source retrieval accepts a stored finding ID and verifies the retained
quote hash, so it can show the checked version after the task file changes.

This slice queries only the current execution generation and its isolated workspace.
Previous-generation records remain in SQLite but have no dedicated history UI yet.
It does not compare a finding with an independently changed author project after
apply, attribute a model review, or establish recall/precision. The UI and Agent
query both disclose numeric-only coverage and that a model reviewer has not run.
A Windows reviewer connection and held-out known-defect comparison remain future
work; no model-quality improvement is claimed from this feedback contract.

The final isolated native run used project `amber-slate-otter`, task
`task-3fb0257693eb695c2f083860541822d2`, generation 1. A controlled local mock provider
invoked the real `write_file` tool and proposed `Loss 0.70 <!-- run: r009 -->`;
there was no recorded r009. The current numeric checker produced one finding.
The native UI saved accepted, rejected and deferred decisions, each with its
operator reason. An unrelated file edit kept the finding current; changing
`main.md` to 0.80 made it stale. A refresh created a second current finding and
left the first stale/deferred with all three decisions. Its source action still
returned the original 0.70 quote. The original project `main.md` SHA-256 stayed
`340ecd0fa6dd9631e7ab46f20649e0b33d87c6c57f5e2987124d8510f9101818`; no result
was applied. Webview reload and a completely new process returned identical
findings and dispositions. A separate read-only SQLite comparison matched both
finding records and all three decision records to the native query.

Final synthetic evidence and the screenshot are under
`.private/findings-smoke/evidence/final/`; its `verification.json`,
`process-recovery.json`, `sqlite-parity.json`, initial/final queries and native
logs separate the final pass from earlier attempts. Earlier attempt logs are
named `native-before-*-fix.log`: the fixture first used an invalid four-minute
budget, assumed English despite the native saved locale, raced asynchronous
checks, and used the driver's input-only `fill` for a textarea. Those were fixed
in the test, using the existing textarea helper and an explicit evidence wait.
They are not reported as successful runs. The final full workflow and recovery
both pass. This is a real native application/IPC/filesystem/persistence test with
a **mock provider**; it is not a real small-model review or accuracy benchmark.
The isolated application is stopped, and its generated configuration/secret
files have been removed. The retained synthetic database/workspaces and separate
test bundle remain available; the installed application is unchanged.

Follow-up verification passed: ResearchTask 524/524, CLI 667/667, desktop task
45/45, affected frontend 348/348 in 16 suites, TypeScript, lint (3327 files),
Rust formatting, scoped all-target Clippy, Vite workbench build, native app
packaging and the final native workflow plus process recovery. The commands and
Cargo settings are the same as the wave-1 list, with
`e2e/tests/118-research-findings.spec.ts`, `OLEAFLY_FINDINGS_SMOKE=1` and an isolated
library/socket. `OLEAFLY_FINDINGS_RESUME=1` checks the retained final identity
without a provider call. Re-enable the research-task switch and select English
if inspecting the fixture after its config cleanup. The existing linker and Vite
chunk warnings remain; these scoped checks make no full-workspace or model-quality
claim. Final log names and scopes are recorded in the follow-up `checks.json`.

### Upstream source comparison and next waves

All default branches below were `main` when inspected on 2026-11-08. Links pin
the reviewed revision; source availability and licence findings refer to that
revision. No upstream code, dependency, service or database was adopted.

| Project / revision / licence | Checked implementation and decision |
| --- | --- |
| [agentlog, 340325cc4310, Apache-2.0](https://github.com/rutts29/agentlog/tree/340325cc43109e8cc338fcb6d41d42b621659fef) | `docs/transcript-storage.md`, `docs/mcp-server.md`, `ingest/pipeline.py` and migration `v027_transcript_storage.py`: new identities are source-backed, transient reads verify canonical identity/integrity, and old materialized text is retained. Useful provenance/retention design reference; another ledger is unnecessary here. |
| [AgentTrail, 3785d4ea62ca, MIT](https://github.com/sodiumsun/agenttrail/tree/3785d4ea62ca58b9ded853b2e4c3b99f12c02c97) | `docs/OBSERVABILITY.md`, `bin/lib/logtail.mjs`, `git-scan.mjs` and hook relay: bounded local logs and file activity accompany explicit `PLAN.md`; activity does not establish agent identity or successful completion. Keep intent and observations distinct without requiring a new PLAN. |
| [AgentPrism, 4fd371b5e4f2, MIT](https://github.com/evilmartians/agent-prism/tree/4fd371b5e4f25acd04278e94a0d4b21e543eb42c) | Lowercase `readme.md` still marks Alpha. `packages/ui/package.json` uses React 19.1 and Tailwind 3.4.17; the OTel adapter maps spans to its own trace tree, and `TraceViewer` owns selection/search/expansion state. Oleafly uses React 19/Tailwind 4; compatibility and reduced maintenance have not been demonstrated. Existing TaskDetail suffices. |
| [Phoenix, 464a60fd3c24, ELv2](https://github.com/Arize-ai/phoenix/tree/464a60fd3c24aaed780cea3f2e0e437d3c8ba037) | Actual `LICENSE` is Elastic License 2.0. `src/phoenix/config.py`, database engines and database documentation confirm default working-directory SQLite and optional PostgreSQL. Tracing/evaluation/MCP are a possible external experiment; they do not justify a second authoritative task store. |
| [RobertTLange AgentLens, df1a976020a6, licence not established](https://github.com/RobertTLange/agentlens/tree/df1a976020a6e219bdde7b0b6cddcd97574483d6) | `packages/core/src/traceIndex.ts` and `discovery.ts` discover, parse, redact and cache multiple local agent log formats. No licence file or package licence was found in this tree. Useful external-log UI reference; no source is copied. |
| [agentkitai AgentLens, 78fe5eb3bbcc, MIT](https://github.com/agentkitai/agentlens/tree/78fe5eb3bbcc84f0f08f645bf4edd60c4ceef5f1) | Storage interface, `sqlite-store.ts`, storage docs and MCP `src/index.ts`: its own events/sessions/agents, SQLite WAL with PostgreSQL option, MCP-to-API transport and capability probe. This is a separate observability product; no parallel authority is added to Oleafly. |
| [BAR Observatory, 72aef5e8e122, MIT public repository](https://github.com/bar181/bar-observatory/tree/72aef5e8e12225bbbfff89352dc9425d776dc210) | `hooks/hooks.json`, `process/03-ingestion.md`, `run.sh` and `CRATES.md`: Claude lifecycle capture, transcript ingestion, optional proxy/OTLP and explicit missing-channel semantics. The public repo says crate engine source lives in a private repo; its runner calls separately distributed binaries. No engine-source audit or Oleafly compatibility is claimed. |
| [TokenTrail, 2fccd739bd68, Apache-2.0](https://github.com/sunil-bodeddula-pro/tokentrail/tree/2fccd739bd686b499f88a2609cdc02f22c9c8d80) | `store.py`, Claude adapter and telemetry schema: keeps its own per-conversation JSON copies even when upstream history disappears. Useful skill/tool/usage analysis reference; that duplicate-history policy is not adopted. |

Wave 2 now has the bounded numeric-checker feedback slice described below.
A configurable auxiliary-reviewer adapter with explicit off/unavailable/error/partial
outcomes is still required. Wave 3 remains offline calibration and
capability-to-output evaluation; wave 4 remains optional OTel/UI interoperability
only when a concrete consumer demonstrates value.

The Windows location was learned from the supplied integration prompt and its
referenced `/Users/mayuheng/Documents/Trae-CN/temp_20261107_01/local-review-plan.md`,
not from a live Windows check or an established deployed-model inventory. The
prompt mentions Qwen/MiniCheck; the referenced deployment plan instead names
Qwen3.5/Mellum candidates. No reviewer model/version or availability is asserted
here, and no Windows connection or deployment occurred. Its 50 tok/s target is
specific to that inference plan, not an Oleafly task-quality gate.

## Captured application delegation and task PDFs (2026-11-08)

The `codex/agent-app` slice starts at the retained observations/findings baseline
`72c4c3da7b3b6110acc697611eaf4154efc8bee1`. It fixes an editor selection's
project, path, main document, UTF-16 range, full buffer hash, disk hash and selected
runtime/model before asynchronous handoff. The built-in and supported ACP paths
consume that captured identity. An explicit **Delegate task** action creates an
existing ResearchTask; changing the visible project does not change its target.
Ordinary built-in chat retains its existing cancellation on project switches.

`task_inputs.rs` retains inputs under the existing task library before start and
prepares them through the existing task bridge. It writes the captured buffer
into the execution copy once per workspace and keeps `delegation.json` in the
task's record directory. Reusing that workspace preserves subsequent agent edits.
Journal tasks retain the selected world, review, check and manuscript baseline
per task instead of resolving a mutable project-wide latest-task pointer.
The same input record freezes the effective `ProjectManifest`, including linked
projects' device-local engine settings. Compilation uses the existing CLI engine
API with that in-memory manifest; no synthetic `project.json` enters review/apply.

Compilation now returns its actual main document, build directory, output ID and
fresh-output status. Only a successful fresh PDF is retained. Its reference binds
task, execution generation, input fingerprint, source revision, output ID, PDF
hash and size. Later builds cannot replace the referenced bytes. Listing and
reading a reference verify the real task and generation, stored identity and
PDF bytes. The task Output tab uses the existing PDF viewer, extraction and page
rendering functions with these retained bytes, independently of the global
preview. The task agent can call `task_pdf_text` with the returned reference.
The native task also discovers `task_pdf_pages`, which verifies that retained
reference and uses the existing window pdf.js bridge to return actual image
parts to the next model request. It is independent of the visible project PDF;
rendering pages is evidence delivery, not a claim of model visual review.

Selected native task skills now start as a compact catalog containing ID, name,
description, folder and the `load_skill` entry point. Full instructions arrive
only when requested. `injectedSkills` therefore remains empty for this initial
catalog. Ordinary ACP composer skill handoff retains its existing inline-text
contract. The main runtime owns dynamic tool schemas and its request hook.
The frontend accepts its `member` and `requestContext` observations and displays
each execution and each request's tools, schema/catalog/skill byte counts and
requirement IDs. A catalog is not reported as schemas supplied to that request.

Native application validation in `e2e/tests/86-agent-delegation.spec.ts` passed
both scenarios in 19.9 seconds with exit 0. It exercised the actual selection
menu and captured native task, plus a deterministic model tool sequence through
real task writes and compilers. Before apply, the resulting PDF was extracted,
rasterized and displayed on the task viewer's canvas. Switching projects and
compiling a second task preserved the original reference and original manuscript.
This is application-flow evidence with a mock model, not evidence of model
reasoning quality. The later test-only rewrite to the existing packaged-import
registry passed that registry's independent guard. The selected final native log
is `.private/a0-native/final.log`; intermediate attempts remain separate.

The frontend production build, full Biome lint and TypeScript checks passed.
The first full frontend run completed 23,444 tests successfully with 21 failures:
the new PDF parent fixtures and packaged-import entry were corrected, and the
affected tests passed on targeted reruns. Four load-sensitive composer/diagram
timeouts passed in their complete single-worker files. The remaining baseline
failures concern journal/plain-text styles and outdated starter/rail fixtures;
the files establishing them are unchanged from the shared baseline. Full i18n
validation reports 6,971 errors both at that baseline and in this slice, with
zero new issues using the same validator and each revision's own catalogs.
The final focused frontend runs passed 372 tests. Task inputs (5), task
skill/ACP behavior (7), compile host (6), retained artifacts (2), Rust formatting
and Clippy for the three affected packages also passed. These results do not
claim a passing full frontend gate. The official installed application has not
been updated.

## Task collaboration and historical annotations in the application (2026-11-08)

The task detail dialog now has **Annotations** and **Task group** tabs backed by
nine thin IPC commands against the existing TaskStore. A single ResearchTask
can retain user feedback without creating a group. Timeline rows and group
messages expose an annotation action which fixes the original object ID and
version; replies keep their parent's target. Opening a retained timeline
reference reads its original generation and sequence, even after the task has
continued. Missing records are reported as unavailable. Arbitrary historical
file or run references do not yet have a versioned preview in this panel.

The annotation view separates the saved original, actual delivery receipt,
handling records and later distillation into requirements. Ordinary feedback
has no execution state without a real receipt. Member mentions use retained
member IDs. Original text, author, object/version, handling result references,
requirement scope, supersession and source links remain visible. The application
assigns user authorship at its boundary instead of accepting an author supplied
by the frontend. Task updates or explicit refresh reread receipts and handling.

The group tab creates built-in members with explicit provider/model choices and
uses existing scheduler/store routing. It shows original messages, replies,
recipients, interests, member pause/group status, actual work and member
executions, plus links from completed work to its returned message. Refreshes
use the persisted message cursor. This application slice only creates built-in
groups; ordinary ACP tasks remain supported, and an unavailable selected ACP
model now fails before prompting instead of continuing with the default model.
Continuous ACP group context and ordinary chat annotations are outside this
slice's verified boundary.

Application TypeScript and scoped Biome checks passed. Focused UI and bridge
regression tests passed **133/133**, including three historical-target and
member-loading parent tests, seven annotation panel tests and six group tests.
The application collaboration boundary passed **2/2** Rust tests. ACP behavior
passed **8/8**; task PDF page bridge frontend passed **8/8**, Rust page boundary
passed **3/3**, and the runtime test confirmed an image URL in the actual next
model request (**1/1**). The full frontend/i18n baseline failures documented above
remain; these focused results do not claim those full gates passed.

`e2e/tests/87-task-collaboration.spec.ts` adds native acceptance scenarios for
ordinary feedback versus an explicit historical follow-up and addressed member
work through real IPC and TaskStore. It uses a scripted model and awaits the
integrated native application run; authoring and typechecking the spec does not
establish that native acceptance passed. The official installation is unchanged.

## Ordinary built-in chat annotations (2026-11-08)

The built-in assistant now exposes **Conversation annotations** in its header
and **Annotate** on saved messages. It uses the real agent thread ID with no
ResearchTask, preserving the old message ID (or turn anchor) as the target
revision and displaying the selected source verbatim. The shared annotation
panel queries `research_object_annotations` across that object's history;
replies retain their original target. The read-only IPC returns original
annotations, real handling/distillation rows and applicable requirements from
the same TaskStore. It does not manufacture a ResearchTask delivery receipt.

Ordinary feedback is saved without invoking a model. An explicit saved request
continues an idle conversation through its existing send path; when the current
run can receive steering it uses the existing queued-follow-up/steer mechanism.
The request contains the retained annotation ID and target, and unsent composer
text, attachments and delegated selections remain separate. Opening a saved
message reference scrolls to that stable message in the current conversation;
references to unavailable records retain their identity and report the gap.
Project/conversation switches clear the visible annotation dialog.

The main runtime's native `annotation_*` tools and per-request context hook
supply open thread/project/relevant-file feedback and enduring requirements to
ordinary built-in model calls. ResearchTask and ordinary-chat annotations share
the store while retaining their separate execution boundaries. This does not
establish continuous ACP annotation context, model training or a learning gain.

The shared panel/dialog regression passed **13/13**, and the complete composer
file passed **80/80**, including historical-message targeting, feedback versus
explicit idle continuation and active-run steering. The first composer run had
three unchanged effort/web test timeouts under concurrent native compilation;
all 80 passed with a 15-second CLI test timeout, without changing test or product
semantics. The broader task panel run passed **129/129**, and the complete ordinary-agent
loop file passed **193/193**. Final application TypeScript passed. Full Biome and i18n
checks passed, with i18n at **0 errors / 0 warnings** after restoring missing
English fallback keys and fixing 11 existing punctuation violations. The
application collaboration Rust boundary passed **3/3**, including object
history without a task; package all-target Clippy with `-D warnings` passed.
A later historical-artifact boundary regression passed in the full **75/75**
task-detail suite: an old generation's artifact cannot open the current
generation's bytes through the generic preview action.

`e2e/tests/120-chat-annotations.spec.ts` prepares a real ordinary-chat UI flow
through native persistence and subsequent model request capture. The scripted
`119-task-pdf-pages.spec.ts` likewise captures actual image parts following a
native task compile. Both require the integrated native acceptance run;
prepared specs and mocks are not evidence of real-model reasoning quality.

## Verified code anchors and remaining checks

- Oleafly documents external MCP clients in `docs/mcp.md`; stdio sessions are
  implemented in `src-tauri/src/mcp/client/session.rs`.
- The workbench declares `rfw-workbench-mcp --library-root <library>` and its
  stdio tool surface in `contracts/s1/mcp-surface.json`. Tools delegate to one
  `WorkbenchService`; they do not implement independent business rules.
- The source application completed modern MCP discovery and content calls against
  a synthetic library. Workbench `--read-only` advertises exactly 11 tools and
  omits all seven management tools. Other agent runtimes still require their own
  verification; this result does not establish arbitrary ACP integration.
- Native ResearchTask MCP calls now pass optional project, task and generation
  correlation on `read_objects` when the connected MCP server identifies itself
  as `research-file-workbench`. Other MCP servers and ordinary calls receive no
  such metadata. This is attribution, not authentication or project-level access
  control; see the workbench MCP contract and the Oleafly client test.
- Native desktop tools preserve `readOnlyHint`; read-only calls work with task
  commands off, while other MCP calls retain the existing approval gate. Caller
  correlation reaches both legacy initialization and modern discovery paths.
  The modern request keeps its protocol metadata when adding the caller field.
- Refreshing the supplier's stored model list exposes supported effort choices in
  the task composer. The direct-supplier task persists `max`; local wire/component
  tests cover explicit effort propagation. This source-run evidence does not
  capture the outgoing supplier request or prove the supplier's internal effort.
- Manuscript editing, full DOCX layout semantics, independent object/page
  acceptance and automatic interpretation of arbitrary journal guidance are
  not established by this integration proposal.

For implementation changes, run the affected repository's gates. Evidence of
a successful mock, protocol or unit test must not be described as desktop or
real-manuscript acceptance. Keep each change small enough to review separately
and preserve a clear upstream diff.

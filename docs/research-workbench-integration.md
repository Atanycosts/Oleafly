# Private research workbench integration

Decision date: 2026-11-02. Current verification: 2026-11-09.

## Direction and current state

Use Oleafly as the primary application foundation for a private research
workbench. The Workbench Python service now lives at `services/research-workbench/` in this
repository. Reuse its domain capabilities while keeping Oleafly's editor, native
shell and Agent infrastructure as the application foundation.

The integration was developed for local research use. Preserve upstream licence
and attribution files. On 2026-11-09 the operator authorized committing and
publishing the implementation in their own fork; distributing installers or
operating a service for others remains outside this change.

On 2026-11-07, the operator excluded a complete journal submission workflow and
comprehensive submission acceptance from the product scope. Journal-requirement
research, source review, versioned rules and supported manuscript checks remain
in scope; complete submission is not a pending deliverable.

Source and integration checkouts:

- Upstream: `https://github.com/Oleafly/Oleafly.git`, remote `upstream`.
- Inspected revision: `1b6521943ea567a4e5df02c99a588b4e49737623`.
- Original development checkout: `<original-development-checkout>`, branch
  `codex/research-workbench`; fast-forwarded to `72c4c3da` after verifying all
  53 formerly dirty files were byte-identical to that committed baseline.
- Canonical source checkout: this repository. The former Agent integration and
  auxiliary app worktrees were retired on 2026-11-09 after preserving evidence
  and unique history. The delivery on the operator's `origin/main` came from
  `codex/agent-runtime`; the Workbench service consolidation is a subsequent change. Earlier implementation commits extend through
  `dc287af1`; the source snapshots, helper usage, ACP receipts, PDF selection,
  native journal continuation, actual relationship routing and compact contexts
  are included in the 2026-11-09 delivery commits. The dependency PR was based
  on `codex/research-baseline`; both delivery PRs are now merged into fork main.
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
  The original Workbench native-task report is retained in the private source archive
  at `workbench-original-source/reports/integration-investigation/` (2026-11-05).
  No existing user library was migrated.

This document separates the integration direction from the verified product slice.
Workbench source, contracts and portable tests are maintained under
`services/research-workbench/`. Its original source snapshot and Git history are
archived locally; existing libraries retain their absolute data paths. The module
requirements describe planned capabilities; its `docs/s1-progress.md` distinguishes
current implementation from pending acceptance.

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
byte interval, truncation state and whether exact source bytes were archived.
The complete UTF-8 file is captured from the same read used to calculate the
hash. An immutable BLOB snapshot is stored in the existing TaskStore SQLite,
keyed by task, execution generation, path and SHA-256. Repeat reads deduplicate;
the 16 MiB byte budget is shared across every path and generation of a task.
Schema v8 adds the table, and deleting its task cascades to its snapshots.
Snapshot insertion is accepted only for the current running generation and is
rejected after cancellation. If the per-task budget is full, the file read still
returns normally and its observation marks the snapshot unavailable.

**Read recorded source range** first verifies the retained bytes against the
event hash, then slices the recorded UTF-8 byte interval. It never resolves a
retained old-generation event through today's task directory. For reads without
an archived snapshot, only the current generation may use the existing secure
baseline/execution preview, and only while those bytes still match the recorded
hash. An older generation without a snapshot returns unavailable even if the
current workspace happens to contain identical bytes. The panel reports whether
the exact version was retained; older events without this field remain unknown.
The task summary queries all immutable event rows, so it still reports a missed
snapshot when that event falls outside the loaded UI page. Other context
retrieval tools currently retain the paired call/hash, not this exact source-
range contract. Skill support reads retain skill identity and result hash; only
`load_skill` retains an instruction-body hash. The main ResearchTask agent,
group members and helper `read_file` calls use this capture path. A helper read
retains bytes from the same file read, emits a request/completion observation
pair and leaves the parent agent's write-CAS version unchanged. Provider call
IDs are scoped by execution session and step for persisted records while the
provider protocol keeps its original IDs.

The design reuses Lody `turn-diff-store`'s evidence that exact old/new bytes,
hashes and read-only recovery are useful, but does not add its Node worker, a
second SQLite file, turn-diff chain or path-head proof. A `read_file` source is
an immutable captured value addressed by content hash; current worktree CAS is
not needed to prove the bytes being previewed. Existing Rust TaskStore has the
right task/generation lifetime and SQLite migration/deletion boundary. This is
a narrow mechanism adaptation, not a product dependency or copied Lody module.

Usage observations accumulate the main native agent's reported counters across
wake-up/wrap-up turns and add each started helper's cumulative snapshot once.
Native usage records, CLI spools and task outcomes use the same task-level
aggregate. A registered helper that never starts contributes nothing; a started
helper without a usage report keeps the corresponding total unknown, while a
reported zero remains zero. Counters are not persisted as separate helper usage
records, and provider/model cost attribution remains at the parent task record.
No cost or model-quality claim is inferred from the counters.

| Runtime path | Evidence owner and current coverage | Remaining gap / verification level |
| --- | --- | --- |
| Builtin desktop chat | Existing live Agent events, chat/session state and usage records. | No new task observation ingestion or task baseline. |
| Standalone CLI Agent | Existing `RunEvent` output and usage spool; bounded/redacted tool arguments and result status/bytes. | No new ResearchTask observation history. |
| Native desktop ResearchTask | New immutable observations plus existing transcript, isolation, diff/review and evidence checks. | Main-agent PDF delivery and helper-specific source recovery have packaged UI verification; test 121 also checks task-level reported usage. This does not establish independent helper billing or model quality. Non-`read_file` source ranges remain gaps. |
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
referenced `local-review-plan.md (operator-supplied local document)`,
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

The frontend production build, full Biome lint and TypeScript checks passed in
this application slice. Earlier full-suite baseline and fixture failures were
subsequently addressed on the integrated branch; current exact gate results
are recorded in “Integrated runtime and real-model acceptance” below. Historical
logs are retained separately and are not edited into success. The official
installed application has not been updated.

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
Continuous ACP group context is outside this slice's verified boundary. Ordinary built-in chat annotations are delivered by the later integrated section below.

Application TypeScript and scoped Biome checks passed. Focused UI and bridge
regression tests passed **133/133**, including three historical-target and
member-loading parent tests, seven annotation panel tests and six group tests.
The application collaboration boundary passed **2/2** Rust tests. ACP behavior
passed **8/8**; task PDF page bridge frontend passed **8/8**, Rust page boundary
passed **3/3**, and the runtime test confirmed an image URL in the actual next
model request (**1/1**). These were slice-level focused results; the later integrated gate results supersede their historical baseline status.

`e2e/tests/87-task-collaboration.spec.ts` adds native acceptance scenarios for
ordinary feedback versus an explicit historical follow-up and addressed member
work through real IPC and TaskStore. It uses a scripted model; its final integrated native execution is recorded below, separately from the real-model reasoning fixtures. The official installation is unchanged.

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

### Historical source snapshots in annotation context (2026-11-08)

Annotations can now retain the exact text displayed by the annotating surface
as an optional immutable source snapshot with a SHA-256. Ordinary chat messages,
ResearchTask timeline text/tool/milestone entries, and task-group messages pass
their visible source into the existing annotation record. A same-generation
ResearchTask text artifact is read through the existing hash-verified artifact
preview when its annotation is saved; stale generations, missing files,
non-text artifacts and sources above 256 KiB retain their stable object/revision
locator without claiming to have a snapshot. Replies keep their parent's target
and link to that original annotation without copying its source bytes. The
digest verifies the stored snapshot bytes, not the provenance or truth of the
original object.

Model-facing context uses a shared `Annotation::context_record` shape:
`referencedSource` is labelled historical evidence and verified against its
digest; `currentComment` keeps the new author, text, and explicit-request bit.
Missing or altered snapshots report `unavailable`, never substitute a newer
object version. Both ordinary chat and ResearchTask/group inboxes use this
shape, including project/object queries, the by-ID `annotation_context` tool
and the first member turn. The direct ordinary-chat continuation carries only
the annotation identity and target, then directs the model to read the same
verified record through `annotation_context`; it does not duplicate the source
snapshot into a second user message. Once handled, an annotation leaves the
active inbox but remains available by ID and in persisted history. This reuses
TaskStore and existing delivery; no scheduler, database, model dependency or
prompt-wide transcript was added.

Focused validation passed the store integrity test, single-agent late-request
test, busy group-member late-request test, all **3/3** dynamic ResearchTask
tests, all **15/15** annotation-store tests, all **4/4** research prompt tests,
all **14/14** annotation UI tests, and the 7-file Biome check. TypeScript
passed. The complete 80-case chat composer initially found two expectations
that still asserted the old continuation wording; those assertions were updated
to the structured request and passed. The ordinary-chat Rust boundary passed
**2/2**, including structured by-ID/project context. The native Playwright test
`120-chat-annotations.spec.ts` also asserts that annotation source reaches the
model as historical evidence. File-source snapshots are a separate contract
from annotation-source snapshots and are validated below. No real-model quality
claim is attached to either storage path.

The packaged native rerun on 2026-11-08 passed both focused tests, **2/2**, in
12.4 seconds: `119-task-pdf-pages.spec.ts` verified read/edit/compile/page-image
delivery and exact historical file-range recovery from the UI; the ordinary
chat annotation test `120-chat-annotations.spec.ts` passed alongside it. The
log is `.private/agent-acceptance/evidence/source-snapshots/native-e2e.log`.
Earlier failed attempts are retained in the same directory and document test
driver selector and initial socket setup issues. The successful packaged test
is application-path evidence, not a real-model reasoning result. A separate
Rust test does not yet pass an actual `BuiltinTaskAdapter` event into
`source_preview`; the packaged UI scenario covers that connected path instead.

The same annotation split also applies to a queued non-built-in ResearchTask
follow-up: the scheduler serializes annotations through
`Annotation::context_record`, so the historical snapshot remains evidence and
the new comment remains the current request for ACP providers. Desktop and
daemon adapters append this execution's structured annotations after selecting
the fresh, resume, load or adopt prompt. Focused tests inspect the actual
`session/prompt` payload for each applicable start path, including a resumed
session. The scheduler records the exact annotation IDs as prepared for the
claimed execution. Schema v9 separates this attempt from delivery: the ACP
transport records delivery only after the complete `session/prompt` frame has
been written and flushed to local stdio. Startup failure leaves prepared-only
state and stops automatic replay; explicit retry can read the open request
again. Cancellation or disconnect after that write retains the receipt. This
receipt establishes local transport completion, while handling remains a
separate result. Migrated v8 receipts retain their historical meaning rather
than gaining a retroactive transport guarantee.
This covers one prompt per ACP task execution. It does not provide a persistent
ACP task group or a per-turn annotation hook inside an already running session.

### Exact ResearchTask file-source snapshots (2026-11-08)

Four focused ResearchTask store tests pass: task/path/hash identity and
repeat-read deduplication, the true task-wide budget across paths and an
actually started later generation, cancellation rejection and cascade deletion,
and migration from schema 7 while preserving the task. Application-boundary
tests assert exact Unicode range recovery after both workspace copies change,
and that an unarchived source in an old generation cannot be substituted with a
same-hash file from the current generation. A packaged native application test
then exercised the complete task path: the scripted agent read the source,
changed it, compiled a PDF, passed its page image to the next request, and the
task panel returned the original read bytes after the edit. This also confirmed
that source preview consumes the persisted observation by its original task,
generation and sequence. Storage and scripted-provider tests do not measure
real-model review quality. See the project plan for the current integrated
validation status.

Helper `read_file` is included in this ResearchTask snapshot contract. It
retains bytes from the same read that produced the tool result and records a
request/completion pair whose actor and call ID are scoped by the parent
execution session. Two member turns using the same provider call ID therefore
remain separate in the UI. The helper uses the shared snapshot writer without
changing the parent member's read hash for managed write CAS. A scripted
`BuiltinTaskAdapter` test reads version A as the member, changes the workspace
to B, reads B as a helper, then verifies the member's write based on A is
refused and both snapshots remain available. A frontend test renders the
parent read and two helper reads with identical provider call IDs, clicks each
source action, and checks the original observation sequence passed to preview.

The independent review on November 9 found that helper completion was recorded
inside the tool runner, before the backend bounded the actual output. Helper
completion now follows the final `AgentEvent::ToolOutcome`, just as the parent
does: status and output hash describe the bounded response; a source locator
is attached only to a successful response that still contains it. A 48 KiB
backslash file reproduces JSON expansion beyond 64 KiB: the helper receives a
size-limit error, its observation records that exact error and hash without a
success locator, and the original read bytes remain retained independently.

These source guarantees cover helper `read_file` only; other helper tool calls
are not attributed as observations. Helper token snapshots now contribute to
the parent task's cumulative usage and native usage record, and a focused
`BuiltinTaskAdapter` test confirms the task outcome includes both parent and
helper counters. Parent turns now begin explicitly through `UsageSink` before
calling the agent runner, including its pre-step context compaction; `StepStart`
no longer defines the accounting boundary. An adapter regression forces
compaction before the first step of both initial and run-wake turns and checks
the task outcome and usage record against all actual scripted requests. Native
and daemon sink regressions also report usage before `StepStart` and verify
it is counted once. The packaged Playwright 119/120 log verifies the main-agent
file-read and ordinary chat annotation paths and predates this helper
increment. The later packaged test 121 follows a helper-specific `read_file`
row in the task UI and recovers `HELPER_SOURCE_SENTINEL`; task-reported input
and output usage are both positive. Execution remains the parent's session,
and the helper is identified by its call namespace. The scripted provider
establishes wiring and persistence, not reasoning quality or independent
helper billing. ACP direct file reads do not pass through the built-in
`TaskFiles` observation path.

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
through native persistence and subsequent model request capture, and asserts
that the saved source snapshot reaches the model as historical evidence. The
scripted `119-task-pdf-pages.spec.ts` likewise captures actual image parts
following a native task compile. Scripted model sequencing is evidence of
delivery and persistence, not real-model reasoning quality.

## Historical PDF selection as an application task input (2026-11-09)

The existing Preview pane now exposes **PDF annotations and review**. A text
selection captures the bytes and identity of the document actually displayed,
its compile checkpoint, selected text, pages, display-normalized rectangles
and rotation. Switching the viewer identity while the previous text layer is
still mounted cannot capture that stale layer under the new document identity.
Saving feedback creates an annotation without selecting a model or starting a
task. Opening the action with no text selection lists retained PDF annotations.

An explicit review fixes the selected builtin/ACP target through the existing
delegation capture, creates a queued ResearchTask, retains its input, then
explicitly starts that task. The original annotation keeps its old words;
the task's child annotation contains the current request and references the
original source. The nested annotation form delegates explicit requests to
this same creation path before generic annotation persistence, avoiding an
extra open project request or accidental continuation of a previous task.
Passive annotation feedback keeps its existing behavior. If creation succeeds
but start fails, the UI retains that task for retry and disables record
switching until it is opened or started.

The source PDF is content-addressed under `pdf-inputs`, and each created task
also retains its own registered generation **0** artifact plus selection
metadata. Generation 0 denotes captured input, not a successful task compile.
`task_pdf_text` and `task_pdf_pages` accept the complete registered reference
for generation 0 or the running generation's output; a later execution cannot
substitute an older output for its own result. Sidecar identity, complete
reference equality, derived path, size and SHA-256 remain checked. A missing
shared PDF does not erase the list's selected text; opening that original
reports unavailable while an intact task-local input remains usable.

Task input initialization happens before start. Schema 10 adds a narrow
input-initialization marker in the same SQLite transaction as task creation,
with an explicit incomplete-input message. `request_start` refuses it and
`claim_next` excludes it even if another path sets the start bit. The final
prompt edit clears the marker/error and resets that bit in one transaction,
after the application has retained the inputs. Reopening the store after an
interrupted initialization therefore cannot run a task without its PDF input.
Ordinary edits and retry do not release the marker. Failure rolls back only the new
unstarted task and its inputs, child/work rows and generation 0 copy,
preserving the original annotation/PDF. Cancellation while initializing can
withdraw that same marker-owned, never-run task; it never makes it runnable.
Deleting a pending task removes its untouched initialization children in the
same transaction. If initialization later writes its files, rollback accepts
the already-deleted initialization ID and still cleans those files. It removes
only Inputs JSON, generation 0 and an empty artifact container; other
generations and retained execution/discussion history remain protected.
Finalization materializes its result within the transaction, so a subsequent
delete cannot turn an already-committed finalization into an initialization
failure. Deterministic Tauri mock-command tests interleave cancel/delete before
and after PDF/child retention, including Inputs writes after deletion; these
are command/store contracts, not native UI concurrency acceptance.
A native command regression injects
an over-limit final prompt to exercise this cleanup. Migration from schema 9
creates an empty marker table and leaves ordinary tasks unchanged.
Re-preparing an existing workspace preserves subsequent agent edits. Compilation, file review and
application still use Oleafly's existing services and isolated-task workflow.
The Output tab shows the original input separately from compiled outputs;
handling references can reopen that original in the existing PDF viewer.
The retained viewer scroll container establishes its own coordinate origin,
so page navigation inside the modal reaches the actual target page.

Validation is retained under
`.private/agent-acceptance/evidence/pdf-selection/`. The native fixture compiles
PDF A, saves feedback with zero model calls, recompiles the project to B,
then requests review from A's history. The scripted provider reads the current
B source and A's retained text/page image, changes the isolated task copy,
compiles and obtains the new result's text/page image, and records handling.
The original project remains B and the change stays available for review.
The UI verifies both the selected text and page 2 are inside the retained
viewer viewport. The former insufficient passing fixture and its screenshot
remain separately labelled `before-position-fix`; it did not verify viewport
position. Final run and restart details are recorded with their actual checks.
Scripted provider evidence establishes the connected application path, not
real-model reasoning quality. Trusted mouse selection uses the production
renderer in system Chrome; the native WKWebView fixture uses a DOM Range.
Playwright WebKit is unavailable on this runner and is explicitly skipped.

The pre-review schema 10 validation package passed tests 121 and 122 together,
**2/2 in 16.9 seconds**. Test 122 uses the nested explicit-annotation form;
independent SQLite inspection finds exactly the original feedback and one
handled task request, with no pending initialization marker. Feedback made
zero provider calls; the scripted read/edit/compile/image/handling path made
11. An actual process restart preserved the full input reference, original
and compiled PDF hashes and all annotation/handling records. A previous
schema 9 fixture also survived the upgrade to 10 with those values unchanged.
See `checks.json`, `sqlite-checks.json`, `restart-checks.json` and the native
screenshot. The compiled second page was separately rendered and visually
checked in `compiled-page-2.png`.

That pre-review checkpoint passed Research **601/601**, desktop `task_inputs`
**9/9**, PDF pages **4/4**, and the final four affected UI suites **104/104**.
The last pending-input retry adjustment then passed its focused store test;
the preceding 601 log remains its own checkpoint. Main and E2E TypeScript,
i18n types/validation, affected-file lint, strict all-target Clippy for
Research/CLI/desktop, frontend build and native bundle passed. The earlier
378-case preview/task UI run remains separate coverage. Trusted browser
selection passed **2**, with the unavailable WebKit case skipped. No current
full-workspace test result is inferred from these scoped runs. Existing Vite
chunk warnings and the debug macOS unwind linker warning remain.

That verification application was stopped and its four isolated
secret/key files removed after clearing credential fields. Its evidence and
TaskStore are retained; see `cleanup.json` and `evidence-manifest.json`.
The bundle includes test hooks, uses its own identifier and library,
and is a validation artifact. It does not update the installed application.

### Independent review repair checkpoint (2026-11-09)

The independent chat **Oleafly Agent 独立复核**
(`01a1bd9c-3f6f-7d33-bc52-5d0a37d26388`) confirmed three P2 defects:
helper observations preceded the final backend output limit, parent usage
double-counted pre-step context compaction, and cancelled/deleted PDF input
initialization could skip its cleanup. The fixes above use the existing final
tool events, an explicit usage-turn boundary and marker-owned initialization
rollback. No schema or product dependency was added for these repairs.

Current repair validation passed Research **603/603**, CLI host **18/18**,
desktop `task_inputs` **11/11**, native runtime **6/6**, behavior **11/11** and
usage **8/8**. The Research total includes the backend-limited helper response
and initial/woken-turn compaction regressions. PDF command/store tests cover
cancel/delete both before and after retention, Inputs writes after deletion,
repeated rollback and preservation of executed or retained history. These
interleavings are deterministic command tests, not a native UI race test.
Strict all-target Clippy for Research/CLI/desktop, focused Rust formatting and
`git diff --check` passed. Frontend source did not change during the repairs;
the current full frontend/workspace suites were not rerun.

A rebuilt isolated verification bundle passed native tests 121 and 122
together, **2/2 in 10.9 seconds**, using the existing E2E frontend. The new PDF
fixture again made zero provider calls for feedback and 11 scripted requests
for explicit review. Read-only SQLite inspection found one original annotation
and one task request, no pending initialization marker, and matching original
and compiled PDF hashes. An actual process restart preserved the complete
input reference and annotation/handling data exactly. This verifies the real
application, compilation and persistence path with a scripted provider; it
does not measure real-model judgment or comparative task-group benefit.

The new logs, source hashes, screenshot, PDFs, SQLite check, restart snapshots
and cleanup receipt are retained separately under
`.private/agent-acceptance/evidence/pdf-selection/review-fixes/`; start with
`verification.json`, `restart-checks.json` and `evidence-manifest.json`. All 57
files in the previous evidence manifest still match their original hashes.
The repair verification app has been stopped, configuration credential fields
cleared and all four isolated secret/key files removed. Its TaskStore and
evidence remain. The repairs are uncommitted on `codex/agent-runtime`; the
official application and Windows services were not changed.

## Native journal annotations, business tools and reliable catch-up (2026-11-09)

The journal slice uses the existing Workbench service, TaskStore, scheduler and
MCP bridge. It adds no product dependency, broker or second task database.
Historical rules, source-review fragments, checks and worlds can be annotated
in Journal checks. Identity includes the canonical library, fixed manuscript,
object and version. Source fragments use their retained `fragment_id`.
The annotation stores the exact object bytes and hash separately from the new
comment. Replies preserve their historical source and actual continuation task;
related tasks come from each task's retained input, not the project's latest
navigation pointer. Enumeration is no longer limited by the UI's 500-task list.

Saving feedback has no task binding or model request. An explicit request
continues the actual associated task, or creates one pending-initialized task
from the selected assistant. The UI retains that task ID before starting it;
a failed first start retries the same ID. Input initialization reuses the
existing marker transaction and ownership-aware rollback. Journal children
may be removed only when they match the original project/object/version/source
and have no real delivery, execution, replies or handling history.
Task detail and the journal panel can open retained source and handling targets.

`ApplicationTools` extends the existing scoped MCP definitions, direct calls
and HTTP dispatch. Desktop ordinary chat, ResearchTasks and built-in members
share three native operations:

- `journal_context` refreshes the linked manuscript or the task's fixed scope,
  keeping captured inputs separate from current bindings/check validity. A
  task receives a bounded receipt page and subscribes its current member to
  manuscript changes. Ordinary chat receives current linked state without
  pretending to have task receipts.
- `journal_read` distinguishes an exact retained rule/fragment/check/world,
  manuscript catalog metadata, actual bounded DOCX content queries, saved read
  receipts and paged history. Catalog listing does not assert content was read.
  Object reads subscribe the actual member to that stable object.
- `journal_check` invokes the existing checker against the manuscript's current
  explicit DOCX binding and returns the real check, target and synchronization
  status. It does not rebind rules or certify the task's LaTeX. Existing task
  editing, compilation and PDF tools remain responsible for the task copy.

Typed arguments reject scope/URL overrides. These operations use the same
listener, lifecycle, payload bounds and restricted task bridge as existing MCP
operations. ACP exposes that bridge but persistent ACP groups and per-turn
annotation steering are separate unfinished work. CLI daemon hosts have no
native journal application tools in this slice.

TaskStore schema 11 retains the declared Workbench record receipts and current
projection. Schema 12 adds the known check-to-member/execution association;
the 11-to-12 migration creates only that table. Catch-up rescans the selected
journal's retained `world` and `rule_version` records and the fixed manuscript's
`binding`, `check` and `disposition` history. Dynamic validity, stale reasons,
update availability and dispositions are kept out of immutable check bytes.
Each batch of at most 512 records commits receipts, the current projection,
object events and member work in one TaskStore transaction. Identity collisions
with changed payloads fail explicitly. Context cursors are local receipt
sequences, not external commit-order claims. Individual snapshots over 256 KiB
are rejected rather than truncated. Multiple external GETs and multiple local
batches do not form a global atomic snapshot; after a later batch fails, a
complete rescan deduplicates the earlier committed batches.

The application registers a 15-second catch-up worker on startup. With
ResearchTasks enabled and retained journal inputs, it reconnects the configured
service without requiring the Journal panel to be opened. Successful UI writes,
task preparation and `journal_context` also reconcile. A dead child is dropped;
connection failures remain pending for subsequent polls and repeated identical
errors do not flood the application log. Scheduling runs after releasing the
Workbench service lock. Paused groups retain work; ordinary events do not
reopen closed groups. Baseline/read/render history and a general external
commit cursor are not part of the enumerated receipt coverage.

A directional review found that a successful `journal_check` followed by failed
reconciliation lost its in-memory origin. The later system poll could then
wake the member for its own check. The fix saves a known committed check ID
with its actual member execution before reconciliation. Plain rescans restore
that check's actor. The current-projection event also inherits the actor only
when the entire change consists of its known check additions or latest-check
pointer catch-up; external world, binding, disposition or other mixed changes retain
system routing. A committed check plus failed synchronization returns success
with `synchronization: pending`, never an automatic repeated POST. A POST with
an unknown outcome, or a crash before its known origin is stored, still needs
history reconciliation; this is not an exactly-once claim for external effects.

A newly available rule world preserves an unchanged explicit old binding and
its valid old check: `CURRENT` and `update_available` may coexist. Only the
domain service decides staleness. Every native check reports LaTeX applicability
as `not_checked`; a linked DOCX result does not establish LaTeX equivalence.

Final validation passed the 17 Workbench store tests and 12 desktop journal
tests (seven sync, three annotation and two tool contracts). The prior complete
Research checkpoint was 618/618, before the durable-origin repair; only the
relevant tests were repeated after that repair, so a final complete 622-test
suite is not claimed. Task inputs passed 11/11 and the five affected UI files
112/112. Main/E2E TypeScript, frontend lint/i18n, focused formatting/diff checks,
strict all-target Research/CLI/desktop Clippy, production frontend and the final
isolated native bundle passed. Repository Biome excludes E2E; those specs are
checked by TypeScript and actual native execution. Existing frontend chunk and
debug linker warnings remain.

The final bundle passed native 123 and 124 together, 2/2 in about 1.4 minutes.
123 saved historical feedback with no model call, created one pending task,
explicitly started it once, read the actual old rule and retained DOCX, ran the
real checker, edited only the task copy, compiled/read its PDF and linked the
handling back to the old rule. 124 used an acceptance-only Python wrapper to
return one HTTP 503 for the history query after the member check was really
committed. The tool returned the successful check with synchronization pending;
after two polling periods the reviewer still had one execution and domain
history contained exactly the fixture check and member check. An external
revision then woke only the subscribed reviewer; two more polling periods kept
work IDs stable. Product code has no fault-injection hook.

A real process stop/restart then recovered a revision committed while Oleafly
was closed, without opening Journal checks. The paused group retained one new
pending work; reopening it completed that same work with one reviewer execution.
Prior receipts, check origins, source bytes, annotation/handling data, task input
and the compiled PDF hash were unchanged. Another two polling periods produced
no duplicate work. This proves the actual application/service/compiler and
persistence paths with a scripted provider, not real-model judgment or a
comparative task-group benefit.

Final evidence is under `.private/journal-acceptance/evidence/repair-final/`:
`verification.json`, `restart-checks.json`, `cleanup.json` and the evidence
manifest. Native 123/124 checks are in the adjacent `native-repair-final/`.
Earlier unsuccessful test drivers and pre-repair schema11 checkpoints remain
separate. The isolated `Oleafly Journal Acceptance.app` has been stopped,
configuration credential fields cleared and all four isolated secret/key files
removed; its TaskStore and evidence remain. The application includes test hooks
and is not a shipping bundle. Changes remain uncommitted on
`codex/agent-runtime`; the official installation and Windows services were not
updated.

### Real-model journal judgment and compiled PDF handling (2026-11-09)

A fresh isolated library now has a real-provider single-agent acceptance run.
The executor was `gpt/gpt-6.1-sol`, T2/high throughout; DS-Max only registered
the criteria and independently reviewed retained evidence. The synthetic input
kept an A4 W1 binding and a CURRENT check while exposing an unbound W2 that
changed only width to 12240 twips, preserving its conflict with the retained A4
source. The imported DOCX was Letter and separate from a Letter LaTeX source.
Expected outcomes were recorded before execution and were not put in the model
prompt. This tests conditional judgment and application integration, not the
authenticity of a real journal guide or comprehensive submission compliance.

The initial baseline made the correct semantic judgment and produced a real
A4 PDF, but its hand-built `compiled_pdf` handling target could not be opened.
The old tool accepted a generic target and the UI had no compiled-output
branch. This was a failed result-link acceptance, despite correct file output;
its 17 original evidence files remain covered by `baseline-manifest.json`.

The repair extends the existing `annotation_handle.resultRefs` contract with a
complete `TaskCompiledArtifact` returned by `compile` or `task_pdf_text`.
The existing registry reader verifies the task, current execution generation,
full artifact identity and retained bytes before normalizing it to a durable
`task_pdf` target. Hand-built `task_pdf` targets are rejected. Ordinary targets
are distinguished by `objectKind`, including native journal targets with
`taskId: null`. Task detail resolves the recorded generation, hash and path to
the exact full reference and uses the existing PDF reader/viewer/text/page
component. Historical generations remain readable; a mismatched reference is
unavailable. This adds no database, dependency or separate PDF storage.
`task.result.artifacts=[]` is independent of the compiled-artifacts registry
and does not mean the compiled PDF is absent. The journal `object_id` schema
also now says that a world uses `journal_id`, rather than `version_id`.

The repaired real run passed 17 independent assertions. W1 remained bound,
CURRENT and update-available. The model identified W2's width-only override and
source conflict, kept the DOCX's two W1 violations separate from LaTeX, changed
only the task source from `letterpaper` to `a4paper`, and built a one-page PDF
with zero compile errors or warnings. Independent PDF extraction measured
595.28 by 841.89 pt and found the fixture marker; the rendered page was visually
inspected. The handling opened the exact registry PDF, extracted its text and
rendered a page in the native UI. A real process stop/restart preserved the
task, annotations, full artifact identity and PDF hash exactly; that same
handling again opened, extracted and rendered the page. The original project
and W1 binding were unchanged, and the task remains awaiting review.

The repaired first generation encountered an upstream stream error after outer
HTTP 200. One explicit resume completed generation 2 in the retained generation
1 execution root and generated a new generation 2 registry artifact. The
annotation's delivery remains recorded at generation 1; generation 2 handled
that same annotation rather than claiming another delivery. The first
generation also had two shell failures, then successfully read the compressed
PDF geometry. Those failures and the upstream error remain in
`failed-upstream-gen1/`; they are not included in a claim of error-free work.

Final generation 2 recorded 31 tool calls, zero tool errors and reported usage
of 541,446 input / 6,620 output. Across both repaired attempts, the wire observer
recorded 23 requests and 22 usage reports: 1,003,606 input / 11,211 output, with
a maximum single reported input of 67,084. One failed request has unknown usage.
These cumulative values include repeated context and cache hits; they are not
a single context length or unique-content count. One baseline and one repaired
scenario, including recovery, do not establish token savings or a task-group
advantage. The next cost investigation should identify repeated material from
the recorded request context before a matched-budget comparison.

The repair passed seven focused tool tests, two journal tool-contract tests,
84 tests across the two affected task UI files, main/E2E TypeScript,
affected-file lint, focused Rust formatting, strict all-target Research/desktop
Clippy, frontend build and the isolated native bundle. The updated native 123
also passed **1/1 in 6.0 seconds**, exercising complete-artifact handling, UI
PDF text reading and reopening the old journal object. Its first driver used
an overlong macOS Unix-socket path; the next used a Tauri role locator that
requires explicit `role`/`aria-label` attributes and did not match the native
button. The shortened isolated path and existing exact-text locator passed;
the failed attempts remain separate. Full-workspace formatting encountered an existing
unrelated difference; only focused formatting is claimed. The default-heap
frontend build failed, then succeeded with the established 12 GiB Node heap.
Existing chunk/debug-linker warnings and unsuccessful driver attempts remain
in their own logs rather than being overwritten.

Entry point: `.private/journal-real-eval/repaired/evidence/verification.json`.
The same directory retains `checks.json`, `restart-checks.json`,
`wire-metadata.jsonl`, native screenshots, original/repaired PDFs and the failed
generation. Build and regression logs are under the parent run's `evidence/`;
the native 123 fixture is separate from real-model evidence. This is an
uncommitted change on `codex/agent-runtime`, not an installed application update
or a Windows deployment. All four evaluation libraries had their credential
fields cleared and isolated secret/key files removed. The evaluation apps and
metadata relay were stopped; their libraries and evidence remain. See
`cleanup.json` and the final evidence manifest. All 17 baseline-manifest files
were rechecked unchanged.

## Actual member relationships and compact context (2026-11-09)

This increment uses the existing TaskStore and scheduler. Schema 13 adds a small
latest-pointer table for each member/object/relation, and a reasons array on
existing work. Old work defaults to an empty array; migration does not infer
historical readership or enqueue new work. Full observations, file snapshots,
annotation originals and handling history remain in their original stores.

Successful finalized built-in member `read_file` / `write_file` outcomes record
file SHA-256, canonical project-relative path, member execution and the namespaced
session/step/call ID. Failed, unavailable and backend-size-limited reads do not
create readership or update the parent's CAS read version. Successful handling
associates only its annotation target, not every result reference. Creating a
relationship alone emits no event or work. Helpers, shell, MCP and external edits
are not attributed by this slice. Their file observer remains System; an unknown
writer can consequently cause another check by a prior reader. There is no claim
of complete self-echo suppression across those paths.

An explicit annotation request combines mentions, explicit interests, actual
object relationships and the direct parent's real member handlers. Each member
receives one work with all matching reasons and the existing priority contract
(user 100, member 50, event 25). Plain feedback saves without automatic interest
or relationship dispatch; explicit mentions can still address a discussion.
Pausing retains pending work, ordinary events do not reopen closed groups, and
explicit user requests follow the existing reopen path. Reasons preserve the
old object revision and source even after the latest relationship advances.
The task-group UI shows the current change separately from the old relationship,
then reads annotation/handling or exact historical tool-call metadata on demand.
The historical call command is task/generation/call-ID scoped; the current-only
observation summary contract is not relaxed. It returns stored metadata and
hashes, not unretained plaintext output or inferred authorship.
The group snapshot still returns its full event array, and the UI resolves
executions within its latest 100 returned execution rows. An older missing
execution is explicitly unavailable rather than guessed. Pagination and scale
optimization of that path are not part of this slice.

File observations now compare the last stored file state transactionally. Content
hash is no longer a permanent event dedupe key: H2→H3→H2 and restoration of the
task baseline are new transitions, while repeated scans of one state remain
idempotent. Latest managed read/write order, including updates in one millisecond,
determines the known revision; an older write cannot suppress a later rollback.
Targeted store and scheduler regressions cover these negative cases.

`journal_context` defaults to `detail:compact`; `detail:full` retains the prior
complete response. Compact receipts include sequence/hash and exact full-read
arguments, omit bodies explicitly, and preserve captured/current bindings,
DOCX applicability, CURRENT/stale/updateAvailable, coverage/limitations and
rule resolution. A current projection can advance between reads; its hash is of
the full retained snapshot. This projection reduces returned material, not the
underlying HTTP refresh or storage work. Against the retained real-provider
fixture, payload 30,151→21,445 B and MCP envelope 32,672→23,358 B; full values
match the original. Tests also cover ordinary chat's absent capture and
not-enumerated history rather than inventing a zero count.

`task_observations` defaults to `detail:summary`. It retains goal, runtime
identity, tool count, baseline, changes, checks and coverage, omits event rows and
repeated tool identity arrays, and returns an explicit `eventsRead`. The summary
keeps nextSequence equal to the requested cursor; unseen events are not
consumed. Explicit `detail:events` returns the prior complete view. On one old
real tool output this projects 32,371→2,371 B; its actual OpenAI tool-message wire
envelope projects 35,376→2,616 B. This is a historical byte replay, not observed
token savings or billing. `MemberTurn` is no longer repeated in the task system
prompt and initial user message; one refreshed request context supplies current
work, with exact `annotation_context(id)` source readback. Full conversation
history still accumulates and can be compacted by the existing runtime.

A fresh isolated real Sol task used the fixed `gpt/gpt-6.1-sol`, T2/high and an
8-minute shared task budget. Generation 1 handled a two-case decision. Plain
feedback then added one annotation and zero work/executions/requests (8→8).
Generation 2 introduced negative case C on the old decision without mentions;
only its prior handler reentered via `handled` and `parent_handling`, retained
C's −0.03 and revised the equal-weight conditional conclusion (+0.0233).
Generation 3 separately added case D after the original preregistration to test
managed-write routing: the coordinator wrote only metrics.csv; its prior reader
woke through one read reason with zero explicit subscriptions. The reader
updated all four cases, retained C and reported the verified mean difference
+0.0225. The unrelated bibliography member had zero work/executions. Original
project hashes remained unchanged, and handling references match actual report
bytes. Independent SQLite/fixture checks passed 19/19; DS-Max's read-only review
confirmed the mechanism and arithmetic. This is one capability probe, not a
matched single/helper/group comparison or evidence of Windows specialist gain.

Retained evidence is under `.private/attention-eval/evidence/`, with raw
`wire-metadata.jsonl`, `final.json`, `checks.json`, source/hash inputs and
screenshots. The real run reported 580,727 input / 6,902 output tokens across
28 requests and 28 usage reports; maximum single input was 32,887. Cost is
unknown. Different task content and continued member history prevent a direct
savings comparison against the earlier journal trial. The final native bundle
opened the exact generation-2 read call from the generation-3 group view;
task/generation/call ID, file SHA-256 and output hash match the original SQLite
row. Annotation source was visible in the native viewport. After an actual
application exit, rebuild and relaunch (PID 23958→33824), task, group,
annotations and observations were entirely equal, as were active budget and
artifact bytes; restart checks passed 15/15 and model requests remained 28.
This is completed-task recovery, not another crash-in-flight test. See
`ui-checks.json`, `historical-read-call.json`, `native-historical-call.png` and
`restart-checks.json`.

Targeted regressions passed: collaboration 19, attention 9, group scheduler 5,
built-in dynamic 7, observation filter 9, the bound-tool cursor test, exact
historical Store and desktop-command tests (one each), and group UI 11. Filtered
sets overlap and must not be summed. Journal tools passed 7 with one opt-in
fixture test ignored by default; that fixture was separately run and passed.
Type checking, relevant Biome/i18n, focused Rust formatting, diff checks,
Research and desktop strict Clippy, frontend build and the final isolated
bundle passed. No new complete-workspace suite was run. `verification.json`
records the commands, scope and retained logs.

The isolated acceptance app and metadata relay have stopped; its credential
fields were cleared and four test secret/key files removed. TaskStore, sources,
screenshots and failed attempts remain. See `cleanup.json`. Earlier
startup/selector attempts, a snapshot query crossing generation admission and
a restart query before the frontend import hook was ready are driver failures;
work was not resubmitted or silently repeated. The historical-call UI gap was
a product defect and was fixed by the exact readback API described above.

## Integrated runtime and real-model acceptance (2026-11-08)

The integrated checkout is `<agent-integration-checkout>`,
branch `codex/agent-runtime`, based on the preserved local snapshot
`72c4c3da7b3b6110acc697611eaf4154efc8bee1`. The original checkout remains at
`553c72d4` with all 53 captured dirty/untracked file hashes unchanged; see
`.private/agent-acceptance/evidence/source-preservation.json`. No official
installation, upstream push or remote deployment was changed.

The code is committed through `8c8d95a6` on the integration branch. The isolated
acceptance application has been stopped, its configuration credentials cleared,
and its four isolated secret/key files removed. A byte scan of the retained
acceptance scope found no configured gateway credential value. TaskStore,
original model traces, run outputs and rendered artifacts remain available;
see `evidence/cleanup.json`. The debug bundle remains an acceptance artifact,
not an update to the user's installed application.

The runtime stores persistent members, immutable messages, per-member work,
interests and independent executions in the existing TaskStore. Work commits
before scheduler wake. A group currently executes one member at a time against
its shared isolated workspace and existing task budget. Task result/aggregate usage describes the current execution generation; per-member records retain previous generations and unknown interrupted usage. It is not a lifetime token total; the existing native cost probe is task-bound across turns. Busy-member inbox is
refreshed before each provider request; pending work keeps its original causes.
Orphaned executions are interrupted and their original work is requeued. A crash
can lose the current unsaved conversation; recovery uses the latest saved
compatible conversation. Retained cause identity does not provide exactly-once
external side effects. Managed group file tools compare the last read hash under
a write lock; shell/MCP/external background writes are not all covered by that
CAS contract.

Tool schemas are prepared per provider request. `discover_tools` adds deferred
schemas to later requests; calls enforce the actual selection. Skills begin as
a compact catalog and load full instructions on demand. Open annotations and
enduring requirements are provided by task/thread/object/path scope each round;
handling a discussion does not withdraw its active requirement. The observation
retains actual tool hashes, schema/catalog sizes and requirement IDs. `skillBytes`
currently measures the skill catalog, not all retained skill instructions or
billable context.

All real-model fixtures use `agent-acceptance / gpt/gpt-6.1-sol` through the
configured gateway, in a separate `com.oleafly.app.e2e` library. Model choice is
recorded per execution; synthetic teaching data are clearly labelled. They are
real model/application runs, distinct from the scripted native delivery tests.

| Scenario | Actual result | Retained evidence |
| --- | --- | --- |
| A0 frozen manuscript | Task `task-d77c6f0f7eec8dcc7fcbb1593ddee995`, generation 2, completed pending review. Frozen buffer/selection and disk hashes verified; means 5/6, sample SD .894427 independently checked. The model compiled twice, read PDF text and page images, then revised from two pages to one. Final PDF SHA `e1826b53d7c78d2fbe8ef557f868d734744e253a26a4af33db63be1d414892db`; page visually checked. Original project unchanged. | `evidence/a0/checks.json`, retained PDF, page PNG, observations and delegation |
| A0 historical follow-up | Explicit annotation stays on generation 2; automatically resumed generation 3 adds an actual reproducibility paragraph, existing calculation script/output paths, handling and promoted enduring requirement. Main manuscript unchanged; requirement remains active after handling. | `evidence/a0/followup-final.json`, `followup-checks.json` |
| Three-member open research | Task `task-8d21c6826e8f7ece4ab47bb009fe6afd` ran Welch baseline r001 and exhaustive permutation r002, both exit 0. Independent script reruns and closed-form check match: t=1.93649, df=10, p=.0815534, CI[-.150606,2.150606]; 138/924 permutation p=.14935065. Reviewer found no blocking defect; Explorer added 104 boundary ties + 34 strictly extreme interpretation. Main/report/table/ledger agree and preserve both non-rejections and design limitations. 32 work completed. | `evidence/group/checks.json`, `group-latest.json`, retained run evidence |
| Real ordinary chat follow-up | A project-bound ordinary chat read main.tex, answered, then an explicit historical annotation continued the same thread, created actual research-note.md, called annotation_handle/distill and retained an active thread-scoped requirement. TaskStore contains **zero ResearchTasks** for this project. Original manuscript unchanged. The existing ordinary-chat file approval was satisfied by the authorized fixture driver. | `evidence/ordinary/checks.json`, `latest.json` |
| Task-group annotation | Historical message request actually produced a baseline/alternative table and revised conclusion. Handling→distillation→active requirement links retained; 27 later request contexts contain that requirement ID. | `evidence/annotation.json`, `group/checks.json` |
| Pure path-triggered participation | Task `task-86c5d55be3a4fea655d7bcf58de77d5b`: Editor saved one useful revision without messaging Reviewer. Reviewer's sole work came from `file_changed` on main.tex, read the current SHA, independently verified means and conclusion, then removed its interest. No addressed message, no fabricated defect. | `evidence/subscriber-checks.json`, `subscriber-latest.json` |
| Actual interrupted execution | Reviewer generation 2 interrupted on application termination; resumed generation 3 completed the exact same 10 work/trigger IDs. Original messages, annotations and requirement survived. Final current activeMs=715512 and two runs retained; the earlier in-flight restart's pre-budget snapshot was not separately saved, so that point is supported by source/tests rather than a before/after artifact. Final package restart is separately captured: activeMs=715512 before and after, same generation, messages/work IDs, handled annotation and active requirement. | `evidence/group/checks.json`, final restart snapshots |

The A0 initial task reported 367,488 input / 6,911 output tokens. The pure path
fixture reported 77,293 / 613. These gateway-reported counts are retained usage,
not a price estimate or a claim that this design reduces cost. No equal-budget
single-agent/helper/group comparison was run. The fixtures establish working
application cooperation and useful limited results, not general superiority.

Real execution exposed macOS Bash 3.2 heredoc attempting temporary writes outside
its granted paths because that implementation ignores TMPDIR for heredocs.
Confined POSIX commands now use the existing system `/bin/dash` on macOS,
without adding a grant. Actual sandbox regressions demonstrate heredoc success
under `analysis/` while workspace-root/outside writes remain denied, for both
persistent and temporary task-home modes. The PDF page model tool additionally
binds the running generation's outputs; a model cannot supply an older output
to bypass the current execution boundary. The later PDF-selection slice also
allows the registered generation 0 input with full reference validation.
Retained UI history may still read the original artifact under its own identity.

Validation was performed in layers, not inferred from commit existence:

- Full Rust workspace tests passed during integration, including the desktop
  library's 4,226 passed / 21 ignored. Later integrated research tests passed
  574/574; the new actual heredoc regression also passed. Final desktop
  `research_tasks::` tests passed 53/53 and ordinary annotation-context tests 2/2.
- A final broad Rust rerun first stopped at an existing Git command test:
  4,235 desktop tests passed, one failed because the host's global
  `url.https://ghfast.top/https://github.com/Oleafly/.insteadOf` rewrote the
  expected GitHub URL. The user's Git configuration was left intact. A rerun with `GIT_CONFIG_GLOBAL=/dev/null` passed that Git test, but
  reported another unchanged session-isolation test failure (unexpected
  `projects/` entry while other app tests run). It passed 4,235 other desktop
  tests. Its exact isolated rerun passed 1/1. These Git/session-test sources are unchanged from the shared baseline.
  This parallel full run is not described as green. The initial failure log remains
  `/tmp/oleafly-agent-runtime-workspace-final-all.log`.
- The final remaining-workspace command was
  `GIT_CONFIG_GLOBAL=/dev/null cargo +1.98.1 test --workspace --exclude oleafly --all-targets`.
  It exited 0: **5,030 passed / 0 failed / 14 ignored across 123 test targets**.
  See `evidence/validation/workspace-final-other.log`. This excludes the desktop
  main package and does not erase its parallel-run failure described above.
- Final full-workspace, all-target Clippy passed with `-D warnings`; see
  `evidence/validation/workspace-clippy-last.log`. Final rustfmt and diff
  checks passed.
- The first integrated full frontend run reported 23,484 passed / 1 failed /
  7 skipped. Its sole TaskFindings fixture asserted before an asynchronous stale
  reload; corrected to await the actual UI state. Seven affected files then passed 187/187. The final full run passed **23,495 tests, 7 skipped; 1,648 files passed, 1 skipped**, exit 0 in 371.34 seconds. Log: `/tmp/oleafly-agent-runtime-frontend-final-all.log`.
- A real group screenshot exposed a footer bug: the last member's timeline
  usage hid the generation's aggregate task result. The footer now prefers
  the result's non-null counts, retaining zero and per-field fallback.
  The complete task-detail file passed 76/76 after this final two-line change;
  production build passed and the rebuilt native package passed all six scenarios again. This
  focused post-change pass is distinct from the preceding full frontend run.
  The actual group UI also displays the generation's 724k input / 5.8k output
  rather than the last member's 24k / 67; see `evidence/group/usage-ui-checks.json`.
- Full Biome lint passed (3,341 files), i18n generated types were current, i18n
  validation had 0 errors / 0 warnings across 24 namespaces. TypeScript and
  production build passed. The final isolated native debug app was bundled.
- The final isolated package passed **6/6 native scenarios** in 15.0 seconds,
  exit 0: editor selection delegation, retained task PDF before apply across
  project/task switches, actual page image parts in the next model request,
  ordinary chat feedback versus explicit follow-up, historical ResearchTask
  delivery, and addressed member work linked to its reply. Log:
  `/tmp/oleafly-agent-runtime-native-verified-last.log`. Earlier fixture
  attempts are kept under `evidence/native-initial` and `native-selectors`:
  the isolated config initially selected Chinese while English locators were
  used, and this native driver's `getByRole` does not implement implicit HTML
  roles or accessible names. The specs now use its supported labels/CSS/text
  primitives without changing product behavior. Scripted responses verify
  delivery, persistence and actual application/compiler behavior; reasoning
  quality is assessed only by the separate real-model artifacts.

Remaining boundaries are ACP persistent groups and per-turn annotation context,
semantic responsibility/claim-dependency inference, arbitrary `@model` execution
selection, automatic capability improvement, broader Workbench record coverage,
additional application business entry points, parallel shared
writers, and measured Windows specialist-model gain. Existing journal rules,
LaTeX/PDF, citations and manual workflows remain in place.

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
- The retained synthetic manuscript flow above establishes editing and task-PDF inspection for that fixture. Full DOCX layout semantics, general journal-guidance interpretation and untested application entry points are not established by it.

For implementation changes, run the affected repository's gates. Evidence of
a successful mock, protocol or unit test must not be described as desktop or
real-manuscript acceptance. Keep each change small enough to review separately
and preserve a clear upstream diff.


## Fork delivery and cleanup (2026-11-09)

The delivery separates two dependent PRs in the operator's `Atanycosts/Oleafly`
fork, retaining the implementation history:

- [PR #1](https://github.com/Atanycosts/Oleafly/pull/1), `main` ←
  `codex/research-baseline`, retains the original Workbench/observations/findings
  baseline through `72c4c3da`; `3593fc97` removes a machine-specific document path.
  Merged as `34d212d7` on 2026-11-09.
- [PR #2](https://github.com/Atanycosts/Oleafly/pull/2),
  initially `codex/research-baseline` ← `codex/agent-runtime`, retains the earlier runtime
  commits through `dc287af1`, ACP transport correction `3773fc78`, retained
  evidence and application/collaboration increment `656e2a41`, and shared
  CodeBlock correction `469035fe` and legacy migration-fixture correction
  `e8de835`. All 27 previously untracked source/test files are included.
  Retargeted to `main` after #1, then merged as `ba1cb02c` on 2026-11-09.

The operator subsequently authorized completing the merge. Merge commits preserve
the delivered history and the stacked PR relationship. Before and after merging
#2, the complete Git tree matched the tested runtime tree at `9aec8aba` exactly
(`5da5ded0d2c9ac911117a4177d5cdbd7d54f4bfd`). Only this delivery-status
documentation is updated afterward. The integrated checkout now follows fork
`main`; the original development checkout is also synchronized without discarding
uncommitted edits. No upstream PR, tag, installer update or Windows deployment
is included. GitHub reported no workflow runs or check results at merge time;
the local validation and its disclosed failures below remain the evidence.

Delivery review corrected a Workbench event that named the internal
`task_workbench_context` method instead of the callable `journal_context` tool.
The request now also explains discovery of the `journal_` tool family. A store
regression asserts the callable tool name.

Delivery checks are recorded separately from the historical checkpoints above:

- Workspace rustfmt, all-target strict Clippy, frontend lint, i18n validation,
  TypeScript and production build passed.
- The complete frontend run reported **23,535 passed / 1 failed / 7 skipped**.
  The failing design-system check found a raw JSON `pre` in TaskGroupPanel;
  the fix uses the existing shared CodeBlock. The two affected test files then
  passed **24/24**, with relevant lint and TypeScript passing. The full frontend
  suite was not repeated after this local correction.
- The workspace Rust command stopped at the desktop library with **4,264
  passed / 2 failed / 22 ignored**. The unchanged Git test was affected by the
  host's global URL rewrite; the unchanged session test saw a parallel app-data
  entry. Both exact isolated reruns passed, with `GIT_CONFIG_GLOBAL=/dev/null`;
  the operator's global configuration was not edited.
- The remaining-workspace command then exposed eight migration-fixture failures:
  older-version fixtures still contained schema-13 `reasons_json` and attention
  storage, so the migration correctly rejected their inconsistent schema. The
  fixtures now remove those additions before declaring an older version, and
  the version-11 assertion checks the actual current schema. The complete
  Research package passed **643/643** after the test-only correction. Production
  migration behavior was not broadened to accept mislabeled databases.
- The unaffected non-desktop packages reached before Research had **3,271
  passed / 14 ignored**, including the two ACP custom-harness process cases.
  The six packages after that interruption were then run separately and passed
  **1,181/1,181**. The final Research all-target strict Clippy and workspace
  formatting checks passed. Counts take the outer result of each test target
  once, excluding nested subprocess test summaries.

Initial failed logs and subsequent scoped results remain in the ignored delivery
evidence. Neither a failed full run followed by focused passes nor an empty
GitHub checks list is described as a fully green CI run.

Local evidence, test libraries, credentials and upstream probe environments
remain excluded by `.private/`. Completed acceptance task libraries and raw
evidence are retained. The source checkout was fast-forwarded from `553c72d4`
to the already delivered `72c4c3da` only after confirming all 53 dirty paths
matched that baseline exactly; its working tree is clean and its original file
bytes are unchanged. The temporary stash was dropped after verification.

The finished auxiliary worktree's 374 ignored evidence files were archived with
verified hashes, and its unique commit history was preserved in a verified Git
bundle. Managed archival was refused because another active chat still uses that
worktree, so the checkout remains in place. Four rebuildable upstream-probe
environments were removed (about 500 MiB), retaining source, scripts, lockfiles
and results. Once all Cargo/rustc processes had exited, the runtime checkout's
debug incremental cache was removed: `du` reported 71.84 GiB allocated, while
the volume's immediately measured available space increased by 47.29 GiB.
Dependencies, acceptance bundles and retained evidence remain in place. The
independent Workbench repository has no configured Git remote and contains
other work, so it is left intact. Verification commands and actual results are
recorded in the fork PR descriptions and ignored delivery records; historical
checkpoints above keep their original scope.


## Repository consolidation (2026-11-09)

The operator requested one active repository and retirement of both temporary
Oleafly worktrees. Current Workbench source, including its previously uncommitted
implementation, is imported under `services/research-workbench/`. The import keeps
all domain packages, current HTTP/MCP contracts, CLI entry points, browser assets,
synthetic fixture evidence and regression tests. It does not translate Python into
Rust or merge the domain databases. Oleafly owns the application shell; the earlier
standalone Workbench desktop shell and build entry are archived locally. Existing
Python packaging helpers remain covered by their regression tests.

`pnpm workbench:setup` creates the module's Python 3.12 environment with uv and
installs its declared development extras. `pnpm tauri dev` supplies that environment
when `OLEAFLY_WORKBENCH_PYTHON` is absent. Packaged apps retain the existing interpreter
selector. The two retained preview libraries now select the new interpreter; their
obsolete MCP smoke-recorder entry is replaced by the same read-only module entry
and retained library. No credentials or manuscript/library records are relocated.
The former independent Workbench root retains only `var/` and a migration pointer,
because saved project bindings and the installed preview still reference that data.
With the old source and environment removed, both retained journal libraries opened
through the new service: 8 projects / 14 worlds and 2 projects / 5 worlds.

This is a reviewed current-source import, not an import of private Git history into
the public fork. A verified bundle and all 556 original tracked/untracked source and
evidence files are preserved locally. Real manuscript annotations and renders,
author source catalogs, raw provider transcripts, local sessions, databases and
credentials remain ignored. Portable Phase 0 tests use explicit controlled source
and renderer inputs and the existing synthetic DOCX/PDF/PNG evidence. The real
historical acceptance catalogs remain unchanged and retain their environmental
requirements. A controlled placeholder test is not author or rendering acceptance.

Both temporary Oleafly worktrees are now removed. The managed auxiliary worktree
was archived through Codex after releasing completed subtask associations; its
unique history is recoverable. Thirteen evidence groups, including all four native
acceptance app bundles and the upstream investigation source, were retained with
91,844 entry identities checked before cleanup. Current evidence links use this
repository's `.private/` locations; historical evidence bytes keep original paths.

Consolidation validation:

- Python Ruff format (213 files), Ruff lint and mypy (118 source files) passed.
- The full Python regression suite passed **1,034 tests**, with **33 existing
  platform/environment skips** and five PyMuPDF/SWIG warnings.
- The preserved native acceptance app connected to the new service environment and
  passed the existing journal workflow **1/1**, including source/manuscript imports,
  binding, checks, revision, dispositions and restored history. The opt-in live
  provider scenario was skipped; no new real-model reasoning claim is made.
- The first native test-driver attempt failed before tests because its restricted
  PATH lacked rustc. The next reached app startup but pnpm tried to reinstall an
  unchanged dependency tree without a TTY. Both driver failures were corrected
  locally; the successful run calls the existing Playwright CLI directly.
- A source-only copy exported from the staged files, with private catalogs and
  manuscript evidence absent, passed **68/68** focused Phase 0, architecture and
  owned-service lifecycle tests. Staged contract/evidence blobs match the retained
  bytes; Git attributes preserve their CRLF where present.
- Actual historical Phase 0 validation remains **CONTRACT_INVALID /
  PHASE0_INCOMPLETE**: nine author inputs and the pinned Windows WPS executable are
  unavailable on this Mac. It was not replaced by the controlled test result.

The frontend and Rust product implementation are unchanged by this consolidation,
so the full Oleafly suites were not repeated. JavaScript setup/development scripts
pass Node syntax checks; the repository Biome configuration excludes these scripts,
so an explicit Biome call processed no files and is not reported as a lint pass.
No installer, formal application or Windows service was updated. GitHub checks have
no result for the earlier delivery; local verification is not called green CI.

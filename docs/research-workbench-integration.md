# Private research workbench integration

Decision date: 2026-11-02. Current verification: 2026-11-07.

## Direction and current state

Use Oleafly as the primary application foundation for a private research
workbench. Adapt the useful ideas and verified domain capabilities from the
adjacent `research-file-workbench` repository rather than transplanting its
entire application or recreating Oleafly's editor and agent infrastructure.

The operator confirmed private local use. AGPL/GPL components are acceptable
for this scope. Preserve upstream licence and attribution files. Publishing
or operating a service for others is not part of this task.

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

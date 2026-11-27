# End-to-end tests

Real user journeys against the real app: real WKWebView/WebKitGTK webview,
real Rust backend, real Tectonic compiles, real PDF rendering. Nothing is
mocked. If a test says the PDF compiled with zero errors, a user clicking the
same buttons gets a PDF with zero errors.

## How it works

- `tauri-plugin-playwright` (Rust) is compiled into the app **only** with
  `--features e2e-testing` and exposes a socket bridge to the webview.
  Its result channel is a plugin IPC command, allowed by a runtime capability
  granted only in e2e builds (see `lib.rs`).
- `@srsholmes/tauri-playwright` (npm) gives Playwright's test API
  (`test`, `expect`, locators, auto-waiting) over that bridge.
- The local plugin's `screenshot` command uses WKWebView's snapshot API on macOS
  and a DOM/SVG fallback on Linux and Windows. `webview-screenshot.ts` therefore
  captures the app's webview without depending on native window capture.
  `page.screenshot()` uses the separate native capture path, which needs macOS
  screen-recording permission and is unavailable on some platforms. These
  adaptations remain confined to the optional E2E plugin.
- `OLEAFLY_DATA_DIR` points the app at a throwaway directory, so runs never
  touch `~/.oleafly`. The webview keeps its storage somewhere else, covered in
  [Isolated web storage](#isolated-web-storage).

## Running

One command (builds, launches, tests, tears down):

```bash
pnpm test:e2e:app
```

Run the book-scale editor performance gate independently:

```bash
pnpm test:editor:performance
```

The fixture is a deterministic, compilable manuscript rather than one copied
line repeated thousands of times. Its 6,200 lines contain 99% distinct
nonempty lines, more than 450,000 characters, 16+ chapters, 70+ sections, ten
formula families, theorems and proofs, tables, lists, quotations, footnotes,
citations, cross-references, prose, and deliberately detectable proofreading
findings. A surrounding project tree adds front matter, an appendix, editorial
notes, and a bibliography.

The deterministic performance gate uses three warm-up runs followed by 20
measured runs and enforces p95 budgets for that manuscript, a 200-file project
near 500,000 characters, project-backed citation completion, syntax
diagnostics, proofreading extraction, inline-math scanning, and completion at
the end of the book.

The native companion in `58-editor-core-stability.spec.ts` opens the Source
Tree and split workspace, compiles the real book with Tectonic, renders its PDF
beside CodeMirror, and keeps project intelligence, Harper, Hunspell, and inline
math active. It then measures repeated distant scrolling and 252 mixed
navigation, slow character-typing, multiline-paste, delete, undo, and redo
actions. Aggregate and per-action p95 ceilings are enforced, the source must be
restored byte-for-byte, and the run allows no blank viewport frames,
line-number drift, missing tree/editor/PDF surfaces, or browser-document scroll
leaks. The same spec also verifies completion stability, feature-surface
agreement, PDF controls, and current/stale SyncTeX behavior.

Or manually, keeping the app open between runs while writing tests:

```bash
# Terminal 1
OLEAFLY_DATA_DIR=$(mktemp -d) pnpm tauri dev --features e2e-testing \
  --config src-tauri/tauri.e2e.conf.json
# Terminal 2
pnpm test:e2e
```

The suite is sequential (one worker, one app instance) and assumes a fresh
data dir: specs build on each other (02 creates the project that 03-06 use).
Rerunning against an already-used app instance is not supported — relaunch.

## Isolated web storage

The webview keeps its own state (localStorage, IndexedDB, cookies, caches)
outside `OLEAFLY_DATA_DIR`, in a location picked from the app's identifier. E2E
builds therefore get their own identifier, `com.oleafly.app.e2e`, from
`src-tauri/tauri.e2e.conf.json`. Without it, an e2e build shares the
`com.oleafly.app` store with the installed app: the boot seed rewrites your
real settings (tours, font size, locale), and keys left behind by one run show
up in the next.

Build e2e apps with the overlay:

```bash
VITE_E2E_HOOKS=1 pnpm tauri build --debug --features e2e-testing --bundles app \
  --config src-tauri/tauri.e2e.conf.json
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
  ./scripts/e2e.sh
```

`scripts/e2e.sh` and `scripts/e2e.ps1` pass the same overlay to
`pnpm tauri dev`. When given `OLEAFLY_E2E_APP_BINARY`, the Bash runner checks
the packaged compilers beside that executable without using Rust or staging
another set of compilers.

Each run starts by deleting the e2e identifier's storage, so
a local run begins as empty as a CI runner. Storage still survives the app
restarts inside one run, just as it does inside a CI shard. In
`scripts/e2e.sh`, setting `OLEAFLY_E2E_REUSE_DATA_DIR` skips the reset.

| Platform | Reset at the start of each run |
| --- | --- |
| macOS | `~/Library/WebKit/com.oleafly.app.e2e`, plus the identifier's folders under `Caches`, `HTTPStorages`, `Application Support`, `Saved Application State` and `Logs` |
| Linux | `com.oleafly.app.e2e` under `$XDG_DATA_HOME`, `$XDG_CACHE_HOME` and `$XDG_CONFIG_HOME` |
| Windows | `%LOCALAPPDATA%\com.oleafly.app.e2e` (WebView2's `EBWebView`) and `%APPDATA%\com.oleafly.app.e2e` |

Every window, the detached preview included, uses this one store. None of
them sets its own data directory, so they all share the app's default web
context.

On macOS, `scripts/e2e.sh` refuses to run a packaged binary that is not
bundled as `com.oleafly.app.e2e`, because its web storage would not be
isolated: a build with the production identifier writes into the installed
app's store, and a binary outside an app bundle writes into the `oleafly`
store that dev sessions use. Rebuild it as an app bundle with the overlay, or
set `OLEAFLY_E2E_ALLOW_SHARED_STORAGE=1` to run it anyway (an artifact from a
CI run before this change, for example).

Dev-mode runs on macOS are the exception. A `pnpm tauri dev` binary has no
bundle identifier, so WebKit files its storage under the process name,
`~/Library/WebKit/oleafly`, which is also where your own `pnpm tauri dev`
sessions keep theirs. The runner leaves that folder alone. Use a packaged
build when a run must not see state from your dev sessions.

### Native task checkpoint recovery

After building the packaged macOS E2E app above, run the bounded task-group
handoff and restart acceptance:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
node e2e/run-task-checkpoint.mjs
```

This runs `132-task-checkpoint-recovery.spec.ts` through three launches with
scripted provider decisions and real native tools, TaskStore, scheduling and UI.
One scenario keeps an older unreported item while a later independent checkpoint
hands its completed review back. The other leaves a required checkpoint review
unreported and verifies the owner stays blocked. After SIGKILL and restart, the
retained records must match and neither scenario starts on its own; clicking
Start handles the remaining work. A second SIGKILL/restart verifies the completed
records without duplicate member executions. The controlled source stays unchanged.
This establishes the scoped scheduling and persistence behavior, not model quality.

The runner uses the existing E2E lock, an isolated library and backed-up E2E web
storage. It restores the original storage and exits its owned app processes on
completion. Local evidence remains in ignored `.private/task-checkpoint-native/run-*`.
Run it after any DOCX native acceptance has released the same app identifier.

### Native DOCX task activity

After building the packaged E2E app above, run the scripted task integration:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
./scripts/e2e.sh e2e/tests/128-docx-task-activity.spec.ts
```

This uses a synthetic DOCX, the real native task runtime, editor, TaskStore and
Python Workbench. A scripted provider drives both a single task and a group
member through discovery, bounded reading, capture, proposal and task history.
The test checks that proposals leave the document unchanged, user acceptance
after the task ends retains the original execution attribution, and saving links
the actual DOCX bytes and LibreOffice PDF to the exact baseline. It also checks
source navigation into task history, minimizing and resuming the same DOCX
session, closed-session history and reopening without restoring an old target. This is
application integration evidence, not a real-model editing-quality assessment.
The runner resets only the E2E identifier's storage as described above.

For a bounded real-model run against an authorized English or Chinese manuscript,
reuse the isolated runner with a local provider URL:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_REAL_DOCX="/absolute/path/manuscript.docx" \
OLEAFLY_REAL_DOCX_SHA256="the-exact-lowercase-sha256" \
OLEAFLY_DOCX_LIVE_URL="http://127.0.0.1:3425/v1" \
OLEAFLY_DOCX_LIVE_MODE=single OLEAFLY_DOCX_LIVE_LANGUAGE=en \
node e2e/run-docx-recovery.mjs
```

The live mode runs `129-docx-task-live.spec.ts` in one isolated launch. Use
`group` and `zh` for the Chinese group-member path. The model is fixed to
`gpt/gpt-6.1-sol` with `high` effort and a seven-minute task budget. It reads an
actual paragraph window and proposes one language edit; automation then uses the
existing accept/save UI, compares the actual DOCX package, opens the saved PDF and
reopens the document. Content quality remains a separate review of the retained
original and candidate. The transparent relay records model, effort, tool names,
response status and usage, without retaining request bodies or credentials and
without changing model responses. Credentials and upstream routing stay in the
local provider. Evidence is kept under ignored `.private/docx-task-live/run-*`.
With no live or attribution flag, the runner retains its three-launch recovery flow.

### Native DOCX crash recovery

After building the packaged E2E app above, run the opt-in recovery acceptance
against one authorized DOCX at a time:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_REAL_DOCX="/absolute/path/manuscript.docx" \
OLEAFLY_REAL_DOCX_SHA256="the-exact-lowercase-sha256" \
node e2e/run-docx-recovery.mjs
```

The macOS runner creates an isolated app library, backs up existing E2E WebKit
storage, and reuses the new storage across three launches. It edits a captured
copy, verifies a native checkpoint, sends SIGKILL to its own app process, downloads
the selected checkpoint through the native granted-path writer and checks its hash,
then restores after restart, continues editing and saves a Workbench baseline and LibreOffice
PDF, then restarts again to check confirmed discard. The author input is read-only
and its hash is checked before and after. `OLEAFLY_LIBREOFFICE` may select an explicit
`soffice` executable. Run English and Chinese manuscripts separately. The test hook
selects the save path; this does not exercise manual interaction with the OS save dialog.

To exercise task attribution across process death, add
`OLEAFLY_DOCX_ATTRIBUTION_RECOVERY=1` to the same command. This runs
`130-docx-task-recovery.spec.ts` through three isolated launches. A scripted
provider reads an actual manuscript paragraph and proposes an explicit acceptance
marker. The test accepts it through the UI, waits for the exact bytes and task
sources to reach the native checkpoint, then kills the app. On restart it restores
those bytes in a new session and retries the original task. Its resumed execution
reads that session and issues a tracked save. The pending-save checkpoint retains
the original task operation in `pendingSave.operation`. After native commit has
really saved to Workbench, the test withholds the commit response and kills the
app again. The final launch replays the fixed request and checks the same
baseline, bytes, request and single Saved receipt,
original task/member/work attribution, package preservation and LibreOffice PDF.
It then freezes another pending request, advances the isolated baseline through
Workbench, confirms the original request's persisted refusal through the recovery
UI, downloads the exact checkpoint and explicitly discards it. This last check
does not add a Saved receipt or change the newer baseline.
The runner requires an actual SIGKILL at each launch boundary and retains its
lifecycle and final outcome under ignored `.private/docx-task-recovery/run-*`.
The model decisions in this mode are scripted; it adds fault-recovery evidence,
not a new real-model editing assessment. Run the English and Chinese inputs
separately. Live-model, attribution-recovery and font/layout flags are mutually exclusive.

### Native DOCX fonts and layout

Add `OLEAFLY_DOCX_FONT_LAYOUT=1` to the isolated runner command above to run
`131-docx-font-layout.spec.ts` in one launch. It requires installed Times New Roman
regular, bold, italic and bold italic faces and network access to the existing PT Serif font-pack URLs. The
isolated application cache must start without a standalone PT Serif face; a system TTC
with that family does not satisfy the editor's current supported-source boundary.
The test checks native font bytes/hash/metadata and observes the actual browser FontFace
binary inputs, load state and membership in `document.fonts`. It opens the authorized
manuscript, verifies settled shaping, truthful missing Chinese font faces, absence of
host family substitution, no-change export and authored font/style/frame/section retention.
It then imports a controlled guide requiring PT Serif through the real Workbench world
service. The DOCX panel downloads the exact catalog font, rechecks actual native faces,
and refreshes after an edit while preserving the active session, revision, dirty text and undo.
It also minimizes the edited workspace, selects another retained journal world and resumes the
same session with the updated font context before exercising refresh and undo.
This controlled guide verifies the acquisition pipeline, not the author's actual journal rules.

Font binaries are not copied into acceptance evidence. The save-path hook chooses the
export path. The runner retains local evidence under ignored `.private/docx-font-layout/run-*`,
restores E2E WebKit storage and checks the author hash before and after. No model is called.
Missing fonts prevent full coverage. This test does not establish Office-equivalent layout,
per-run font compliance.
For Microsoft package acceptance, also set `OLEAFLY_FONT_SOURCE_EVIDENCE` to the ignored
directory holding the complete, previously verified `office-preview.pkg` and
`eadengfontpack.exe`. The runner checks their catalog hashes and seeds only the isolated
archive cache. It leaves the font cache empty, then uses four controlled exact-family
guidelines on the real manuscript to exercise native extraction, source receipts and
same-session font refresh. This is archive reuse evidence, separate from the real network
PT Serif download. Cache modification times and native progress events verify no new package
download. Local `7zz`/`7z` and tar are required; use Homebrew `sevenzip` on this Mac.
The test reads back the retained real-manuscript PDF, checks supplied cache hashes and actual
PDF font names separately, and inspects the embedded SimSun subset's version record.
It also checks that all four exact Times New Roman sources reach the render profile,
that both manuscripts' regular/bold subsets and the English manuscript's italic subset
retain the resolved versions.
Formula runs declaring unavailable Cambria Math can still use LibreOffice substitutes.
Unused-face embedding is covered by the controlled four-face probe; supplied faces
need not be embedded when the manuscript does not use them.
The subset hash identifies the PDF subset, not the complete cached font. It also repeats
the structural export check after font preparation and verifies reopen reuses a completed
render. It then applies one permitted text edit through the existing Agent host, saves a new
baseline with the workspace button and checks the saved DOCX structure and regenerated PDF.
For the authorized English fixture, it checks the actual editor title/author widths and
source order, both columns clearing the frame group, and retained layout after reopen and save.
These checks do not change LibreOffice's separate title-frame importer limitations.
System fonts are checked before acquisition, so this acceptance requires no existing
standalone SimSun, SimHei, KaiTi or DengXian faces. It cannot establish same-version behavior
when a machine has another version of the same family installed.
The earlier 2026-11-13 Noto-substitution runs are retained historical evidence and do not
validate this exact-font policy.

Font-mode results and recovery material stay in ignored `.private/docx-font-layout/run-*`.
Normal exit and catchable failures restore the previous E2E WebKit storage. If the
runner itself is killed or the machine stops, use that run's `runner.json` and
`webkit-before/` to restore its recorded storage paths. This acceptance does not
exercise a model provider, Word/WPS fidelity or Windows.

### Native material workspace

`143-material-workspace.spec.ts` uses synthetic Markdown, source, diagram,
image, PDF, HTML and DOCX inputs. It checks nonmodal central rendering, feedback without model
calls, exact-version source recovery, an isolated scripted-provider handling
task, frozen HTML/CSS/JavaScript and Word comparison session preservation.
The Word case checks one visible paper layer and one formatting toolbar, the
same writable session across version changes, real operation feedback in the
sidebar and center, pause on navigation and **Continue following**. Opening a
retained result and returning must preserve the working session. HTML return
navigation checks the original iframe lease rather than loading a new page.
The Word case also checks actual font-preparation receipts, native export to a
granted save path and cancellation, and font-size editing and undo through the
product toolbar. Historical view selections remain separate from write targets.
It uses the WebKit screenshot bridge rather than screen-recording access.

Build the isolated native application with `VITE_E2E_HOOKS=1` and
`--features e2e-testing --bundles app --config src-tauri/tauri.e2e.conf.json`,
then run:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_MATERIAL_WORKSPACE=1 ./scripts/e2e.sh e2e/tests/143-material-workspace.spec.ts
```

The runner isolates application and web storage. The DOCX case requires the
existing Workbench Python environment. The scripted provider verifies task
and tool integration, not real-model editing quality. Run large frontend and
Rust builds sequentially on memory-constrained development machines.

### Native long Word interaction performance

`144-word-interaction-performance.spec.ts` measures opening, character input,
caret movement, scrolling and version switching using an explicitly selected
local manuscript with more than 400 paragraphs. It copies the input into the
isolated library, verifies input hashes, inserts and undoes a marker through the
editor's contenteditable, and checks the retained working session and scroll
position. It then saves the edited working copy, closes it and reopens the
unchanged project source, checking that the latest saved baseline and edited
content return. First-paper and full-ready times are recorded separately for
initial import and reopening. The fixed-mode assertions also reject unrequested PDF conversion and
loading, validate paper-aligned stack geometry, and reject input or caret paint
delays of 500 ms or more. The measurements include two animation frames; they
are WebView input evidence, not native OS keyboard or Word/WPS equivalence.

Use the same packaged E2E build as above, then run with the input's actual hash:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORD_INTERACTION_PERFORMANCE=1 OLEAFLY_WORD_PERFORMANCE_EXPECT_FIXED=1 \
OLEAFLY_REAL_DOCX=/absolute/path/to/manuscript.docx \
OLEAFLY_REAL_DOCX_SHA256=<actual-lowercase-sha256> \
node e2e/run-docx-recovery.mjs
```

The runner backs up and restores E2E WebKit storage, exits its owned process,
and retains local-only measurements, screenshots and recovery material under
ignored `.private/material-workspace/performance/run-*`. Omitting the fixed-mode
flag measures a prior build without imposing the new performance assertions.

## Writing tests

- Prefer `data-testid` selectors; add ids to the app rather than matching
  Tailwind classes. `getByText` works for user-visible copy.
- The selector engine is CSS (`querySelector`) plus `getByTestId` /
  `getByText` / `getByLabel` / `getByRole` — no `:has-text()`.
- Global shortcuts (Cmd+K etc.): use `pressGlobal` from `helpers.ts`
  (dispatches a window keydown, which the app's real handlers receive).
- Typing into CodeMirror: `typeInEditor` (execCommand-based real input).
- Compile assertions: `.pdf-canvas` for a rendered page, the
  `compile-status` testid's `data-severity` attribute for zero-error runs,
  `.textLayer` for text that must appear in the PDF.
- Skip: native dialogs (export "Save as"), rendering inside secondary native
  windows, nondeterministic live AI replies, and the updater.
- **Idempotency**: tests may be re-run against a live app while iterating, so
  restore what you toggle (theme, vim, ignored words), use `\providecommand`
  instead of `\newcommand` for injected LaTeX, and make injected command
  names unique per run. CodeMirror anchors must live inside ONE syntax token
  (no backslash-prefixed anchors - highlighting splits text nodes).
- Rail tabs: use `openRailTab` (handles the persisted collapsed-sidebar state
  AND the re-click-collapses-the-active-tab trap).
- Settings: `openSettings(page, section)`; toggles are `[role="switch"]` with
  their label as `aria-label`.
- TEXTAREAS: the plugin's `fill()` only drives `<input>` (it throws
  "HTMLInputElement.value setter" on textareas) - use `fillTextarea` from
  `helpers.ts` (chat box, commit message, custom instructions).
- Hover-revealed controls (`opacity-0 group-hover`): the plugin's `click()`
  waits for visibility and never fires - click the element via `evaluate`
  (`el.click()` works fine on invisible elements).
- Panels that refresh on mount only (source control): after making an edit,
  loop "click Refresh -> check" rather than waiting once; the save-on-compile
  and the panel's own refresh both land asynchronously.
- A `data-severity="ok"` wait passes IMMEDIATELY if the chip is still "ok"
  from an earlier compile in the same test - don't use it as a "my second
  compile finished" signal; wait for the downstream effect instead.

## Opt-in env vars

Set them in your shell, or copy `e2e/.env.example` to `e2e/.env` (gitignored)
and fill in values - `fixtures.ts` loads it in every worker process (loading
it only from the Playwright config does NOT work: workers never see env vars
set while the main process evaluates the config).

| Var | Effect |
| --- | --- |
| `E2E_GITHUB_TOKEN` | Runs the source-control stage/diff/commit flow and the history restore round-trip (connects with the PAT) |
| `E2E_GIT_PUSH=1` | Runs the publish test with a GitHub account: creates a real `e2e-oleafly-*` repo, pushes, verifies over the API, then deletes it (grant the PAT the `delete_repo` scope, or delete the repo manually) |
| `E2E_SKIP_NETWORK=1` | Skips the font-download and template-font-pack tests |
| `E2E_AI_TOKEN` | Runs the real AI tests: provider connect, GLM-4.6 model pick, conversation, tool call, figure generation |
| `E2E_AI_PROVIDER` | Provider card name for the AI tests (default `Z.AI`) |

## Journal template acceptance

The browser template harness uses Transitional OOXML fixtures. The
[native IEEE acceptance](#strict-ieee-ooxml) checks direct Strict OOXML import
through the desktop app and Workbench. The browser tests leave the author
inputs in place, retain hashes in their reports, and retain imported bytes
in each run's isolated Workbench library.
The native runner additionally records the original template, normalized
template, English and Chinese input hashes in `runner.json` and checks them
before and after cleanup.

The 138 browser tests need a Vite dev server on `http://127.0.0.1:1420`. Run
the deterministic scenario with:

```bash
OLEAFLY_BROWSER_TEST_URL="http://127.0.0.1:1420" \
node node_modules/@playwright/test/cli.js test \
  -c e2e/playwright.config.ts \
  e2e/tests/138-journal-template-browser.spec.ts \
  --grep "template DOCX drives the live editor" \
  --retries=0
```

Its report is retained under ignored
`.private/journal-template-acceptance/run-*/report.json`.

Run the opt-in real template and English/Chinese manuscripts separately with:

```bash
OLEAFLY_BROWSER_TEST_URL="http://127.0.0.1:1420" \
OLEAFLY_TEMPLATE_ACCEPTANCE=1 \
OLEAFLY_TEMPLATE_FILE="/absolute/path/template.docx" \
OLEAFLY_REAL_DOCX_EN="/absolute/path/english.docx" \
OLEAFLY_REAL_DOCX_ZH="/absolute/path/chinese.docx" \
node node_modules/@playwright/test/cli.js test \
  -c e2e/playwright.config.ts \
  e2e/tests/138-journal-template-browser.spec.ts \
  --grep "opt-in real template and English/Chinese" \
  --retries=0
```

The real report is retained under ignored
`.private/journal-template-acceptance/real-*/report.json`. It records the three
input paths and before-hashes, retained snapshot hashes, complete finding
pagination, repeated-check identity, and finding artifact IDs. The test reads
the inputs again at the end and fails if their hashes changed.

Template comparison uses `observed_match`, `observed_difference` and
`cannot_determine` for candidate objects measured against the explicitly
selected template. These are observations of that template, not publisher
authentication or normative compliance. A `violation` is only produced by the
separate explicit guide-rule checker; an observed difference must not be
reported as a journal violation.

The 139, 140, and 142 native acceptance tests run through the existing isolated
DOCX runner. It needs the packaged e2e app and three read-only inputs; the
fourth retained hash is the normalized template produced during the run:

```bash
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_DOCX_TEMPLATE=1 \
OLEAFLY_JOURNAL_TEMPLATE="/absolute/path/template.doc" \
OLEAFLY_JOURNAL_TEMPLATE_SHA256="the-exact-lowercase-sha256" \
OLEAFLY_NATIVE_DOCX_EN="/absolute/path/english.docx" \
OLEAFLY_NATIVE_DOCX_EN_SHA256="the-exact-lowercase-sha256" \
OLEAFLY_NATIVE_DOCX_ZH="/absolute/path/chinese.docx" \
OLEAFLY_NATIVE_DOCX_ZH_SHA256="the-exact-lowercase-sha256" \
node e2e/run-docx-recovery.mjs
```

This mode requires a legacy `.doc` template with a Compound File Binary
signature. The runner normalizes it through LibreOffice, runs
`139-journal-template-native.spec.ts`, `140-docx-format-task.spec.ts`, and
`142-word-product-entry.spec.ts`, and retains the normalized template and
reports under ignored `.private/journal-template-native/run-*/`. It backs up
and restores the E2E WebKit storage and owns app cleanup. The 139 report is in
the runner's `template/run-*/report.json`; `runner.json` is the hash and
lifecycle receipt. The task and product-entry tests retain
`docx-format-task-report.json`, `word-file-entry-report.json`, saved DOCX,
screenshots and scripted provider requests in the isolated run directory.

The 139 test exercises real template import, both manuscripts, ordinary Agent
format/save/check tools, all-story paragraph/style pagination and exact ordinary
paragraph/raw text against independent XML, creation of a managed draft from
the selected template, style dependency import/save/reopen, and a
duplicate-text paragraph with separate Latin/East Asian font slots. It also
checks that template facts and check results appear in the central workspace
without backend coverage diagnostics, and that a saved annotation has a readable
target and can open its immutable retained check without displaying internal
source JSON or requiring the current world projection. The 140
test uses a small synthetic table document and scripted provider through the
native task-group runtime for two format/save/check rounds. It writes paragraph
pagination controls, then the containing cell, table and section formats, with
an explicit revision for each operation. It closes and normally reopens the
saved document without a recovery prompt, and checks revisions, both baselines
and source hashes, retained XML, historical check validity, findings and
operation-intent/result/checkpoint attribution. Check tools return compact
receipts; the task follows their exact `journal_read` parameters to read check
metadata and retained findings. Each changed format operation retains its
recovery and saved-byte checkpoints; check operations retain recovery
references, and save results use native source-hash verification.

The 142 test checks the first-use Journal workspace and template upload without
an internal ID field, then copies the English and Chinese sources into a
blank project and opens both from the file tree. It installs exact SimSun from
Settings and checks the same open Chinese session receives the font bytes.
It formats each document, switches between source, Word and Journal tabs with
dirty edits, and checks that the same editing session survives. It saves,
closes and reopens each saved baseline, and confirms the project source copies
still match the originals. Word and its saved PDF must appear inside the
central workspace without a document dialog. Returning from the PDF must keep
the same clean editor session. Source compile and view controls must be absent
while Word is active, and internal version/font details must have no UI.
Renaming the English entry must continue its existing working copy by content
hash. Replacing only the isolated renamed project copy with the Chinese source
must offer the existing exact Chinese draft; selecting it updates the path
mapping while the Workbench project count stays unchanged. These are application
integration tests, without a new real-model quality claim. Set
`OLEAFLY_FONT_SOURCE_EVIDENCE`
to a local directory containing the exact catalog archives to verify package-cache
reuse and extraction without downloading the shared Microsoft archive again.

To add the genuine model test `141-word-template-live.spec.ts` to this same isolated run,
also set `OLEAFLY_WORD_TEMPLATE_LIVE=1` and `OLEAFLY_DOCX_LIVE_URL=http://127.0.0.1:PORT/v1`
to a configured credential-free local provider. It requests `gpt/gpt-6.1-sol` with high effort.
The relay retains requested/returned model labels, HTTP outcomes and usage in `live-wire.json`;
the provider owns the actual upstream identity. No provider secret is written into the report.
An independent ZIP/XML control damages title size, frame width and the title section's column count/space/separator
in a managed English copy. The model must discover target and expected values from system facts,
apply one atomic batch, save and check. Retained tool requests and actual receipts must confirm successful
operation checkpoints, and the batch's saved-byte checkpoint must identify the final source hash.
The control verifies exact repairs, unrelated section and
package preservation, and normal reopen. Numerical expected values are not placed in the prompt.
The fixture records any invalid paragraph ID it normalizes before import. A public Download DOCX copy
captures the initial live export without changing its baseline or dirty state. An independent comparison
allows only the observed removal of redundant `xml:space` and valid, unique ID pairs added to previously
unidentified note paragraphs. All other initial XML and package content must match. The final repair
comparison uses those initial live bytes and independently verifies every controlled title run/paragraph-mark
size plus the title section's column count, gap and separator. Wrong text, extra properties and unrelated
section changes are rejected.
The test retains `word-template-live-report.json`, actual transcript/usage and DOCX evidence.
It measures one bounded real-model task, without establishing whole-manuscript quality or Office pagination equivalence.

### Strict IEEE OOXML

Use the unmodified A4 DOCX and the `Word-Letter-A4.zip` archive from the
[IEEE conference template download](https://www.ieee.org/conferences/publishing/templates.html).
The A4 file must match its entry in the ZIP; the test reads Letter directly from
the archive. Both files have the usual DOCX main-part content type and a Strict
Word root. No office-suite conversion is used.

Build the isolated debug app with the [E2E overlay](#isolated-web-storage)
and set the Workbench Python path from `pnpm workbench:setup`:

```sh
OLEAFLY_E2E_APP_BINARY="$PWD/src-tauri/target/debug/bundle/macos/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_STRICT_IEEE_NATIVE=1 \
OLEAFLY_STRICT_IEEE_A4="/absolute/path/conference-template-a4.docx" \
OLEAFLY_STRICT_IEEE_ZIP="/absolute/path/Word-Letter-A4.zip" \
./scripts/e2e.sh e2e/tests/146-strict-ieee-native.spec.ts --retries=0
```

The test opens the original A4 from the file tree as an unbound working copy,
imports A4 as its first template, and uses **Return to document** to confirm
the formatting action appears in the same editor session. It runs an A4 check
to establish a binding, then imports Letter and confirms import alone does
not change the binding or the open baseline. The A4-versus-Letter check reads
the retained manuscript and template snapshots and resolves a finding's exact
paragraph node against the working bytes. The test compares the originals'
hashes before and after. The report is under ignored
`.private/strict-ieee-native/run-*/`; override the parent with
`OLEAFLY_STRICT_IEEE_OUTPUT`. This does not exercise candidate generation,
production app startup or Word/WPS rendering.

### Whole-manuscript live Word format candidates

`145-word-manuscript-live.spec.ts` exercises the public Word candidate flow on
the actual legacy journal template and the actual English and Chinese author
manuscripts: English starts in the Word toolbar; Chinese starts with the
message `按这份模板排，不改内容` in ordinary chat. Each language uses its own
blank project, managed working copy, exports and report entry. A third English
copy tests editing the active manuscript during candidate preparation.

Hash the three read-only inputs before a run, for example:

```sh
shasum -a 256 \
  "/absolute/path/IJAM_MSWord_template..doc" \
  "/absolute/path/IJAM_english_working.docx" \
  "/absolute/path/批注.docx"
```

Use those exact lowercase hashes:

- Template: `5c9f9dcedd69beddafd3605d0c40966a9e2a777814c507b8e220e5388d4a2d2b`
- English manuscript: `778b76e7abcd01fbd68fa3e09a75bf07a726c6febeb18f758131e2c562027c2d`
- Chinese manuscript: `a3d998b1a0e439282595bd13c7407e55adb42c6643b49b50b5d4a26b14999288`

Start the local OpenAI-compatible relay separately. The runner uses an isolated
application library and provides:

- Template: `OLEAFLY_JOURNAL_TEMPLATE` and `OLEAFLY_JOURNAL_TEMPLATE_SHA256`
- English: `OLEAFLY_NATIVE_DOCX_EN` and `OLEAFLY_NATIVE_DOCX_EN_SHA256`
- Chinese: `OLEAFLY_NATIVE_DOCX_ZH` and `OLEAFLY_NATIVE_DOCX_ZH_SHA256`
- Template mode and candidate flow: `OLEAFLY_DOCX_TEMPLATE=1` and
  `OLEAFLY_WORD_MANUSCRIPT_LIVE=1`
- Relay: `OLEAFLY_DOCX_LIVE_URL=http://127.0.0.1:PORT/v1`
- Packaged macOS app: `OLEAFLY_E2E_APP_BINARY=/path/to/Oleafly.app/Contents/MacOS/oleafly`;
  build with test hooks as described above and run `node e2e/run-docx-recovery.mjs`.

The default model is `gpt/gpt-6.2-sol`; set
`OLEAFLY_WORD_MANUSCRIPT_MODEL` only when the relay exposes a different model.
The runner exposes `max` as the model's only reasoning choice and selects it in
chat. Acceptance checks the real relay's model, effort, returned label and HTTP
status, and verifies that ordinary chat called `create_docx_format_candidate`
in its streamed response. Use `OLEAFLY_ACCEPTANCE_DISABLE_RESEARCH_BUDGET_STOP=1`
to exercise the packaged app under the same budget policy as `pnpm tauri dev`.

`OLEAFLY_WORD_FORMAT_CANDIDATE_TIMEOUT_MINUTES` defaults to 25 and is the
observation timeout for each candidate, not a research budget. The runner
records it in `runner.json`. This flow does not create a ResearchTask.

For each language the scenario:

1. Checks the author input hash, writes the exact source into a blank project's
   file tree and opens it through Explorer.
2. Confirms the clean working-copy baseline and the original source identity.
3. Imports the legacy template through Journal checks and selects that template
   world for the opened document.
4. Starts from the Word toolbar or ordinary chat and waits for the candidate
   panel to show at least one confirmed change.
5. Opens a change preview and verifies the pane is read-only while the active
   document keeps its session, baseline, revision, source hash and clean state.
6. Adopts the candidate, confirms a new clean baseline, uses **Export DOCX**,
   verifies the adopted bytes and reads back the previous version.
7. Compares the initial live export and adopted export with the independent
   Python verifier in `e2e/helpers/word-format-candidate.ts`.
8. Closes, reopens through Explorer, downloads again, and requires byte-identical
   output plus the adopted baseline and source hash.
9. Confirms the project file-tree copy and the original author input remain
   unchanged.

In the concurrent-edit case, the test types into the active editor, attempts
adoption, and checks that the newer draft remains intact and the candidate is
still downloadable.

The independent verifier requires the same package part set and byte-identical
binary parts. It ignores only Word identity/cache normalizations
(`w14:paraId`/`textId`, `w:rsid*`, `xml:space`, `w:lastRenderedPageBreak`,
`w:proofErr`), XML namespace declaration and prefix serialization, and
format-property containers in story XML. Elements and attributes are still
compared by expanded namespace. It permits changes in known format parts such as
styles, numbering, themes, fonts, settings and web settings. Text, formulas,
drawings, relationships, story structure and all other XML remain protected.
The verifier separately compares existing tables, sections, frames, tab stops
and paragraph pagination properties. It rejects a rewrite with no actual XML
format change. These checks do not measure the resulting page breaks.

All source files, normalized template, DOCX exports, `runner.json`,
`live-wire.json` and `word-manuscript-live-report.json` stay under ignored
`.private/whole-manuscript/run-*`. The runner checks all three input hashes before
and after, restores E2E WebKit storage and exits its owned process. A pass establishes the
candidate, preview, adoption, exact export and reopen behavior on the built app;
it does not require every template difference to be repaired and does not
establish Word/WPS pagination or complete journal compliance.

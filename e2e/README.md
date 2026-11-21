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

These acceptance paths use Transitional OOXML DOCX. A document in Strict OOXML
is not supported: save it as Transitional in Word first, then use the saved
copy. The browser tests leave the author inputs in place, retain hashes in their
reports, and retain imported bytes in each run's isolated Workbench library.
The native runner additionally records the original template, normalized
template, English and Chinese input hashes in `runner.json` and checks them
before and after cleanup.

### Word citation picker preview

Start Vite with `VITE_DOCX_CITATION_PREVIEW=1` and `OLEAFLY_E2E_DISABLE_HMR=1`
on `http://127.0.0.1:1420`. The browser test uses the Workbench virtual
environment for the current platform, or the interpreter specified by
`OLEAFLY_WORKBENCH_PYTHON`. Run:

```bash
OLEAFLY_DOCX_CITATION_ACCEPTANCE=1 node node_modules/@playwright/test/cli.js test \
  -c e2e/playwright.config.ts e2e/tests/126-docx-workspace-browser.spec.ts \
  --grep 'opt-in citation picker' --retries=0
```

The test uses a synthetic two-column DOCX and an isolated Workbench library.
Generated bibliography entries do not offer insertion. Opening the picker leaves
page geometry unchanged. **Enter** from the search box starts a Crossref lookup
without adding a field; selecting an existing source does not need a lookup.
**Close** dismisses the picker during a keyboard-initiated search,
and moving the caret or switching to Source discards the pending search.
Returning to Word and opening the picker again does not show the old result.
If a background edit changes the draft while confirmation has keyboard focus,
the picker closes and returns focus to the document without scrolling or adding a field.
The context-tools component regression also checks immediate confirmation after
a caret move, before the picker has dismissed. No field is added, the new caret
stays in place, and focus returns to the document only if the picker held it.
Choosing a result visibly
marks the selection and shows whether confirmation will add or reuse a document
source. A conflict or an overlong title disables confirmation and leaves the
draft unchanged. The test looks up the same Crossref DOI
as bare text and as an uppercase DOI link, inserts it once in each column, and
checks that both fields point to one saved source. The first undo keeps the first
field and its source; the next removes both. After redo, save and reopen, both
fields open the source. The test uses **Download DOCX copy** and runs the package
check against the original fixture and downloaded copy. In a short, narrow
viewport, keyboard selection and confirmation remain reachable and **Close** returns
focus without scrolling the paper. At 72px of visible height, the picker itself
scrolls to bring the source and confirmation into view; **Escape** returns focus
to the paper without moving it or inserting a citation. Scrolling the insertion
point out of view closes the picker without changing the new scroll position.
A confirmation dispatched before the picker closes does not insert a citation
at the now offscreen caret. Focus
stays in the viewport if the picker had focus, or stays with the newly focused control.
The same test pastes an existing
author source's DOI link, selects that source by keyboard without a Crossref request,
and checks that the added field survives undo, redo and reopening without changing
the bibliography part. Crossref and desktop IPC responses are scripted. This does
not verify bibliography rendering in Microsoft Word or desktop WebView behavior.

The Word browser spec uses Chrome by default. To check pointer, selection and
keyboard behavior in Playwright WebKit, install it with
`node node_modules/@playwright/test/cli.js install webkit` and set
`OLEAFLY_DOCX_TEST_BROWSER=webkit` on the test command. Use the same environment
and add `preserves intervention|across a (page|column) break` to the grep pattern
to cover formula clicks and drags, narrow review, and cross-page or cross-column
selection placement. The live working copy scenario also checks that a native
citation opens its source from the retained original by pointer and keyboard,
without moving the paper or changing the working session. In Chrome and
Playwright WebKit, Escape exits while the formula source preview loads, without
moving the paper or changing the draft. The test also checks that focus stays
inside the formula editor during replacement. In Document tools, pressing
Enter on Replace keeps Escape available. The test closes Document tools during
the pending conversion and verifies that the late result changes neither the
draft nor the paper or focus. It also releases a pending conversion immediately
after scrolling the equation out of view, before the popup can close. The
revision and scroll position stay unchanged, and reopening the same equation
restores its LaTeX draft. Run the same spec with
`--grep 'reopening feedback'` for the actual workspace center and feedback
panel: after editing the manuscript, reopening older feedback with the
keyboard preserves its revision, unsent draft, focus and page geometry when a
new capture finishes. Switching to the original hides working-copy feedback;
switching back restores the draft. Feedback on retained notes does not hide the
manuscript's review action. The notes and manuscript keep separate drafts. The
test saves both and checks each submitted source hash against its captured revision.
This uses a synthetic manuscript and scripted desktop IPC. The clipboard checks
use a scripted event and adapter; verify actual
keyboard copy and paste in the desktop acceptance.

### Published two-column DOCX browser check

Download the CC BY 4.0 DOCX from [Zenodo 8227226](https://zenodo.org/records/8227226)
to an ignored directory. The checks verify the original's SHA-256 and import a
copy into a temporary Workbench library. For default interactions, start Vite
with `VITE_DOCX_CITATION_PREVIEW=0` and `OLEAFLY_E2E_DISABLE_HMR=1`:

```bash
OLEAFLY_PUBLISHED_DOCX="$PWD/.private/word-real-acceptance/candidates/8227226.docx" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_DOCX_CITATION_ACCEPTANCE=0 node node_modules/@playwright/test/cli.js test \
  --config=e2e/playwright.config.ts 126-docx-workspace-browser --grep 'published DOCX keeps default' \
  --output=.private/word-real-acceptance/test-output --retries=0
```

The default check drags and copies text containing a Zotero field, then opens
its source without shifting the paper. A separate drag across a page break
copies text from both pages without opening the strip. Shift+F10 opens the
strip at the active end, and Escape preserves the selection and scroll position.
A suggestion becomes ready while focus stays in the document. The test opens
it with F6 from a different paragraph, accepts it by keyboard, and uses Escape
to return to the same caret without scrolling. It also exercises the inline
entry in a narrow viewport, then undoes, redoes, saves and reopens the two edits.
An ordinary caret does not offer insertion.
The downloaded `8227226-default-export.docx` retains both edits, the original
fields, their linked bibliography stores, named bookmarks, and section columns.

This path also passed on macOS arm64 in Playwright WebKit with a non-editable
Workbench wheel installed in a fresh Python 3.12 environment. The service
loaded from the installed package. A separate service check saved the browser
export to a fresh library, restarted Workbench, and read back identical bytes.
The original hash was unchanged. Installation used the local dependency cache;
this does not verify a user-facing runtime installer or the packaged desktop app.

The separate `DOCX review shortcut yields expanded feedback` case uses a
synthetic manuscript in WorkspaceCenter. In Playwright WebKit it verifies that
F6 opens the review from the paper while feedback is still expanded, and Escape
returns to the same caret without scrolling or resizing the paper. Reopening
feedback restores its unsent draft.

For citation insertion, restart Vite with `VITE_DOCX_CITATION_PREVIEW=1`, set
`OLEAFLY_DOCX_CITATION_ACCEPTANCE=1`, and use `--grep 'opt-in published DOCX'`.
That check queries Crossref by DOI, inserts in both displayed columns and
verifies one shared source through undo, redo, reopening and export. The package
check verifies that both citations start the selected paragraphs, only the review
and manual-edit paragraphs changed, and third-party fields, bookmarks and section
columns survived.

Set `OLEAFLY_DOCX_TEST_BROWSER=webkit` to use Playwright WebKit. Clipboard events,
Tauri IPC and suggestion tokens are scripted in both checks. Neither replaces the
[release candidate check](#word-context-tools-release-candidate-check), and this
manuscript has no native Word `CITATION` fields for the
[Microsoft Word round trip](#word-citation-round-trip-acceptance).

### Word context tools release candidate check

For an internal Apple Silicon test, push the reviewed candidate commit,
including [the candidate workflow](../.github/workflows/word-workspace-candidate.yml),
to a dedicated branch such as `codex/word-candidate/first-open`. The push builds
that commit without merging it to the default branch or creating a release.
Once GitHub registers the workflow on the default branch, you can also dispatch
it on the ref to be tested. Download `word-workspace-macos-<commit>` from the
Actions run and unpack `Oleafly.app.zip`. The app has an ad hoc signature and
uses the release configuration with test hooks, citation preview, and the
in-app updater disabled so it stays on the candidate commit during acceptance.
It does not verify the public install path of a Developer ID-signed, notarized
release.

Use the current macOS release candidate, built without E2E hooks and with
citation preview disabled, and the unmodified
[Zenodo 8227226 DOCX](https://zenodo.org/records/8227226). First launch
the candidate from Finder in a clean macOS user profile, without a saved
Workbench interpreter or `OLEAFLY_WORKBENCH_PYTHON`. From the project file tree,
open the manuscript and check that the Workbench connection form appears.
Install Workbench from the candidate's source revision using the
[packaged macOS setup](../docs/development.md#connect-a-packaged-macos-candidate-to-workbench),
then connect from the same file tab and confirm the working copy opens. Record
any installation steps or connection problems. Relaunch from Finder and check
that the same manuscript opens without selecting Python again. A run with a
developer interpreter already configured can verify editing, but does not pass
this first-open check. Use the [Agent provider setup](../docs/Integrations.md)
for the review step.

Once the working copy opens, keep the desktop unlocked and the window visible.
Use the system mouse, keyboard and clipboard:

1. Drag-select across a Zotero field, then separately across a page break.
   Copy and paste into TextEdit. The visible citation marker and text on both
   pages survive; ordinary selection and copy do not open the context strip.
2. In either column, use right-click or Shift+F10 on a text selection. The
   strip opens by the clicked line or the active end of the selection. Escape
   preserves the selection. Reopen it and use **Copy**; pasting into TextEdit
   gives the same text as keyboard copy from that selection. Scroll the anchor
   out of view with the strip open; it closes without a scroll back. Ordinary
   carets do not offer citation insertion.
3. In a narrow window, open the source for a Zotero marker and preview an
   embedded image. Confirm that each panel belongs to the object selected. Use
   the keyboard to open and close at least one panel when the strip needs to sit
   at the viewport edge. The paper and viewport stay the same size, and the
   edit position does not jump.
4. Request a rewrite of the paragraph beginning “The main objective of this
   research” (`0E8ABDCF`). While it is pending, edit only the paragraph beginning
   “Many researchers did research” (`4AD876D5`). Readiness leaves the paper and
   focus in place. Open material feedback and leave an unsent draft, then put
   the caret in the edited paragraph. Press F6 to open the review and Escape to
   return to the same caret without scrolling. Reopen feedback and confirm the
   unsent draft is intact, then return to the caret. Open the review again with F6,
   accept by keyboard, then press Escape and confirm that the original caret
   returns without scrolling. Undo and redo, then save and reopen. Compare the two paragraphs and
   confirm the source file remains unchanged. Download this working copy as `oleafly-export.docx` for
   the Word round trip. After exporting, request a suggestion on another plain
   paragraph and edit its target while the request is pending. Confirm that the
   old suggestion cannot be accepted.

On the same candidate, open **Edit LaTeX** on the total-loss equation in the
[formula manuscript](#word-formula-editing-on-a-published-manuscript). Change
the draft, dismiss it with Escape and reopen the same equation in the same
revision. Confirm that the draft returns, then submit by keyboard and undo and
redo the replacement. No other equation should change. Use the fixture in the
[embedded chart check](#word-embedded-chart-workbook) to select its chart and
open **Export embedded workbook**. Cancel and retry in the native save dialog;
compare the export with the embedded workbook and confirm that the manuscript
does not change.

Record the candidate version and the build commit or artifact reference with
the result. The isolated [review desktop check](#published-docx-review-desktop-check)
also exercises review and reopening
with scripted inputs. It does not replace this check. Neither check requires
Microsoft Word or opens the citation-write preview.

On 2026-11-21, a local system-input check used the existing isolated macOS
debug shell with the current development frontend and citation preview off.
The file tree opened the nine-page manuscript with a configured Workbench
interpreter. Dragging over `[1]` left the context strip closed; Shift+F10
opened it, and Escape preserved the selection for copying into TextEdit.
Clicking `[1]` exposed its Zotero source. A keyboard edit to `4AD876D5`
survived undo, redo, save and reopening from the file tree. The copy saved
through the native dialog changed only that paragraph's text and retained the
field instructions, bookmarks and section columns. The original hash was
unchanged. The local-only export is
`.private/word-system-input.0BSfK6/oleafly-desktop-check.docx`.
This check did not exercise Agent review or first launch in a clean account;
the packaged candidate and Microsoft Word round trip remain unverified.

### Default Word round trip

Keep citation preview off. In Microsoft Word, open `oleafly-export.docx` from
the [candidate check](#word-context-tools-release-candidate-check). Confirm that
it opens without a repair prompt and that both edits, the existing citation
markers, and the two-column
sections are intact, and save a separate copy as `word-save.docx` without editing
or refreshing fields. Record the Microsoft Word version used.

Re-import `word-save.docx` in Oleafly. Open an existing Zotero citation's source.
Choose an existing plain, field-free body paragraph and record its unique
`w14:paraId` from the Word-saved copy. Type `ROUNDTRIP ` at the start of that
paragraph as the only new edit. Undo, redo, save and reopen, then verify the prefix
and download `oleafly-reexport.docx`. Check the retained files from the repository
root:

```bash
PYTHONPATH=services/research-workbench/src \
  services/research-workbench/.venv/bin/python -B e2e/tests/docx-real-package.py \
  --word-round-trip /path/to/8227226.docx /path/to/oleafly-export.docx \
  /path/to/word-save.docx /path/to/oleafly-reexport.docx 0E8ABDCF,4AD876D5 AAAAAAAA ROUNDTRIP
```

Replace `AAAAAAAA` with the paragraph ID from the Word-saved copy. The check
reports hashes and errors, not manuscript text. Compare the original
hash with the one recorded before import. It checks that only the two named
paragraphs changed in the first export and checks fields, bookmarks and declared
section columns through both exports. It allows Word to re-encode fields, but
checks that each field instruction stays with its surrounding text even when
two fields display the same marker. For third-party and other non-native fields,
it also checks paragraph identity when the same ID is unique in its document
part before and after the save. It compares main-document prose outside fields
across the Word save and the re-import edit. Only the stated paragraph may gain
the prefix. The check does not verify Word rendering
or editor input. For a file-only check before opening Word, use
`--word-export ORIGINAL OLEAFLY_EXPORT 0E8ABDCF,4AD876D5`.

This path does not add citations. Before enabling citation writes, also complete
the [native citation round trip](#word-citation-round-trip-acceptance).

### Published DOCX review desktop check

Use the same Zenodo DOCX in an [isolated E2E desktop bundle](#isolated-web-storage).
Leave the desktop unlocked and the Oleafly window visible. The Word desktop
cases check visibility before importing the manuscript: macOS can suspend
WebKit rendering while the desktop is locked. This test needs neither citation
preview nor Crossref:

```bash
OLEAFLY_E2E_APP_BINARY="/path/to/e2e/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_PUBLISHED_DOCX="$PWD/.private/word-real-acceptance/candidates/8227226.docx" \
OLEAFLY_DOCX_REVIEW_ACCEPTANCE=1 ./scripts/e2e.sh \
  e2e/tests/143-material-workspace.spec.ts --grep 'published DOCX review' --retries=0
```

The review-only test and the published citation run use the same review sequence.
While a local scripted stream waits, the test edits another paragraph. The ready
suggestion leaves focus and paper in place. In a 940 × 620 viewport, the test opens
review, tabs to Accept, and closes with Escape without shifting the paper. Undo
and redo after acceptance leave the other edit intact. Editing the target of a
second suggestion makes it unavailable for acceptance. A background text edit
then withdraws a ready suggestion while its inline action has focus. Focus
returns to Document tools without opening it, and the Agent receipt appears
without moving or resizing the paper or viewport. At 940 × 620 the receipt
stays outside the editor viewport, its follow control is focusable and not
covered, and pausing follow leaves the paper in place. Undo restores the text.
The review-only test then saves and opens a new working session, comparing the
text of all three target paragraphs and checking that the project source and the downloaded original
are unchanged. The bridge supplies pointer and edit events and button activation;
this does not replace manual mouse and keyboard verification.

On 2026-11-21, this check passed with citation preview off in an isolated macOS
development shell loading the current frontend. In the reopened working copy,
system mouse drags across a page break and Zotero citation `[5]` left the
tools closed. Command+C and paste into TextEdit kept text from both pages and
retained the on-screen citation marker with the surrounding text. Shift+F10
opened the tools; Escape kept the selection, and **Copy** and Command+C pasted
the same cross-page text. Scrolling the anchor out of view closed the tools
without scrolling back. The citation source and Figure 4 preview opened beside
their objects without visibly shifting the paper. The native save dialog
exported `.private/word-real-acceptance/8227226-macos-default-review-export.docx`
(local-only); `--word-export` confirmed the original input hash, fields,
bookmarks and section columns, and found prose changes only in the two trial
paragraphs. The narrow-window review used the test bridge.
The [release candidate check](#word-context-tools-release-candidate-check) and
[Microsoft Word round trip](#default-word-round-trip) remain separate.

### Word citation picker desktop check

Use an [isolated E2E desktop bundle](#isolated-web-storage) built with both
`VITE_E2E_HOOKS=1` and `VITE_DOCX_CITATION_PREVIEW=1`. To obtain one on macOS,
manually run `CI` on a ref containing the workflow change with
`build_macos_citation_preview` enabled, and download `e2e-app-macos-citation-preview`.
The standard E2E and release builds explicitly disable the preview. Run the check
from the repository root with an unlocked desktop, a visible Oleafly window,
internet access and the Workbench environment:

```bash
OLEAFLY_E2E_APP_BINARY="/path/to/e2e/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_DOCX_CITATION_ACCEPTANCE=1 ./scripts/e2e.sh \
  e2e/tests/143-material-workspace.spec.ts --grep 'DOCX citation picker' --retries=0
```

By default the test uses a synthetic two-column DOCX and sends only a public
title and DOI to Crossref. Set `OLEAFLY_PUBLISHED_DOCX` to the original Zenodo
8227226 DOCX from the [browser check](#published-two-column-docx-browser-check)
to use the published manuscript. That run verifies the input's SHA-256 and
looks up the trial DOI without sending manuscript text to Crossref. Both runs
check that keyboard invocation leaves the paper in place, that search-field
undo and redo through the app's menu handlers leave the manuscript unchanged,
and that two target paragraphs share one source. Undoing the second citation
keeps the source;
undoing the first removes it. Both fields resolve to the correct source after
redo, save and reopen, including when their displayed text wraps across lines.
The export is checked independently. The published run first performs the
[review sequence](#published-docx-review-desktop-check) in the same working copy
and checks that those edits survive alongside the citations. The bridge supplies
pointer and edit events, button activation and the export path. It does not
verify the system clipboard, hardware key activation, the native save dialog,
or Microsoft Word.

A separate manual check on the isolated macOS bundle used the same synthetic
two-column export. Dragging across two lines in the right column and pressing
Command+C did not open the toolbar or move the page. Command+V into TextEdit
reproduced the selected sentence, including the citation's visible placeholder.
Right-click in the right column and Shift+F10 in the left opened the toolbar
beside their respective selections; Escape closed it without losing the
selection or moving the page. In a separate synthetic DOCX with one paragraph
split across two pages, dragging across the break did not open the toolbar.
Right-click opened it on the clicked page; Shift+F10 opened it on the page where
the drag ended. Escape preserved both fragments of the selection, and system
copy and paste into TextEdit preserved both sentences with a line break. These
checks did not use the long manuscript.

On the same macOS preview bundle, a manual check with the Zenodo manuscript
dragged across the Zotero citation `[1]` and adjoining text. Command+C kept
the selection visible without opening the toolbar or moving the page;
Command+V into TextEdit reproduced the marker and the selected text. A separate
click on `[1]` opened the matching source. A keyboard selection across a page
break copied text from both pages into TextEdit. In the right column, Shift+F10
opened the text actions and Escape left the selection in place. This run used
the system clipboard, not the test bridge; it did not use a newly built app.

The Zenodo manuscript was also tested with the development frontend in a
separately identified macOS WebView shell. A real drag left the floating tools
closed; system copy and paste into a new TextEdit document reproduced the
selected text including `[1]`. In the right column, Shift+F10 opened the tools
and Escape returned focus to the paper. After saving and reopening from the
project tree, the accepted rewrite and independent manual edit remained, and
the source hash was unchanged. The scripted review portion of case 143 reached
the Crossref step but did not pass the full case: that shell did not register
`crossref_work`, and its HarfBuzz initialization fell back. This run did not
verify the current packaged app, exact font layout, or the Microsoft Word
round trip.

After moving HarfBuzz asset setup into the shared Word editor, the same
development-shell setup loaded the WebAssembly binary and reported `shaped`
measurement for the nine-page Zenodo manuscript. The document still reported
missing fonts; shaped measurement does not establish exact font fidelity. A
system mouse drag across a page break left the context tools closed. Shift+F10
opened the selection actions, and after Escape, system copy and paste into
TextEdit reproduced text from both pages. Case 143 now requires shaped
measurement before editing. With the caret check based on the active editor and
its collapsed selection, the separate [review check](#published-docx-review-desktop-check)
passed through reopening in this shell. Its combined run stopped at DOI lookup
because that native binary lacked `crossref_work`.

On 2026-11-20 the combined nine-page run passed in an isolated macOS debug
shell compiled from the current Rust source and serving the current development
frontend. Both DOI lookups used real Crossref, the two reopened citations each
resolved to the same source, and the exported package retained the original
Zotero fields, bookmarks and columns. The synthetic two-column case also passed
in that shell. The final published export and local-only result are in
`.private/word-citation-current/published-final/`. This verifies the native development
path, not a packaged release or the Microsoft Word round trip. The Chrome
working-copy and published manuscript checks used scripted citation lookups.

### Word citation round-trip acceptance

The native `143` case exercises desktop review and citation export and writes
`oleafly-export.docx` for Microsoft Word. For full acceptance, also follow the
[desktop input and Word checklist](../docs/word-workspace-design.md#2-中栏是一张工作底板)
on an authorized copy, including real keyboard, pointer, and clipboard use.

#### Desktop review and export

Use an authorized long two-column manuscript with resolvable native Word
citations. Keep the author original read-only. If an authorized manuscript has
only third-party citations, use Microsoft Word to add a native citation to a
separate copy without editing the existing fields. Save and preflight that copy
as the read-only round-trip baseline. Select three plain, field-free body
paragraphs and record their distinct `w14:paraId` values in
`left,edit,right` order:

- `left` and `right` start in the left and right columns of the same page.
  `left` uses uniform formatting throughout so it can receive a paragraph suggestion.
- `edit` is the separate paragraph used for an ordinary edit while the review
  suggestion is pending.
- Every ID has eight hexadecimal digits, comes from the main document body, and
  its paragraph accepts a caret at the start. Do not use display paragraph
  numbers or IDs from a table, text box, header or footnote.

Choose a Crossref journal article with a new DOI and a title absent from existing
source titles and cached bibliography results. To check the input without opening
the desktop app, run this from the repository root:

```bash
PYTHONPATH=services/research-workbench/src \
  services/research-workbench/.venv/bin/python -B e2e/tests/docx-real-package.py \
  --citation-input /path/to/authorized-manuscript.docx 10.1234/example \
  AAAAAAAA,BBBBBBBB,CCCCCCCC
```

The preflight checks that the file has a two-column section, a resolvable native
citation in the main document, no bibliography record for the trial DOI, and
Track Changes turned off. The preview does not write tracked citations.
It checks that the three IDs each name one plain, field-free body paragraph,
including paragraphs that look plain but are inside a spanning field. It prints
counts and failures, not manuscript text or references. Confirm the actual
left and right column placement and the review paragraph's formatting in the editor;
the package check does not render pages.

Use the isolated
[citation-preview build](#word-citation-picker-desktop-check); the standard E2E
and release bundles keep citation writes disabled. Run from the repository root
with the Workbench environment created by `pnpm workbench:setup`:

```bash
OLEAFLY_E2E_APP_BINARY="/path/to/citation-preview/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_WORD_ORIGINAL_DOCX="/absolute/path/to/authorized-manuscript.docx" \
OLEAFLY_WORD_TRIAL_DOI="10.1234/example" \
OLEAFLY_WORD_TRIAL_PARAGRAPHS="AAAAAAAA,BBBBBBBB,CCCCCCCC" \
./scripts/e2e.sh e2e/tests/143-material-workspace.spec.ts \
  --grep 'authorized Word manuscript survives desktop review and citation export' \
  --output .private/word-citation-round-trip \
  --retries=0
```

The run repeats the input preflight before import. In the desktop app, the case
performs a scripted review suggestion on `left`, edits `edit`, accepts and undoes/redoes the
suggestion, and inserts the same DOI in `left` and `right`. Both citation fields
must share one source and resolve to it again after undo, redo, save and reopen.
The test writes `oleafly-export.docx` to its Playwright output directory and runs
`--citation-export ORIGINAL EXPORT DOI LEFT,EDIT,RIGHT`. It verifies a citation
at the start of each named column paragraph, and prose changes only in `left`
and `edit`, with both edits present. The result must contain `ok: true` and
an empty `issues` array, and the original hash must remain unchanged. Locate the
retained artifact with:

```bash
find .private/word-citation-round-trip -name oleafly-export.docx -print
```

This case uses WebView pointer and edit events, dispatched keys and a test save
path. It does not use system mouse or keyboard input, the native save dialog,
Microsoft Word or Word's field refresh. A green run is not a Microsoft Word
round-trip result.

#### Microsoft Word and re-import

Open `oleafly-export.docx` in Microsoft Word with the normal system input.
Before updating the fields, record both trial citations; they should still show
Oleafly's `⟦title⟧` placeholder. Update the citations and bibliography, and
confirm both placeholders are replaced, the new source has one bibliography
entry, existing citations still resolve, the rendered style is correct, and Word
shows no repair prompt. Refresh or insert the native bibliography field without
adding a separate gallery heading or making unrelated prose edits. Save the
refreshed manuscript separately as `word-save.docx`.

For the full comparison after Word saves, run this on macOS:

```bash
PYTHONPATH=services/research-workbench/src \
  services/research-workbench/.venv/bin/python -B e2e/tests/docx-real-package.py \
  --citation-round-trip /path/to/original.docx /path/to/oleafly-export.docx \
  /path/to/word-save.docx 10.1234/example AAAAAAAA,BBBBBBBB,CCCCCCCC
```

On Windows PowerShell:

```powershell
$env:PYTHONPATH = 'services/research-workbench/src'
& .\services\research-workbench\.venv\Scripts\python.exe -B e2e/tests/docx-real-package.py `
  --citation-round-trip C:\acceptance\original.docx C:\acceptance\oleafly-export.docx `
  C:\acceptance\word-save.docx 10.1234/example 'AAAAAAAA,BBBBBBBB,CCCCCCCC'
```

Use the same `left,edit,right` paragraph IDs as in the input preflight. The
read-only check reports each file's hash and exits nonzero if it finds a
mismatch or cannot verify the native citations. Compare the reported original
hash with the one recorded before import. It counts occurrences of each
existing native citation's full set of sources in both copies, resolving tags
through the linked bibliography by DOI or, when no DOI is recorded, by Word
source GUID. Retagging a source or converting a simple field to a complex field
does not by itself fail acceptance. A field with an unresolved source is not
counted as preserved. The Oleafly export must keep earlier citations in the same
paragraphs and order, preserve existing citation and bibliography instructions,
field boundaries and cached results, and keep the contents and counts of existing
source records, including uncited ones. In main-document paragraphs whose prose
has not changed, the check also verifies that existing citations stay at the
same position in the prose. For paragraphs rewritten during review, confirm the
citation positions in the editor; the check does not infer positions across a rewrite.
For the Word save, the check compares existing source contents and counts,
including uncited sources, independently of their tags. It compares citation
order and paragraph grouping without requiring the same paragraph numbers:
refreshing a bibliography can add or remove paragraphs. It also compares citation
options such as page numbers, prefixes and omitted authors, ignoring locale and
field-format switches. It compares main-document text outside fields with the
Oleafly export, including the independently edited paragraph. This text check
normalizes whitespace and ignores run splits, empty paragraphs, and
cached field results, including bibliography results that span paragraphs.
Text boxes are outside its scope. The check also compares prose on both sides of trial and
pre-existing citation fields. Confirm the locations on the rendered pages in Word.

For non-native fields, including third-party citations and unknown instructions,
the Oleafly export must preserve each paragraph's field order, instructions,
cached text, and boundaries. Where paragraph prose is unchanged, the check also
rejects moves within a paragraph, both on first export and after re-import.
The preflight checks field locks and auxiliary data, such as `fldData` and
`ffData`, at their original field boundaries. For the
Word save, the check compares the original field instructions with their
surrounding prose and checks that locks and auxiliary data survive in the same
document parts. Word can change field encoding and cached results. The check
also verifies that neither trial citation retains a
placeholder and that the trial source title now occurs once in the native
bibliography results, as well as comparing named bookmark pairs and declared
section columns. In Word, record both trial citations before and after updating
them, and confirm the rebuilt bibliography contains one separate entry for the
trial source. Check that existing citations still point to the intended sources,
the rendered style is correct, and no repair prompt appears.

Re-import the Word copy into Oleafly and verify that both trial citations open
the correct source. Choose a plain, field-free body paragraph and record its
unique `w14:paraId` from the Word-saved copy. As the only new edit, type
`ROUNDTRIP ` at the start of that paragraph. Undo, redo, save, reopen and
confirm the edit. Download a new copy and run the same checker with
`--citation-reimport WORD_SAVE OLEAFLY_REEXPORT DOI EDIT_PARA_ID ROUNDTRIP`.
It compares the fields and their results, linked bibliography stores, field locks and auxiliary data,
bookmarks, and columns against the Word save. It also compares the prose on either
side of each trial and pre-existing native citation, ignoring run splits and
whitespace, and verifies that the trial prefix is the only change to
main-document prose outside fields and text boxes, at the recorded paragraph ID.
The interactive steps still need to be observed in Oleafly.

The desktop case `143` can re-import the refreshed Word copy using a standard
isolated E2E build; citation preview is not needed:

```bash
OLEAFLY_E2E_APP_BINARY="/path/to/e2e/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_WORD_REIMPORT_DOCX="/absolute/path/to/word-save.docx" \
OLEAFLY_WORD_REIMPORT_DOI="10.1234/example" \
./scripts/e2e.sh e2e/tests/143-material-workspace.spec.ts \
  --grep 'Word citation re-import remains editable on desktop' \
  --output .private/word-reimport-desktop-results --retries=0
```

The case checks both DOI link addresses before and after reopening, edits a
separate paragraph, undoes and redoes the edit, and exports
`oleafly-reexport.docx`. It verifies the edit at the same paragraph ID, runs
`--citation-reimport` on the export, and checks that the input bytes are unchanged.
The bridge supplies input events and the export path. This case reads the link
addresses without opening the browser and does not replace the manual checks in Word.

The browser spec `126-docx-workspace-browser` with `--grep 're-imported DOCX'`
checks the Oleafly half using a synthetic two-column file. It includes split
citation instructions, identical visible citation text for different sources,
a cross-paragraph bibliography and protected third-party fields. With Vite
running on port 1420, you can run the same browser steps on the authorized Word
save from the full procedure:

```bash
OLEAFLY_WORD_REIMPORT_DOCX=/absolute/path/to/word-save.docx \
OLEAFLY_WORD_REIMPORT_DOI=10.1234/example \
node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.ts \
  e2e/tests/126-docx-workspace-browser.spec.ts --grep 're-imported DOCX from' \
  --output .private/word-reimport-results
```

Both tests locate two trial citations and a separate plain-text edit
target among top-level body paragraphs with unique `w14:paraId` values. If the
tests cannot locate them (for example, the Word save lacks paragraph IDs), use the
manual re-import check. That is a test limitation, not a failure of the file.
The browser test verifies the full DOI opened by each source action before and after
saving, then checks that the downloaded copy contains the edit in the same
paragraph. Match the input hash in the result to the Word save hash from
`--citation-round-trip`. Keep the re-export and failure artifacts private.
This test does not require citation preview and does not run Microsoft Word
or the desktop UI.

### Word formula editing on a published manuscript

On 2026-11-20, the isolated macOS development shell opened the CC BY 4.0
[Zenodo 19911490](https://zenodo.org/records/19911490) DOCX. A click on the
total-loss equation revealed **Edit LaTeX** beside it. Keyboard submission
moved focus to Close while Pandoc converted the replacement. Command+Z and
Command+Shift+Z moved through the edit history. After saving and reopening the
working copy, **Download DOCX copy** exported it through the system save dialog.
The export retained all 14 native formulas, with canonical OMML changed only
at the target. Body text, double-column settings and embedded image bytes were
unchanged, and the replacement source remained in the package. The author
input hash was unchanged. The editor reported unavailable fonts; this checks
editing and persistence, not font fidelity or Microsoft Word interoperability.
The local-only export is `.private/word-real-acceptance/19911490-macos-formula-export.docx`.

### Word embedded image preview

With the regular Vite server and an installed Workbench environment, run:

```bash
node node_modules/@playwright/test/cli.js test \
  -c e2e/playwright.config.ts e2e/tests/126-docx-workspace-browser.spec.ts \
  --grep 'embedded image' --retries=0
```

The synthetic DOCX has an inline image and a floating image. The test clicks
each and checks the preview pixels. The floating image's tools stay beside the
picture, away from its anchor paragraph. Clicking it again after closing the
tools does not create a revision. Dragging the selected image moves it without
reopening the tools. After two drags and scrolling down and back, keyboard undo
restores one position per press without moving the paper or viewport. The test
presses **Shift+F10**, then **Enter** without waiting for focus, both from the
inline image's caret and after clicking the floating image. Each opens the
correct preview and leaves the body text and revision unchanged.
Ordinary text selection stays quiet,
the preview fits inside a short, narrow editor without changing page geometry,
scroll or revision, and scrolling the picture out of view closes the preview
without pulling the paper back. When the preview held focus, the viewport
receives it. The test restores the wide editor and verifies that selecting the
floating picture again does not scroll. No citation preview flag is required.

On 2026-11-20, the nine-page Zenodo manuscript also opened Figures 5 and 6
in the isolated macOS development shell using desktop mouse and keyboard input.
The actions stayed beside the pictures; the previews matched their respective
DOCX media bytes. Shift+F10 focused the action, Escape and scrolling offscreen
closed it, and the verified preview sequence kept the scroll position and
document revision unchanged. Dragging a resize handle did not open the tools.
In a separate instrumented desktop check, resizing Figure 5, scrolling down
and back, and pressing Command+Z restored the figure bounds at the same scroll
offset. An earlier mixed scroll and undo sequence jumped to the end; the jump
did not recur there or in the Chrome harness's two-drag keyboard regression.
The harness exercises the editor's shortcut independently of the app's global
shortcut handler. An immediate Enter also reached the editor instead of the
toolbar. A focused regression reproduced the paragraph split before React
committed the toolbar. The shortcut now commits a recognized action before
returning from the key handler. The component regression and the Chrome image,
chart, citation picker and published manuscript cases passed. In the macOS
development shell, traced desktop key presses reached the image action when
switching between Figures 5 and 6, from the caret beside Figure 5, and after
selecting a floating image on the first page. Each shortcut kept its starting
scroll position; no edit event fired, the revision stayed at zero, and Undo
stayed disabled. One earlier attempt edited the isolated copy before event
tracing was attached; it did not recur in these runs. The author input hash was
unchanged. This was not a packaged release check.

### Word embedded chart workbook

With the same Vite and Workbench setup, run the Word browser spec with
`--grep 'embedded chart exports'`. The [frozen WPS fixture](../services/research-workbench/tests/fixtures/docx/native/s1-native-complex-objects/s1-native-complex-objects.docx)
contains the classic chart `RFW-FX-EO-CHART-001` and its linked
`word/embeddings/Workbook1.xlsx`. The test selects the chart, opens the action by
keyboard, and compares the export byte for byte with the workbook inside the DOCX.
It checks that page geometry, scroll and revision stay unchanged. With scripted
desktop IPC, repeating Enter while the save dialog is pending sends only one
request. Cancelling keeps the action focused and lets the user retry. The test
checks the saved bytes and confirms that switching to Source before the dialog
returns prevents the write. It also checks the
case where the dialog returns after the chart has scrolled out of view, before
the action strip closes: nothing is written, and focus stays in the viewport
without reversing the scroll.

To check the real desktop export, use an [isolated E2E bundle](#isolated-web-storage)
built with `VITE_E2E_HOOKS=1` and the Workbench environment:

```bash
OLEAFLY_E2E_APP_BINARY="/path/to/e2e/Oleafly.app/Contents/MacOS/oleafly" \
OLEAFLY_WORKBENCH_PYTHON="$PWD/services/research-workbench/.venv/bin/python" \
OLEAFLY_MATERIAL_WORKSPACE=1 ./scripts/e2e.sh \
  e2e/tests/143-material-workspace.spec.ts --grep 'DOCX chart exports' --retries=0
```

The desktop check uses the same WPS fixture. It opens the chart action by keyboard,
cancels once, then exports through Tauri and compares the saved file with the
embedded workbook. The test bridge supplies the dialog results.

A separate manual check on the isolated macOS bundle used the system save
dialog. Cancelling left the chart action focused; opening it again and saving
returned focus to the paper without moving it. The exported workbook matched
the embedded file byte for byte, and the input DOCX stayed unchanged. Oleafly
showed the chart as a placeholder. Neither check verifies its rendering in
Excel or Microsoft Word.

### Journal template browser tests

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

### Whole-manuscript live Word acceptance

`145-word-manuscript-live.spec.ts` runs the English and Chinese manuscripts as
separate Sol tasks with `reasoningEffort=max` and a 20-minute budget per task.
It requires the same read-only template and manuscript paths and exact hashes
as the native template command above. Replace `OLEAFLY_WORD_TEMPLATE_LIVE` with
`OLEAFLY_WORD_MANUSCRIPT_LIVE=1` and provide
`OLEAFLY_DOCX_LIVE_URL=http://127.0.0.1:PORT/v1` to the same runner. These two
live modes are mutually exclusive. The whole-manuscript mode runs only `145`.
Provider configuration belongs to the runner's isolated application library.
Task startup waits for the actual generation-zero DOCX binding activity after
the UI bind action and verifies its complete document identity before execution.

Run native visual acceptance with an unlocked, visible console. macOS can suspend
WebKit animation frames while the console is locked, preventing real PDF painting
and the deterministic takeover steps. A data-only diagnostic that omits those
steps does not establish a `145` pass.

While waiting for a model task, a Playwright eval timeout is logged as a missing
read-only status observation and polling continues within the original deadline.
Other query errors fail immediately. A terminal state must still come from a
successful query; this does not retry edits or extend the task budget.

The scenario creates managed copies with controlled format errors distributed
across four selected paragraphs, three table cells and the first section,
plus one editorial marker appended to an existing plain-text paragraph. The
task names the selected target paragraphs by their exact text, the three table
numbers and the first section. It authorizes changes only to those targets
and removal of the unique marker. Independent expected format values remain
in the test. Paragraph edits are limited to size (including complex-script size),
ordinary bold and alignment, with paragraph-mark updates limited to the same
formatting API; existing complex-script bold is preserved. Cell edits are limited
to vertical alignment and direct fill/shading; section edits to page size and
margins while retaining columns. Font families, styles and spacing are preserved.
Successful model reads must establish full manuscript text coverage,
including continued text and non-body stories, plus the applicable template
text and format evidence. Paragraph text windows and targeted format reads
are accepted. Reading every paragraph's effective format is not required.
The format overview explicitly binds its revision. Its source hash identifies
the live export; narrative-read identity identifies the saved baseline. Empty
footnote and endnote paragraphs are included in non-body coverage. Failed reads
remain in evidence and can be recovered by complete successful reads.

Template reads explicitly use the effective snapshot route for every object and
style definition. Acceptance independently decodes each page's shared dictionaries
and compares identity, text and retained facts with a full pre-task inventory;
metadata references must resolve to that collection's read first page. The inventory
itself is setup evidence and does not count as model reading. Effective views omit
declarations, so targeted raw reads remain necessary where the task needs them.
The three cell targets share the current template's first table/first-cell identity
with text `Symbol`; the prompt supplies its locator without expected format values
and requires a direct property-node read to establish shading presence or absence.

Acceptance checks actual edit, font-preparation, save and check receipts against
the retained DOCX bytes and an independent ZIP/XML oracle. The content assertion
requires the marked paragraph's exact original text and preserves all other
author text. Any normalization of invalid paragraph identities is confined to
the managed fixture and recorded explicitly. It verifies that the
previous check becomes stale, the final check identifies the saved baseline and
selected template, normal reopen restores that saved source, and the public
DOCX export matches its exact retained bytes. Template
differences and unresolved cases are recorded without requiring every finding
to disappear. After multiple saves, acceptance checks the saved checkpoint of the
last changed operation before the final save. It preserves that operation's original
document identity and previous checkpoints; the save request, final receipt and
retained bytes establish the final saved hash.
A separate deterministic takeover probe covers manual navigation
and editing, pause, continued background operations and resumed following on
the real English manuscript before its model task starts. Resume must reveal the
actual target in the viewport, hit the expected paragraph and produce a fresh
highlight in consecutive observations; any reveal-error banner fails the probe.
The pre-probe initial
export remains separate evidence. After discarding probe edits and reopening
the same saved baseline, the test reads a new model-session identity and
paragraph references, then strictly verifies a separate model-start export.
Model read coverage uses that session and its export hash. The probe is
execution evidence, separate from model judgment and reading coverage.

All fixtures, raw transcripts, operation receipts, DOCX outputs and reports stay
under ignored `.private/whole-manuscript/run-*`. The runner passes this directory
as `OLEAFLY_WORD_MANUSCRIPT_RUN`, checks all three author-input hashes before and
after, restores E2E WebKit storage and exits its owned process. The root report
is `word-manuscript-live-report.json`; `runner.json` records lifecycle and input
identities, and `live-wire.json` records requested effort, returned model labels,
HTTP outcomes and usage. Upstream identity remains the provider's evidence.
The scenario must pass on the built application before it establishes a result.
It does not establish Word/WPS pagination equivalence.

The independent XML oracle passes its JSON input through a private temporary file
opened as child stdin, then closes and removes it after either success or failure.
This gives Python a finite EOF for multi-megabyte manuscripts; the oracle script
and format/content assertions are unchanged by this transport choice.

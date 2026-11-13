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
`pnpm tauri dev`. Each run starts by deleting the e2e identifier's storage, so
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
those bytes in a new session and saves through the UI. After native commit has
really saved to Workbench and written the Saved receipt, the test withholds only
the response to React and kills the app again. The final launch replays the fixed
request and checks the same baseline, bytes, request and single Saved receipt,
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
regular/bold faces and network access to the existing PT Serif font-pack URLs. The
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
The subset hash identifies the PDF subset, not the complete cached font. It also repeats
the structural export check after font preparation and verifies reopen reuses a completed
render. It then applies one permitted text edit through the existing Agent host, saves a new
baseline with the workspace button and checks the saved DOCX structure and regenerated PDF.
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

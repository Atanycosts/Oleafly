# Journal-world workbench

This document defines the first journal-world slice. It is an implemented local workflow for
page geometry; it is not a full journal compliance engine. The
[machine-readable world contract](../../contracts/journals/world-contract.json) owns the current
world, analyzer, checker and HTTP identity strings.

## User flow

1. The operator selects a journal identifier, name, article type, submission stage, language and
   captured sources.
2. The analyzer creates a deterministic world version immediately. There is no mandatory publish
   gate before viewing or binding a local world.
3. The project binds an explicit world version. A later version is shown as an available update;
   it never silently changes an existing project binding.
4. A check reads the retained manuscript snapshot and compares the declared section geometry with
   rules in the selected world.
5. The rule map groups results by property. Selecting a rule shows the rule evidence and the
   manuscript section observations together.
6. The operator may record a note or defer a finding. A disposition never changes the check verdict.
7. A rule correction creates a new world version. The original world, source evidence and old checks
   remain recoverable. The manuscript binding does not move automatically.

## World data

The world includes captured source hashes, a declared context, deterministic analyzer and reader
versions, rules, evidence locators, confirmation basis and coverage gaps. Sources are operator
supplied; their bytes and publisher status are not authenticated by the workbench.

Template geometry is a candidate observation. A narrow, unconditional requirement sentence in a
supplied UTF-8 guide can create a confirmed rule for the declared context. Conflicting guides,
conditional text, negative text, unsupported grammar and PDF guide semantics remain conflict or
coverage gaps. A declarative rule component is strict data and remains a candidate; it cannot load
code or execute a command.

The current property vocabulary is page width, page height, four margins and column count. Values
are stored as twips or count. Missing values and mixed template sections remain unknown; no default
paper size, margin or column count is invented.

## Check results

An applicable confirmed rule produces `compliant` only when every required section is observed and
matches. A known mismatch produces `violation` even when another section has a missing value; the
missing coverage stays visible alongside that violation. Candidate comparisons produce
`observed_match` or `observed_difference`, never formal violations. Candidate matching also requires
complete coverage; a known candidate difference is retained even when other sections are unknown.
Conflicts and incomplete coverage with no known difference produce `cannot_determine`. A scope
outside the supported check is `not_checked`. Current findings retain a verdict for each section.

The four independent presentation axes are rule basis, check verdict, current validity and operator
disposition. Applicability is an additional scope result, not a replacement for any axis. A new world
version does not stale an old check by itself. A changed manuscript baseline, binding, analyzer,
reader or checker method makes the historical check stale; its original conclusion remains immutable. The
interface shows stale findings as historical observations, not as current green passes. Counts of
formal violations, candidate differences, undetermined rules and unchecked rules are kept separate.
The summary also distinguishes source-material gaps from missing manuscript observations. A missing
observation is a returned section/property finding with `observed: null`; a conflict that prevented
checking does not invent missing section observations.

For a human-corrected rule, the evidence panel shows the recorded reason, actor and previous-to-new
value. Original source excerpts remain visible and unchanged, even when they disagree with the
operator's selected expectation.

## One retained world, explicit current use

New check records store a `world_version_id` reference and exact source/method dependencies. They
do not duplicate the world manifest. The service joins that retained world into the check response
for display and derives `validity`, `stale_reasons`, `update_available` and dispositions when reading.
Those presentation fields are not independent writable check authority. Binding and check commits
recheck the source baseline and current binding; a concurrent change cannot publish an apparently
current result for the wrong version.

Retained bytes, identities, source references and record consistency are checked before historical
retrieval. Reading an older analyzer or checker result does not execute the old engine. Historical
checker 1.0.0 records keep their original aggregation and may lack per-section verdicts; the UI labels
that missing historical information rather than inventing it. New checks and rule corrections require
the current analyzer and reader. Re-import the retained source files to establish a current world;
do not relabel old records or silently switch a manuscript binding.

World comparisons include expectation, basis, scope, unit, evidence and correction reason. A same-
journal change in article type, submission stage or language is shown even if every numeric value
is equal. Cross-journal comparison likewise does not authorize automatic rebinding or manuscript edits.

## Browser and local service contract

The existing [machine-readable world contract](../../contracts/journals/world-contract.json) also
owns the HTTP contract; there is no separate client-side rule or publication system.

- `GET /api/session` returns a process token, `contract_version` and `asset_version`. POST requests
  carry `X-RFW-Token`. The browser accepts only the HTTP contract declared by that owning contract.
- The server binds IPv4 loopback and verifies local Host/Origin. It snapshots static assets when it
  starts. `asset_version` identifies those served bytes, not the latest files subsequently edited on
  disk. Restart the server after code changes, then reload the page. A changed asset identity during
  a session requires a reload; the UI does not keep mutating through a mixed version session.
- Manuscript import sends `{name, filename, content_base64}`: `name` is the display label and may
  omit the extension; `filename` is the original DOCX basename; only captured bytes cross HTTP.
- `GET /api/manuscript-source` requires `project_id` and an explicit `baseline_id`. It returns that
  retained DOCX artifact and recorded hash; it never reads the original author path or creates a
  structured read receipt.
- World input and state summaries use `journal_name`. There is no fallback `name` alias. Every
  source has its explicitly selected `kind`, original label and captured bytes.
- `POST /api/world-component` takes `{version_id, name, content_base64}` and optional
  `sources`, `decisions` and `preview`. Captured sources use `{name, kind, content_base64}`;
  selected operator decisions use `{property, expected, reason}`. It analyzes the component
  and captured sources with the selected version, carries prior decisions and applies the
  new decisions. `preview: true` returns the proposed world without saving; adoption saves
  one immutable version. Neither operation moves a manuscript binding. The operator UI can
  explicitly bind the adopted version and run the existing check as the next action.
  Component quotations and applicability remain supplied declarations. The existing component
  parser validates the schema; adding a model-generated component does not authenticate its
  quoted guide or promote a candidate to a confirmed journal requirement.
- Initial binding sends `expected_binding_id: null`; changing an existing binding sends the exact
  current ID. A conflicting binding returns HTTP 409, which requires rereading current state.
- Malformed requests and responses remain visible errors. Refreshing loads all required records
  before replacing the displayed state. If saving succeeded but refresh failed, the UI states what
  was saved and asks for a refresh rather than a repeated submission.

## Current limits

- The slice checks declared OOXML section values. It does not compute final paragraph/run formatting,
  theme-font resolution, rendered page layout or full journal requirements.
- PDF guide sources are retained and yield page- and region-bound text fragments
  (`journal-pdf-source-1.0.0`): reading order follows a deterministic column-band heuristic,
  headings are font-derived, and bounding boxes are PDF points with a top-left origin. Block
  segmentation follows the PDF text layer, so equations and figures inside text blocks extract
  imperfectly, and rotated pages preview in their unrotated page space so previews align with
  fragment boxes. PDF prose feeds the same narrow requirement recognizer as text guidance;
  conditional, negative or unparsed blocks remain explicit gaps and never become confirmed rules.
- The interface is local and uses a per-process session token. It is not an authenticated remote MCP.
- Uploading a manuscript creates an application-owned project snapshot and never modifies the source.
- There is no manuscript editing or automatic publication operation in this slice.

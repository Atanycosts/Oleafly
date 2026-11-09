# Desktop research workbench

The active desktop is Oleafly, using one application service for journal review and retained
manuscript reading. Oleafly `src-tauri/src/journal_workbench.rs` owns the child process and
shutdown. The earlier standalone shell is archived locally; the packaging section below records
its historical procedure. `workbench/` owns application
coordination, HTTP transport and browser views. `journals/`, `projects/` and `docx/` retain
their domain responsibilities. There is one active browser implementation and one service entry.

## Review model

The rule map moves through journal world, format component and rule. Rule review presents
the current question, candidate sources and manuscript observations in three columns.
Selecting a source reveals its exact fragment, parent context and child sentences. The adopted
value is separate from the source quotation and the observed manuscript value.

Source units have immutable byte-bound identities and locators. Sentence offsets use Unicode
code points. DOCX units reuse the bounded reader's text projection, table cells and source nodes;
they do not infer physical pages. Unsupported PDF guidance remains an explicit extraction gap.

Related rules and sources use deterministic lexical vectors and cosine similarity. The value
measures textual resemblance for retrieval order; it is not calibrated probability. Suggestions
cannot confirm a rule, change a check verdict or merge components. Possible duplicates remain
two independently inspectable declarations. No external model receives manuscript content.

Rule basis, applicability, original verdict, current validity and operator disposition remain
separate. Correcting a rule makes a new world; updating a manuscript creates a new baseline.
The user explicitly rebinds the new manuscript baseline before checking it. Historical checks,
source bytes and delivered read responses are retained unchanged.

## Connected capabilities

- Journal import, exact version binding, checking, rule correction, notes, defer and comparison.
- Source fragments, source-node properties, related rules and possible component duplicates.
- All reader object types and regions, individual or paginated reads, exact read receipts.
- Manuscript baseline updates, checks, bindings and reading history across saved versions.
- Captured PDF, page image, render record and paired independent annotation registration.
- Explicit page evidence selection and exact image/PDF presentation; physical-page queries
  still require independently reviewed mappings supported by the existing query engine.

The HTTP boundary accepts captured bytes and application identities. Historical path text in
uploaded evidence is not opened. Page registration validates physical PDF count and exact PNG
hashes using the existing project evidence contract; it never runs Office or generates review.

## Runtime and verification

Build using `tools/desktop/build.ps1`. The resulting directory contains the executable and
isolated Python/application/PDF runtime. The shell starts its own service on an available
loopback port. The child reports readiness on its pipe only after library and assets validate.
Closing the owner pipe shuts down that service. A different process on a known port is never
treated as the workbench.

Run the repository's full Python gate, recursive JavaScript syntax checks, Cargo format/tests
and release build. Browser validation covers 1024, 1280 and 1920 pixels, imports, exact source
drill-down, manuscript object reading, revisions, history, failures and refresh after writes.
Native window behavior and real Office rendering are separate validation scopes.

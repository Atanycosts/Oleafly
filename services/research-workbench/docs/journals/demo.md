# Journal-world local demo

The demo runs entirely in an application-owned directory. It accepts captured files through the
browser and never writes beside an author manuscript.

```powershell
$env:PYTHONPATH = "src"
$library = "D:/ResearchWorkbench/journal-library"
python -m research_file_workbench.workbench.cli --library-root $library init
python -m research_file_workbench.workbench.cli --library-root $library --port 8765 serve
```

Every CLI command prints one JSON object on stdout, so `init` reports
`{"library_root": ...}`. Global options such as `--library-root`, `--host` and `--port`
precede the subcommand word.

Open `http://127.0.0.1:8765/`. The workbench supports this path:

1. Add a DOCX template, a UTF-8 guide, or a declarative rule component.
2. The service creates a world version immediately and shows candidate, confirmed, conflict and
   coverage states. A publication action is not required for local binding.
3. Add a DOCX manuscript and a readable display name. The name need not end in `.docx`; the browser
   submits the original filename separately and the service stores the captured bytes in an application project.
4. Bind the manuscript to an explicit world version, then run the page-geometry check.
5. Select a rule bubble to inspect journal evidence and manuscript section observations.
6. Save a note or defer a finding without changing its check verdict. Correcting a rule creates a
   new world version and leaves the existing binding in place.
7. Compare two world versions before changing a binding. The comparison includes basis, source
   evidence and scope, so equal dimensions alone do not imply identical requirements.

The browser keeps the served asset identity internally, requires the HTTP contract declared by the
[journal world contract](../../contracts/journals/world-contract.json), and obtains its process
token from `/api/session`; this is local session protection, not remote account authentication.
`GET /api/manuscript-source` accepts an explicit project and baseline ID, returns the stored DOCX
artifact and hash, and neither reads the original author path nor records a read receipt. The server
captures HTML/CSS/JavaScript at startup. After editing application code, restart the service and
reload the browser rather than relying on a refresh to replace a running Python process or its
assets.

A saved old check is a historical record. After changing its binding, baseline or supported method,
it appears stale and requires a new check for current use. Merely adding a newer journal version
does not change the existing binding. If an older world uses an obsolete analyzer, reading it stays
possible but starting another check requires re-importing its sources under the current analyzer.

The interface reports formal violations, candidate differences, missing observations and uncovered
requirements separately. A known violation is still shown when another section is missing a value;
missing information never becomes a matching default. PDF guides feed the same narrow requirement recognizer with page/block evidence locators;
unparsed, conditional or scanned content stays an explicit gap.

This slice reports declared OOXML section values. It does not compute final paragraph/run style,
fully interpret PDF guide prose beyond the narrow recognizer, edit manuscripts, or claim full
journal compliance.

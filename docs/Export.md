# Export

Export is engine-aware. The application validates the requested format against
the persisted engine descriptor and writes only to a user-approved destination.

## Output families

- Compiled PDF for all supported document engines.
- Full source archive as a ZIP, excluding application metadata and Git internals.
- Conversions to DOCX, HTML, Markdown, plain text, Typst and LaTeX when the
  engine descriptor allows them. Typst projects on Typst 0.13 or newer
  convert through Typst's own HTML output.
- PowerPoint export for Beamer presentations and for every Markdown document.
  Level 1 headings become section slides and level 2 headings start new slides.
- EPUB export for LaTeX books, reports and theses, and for every Typst and
  Markdown document.
- Typst projects also export PNG or SVG page images and HTML from Export >
  Images and HTML. The PDF standards box under Preflight > Accessibility
  exports PDF/A or PDF/UA.
- Source and PDF export records retained in project metadata.

## Import and reconstruction

- DOCX import uses Pandoc to create an editable project.
- PDF import performs deterministic local reconstruction into editable LaTeX;
  it reports limits instead of inventing missing text.
- Optional vision assistance can refine an imported project after the user
  connects a provider.

### Read-only spreadsheet API

Use [`openSpreadsheet`](../src/lib/spreadsheet-reader.ts) with the filename and
captured bytes for XLSX, XLS, CSV, or TSV. Open once, then call `listSheets()`,
`readHeader()`, or `readRange()` on the same reader. Coordinates are one-based
and inclusive: Excel keeps worksheet coordinates, and CSV/TSV count logical
records including blank records. The header defaults to the first row of the
used range; callers can choose another row. The reader does not infer headers.
It formats stored Excel values without recalculating formulas.

Delimited text uses UTF-8 unless a byte-order mark specifies UTF-16. The reader
labels lossy decoding. CSV uses commas and TSV uses tabs. Range results distinguish
the requested, available, and returned rectangles, so an out-of-bounds request
is not confused with truncation. Truncation reasons report the applied limit;
`returned` gives the last row and column actually covered. The size limits are
defined in the reader. It parses in memory and never writes back to the source.

## Integrity and safety

- Export destinations must be absolute, existing, and non-directory paths.
- The Rust sandbox rejects paths outside the approved destination policy.
- Existing artifacts are preserved when a conversion fails.
- Pandoc conversions that render citations check the complete diagnostics for
  unsupported mathematical or structured content, even when the displayed
  diagnostic report is shortened. A successful process exit alone does not
  establish a successful conversion.
- The engine descriptor is the source of truth for allowed conversion formats.
- PDF and source downloads use explicit filenames and do not expose credentials.

## Engineering anchors

- `src-tauri/src/project.rs`: PDF, document, and ZIP export commands.
- `src-tauri/src/document_engine.rs`: engine conversion matrix.
- `src-tauri/src/sandbox.rs`: export destination validation.
- `packages/pdf-to-latex/`: deterministic PDF reconstruction.
- `packages/preflight/`: output and accessibility checks before export.

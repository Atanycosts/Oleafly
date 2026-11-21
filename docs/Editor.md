# Editor

The editor is a CodeMirror 6 surface backed by a project-wide index. It is not
just a text box: the editor receives syntax, diagnostics, symbol, reference,
and completion data from the active document engine and the shared project
analysis services.

## Core capabilities

These nine capabilities are the editor support contract. The stable IDs and
acceptance criteria live in `test/fixtures/editor-support/contract.json` and
are exercised by `src/lib/editor-support-contract.test.ts`.

1. **Advanced syntax highlighting**: engine-aware highlighting for LaTeX,
   Typst, Markdown, and BibTeX, including math, commands, environments, and
   comments.
2. **Live reference checking**: resolves labels, references, citations,
   macros, environments, and included files across the project index.
3. **Integrated PDF viewer**: keeps the compiled artifact beside the source
   and exposes source-to-PDF navigation: SyncTeX for LaTeX, and the Typst
   language server for Typst 0.13 or newer.
4. **Live inline preview**: renders supported inline math and visual content
   without replacing the editable source representation.
5. **LaTeX command completion and syntax checking**: completes commands,
   labels, citation keys, environments, bibliography styles, and project file
   paths, while compile and parser diagnostics remain attached to source
   locations.
6. **Live grammar checking**: runs the configured offline proofing pipeline on
   prose while excluding commands, comments, and mathematical syntax.
7. **Local and global structure view**: exposes headings, symbols, labels,
   citations, macros, and file relationships for the current file and project.
8. **Citation checking and completion**: indexes BibTeX entries and reports
   undefined or duplicate references before compilation.
9. **Spellchecking**: uses the shipped dictionary contract, user additions,
   and truthful active-dialect state.

## Editing surfaces

- Code view is the canonical source surface for all engines.
- Visual editing is available for LaTeX and Typst source files. Markdown has
  its own rich-text visual editor.
- Markdown, LaTeX and Typst formatting actions operate through engine-aware
  ports; they do not infer behavior from a file extension alone.
- Vim mode, find and replace, code folding, multi-file tabs, and slash-command
  insertion are application contributions rather than editor parser logic.
- File and diff tabs share one strip in open order. Each tab has a context
  menu (Close, Close others, Close all to the left or right, Close all) and
  closes on a middle click. Tabs opened by the assistant, through its writes,
  reveals or approval cards, are tracked in the files store and marked, so
  they can be closed together. Opening such a file yourself clears the mark.
- LaTeX structural helpers: Enter continues `\item` lists. A description item
  comes out as `\item[] ` with the caret in the label. An empty item deletes
  its marker. When the inner list closes right below it, the item moves out to
  the enclosing list instead. Shift-Enter stays a plain newline, and Backspace
  behind a marker blanks it before deleting it.
  Enter at the end of a `\begin{...}` line writes the matching `\end`.
  `Mod-Alt-.` closes the innermost open environment and `Mod-Alt-e` surrounds
  the selection with an environment (both also in the command palette).
  `@`-prefixed math shortcuts complete Greek letters and symbols inside math
  contexts.
- Typst editing: `.typ` files get folding, sticky headings and breadcrumbs.
  Typing `$` writes the closing `$`, Enter continues a list, and `/` opens
  snippets. Completion covers functions, file paths, labels, packages and
  bibliography styles. Rename, Go to definition, signature help and Format
  document (typstyle) come from the Tinymist language server.
- LaTeX input pairing: typing `$` writes the closing `$` too, and a second `$`
  inside empty math opens a display block. `\(` and `\[` expand with their
  closing delimiter, and Backspace between a fresh pair removes both halves.
  Comments, verbatim blocks and an escaped `\$` are left as typed. Environment
  completions insert the matching `\end`, with a first `\item`, caption or
  column specification where the environment needs one. Environments that take
  arguments, such as `alignat`, `array`, `tabularx` and `minipage`, arrive with
  them filled in. Two toggles in Settings > Appearance > Editor control this:
  Auto-close math and Auto-close environments. Both sit under Auto-close
  brackets: switch that one off and the LaTeX pairing and the Enter `\end` go
  with it.
- Sized delimiters: a `(`, `[`, `<`, `|`, `\{` or `\|` typed after `\left`,
  `\bigl`, `\Bigl`, `\biggl` or `\Biggl` brings its closer, and `\big`,
  `\Big`, `\bigg` and `\Bigg` do the same for the glyphs that have a distinct
  closer. The caret lands between the two halves. Nothing pairs after
  `\middle`, `\bigm` or a closing command, and a `\big|` stays a single bar.
  The closer is skipped when the caret sits right in front of a word or a
  command such as `\frac`, so a `\left(` typed in front of `x^2` stays open
  for you to close by hand. Typing the closing glyph steps over the closer the
  editor wrote, an inner `(a+b)` keeps its own parenthesis, and spelling the
  whole closer out, `\right)` or `\right\}`, replaces the pending one instead
  of leaving two. Backspace between an empty pair removes both halves.
  Autocomplete offers the named delimiters as pairs too: `\left\langle`
  writes `\right\rangle` with it, `\langle` on its own writes `\rangle`, and
  once `\left\`, `\middle\` or `\right\` is typed the list narrows to the
  delimiters that can follow. Accepting `\right\rangle` while that closer is
  already pending replaces it rather than adding a second one.
- Turning the syntax check off: a comment line that reads `%novalidate` and
  nothing else silences the LaTeX syntax check for the whole file, wherever
  it sits. `%begin novalidate` and `%end novalidate` silence a region, and
  the text between them is not read at all, so an environment that generated
  code opens in there is never reported as unclosed. A `.bib` file uses two
  percent signs for the same three markers. The marker has to be the whole
  comment, so `% novalidate later, not yet` stays an ordinary comment. The
  project index reads the same markers, so the LaTeX syntax findings it
  contributes go quiet along with the editor's. Compile errors, spelling,
  grammar and the reference and citation checks carry on as before.
- Rich hovers: references whose label sits in a math environment render the
  equation (KaTeX), `\includegraphics` targets show a thumbnail, and labels
  display their number and page from the last successful compile. Label
  completions carry the same compile-derived number.
- Word count (toolbar popover and command palette) uses the spellchecker's
  prose mask, so math bodies, verbatim blocks, and machine arguments are not
  counted; a non-empty selection adds a selection count.

## Word documents

The file tree recognizes `.doc` and `.docx` names without regard to case and
opens them as a tab in the central workspace. Switching to a source file,
Journal checks or a PDF keeps the Word editing session and its unsaved changes
in memory. The project file is a read-only source:
**Save** creates a new Workbench working-copy baseline, while **Download DOCX**
exports the captured working copy. Edits made while choosing where to save the
copy stay in the editor; the export receipt identifies the captured revision.
Oleafly reuses an existing working copy for the same path and source. It follows
a rename by content hash;
when an external replacement finds the old draft or an exact copy of the new
content, it asks whether to continue an existing working copy or create one. A
new source with no matching working copy imports directly. The file tree and
Journal checks share this editor and its exact-font state. Legacy `.doc`
normalization uses the configured LibreOffice installation; Strict OOXML
`.docx` files must be resaved as Transitional OOXML.

The working copy requires a connected Workbench. If a packaged app has no
working connection, select the Python executable in an installed Workbench
environment from the Word file tab. **Connect Workbench** continues opening
that file. If you leave Files while it connects, return to the file tab and open
the draft yourself. If Workbench has exited, opening the file again restarts it
with the saved runtime. The same connection is available from Journal checks.
The app does not install the runtime; see [Workbench setup](development.md#journal-workbench-service).

The first manuscript import parses its retained bytes once. Reopening an
unchanged mapped file uses verified project metadata and the current saved
baseline without first reading the full manuscript catalog and history.

Journal checks starts with a manuscript and a Word template. The left sidebar
selects those inputs and starts a check; the central Journal checks tab shows
the results, expected and observed formats, source text and earlier checks.
Template facts are available before a manuscript is imported. The right-hand
Agent can discuss and edit the open document through the existing document
tools. Continue with Agent prepares an editable request in that chat.

Word's Document tools panel shows missing font families, acquisition status,
source and license information, installed versions and task activity. Installing
or removing a font from Settings refreshes the same open Word session. Internal
IDs, hashes, raw JSON, XML and developer diagnostics are absent from these
product views. Coverage messages explain which content still needs review,
such as an unknown text role or the visual layout of an embedded object.
Single-click a native equation in the working copy to reveal **Edit LaTeX** beside it.
Dragging from the equation into text or double-clicking it leaves selection to the editor.
With the keyboard, put the caret next to an unambiguous equation or select the equation,
then press **Shift+F10**. The panel edits only that equation, without resizing the page or opening
Document tools. The action stays attached to the clicked equation even if the browser
collapses the selection. Moving the caret with the keyboard, clicking elsewhere,
or scrolling the equation out of view dismisses the action. Escape closes the
action or its open panel.
Reopening the same equation in the same working revision restores any unsent LaTeX
source and macros. This draft is not part of the DOCX and does not carry over after
the document changes or the working copy closes. Use **Document tools** to
insert an equation or choose one from the current paragraph. Opening those tools
after clicking a formula keeps that exact target. Returning to the text or
changing the working revision ends that selection. These tools retain the
equation source and explicit math macros inside the DOCX and report stale associations
when the generated equation changes outside that workflow. Insertion uses the collapsed caret, or the paragraph
end when no caret offset is available; display equations require an empty paragraph.
Replacing imported or stale math requires adopting the supplied source. In Document tools,
a document edit disables replacement until you refresh the target. Refresh keeps the draft
LaTeX and macros only when it can verify the same unchanged formula; it does not transfer
them to a different target. If a formula selected on the page loses its selection, select
it again before refreshing. The optional LaTeX preview includes the supplied macros and
does not reproduce Word's page rendering.
Closing the equation panel, scrolling its target out of view, returning to the
manuscript from Document tools, or switching away from the working copy prevents
a pending conversion from writing to the document. An edit elsewhere in the
working copy also invalidates a pending replacement, even if its panel is still
open. A retained draft can be
submitted again after you confirm its target. Escape remains available while the
source preview loads, during conversion, and after warnings. A late result does
not take focus back from another control.
The change is undoable and saving is a separate action. Conversion
losses are reported; algorithm figures, arbitrary TeX projects and tracked equation
replacement are outside this entry point.
Selecting text alone does not open any tools. In the working copy or original, right-click
within the selection, or press **Shift+F10**, for **Copy**. **Annotate selection** is
available when the selection is in one paragraph. Across paragraphs, columns, or pages,
right-click places the strip beside the clicked line; the shortcut uses the active end
of the selection. Both keep the full text selection.
If the selection or document changes, or the anchor line scrolls out of view
before you use an action, the strip closes without copying or opening feedback.
Tab and Shift+Tab move between the available actions. Leaving the strip closes
it; Escape closes it and returns to the selection. In an open object panel, Tab
cycles through its enabled controls until you close the panel or click outside.
Scrolling the target out of view closes its tools. If they held keyboard focus,
focus stays in the scrollable viewport without jumping back to the target.
An offscreen target cannot open an object panel or hide feedback, even before
the strip has finished closing.
If a caret is shared by adjacent actionable objects, **Shift+F10** leaves it alone.
Select or click the intended object to open its tools.
Right-clicking a citation inside that text selection keeps the selection actions.
Feedback opens over the Word workspace without narrowing the page. It keeps the captured
words and document version; reopening the retained source locates the paragraph.
Word keeps a separate draft for each selected range in each version, even when
two selections in a paragraph contain the same words. Whole-document feedback has
its own draft. Reopen a draft from the same selection, or switch
between open drafts inside Material feedback, including earlier versions.
Feedback from a different material does not cover the manuscript. You can start
feedback on another material and return to the first draft while the project is open.
Changing the selection, scrolling its anchor line out of view, or moving keyboard
focus outside the editor while preparing a selection annotation cancels the open request.
While whole-document feedback is preparing, continuing to use the editor or moving
focus to another control cancels the open request without changing existing drafts.
Leaving that view, opening Document tools or an object panel, or reopening existing
feedback also cancels a pending open request. Revealing an action does not minimize
feedback; opening the formula editor,
citation panel, or image preview does, without clearing the feedback draft.
Reopen feedback from its existing
button; it takes the foreground without discarding any pending rewrite. Use
**Annotate whole material** for document-level feedback.
In the working copy or retained original, click an existing Word citation with a matching
bibliography record, or a Zotero or CSL citation with embedded source details, and choose
**View citation**. The lookup uses the document version in front.
The list opens beside the citation; only clicking a source with a link opens the browser.
If a source declares conflicting DOIs, the list shows its title without a link.
Close the list with **Escape** or its close button to return to the citation.
A cross-reference offers **Go to reference** if its Word
bookmark exists. Both actions are available with **Shift+F10** at an unambiguous field.
If a field spans several lines, the action stays with a visible part of that
field when its first line scrolls out of view. Once the entire field is out of
view, the strip and source panel close without opening a link or jumping to a bookmark.
These read-only actions do not edit fields or refresh the bibliography. The opt-in
[citation insertion preview](../e2e/README.md#word-citation-picker-preview) is separate
and off by default. Insert from an ordinary body paragraph, outside fields that
span multiple paragraphs, such as a generated bibliography. The preview does not
offer insertion in protected documents or when Word's Track Changes is on.
Search the current document's sources by title or exact DOI without contacting
Crossref. Choose the source before inserting. Reusing it keeps the exact Word
source tag, including localized letters, and leaves the bibliography record unchanged.
Undo and redo in the search box affect the query, not the manuscript.
Choose **Search Crossref**, or press **Enter** in the search box, to search
journal articles by title or look up an exact DOI. Bare DOIs and DOI links both
use the exact lookup. The picker separates document sources from Crossref results.
Select a result to see whether it will
reuse a named source or add a document source. It does not refresh the rendered bibliography.
Conflicting records and metadata that
does not fit Word's bibliography format cannot be confirmed; you can choose
another source without changing the draft or moving the insertion point.
When space is tight, scroll within the picker to reach the sources and confirmation.
Scrolling the insertion point out of view cancels insertion and closes the picker
without scrolling back. Changing the draft invalidates the open picker. Switching away discards
any pending search result. **Close** or **Escape** returns focus to the insertion point. If
focus has already moved elsewhere, the picker does not take it back.
Click a supported inline or floating image in the working copy and choose **View image**
to see the embedded picture. The action follows the visible picture, not its anchor
paragraph. Click again to reopen the action, or drag the selected floating image
to move it without reopening the action. **Shift+F10** focuses the action
when the picture is selected or when the caret is at the start of an unambiguous
picture in the text. If there's too little room beside the target, open context
tools move to the edge of the editor without resizing the page. Escape or
scrolling the target out of view closes them.
This is a read-only view of the embedded picture, not the cropped page rendering.
It does not open external images or infer captions or chart data.
Select a chart with an explicitly linked, embedded Excel workbook to **Export embedded workbook**.
The action is also available with **Shift+F10** on the selected chart. It saves the original
workbook without editing the draft, reading external links, or treating chart caches as source data.
If a compatibility drawing could refer to different objects, Oleafly does not offer workbook export.
If you switch away or scroll the chart out of view before the save dialog returns, no workbook is written.
A pending rewrite highlights its target and offers **Review suggestion** beside
the paragraph without moving the page. When there is no room beside a visible
paragraph, the compact action moves to the viewport edge. Open it to read the
original and proposed text and stop, accept, or reject in **Document tools**.
From the working text, press **F6** to open a pending review, even if its
paragraph is offscreen. Open feedback gives way without losing its draft.
Escape or rejecting the suggestion closes that review
and returns to the original caret or selection without scrolling. This leaves
the editor's normal Tab behavior unchanged.
When a short action and the review entry overlap, the short action moves beside
it or wraps without resizing the page. If both cannot fit, a focused review
entry keeps focus and the short action closes. Otherwise, the review entry
temporarily yields and returns when there is room or the short action closes.
If the paragraph scrolls out of view, the inline entry closes without opening
the comparison. The pending suggestion remains in Document tools even when a short
action, an expanded object panel, feedback, or a different view hides the entry.
If recording a task result fails, the error and retry stay in **Document tools**
without moving the paper. Retrying records the same result without applying the edit again.
When opened from their button or the inline review action, **Escape** closes
Document tools and returns focus to their button. **Go to paragraph** returns to the pending target
in the working copy. If you resume editing or move focus before it scrolls,
the pending jump is canceled and the suggestion stays available. If a focused
button inside the review panel disappears
because the suggestion finishes or is withdrawn, focus moves to the review heading. Editing the
target withdraws the suggestion. If focus is on the inline action when it
disappears, it returns to the Document tools button without opening the panel
or scrolling the page. Focus elsewhere stays where it is. Edits elsewhere,
including changes applied by Agent, do not displace the pending review. Navigation
highlights do not replace it either. Accept is available only in the working copy.
Journal annotations use readable target names and open their retained source
through the source viewer; saved feedback keeps its exact original reference.
Source compile and export controls return when a source tab is
active. A saved Word PDF opens inside the same central workspace, with a Back
to document action that preserves the editor session. PDF conversion and loading
start when Open PDF or Document tools is opened; opening Word alone does not
start a background conversion. Closing those views retains the completed PDF
without requesting a new one.

The Display menu switches between the working copy, the version opened at the
start of the session, and a comparison on the same paper surface. The version
spine stays visible, with the earlier version behind the active paper. Its
compressed shell follows the rendered paper width, and selecting a version
exchanges the two labels without changing the document viewport dimensions.
One paper layer is visible and
accepts interaction, with one shared formatting toolbar. The editable session
stays mounted while the historical version uses a read-only instance of the
same DOCX renderer. Changing the display preserves the editable session and its undo history.
Saving advances the working baseline while the original stays fixed until the
document is reopened.

The Agent receives the material and version actually being viewed, its supported
selection, and the writable Word session as separate facts. A historical selection
does not become an editing address. Caret and edit notifications publish the
current paragraph identity without enumerating the manuscript. When the Agent
requests context, the host resolves a write address against the live session and
revision. Chat, desktop MCP and research tasks share
the live document services for formatting, fonts, saving, checking and export.
The left sidebar and central surface show actual operation receipts. In Word,
the receipt shares the tab row. Focus mode keeps its space above the manuscript,
without tabs. Receipts neither cover the editor viewport nor move it when the
operation changes. Hover or Tab to a receipt with a title or error to see its details.
Following the assigned flow can reveal its current Word
target. Editing, scrolling or navigating pauses that movement, while execution
continues. **Continue following**
resumes at the latest reported target. Other flows update state without taking
over the current navigation.

## Material feedback and results

PDFs, images, Markdown previews, source, diagrams and local HTML reports share
the central workspace with Word. Feedback opens from a compact paper-edge entry
as a panel inside that workspace. Minimizing it keeps an unfinished comment.
The right-hand Agent remains available for conversation.
PDF feedback can refer to the whole document, the current page or selected
text. Images support a selected area, diagrams a node or edge, Markdown a
source block, source a character range, and HTML selected text. Word currently
supports whole-document feedback and a single selected paragraph.

Saving feedback retains the displayed source bytes and its version. It does
not start an AI task. Selecting **Request AI handling** sends that feedback and
the retained source to an isolated task. Its handling record links back to the
request and resulting files. Complete text, image and DOCX task results have an
**Open in workspace** action; available starting and final versions use the
same renderer for comparison. Retained views are read only.

An earlier feedback item opens its own version and location. PDF locations
restore the page and rotation, without drawing a rectangle overlay. A retained
Markdown text snapshot shows placeholders for image attachments rather than
loading a newer image from the project. HTML snapshots include static local
resource references and run in a sandbox. Dynamically constructed resource
URLs and remote resources are outside that snapshot.
Visiting another retained material keeps the earlier renderer mounted. **Back**
returns to that exact version with its local reading state. Closing the visit
chain returns to the prior working surface and its editing session.

## Visual editor

Visual mode is the same editor with a different set of decorations. The
`.tex` file is still the only copy of your work. The toolbar toggle switches
between Code and Visual, and the choice is remembered per project. Line
numbers, folding, find and replace, spelling, grammar and the compile
diagnostics all keep working.

Markup is hidden while you read and comes back while you write. Put the
cursor inside a heading, an equation or a command and its source appears on
that line, with syntax colours. Move away and the rendered form returns.
Everything below behaves that way, so there is no separate edit step and
nothing to commit.

What renders:

- Sectioning commands from `\part` to `\subparagraph` as headings, sized by
  level.
- Inline math and display math through KaTeX. Display environments such as
  `equation`, `align`, `gather` and `multline` become centred blocks.
- Footnotes and endnotes as a small grey marker.
- Theorem-like environments, including ones declared with `\newtheorem`,
  with the name in bold, the optional title in parentheses and a rule across
  the line. `\theoremstyle` decides whether the body is italic.
- `\textcolor` and `\colorbox` in their colours, named, HTML, `rgb`, `gray`
  and `xcolor` mixes alike.
- `figure` and `table` environments as a panel. The `\centering` line is
  hidden, the caption shows as its text and the label as a small chip.
- `\includegraphics` as the image itself, resolved from the project the way
  LaTeX resolves it. An edit button opens the figure dialog to swap the image
  or change its width.
- `tabular` as a grid you can type into. Select a cell and a toolbar appears
  above the table for rows, columns, alignment, border styles including
  booktabs, the caption, the label and merged cells.
- Lists with their markers, quotes with a left border, `verbatim` and
  `lstlisting` as monospace panels, and `abstract` with its heading.
- Citations, references and labels as chips, links underlined, `\LaTeX` and
  `\TeX` as their logos, `~` as a space you cannot break, and the usual
  character and spacing commands as the characters they produce.

Everything before `\begin{document}` collapses into a "Show document
preamble" bar at the top. Click it to expand the preamble in place, click
again to collapse it. `\end{document}` becomes a centred "End of document"
bar. Both show their source when the cursor is on them, and a file opens with
the cursor after the preamble.

Above the editor, a breadcrumb bar names the file and the sections the cursor
sits in, for example `main.tex > Widgets > Rendering > Inline and display
math`. Click a crumb to jump to that heading. The bar is there in Code mode
too.

In both modes, the math preview shows the rendered result of the equation the
cursor is in. Its menu can hide the preview until you leave the equation, or
switch it off entirely. Settings > Appearance > Editor > Math preview brings
it back.

Pasting formatted text from a browser or an office suite converts it to
LaTeX. Pasting or dropping an image file saves it into the project
(`figures/` when that folder exists, otherwise next to the main document) and
inserts a figure snippet.

Every toolbar action writes ordinary LaTeX into the document, in Visual mode
exactly as in Code mode. Insert figure opens a dialog to choose an image from
the project or import one from disk, then set its width, caption and label.

Markdown files keep the rich-text visual editor they have always had.

Typst files have a visual mode too. It renders headings, emphasis, lists,
math, images, editable tables, reference chips and footnotes, and shows the
source where the cursor is.

## LaTeX controls at a glance

The LaTeX toolbar keeps common source operations close to the editor. It does
not replace the source: each action inserts ordinary LaTeX that remains
readable in Git and other editors.

| Group | Available controls |
| --- | --- |
| Modes and history | Code view, Visual view, undo, redo |
| Structure | Seven heading levels, from `\part` through `\subparagraph` |
| Inline text | Bold, italic, underline, and monospace text |
| References | Links, citations, cross-references, and footnotes |
| Blocks | Quotes, figures with captions and labels, tables, itemized and numbered lists, `equation`, `align`, and fractions |
| Intelligence | Go to definition, find references, and project-wide rename |
| Symbols | A searchable palette with 236 unique commands across 13 categories |
| Project tools | Draw a diagram, LaTeX packages, Document insights, and Document settings |

<div align="center">
  <img src="assets/readme/latex-editor-toolbar.png" alt="Oleafly LaTeX editor toolbar with formatting, references, figures, tables, lists, equations, and symbol controls" width="100%" />
</div>
<p align="center"><em>Insert common LaTeX structures without leaving the source editor.</em></p>

The symbol palette groups Greek letters, operators, relations, arrows, set
theory, logic, calculus, functions, brackets, accents, dots and spacing, and
miscellaneous symbols. Search by symbol or command, then insert it at the
current cursor. The full [symbol catalog in the README](../README.md#a-searchable-latex-symbol-palette)
lists every category and command. In a `.typ` file the palette shows and
inserts Typst symbol names. The Typst toolbar has the same insertion tools as
the LaTeX one.

<div align="center">
  <img src="assets/readme/latex-symbols.png" alt="Oleafly searchable LaTeX symbol palette with categorized mathematical commands" width="100%" />
</div>
<p align="center"><em>Browse or search the symbol catalog, then insert the command where you are writing.</em></p>

## Proofreading

- Two checkers share one worker pass. Hunspell owns spelling against the
  selected dictionary pack. Harper owns grammar and style.
- Five dictionary packs ship with the app: English (United States, United
  Kingdom, Australia), German and French. The rest of the list, more than
  sixty languages, downloads on demand and then stays on disk, so it works
  offline afterwards. Every download is checked against its published
  SHA-256 before it is used, and a language that is not installed says so
  instead of falling back to another one.
- A project can pin its own spell-check language in the Project info panel.
  The choice lives in `project.json`, travels with the project, and overrides
  the app setting for that project only. The grammar checker's English
  dialect still follows the app setting.
- LaTeX reaches Harper through a prose mask the same length as the source, so
  a lint span is already a document offset. Markup that reads as a noun in the
  sentence, such as a citation, a reference, a `\gls` term or inline math,
  becomes a placeholder noun padded with spaces. Markup that prints nothing,
  such as an opaque environment, display math, a comment or a preamble
  command, becomes spaces. Prose arguments stay: `\section{}`, `\emph{}`,
  `\textbf{}`, `\caption{}`, `\footnote{}` and `\item[]` keep their text
  while the command name and braces go.
  Deleting markup instead of replacing it used to join the words on either
  side and manufacture findings that were not in the document.
- A finding is shown only when it sits entirely in prose the mask kept. One
  that reaches across a masked construct or a placeholder is dropped, because
  its suggestion would rewrite the markup underneath.
- Typst gets its own prose mask, like LaTeX, so grammar checks the same text
  that spelling does. Markdown and plain text use the existing masks.
- Harper is tuned for chat and email. The academic profile in
  `src/lib/proofreading/lint-profile.ts` turns off the rules that fight
  scholarly prose: sentence length, hedging, contractions, shorthand
  expansion, comma style, dash style, and the whitespace rules that a masked
  document always trips. Each profile rule carries a one-line reason and an
  example of what it would flag, and Settings shows both next to a switch.
  Settings keeps two lists on top of it, one of rules the writer turned off
  and one of profile rules they turned back on.
- When a Harper call fails, the worker throws that engine instance away and
  builds a new one for the next pass, because a panic inside the WebAssembly
  module leaves the old instance unusable. The failure reason goes to the
  console once. `HARPER_PANICKING_RULES` in `lint-profile.ts` lists rules that
  are forced off for the pinned Harper release (BoringWords in harper.js
  2.10.0). A test against the installed Harper fails when the rule stops
  panicking, which is the cue to unblock it.
- A partial pass, where one engine finished and the other did not, is not
  announced with a toast. The Project info panel keeps the counts, and the
  worker logs the reason. Errors that need a retry keep their sticky toast.
- Deferred, not planned for 0.4.1: a general way to mute an informational
  notice from the toast itself, with a Settings list of muted notices and a
  reset button (toasts that need action would stay unmutable), and an upstream
  report of the BoringWords panic to the Harper project.
- A finding is only ever as wide as the thing it is about. A spelling finding
  wider than 40 characters, or one that crosses a line, is dropped. A grammar
  finding stops at the end of its sentence and at 300 characters. The same
  word cannot be reported more than 20 times in one document.
- The card names what was found. Spelling says "Not in dictionary" or offers a
  replacement; everything else shows the checker's own message with the rule
  name under it.
- Dismissing. The card lists its actions as rows with an icon each. A
  misspelling can be ignored in this project (the project dictionary),
  ignored everywhere (the personal dictionary), or ignored for now, which
  covers this document until the app restarts. A grammar finding can be
  ignored in this project, which the project remembers by rule plus a digest
  of the sentence, or its rule can be turned off everywhere.
  Dismissing clears every finding over the same text, since removing one can
  reveal another underneath. Those cleared findings stay hidden for the rest
  of the session, so the next pass does not bring them back.
  A selection too long or too strange to store as a word is hidden for the
  session instead, with a toast saying so. Nothing is ever a silent no-op.
- Settings > Dictionary lists the rules the writer turned off and the number
  of findings dismissed in the open project, and takes either back. Under
  them it lists every rule the academic profile turns off, each with a switch
  that turns it back on.

## Editor settings

Settings > Appearance > Editor holds the editor's own preferences. All of
them are stored locally, survive a reload, and go back to their defaults with
Reset to defaults at the foot of Appearance.

- Keybindings: Default, Vim or Emacs. See
  [KeyboardShortcuts.md](KeyboardShortcuts.md) for what each mode binds.
- Use the app font: off by default. When it's on, the editor uses the App
  font and App font size, and the Editor font and Editor font size settings
  are locked until it's turned off again.
- Theme in light mode and Theme in dark mode: the editor uses one theme while
  the app is light and another while it's dark, the way VS Code and Zed pair
  them. Match app follows the app's own colors. Paper, a warm off-white, and
  One Light are light themes. Linear, GitHub Dark, Dracula, Nord, Tokyo Night,
  Rosé Pine, Catppuccin and One Dark are dark. A theme saved by an older
  version is used for both modes.
- Editor colors: change any color of the theme picked for light or dark mode,
  with a live preview in LaTeX, Typst and Markdown. Editor covers the
  background, text, line numbers and selection. Syntax covers commands,
  preamble and imports, headings, formatting, environments, citations and
  references, math, values and strings, names and keys, links, brackets and
  symbols, and comments. A role means the same thing in every language, so
  the heading color applies to `\section`, a Typst `=` heading and a Markdown
  `#` heading alike. Colors are kept per theme, and Match app keeps one set
  for light mode and one for dark. Each swatch shows the theme's own color
  until you pick yours, and Use theme colors puts them all back. Exporting a
  theme from Appearance > App also saves the editor themes and colors, and
  importing one applies them.

  The roles live in `packages/editor/src/color-roles.ts`, and
  `syntax-colors.ts` maps each language's highlight tags onto them. Every
  color resolves as `var(--cm-user-*, var(--cm-theme-*, palette))`: your
  color, then the theme's own value for that role, then the theme's palette.
  Changing a color only sets a variable on the root element, so open editors
  never reconfigure. Source-mode LaTeX uses the legacy `stex` tokenizer,
  which tags every command the same way; `latex-stream.ts` wraps it and
  splits commands and their arguments into roles, which adds about 1 ms to a
  full parse of a 9,000-line document.
- Editor font size and editor font. The size list runs from 11
  to 24 pixels, and Custom takes any size from 6 to 100, the same range as VS
  Code. The font list holds every font installed on the computer, monospaced
  ones first, each drawn in its own font. A typed name works even when the list doesn't show it, and a
  saved name that isn't installed gets a note under the setting. Rust lists
  the fonts with `fontdb`, the same way Typst finds system fonts. It leaves
  out symbol and icon fonts such as Webdings and Wingdings, and it counts a
  font as monospaced when its letters all have the same width, even if the
  font file doesn't say so (Monaco and Courier don't).
- Tab size: 2, 4 or 8 spaces. It sets the indent unit and the width a
  literal tab renders at.
- Letter spacing: normal, +0.5, +1 or +1.5 pixels, or custom from 0 to 4
  pixels. It adds the same space between every pair of characters, so the
  cursor also gets more room. How close the cursor sits to a letter otherwise
  depends on the font.
- Line height: compact (1.4), normal (1.7), wide (2.0) or custom, which takes
  any value from 1 to 3 with up to two decimals. The arrow keys move it by
  0.05. The first time you pick custom it starts from the preset you had.
- Cursor width: 1, 2 or 3 pixels.
- Cursor color: one color for light editor themes and one for dark ones, so
  a cursor picked for a white page doesn't vanish on a dark one. Each swatch
  shows the theme's color until you pick your own, and Use theme colors goes
  back to both. The color also applies to the Vim block cursor and to the
  Markdown Visual editor's caret.
- Wrap long lines: on by default. Turn it off and the editor scrolls
  sideways instead.
- Auto-complete, auto-close brackets, auto-close math, auto-close
  environments, inline suggestion, non-blinking cursor and sticky scroll.
- Typst: Format on save, Formatter line width, Formatter indent, Parameter
  name hints and Typst lint checks.

## Engineering boundaries

- `packages/editor/` contains parser, proofing, highlighting, and editor-port
  logic that can run without Tauri or application stores.
- `src/store/project-index.ts` owns project-wide indexing and invalidation.
- `src/lib/analysis/` coordinates language-service requests and stale-result
  rejection.
- `src-tauri/src/document_engine.rs` publishes the active engine descriptor.
- `src/contributions/` registers commands and editor-facing tools.

## Correctness and performance contract

The contract requires all acceptance criteria for all nine features. Results
are rejected when they belong to an older project revision. Performance gates
are measured separately from cross-platform functional gates and use the fixed
reference methodology recorded in the test fixture.

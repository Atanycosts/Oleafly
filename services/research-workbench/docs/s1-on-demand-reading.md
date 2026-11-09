# S1 on-demand DOCX reading

`rfw-s1-query` queries the application-owned snapshot from an existing `rfw-s1-read` run.
It returns selected source observations and records exactly which objects the response contains.
It does not reopen the author manuscript or change the source run. The command contract is
[`contracts/s1/read-query.json`](../contracts/s1/read-query.json).

## Discover objects

In PowerShell, set the paths to the existing run, application storage and protected author root:

```powershell
$env:PYTHONPATH = "src"
$appRoot = (Get-Location).Path
$runDirectory = Join-Path $appRoot "var/s1-live-run-20260925-final3"
$authorRoot = "C:/Users/Administrator/Desktop/研"

python -m research_file_workbench.docx.query_cli $runDirectory `
  --application-root $appRoot --author-workspace-root $authorRoot catalog
```

The catalog contains source-bound object IDs, kinds, regions and source locators. It contains no
object text and creates no read receipt. IDs are scoped to the source hash and reader method;
they are not permanent cross-version paragraph IDs. A catalog only covers the indexed object
kinds; it does not claim that every package part is understood.

## Read and continue

```powershell
python -m research_file_workbench.docx.query_cli $runDirectory `
  --application-root $appRoot --author-workspace-root $authorRoot read `
  --region body --object-type text_block --page-size 10 `
  --output-directory (Join-Path $appRoot "var/query-body-first")
```

The response prints to stdout and is saved as `response.json`, together with
`read-receipt.json`, in the requested new directory. Read `pagination.next_cursor` from the
response and pass it as `--cursor` with the same selectors and page size to continue. Choose
a new output directory for each response; the command never overwrites an earlier delivery.
You can use `--object-id` from the catalog to retrieve one exact observation.

Selectors combine as an intersection. Supported regions are body, header, footer, footnote,
endnote and textbox. Object kinds are text_block, table, image, math, field, section, break,
complex_object and reference. Region scope is explicit: a captured paragraph ancestor can establish
a drawing's textbox region; a remaining part-level classification cannot. Results follow object kind and reader
order, not rendered reading order.

Page size counts whole objects, not characters or bytes. A large table is returned intact;
there is no silent truncation inside an object. The response includes total selected objects,
continuation, and the known indexed objects absent from this response. Objects delivered on
earlier pages are not silently marked as read again. Receiving a metadata reference to an image,
formula or embedded object does not establish visual or semantic understanding.

## Query a physical page

`--page-number 1` requires that the run already contains independent reviewed mappings and a
process-verified render record. The command checks snapshot and PDF hashes, rendering profile,
reader version, and actual PDF page count through the existing `pdfinfo` installation. Only
uniquely matched, reviewed observations are returned; ambiguity and mapping gaps remain visible.
A page result never claims to contain every object on the physical page.

The current IJAM run has no reviewed object-to-page mapping. Page queries for it therefore refuse
until independent review is complete. Do not populate its annotations from the reader's output.
Regression tests exercise this path with the already annotated fixtures and recorded PDFs;
those tests do not launch or attest a new WPS process.

## Status and boundaries

Two independent axes describe a content response, and neither replaces the other.

`status` is the coverage axis. It is `partial` on a content response because the S1 reader
declares unconditional limits, it never asserts document completeness, and it is `catalog_only`
on a catalog response, which delivers metadata and no content.

`selection_delivery` is the continuation axis for the requested selection: `continuation_exhausted`
when no further page exists after this response, `continuation_available` when
`pagination.next_cursor` continues the same selection. It reports whether another page exists, not
how much of the selection one response holds: a page reached with a cursor can hold only the last
part of a selection, and every selected object it did not return stays listed in the receipt's
unread ranges. Reading a selection whole says nothing about the rest of the document; coverage and
semantic limits stay in `status` and `limitations`.

- Exit `0`: catalog delivered, or a content response after which no further page remains. The
  selection is in hand only when the caller started from the first page and followed every
  continuation; check `pagination.total_ranges` before treating an empty result as an answer.
- Exit `1`: content delivered with `continuation_available`; continue with the returned cursor.
- Exit `2`: request refused, delivery failed, or a response whose `selection_delivery` cannot be
  read. Inspect the error; do not treat it as an empty successful query. Exit `2` does not by
  itself prove that no output directory was written.

The run, snapshot and referenced evidence must stay in declared application storage. Outputs must
be outside the author workspace and the original run, cannot exist already, and cannot traverse
symbolic links or reparse points. These checks are not an operating-system sandbox against hostile
concurrent changes. Run reports are operator-controlled local records; actor/client arguments are
labels, not authentication. No network service or additional filesystem authority is exposed.

The reader reparses the snapshot on each invocation. Persistent project baselines and page bundles
are available through `rfw-project`; see [project storage](s1-project-storage.md). Caching,
authenticated MCP access, task-material directories and the desktop interface remain separate S1
work. This query slice does not complete the full 0.1 acceptance contract.

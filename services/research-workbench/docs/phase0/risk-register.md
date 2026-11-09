# Phase 0 risk register

| Risk | Current evidence | Required action | Blocking condition |
|---|---|---|---|
| Renderer ambiguity | WPS versions 12.1.0.28043 and 12.1.0.28505 both exist | Pin the full 28505 executable path and hash | Render command resolves to an unpinned executable |
| Microsoft Word unavailable | No local Word executable found | Treat Word path as unavailable or use a separately fixed environment later | Acceptance is incorrectly claimed for Word |
| English page baseline has known limitations | Dedicated WPS baseline generated: 10 pages, PDF SHA-256 `db669100...` | Preserve field/revision/font limitations with every mapping | Baseline is presented without its environment or limitations |
| Legacy template format | Official probe input is `.doc`, not `.docx` | Keep it outside the S1 OOXML input set | Converted output is described as native DOCX |
| Independent annotation drift | Eight reviewed DOCX fixtures and page mappings are frozen by hash | Keep annotations external to the future reader and invalidate them when fixture hashes change | Parser output is used to rewrite its own expected answer |
| Baskerville unavailable | Source declares Baskerville; local registry has no matching font | Treat the WPS baseline as candidate evidence with substitution risk | Layout is described as fully font-complete |
| WPS refreshes fields during PDF export | Controlled PAGE-field probe changed cached `999` to `1` | Keep structural source and rendered result as separate evidence | Refreshed result is described as the source-saved result |
| Revision display changes page evidence | Insertions render inline; deletions render in markup balloons | Bind mapping to revision display behavior | Revision view is omitted from the render profile |
| Source correctness not proven | Hashes identify versions only | Preserve content and scientific verification as separate concerns | A matching hash is treated as factual correctness |

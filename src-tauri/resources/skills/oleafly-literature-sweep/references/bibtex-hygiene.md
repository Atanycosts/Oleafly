# BibTeX hygiene

## The entry you write is the entry you were given

`verify_citation` with a DOI returns the publisher's BibTeX. Write that, changing only the citation key. Do not retype fields, do not tidy the title casing, do not helpfully add a `url`. Every edit you make by hand is a chance to introduce a fact the source did not assert.

Two changes are legitimate. Renaming the key to the project's scheme. And wrapping proper nouns and acronyms in braces so BibTeX does not lowercase them: `title = {{GNN} expressivity under {WL} refinement}`.

## Keys

`<firstauthor><year>-<slug>`, lowercase ASCII, unless the project already uses another scheme, in which case the project wins.

- Surname of the first author, accents stripped, no spaces or punctuation.
- Four digit year of the version you actually read.
- Two or three content words from the title, hyphen joined.

`xu2019-gnn-expressivity`, `he2016-deep-residual`, `vandenoord2016-wavenet`.

If two papers collide after the slug, suffix the year: `smith2020a-...` and `smith2020b-...`.

Check the key is free before using it. `project_map` returns `bibKeys`, or `search_project` with `{"query": "<intended key>"}` finds it. A duplicate key is not a compile error in every engine, so it can silently shadow an entry.

## Minimum fields by type

An entry missing these will cite, but will render wrong or incompletely.

| Type | Required | Strongly wanted |
|---|---|---|
| `@article` | author, title, journal, year | volume, number, pages, doi |
| `@inproceedings` | author, title, booktitle, year | pages, publisher, doi |
| `@book` | author or editor, title, publisher, year | edition, isbn |
| `@incollection` | author, title, booktitle, publisher, year | editor, pages |
| `@misc` (preprint) | author, title, year, eprint or url | archivePrefix, primaryClass, doi if one exists |
| `@techreport` | author, title, institution, year | number |

If a field is genuinely unavailable, leave it out. Do not fill it with a plausible value. An `@article` with an invented volume number is a fabrication that will survive into print.

## Preprints

An arXiv paper with no journal version is `@misc` with `eprint`, `archivePrefix = {arXiv}` and `primaryClass`. Do not construct `10.48550/arXiv.<id>` and treat it as a portable DOI: it resolves at doi.org but is not a Crossref record and is not how every index stores the paper. Cross reference by arXiv id.

When a preprint has since been published, cite the published version. Note the preprint in the source note so the trail is visible.

## Appending safely

`write_file` replaces the whole file. For an existing bibliography, first read all current entries and retain them in the amended content.

The safe sequence:

1. Read the current bibliography. In a ResearchTask, start at byte offset 0 and continue with `nextOffset` until null. Ordinary chat may expose line offsets.
2. Pick an anchor string from what you just read. The last entry's key line is a good anchor, for example `@inproceedings{he2016-deep-residual,`. A bare `}` is not: it appears in every entry.
3. When offered, `replace_in_file` can append against that unique current anchor. In a ResearchTask, use `write_file` with the full amended bibliography after reading its complete current content.
4. `compile` with `{}` to confirm the file still parses.

In ordinary chat, `replace_in_file` fails when `find` is absent, which is what you want. It does not fail when `find` matches in more than one place, so make the anchor long enough to be unique.

If the file does not exist, `write_file` is the right tool, once.

## After appending

`compile` with `{}`. A malformed entry takes the whole bibliography down and every citation in the document with it, so a green build is the real check.

Then `project_map` with `{}` and read `unresolvedCites`. An empty list means every `\cite` in the document resolves. A key still listed there means either the entry did not land or the key in the prose is spelled differently from the key in the file.

Inspect the actual PDF for missing citation markers. In a ResearchTask, use `task_pdf_text` with the complete compile `artifact` as `reference` and continue with `nextOffset`. In ordinary chat, use `get_pdf_text` when offered. An entry can parse and still render as a question mark.

## Handing off

For deduplication across an existing messy file, rekeying to a consistent scheme, or validating a large bibliography, `citation-management` ships the right tools.

```
python3 "<citation-management dir>/scripts/validate_citations.py" references.bib --report research/bib-report.json
python3 "<citation-management dir>/scripts/format_bibtex.py" references.bib -o references.clean.bib --deduplicate --sort year
```

`validate_citations.py` also takes `--manuscript <path>` to report unresolved and unused citations, and `--check-dois` to confirm each DOI resolves, which is slow. Write to a new file rather than using `--in-place`, read the result, and let the user approve the replacement. The skill needs the `requests` package, so check its frontmatter before relying on it.

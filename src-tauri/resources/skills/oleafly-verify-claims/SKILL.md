---
name: oleafly-verify-claims
description: Audit a section claim by claim and report which statements the cited sources actually support. Use when the user asks to check citations, verify claims, or find unsupported or overstated statements. Maintains a claim record with evidence and proposed fixes, reusing the project's existing record or research/claims.md.
license: MIT
compatibility: Audit author text unless revision is authorized. Use the current host tools and task permissions. The optional scientific-writing audit script needs Python 3.11 or newer on the login shell PATH.
allowed-tools: read_file search_project project_map project_library_search read_paper verify_citation write_file replace_in_file create_file compile get_pdf_text task_pdf_text update_todos load_skill read_skill_file run_command
metadata:
  version: "1.2.0"
  skill-author: "Oleafly"
  oleafly:
    tier: native
    phase: review
    tools:
      - read_file
      - search_project
      - project_map
      - project_library_search
      - read_paper
      - verify_citation
      - write_file
      - replace_in_file
      - create_file
      - compile
      - get_pdf_text
      - task_pdf_text
      - update_todos
      - load_skill
      - read_skill_file
      - run_command
---

# Oleafly Verify Claims

This skill answers one question for every factual sentence in a section: does the source it cites actually say that? Maintain one claim record containing the evidence table, summary and proposed fixes. Reuse an existing project record; `research/claims.md` is the default when there is none. Export a separate report only when the requested deliverable needs it.

**A review request does not authorize editing the user's prose.** Propose fixes with file and line locations. Write the claim record and requested exports; preserve the manuscript being audited.

## Step 1. Fix the scope

Audit one section, or one file, at a time. A whole manuscript in one pass produces a table nobody reads.

Confirm with the user which file, or infer from what they just asked about. `project_map` with `{}` returns `sections` with the file and line of each heading, so you can name the boundaries precisely.

For substantial work, use the host's existing task state to track scope and remaining claims.

## Step 2. Read the text with line anchors

Read the section with the offered `read_file` schema. In a ResearchTask, `offset` and `limit` are UTF-8 byte positions and byte limits, starting at 0. Continue with the returned `nextOffset` until null. Ordinary chat may offer line-based reads. Use the actual schema and returned fields.

To pin a line number exactly, `search_project` with `{"query": "<six distinctive words from the sentence>"}` returns the file and line of every match. That is more reliable than counting, and it is the anchor to record in the table.

## Step 3. Extract the claims

Go sentence by sentence. A claim is anything a reader could be wrong to believe.

Audit these:

- A statement about what prior work did, showed, achieved or failed to handle.
- A number, a rate, a size, a threshold, a benchmark result, a date.
- A statement about the state of a field. "Most approaches assume..." is a claim about a population.
- A causal statement. "Because X, Y follows."
- A statement about what is standard, common, or widely used.
- A definition attributed to a source.

Skip these:

- The paper's own contributions and results, which are evidenced by the paper itself, not by a citation.
- Statements of intent. "We now describe the method."
- Pure mathematics that is derived in place.
- Hedged framing that asserts nothing. "One way to see this is..."

Number the claims C1, C2 and onward. Quote each one, or paraphrase tightly enough that the user recognises the sentence.

## Step 4. Map each claim to its cited key

For each claim, record which keys the sentence cites. A claim with no citation is not automatically a problem, but it has to be classified deliberately (step 6).

`project_map` with `{}` gives `bibKeys` and `unresolvedCites`. Any key on the claim list that appears in `unresolvedCites` is already broken before the content question is asked: it cites nothing. Record it as `unsupported` with the reason "no bibliography entry".

## Step 5. Gather the evidence

For each cited key, in this order, stopping when you have enough to judge:

1. `read_file` with `{"path": "research/sources/<key>.md"}`. If the sweep ran, this holds the abstract verbatim and the provenance. This is the cheapest real evidence available.
2. Search existing text and notes with `project_library_search` when offered. In a ResearchTask, use `search_project` with a distinctive literal phrase, then `read_file` on the matches. This is a literal search, not a semantic library index.
3. Read the actual paper with `read_paper` when offered, using `path`, `doi`, `arxiv` or a public PDF `url`. Continue with `nextOffset` as `offset` while the needed passage remains unread. Keep the source hash, byte range, PDF identity and page anchors. `read_file` reads UTF-8 text and cannot extract a PDF. If only abstracts are available, state that limit.
4. `verify_citation` with both `doi` and the entry's `title` when available checks their identity. Inspect returned metadata before adopting it. DOI resolution alone does not verify venue/year or claim support. Judge support from the source passage, at its stated scope.

When no evidence is available at all, that is a finding, not a blocker. Record the claim as `unsupported` with the note "no source note, no full text in the project", and propose that the source be added by `oleafly-literature-sweep`.

Never judge from the title. Titles overstate, and a title that matches the claim is the most common way a wrong citation survives review.

## Step 6. Assign a support level

Exactly one of three, defined in full in `references/support-levels.md`.

| Level | Means |
|---|---|
| `verified` | The source states the claim, at the scope the sentence gives it. You can point to where |
| `partial` | The source supports a narrower or different version. The direction is right, the scope, magnitude, population or conditions are not |
| `unsupported` | The source does not state it, the citation does not resolve, or there is no citation and no source that would carry it |

`partial` is the level that does the most work. Most citation problems in real manuscripts are not fabrications, they are a true finding stretched one step past what was measured.

The evidence note must say what the source actually says, not just that it disagrees. "Measured on graphs up to 10k nodes; the sentence says arbitrary scale" is actionable. "Overstated" is not.

## Step 7. Update the claim record

Read the project's existing claim record first. If there is none, create `research/claims.md` using `assets/claims.md`. If an available application tool owns an equivalent claim record, update it through that tool and retain its identifiers rather than copying it to a second file. The task Finding tools cover deterministic numeric checks; do not use them as a substitute for this claim audit.

Include the audit scope and input revision or hash when available. Columns: claim ID, claim, location as `file:line`, cited key, support level, evidence note. Add summary counts, proposed fixes and any material coverage gaps. Unsupported claims must be identifiable in full, with what evidence is missing.

Merge the current scope without discarding other sections. Preserve existing claim IDs and distinguish results against an older manuscript revision from the current audit.

## Step 8. Optional deeper audit with the vendored script

`scientific-writing` ships `scripts/audit_claims.py`, which checks a Markdown manuscript against a structured claim registry and a source manifest. It is worth running when the project is Markdown and the user wants a machine checkable evidence trail, and it is overhead otherwise.

Before the first script call, check the interpreter once with `run_command` and `{"command": "python3 --version"}`. Below 3.11, skip this step and say so.

`load_skill` with `{"id": "scientific-writing"}` returns its absolute directory and file tree. It takes three positional arguments, in this order:

```
python3 "<scientific-writing dir>/scripts/audit_claims.py" manuscript.md research/claims.csv research/sources.json
```

- The manuscript, UTF-8 Markdown.
- A claim registry CSV with the columns `claim_id`, `section`, `claim_kind`, `claim_text_sha256`, `evidence_ids`, `verification_status`, `uncertainty`, `analysis_intent`. Template at `assets/claim_evidence_template.csv` inside that skill.
- A source manifest JSON with a `sources` array of records carrying `evidence_id`, `title`, `year`, `authors`, `identifiers`, `locator` and a `verification` block. Template at `assets/source_manifest_template.json` inside that skill.

Read either template with `read_skill_file` and `{"id": "scientific-writing", "path": "assets/claim_evidence_template.csv"}`.

Two related scripts from the same skill: `scripts/check_references.py <sources.json>` validates the manifest alone, and `scripts/lint_manuscript.py <manuscript.md>` checks the prose against the skill's writing rules.

Read the script result. If output would be truncated, capture it in the host's disposable run directory and read the needed parts. Retain raw output only when the audit needs it as evidence; do not create another summary of the same findings.

The script checks structure and completeness. It does not read the sources. It never replaces steps 5 and 6.

## Step 9. Present the result

Give the user the summary and a link or record ID for the claim record. When a separate report is requested, derive it from that record using `assets/audit-report.md`; the export does not become a second status owner.

Lead with the count at each level. Then list every `unsupported` claim in full, with its location and what is missing. These are the ones that must be resolved before submission, and burying them under the verified ones is how they get missed.

For each problem, propose a concrete fix and let the user choose:

- Narrow the sentence to what the source measured.
- Add a second citation that carries the rest of the claim.
- Replace the citation with one that actually supports it.
- Mark the statement as this work's own contribution rather than a citation.
- Remove the claim.

For an audit-only request, propose the fixes without changing author prose. When the request already authorizes revision, apply supported fixes with the host's editing tools and retain unresolved evidence gaps. In a ResearchTask, read the current file before a version-checked `write_file`.

## Step 10. Confirm the document still builds

If no build input changed, `compile` is not required. After authorized fixes, compile and inspect diagnostics. In a ResearchTask, pass the complete `artifact` returned by `compile` to `task_pdf_text` as `reference`. Continue with `nextOffset` until affected passages and citations have been read. Keep the original captured PDF distinct from this new artifact. In ordinary chat, use `get_pdf_text` if offered. Check the actual output and unresolved citations, not just compile success.

## Step 11. Hand off

- The methodology behind a claim needs appraising, not just the citation: `load_skill` with `{"id": "scientific-critical-thinking"}`.
- Sources are missing and have to be found: `load_skill` with `{"id": "oleafly-literature-sweep"}`.
- The bibliography itself is inconsistent, duplicated or malformed: `load_skill` with `{"id": "citation-management"}`.
- The whole manuscript needs a reviewer's read, not a claim audit: `load_skill` with `{"id": "oleafly-review-manuscript"}`.

## Failure handling

| What happened | What to do |
|---|---|
| No `research/sources/` directory | Look for existing library records or task `papers/` first. Record missing evidence without assuming no previous review exists |
| A cited key is in `unresolvedCites` | `unsupported`, reason "no bibliography entry". This is a build problem as well as a citation problem |
| `verify_citation` returns `verified: false` for an existing entry | The entry may be fabricated or the metadata wrong. Flag it prominently. Do not delete it yourself |
| The PDF is not in the project | Try DOI, arXiv or an open PDF with `read_paper` when offered. If only the abstract is available, state what it supports and that the full text was not read |
| The user asks you to fix the audited section | Apply supported fixes within that authorization. Ask only about a material choice the request does not resolve |
| A claim cites six keys at once | Audit the claim against the set. If no single source carries it and the set does not either, it is `unsupported` |
| `run_command` reports `timed_out` | Skip the script step. It is optional and the manual audit is the real work |

## Done when

- [ ] Every factual claim in the scope has a row, with a `file:line` location that `search_project` confirms.
- [ ] Every row has a support level and an evidence note that says what the source actually says.
- [ ] Every `unsupported` claim is listed in full in the claim record, not only counted.
- [ ] Every proposed fix names the file, the line, and the specific change.
- [ ] The existing claim record is updated, or `research/claims.md` is created when needed. A separate report is exported only when requested.
- [ ] Any author-prose revision is covered by the user's authorization and linked to supporting evidence.

## Reference files

- `references/support-levels.md` defines the three levels with worked examples and the judgement calls between them.
- `assets/claims.md` is the audit table template.
- `assets/audit-report.md` is the report template.

## From a terminal

Outside the app (a terminal, or a coding agent with a shell), the `oleafly` command does the same work. Always pass `--json` and check `ok`.

| In Oleafly | From a terminal |
|---|---|
| `compile` | `oleafly build --json` |
| `project_map` | `oleafly context --json` |
| `list_files`, `read_file`, `search_project` | Your own file tools; `oleafly context --json` for the outline |
| `verify_citation` | `oleafly bib check --json`, or `oleafly cite <doi> --json` for one entry |

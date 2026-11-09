---
name: oleafly-research-loop
description: Coordinate research writing across several stages in Oleafly. Use when the work needs a project-wide plan or help choosing specialist skills; focused tasks can use a specialist directly.
license: MIT
compatibility: Works in any Oleafly project. Stages that compile need a document engine (LaTeX, Typst or Markdown). Handoffs to vendored skills need Python 3.11 or newer on the login shell PATH.
allowed-tools: update_todos get_todos list_notes remember_note project_map list_files search_project read_file compile load_skill read_skill_file run_command spawn_agent wait_agent close_agent
metadata:
  version: "1.3.0"
  skill-author: "Oleafly"
  oleafly:
    tier: native
    phase: research
    tools:
      - update_todos
      - get_todos
      - list_notes
      - remember_note
      - project_map
      - list_files
      - search_project
      - read_file
      - compile
      - load_skill
      - read_skill_file
      - run_command
      - spawn_agent
      - wait_agent
      - close_agent
---

# Oleafly Research Loop

Use this router when a project spans several research or writing stages. Start with the
current task and workspace context. Read existing notes, files or `project_map` where they
resolve a question about the project; there is no required discovery sequence.

Plan substantial work in the host's existing todos or task record. `update_todos` replaces
the whole list; send the remaining and completed items together. Choose the stages needed
for the requested outcome rather than assuming every project needs a full writing cycle.

## Choose relevant expertise

Load the skill that helps the work at hand. Read supporting references only as needed.

| Work | Skill |
| --- | --- |
| Find papers and gather background | `oleafly-literature-sweep` |
| Evaluate a paper's evidence | `scientific-critical-thinking` |
| Conduct a systematic review | `literature-review` |
| Access literature APIs, DOI/PMID records or open-access papers | `paper-lookup` |
| Find datasets, code or research tools | `research-lookup` |
| Develop research ideas or hypotheses | `scientific-brainstorming`, `hypothesis-generation` |
| Design a study or size it | `experimental-design`, `statistical-power` |
| Analyze project data | `oleafly-data-analysis`, with statistics guidance as needed |
| Start a manuscript | `oleafly-manuscript-scaffold` |
| Write related work or background | `oleafly-related-work` |
| Audit support for claims | `oleafly-verify-claims` |
| Manage a bibliography | `citation-management` |
| Revise scientific prose or reporting | `scientific-writing` |
| Fix compilation | `oleafly-latex-build` |
| Adapt a template | `template-generate`, `venue-templates` |
| Reconstruct a PDF or clean imported source | `pdf-to-latex`, `import-refine` |
| Prepare manuscript figures | `oleafly-figure-prep` |
| Plot data | `scientific-visualization` |
| Draw a scientific diagram | `scientific-schematics` |
| Review a manuscript | `oleafly-review-manuscript`, `peer-review` |
| Assess scholarly work | `scholar-evaluation` |
| Prepare submission or a response letter | `oleafly-pre-submission`, `oleafly-response-letter` |
| Prepare a grant | `research-grants` |
| Make slides or a poster | `oleafly-slides-and-posters`, `scientific-slides`, `pptx-posters` |
| Run an OpenResearch experiment | `openresearch` |

## Reuse project artifacts

Keep the bibliography already wired into the document and its citation-key scheme.
`project_map` or a search for the document's bibliography directive can locate it.
Reuse the project's existing source and analysis records, including records exposed by
application tools. Their identifiers and provenance remain authoritative. Do not copy
them into Markdown and JSON merely to make another view. For records that need new
files, these are the shared locations used by the bundled skills:

| Path | Purpose |
| --- | --- |
| `research/reading-list.md` | Literature considered for the current review |
| `research/sources/<key>.md` and optional `.pdf` | Retrieved source and provenance |
| `research/notes/` | Reading notes and synthesis |
| `research/claims.md` | Claim audit |
| `review/` | Requested reviews and response material |
| `figures/` | Figures used by the manuscript |

Create an artifact when it serves the requested output, reuse or verification. Routine
turns do not need an extra progress report or handoff. Keep temporary command output in
the host's disposable run location and retain it only when a result needs that evidence.
A specialist's suggested path is a default when no equivalent record exists. Export
another format only when the task or a consuming tool needs it.

If a project has no citation-key convention,
`<firstauthor><year>-<slug>` is the default shared by source notes and bibliography entries.
`remember_note` is useful for durable conventions that future turns cannot recover from
the project itself.

## Tools

Use the tools offered by the current host. `load_skill` returns a skill's directory,
files and runnable script commands; scripts use absolute paths inside that directory.
Check a script's runtime requirements when needed. For long experiments, use the task's
`start_run` and `wait_runs` when available. Independent reading can be delegated with
`spawn_agent`. ResearchTask helpers return within that call and have a `brief` schema.
Ordinary chat agents use `wait_agent` and `close_agent`. Use the offered schemas.

Compile when changing the manuscript's build inputs. Questions, source searches and
standalone analysis do not require a document build. Report the requested result and any
remaining issue that affects it.

## References

- `references/handoffs.md`: additional skill routing examples.
- `references/project-layout.md`: source-note, bibliography and claim-table formats.
- `references/tooling.md`: tool permissions, limits and script use.
- `assets/reading-list.md`, `assets/source-note.md`, `assets/claims.md`: optional artifact templates.

From a terminal, `oleafly context --json` returns the project map and
`oleafly build --json` compiles it. Inspect the returned `ok` field.

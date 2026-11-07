---
name: Data analysis
description: Analyze project data and connect computed results to the requested report, figure, table or manuscript. Use existing scripts and outputs; load specialist statistics guidance when the method needs it.
license: MIT
compatibility: Needs python3 on the login shell PATH with the analysis packages the method requires. Scripts run through run_command in the project directory, with a 120 second timeout and a 200 KiB output cap.
allowed-tools: run_command, read_file, write_file, create_file, replace_in_file, list_files, search_project, compile, get_log, update_todos, remember_note, load_skill, read_skill_file
metadata:
  version: "1.1.0"
  skill-author: Oleafly
  oleafly:
    tier: native
    phase: authoring
    tools:
      - run_command
      - write_file
      - create_file
      - replace_in_file
      - read_file
      - list_files
      - search_project
      - compile
      - get_log
      - update_todos
      - remember_note
      - load_skill
      - read_skill_file
---

# Data analysis

Start from the research question, the available data and the requested deliverables.
Read the relevant data description and existing analysis before selecting a method.
Keep original inputs intact and write derived results to the project's output paths.
Use the user's specified filenames and command interface when provided.

## Method and computation

Resolve the observational unit, inclusion criteria, identities and comparison before
computing. Simple counts and descriptive comparisons do not require a hypothesis test.
Load `statistical-analysis`, `exploratory-data-analysis`, `statistical-power` or
`experimental-design` when its expertise is needed for the actual question.

Use an existing script or save a script for an analysis that must be rerun or delivered.
A short command is suitable for inspecting data or checking arithmetic. One clear script
can handle a small analysis; split stages when they have independent uses or expensive
work worth reusing.

Use the available interpreter and import only the packages the method needs. Inspect
versions or dependencies when they affect execution or interpretation. If a dependency
is missing, use an equivalent available implementation or obtain any permission needed
to install it; changing the scientific question is not an equivalent implementation.
Long runs belong in the host's run tools when offered (`start_run`, `wait_runs`), rather
than repeatedly hitting a short command timeout.

## Results

Run the analysis and inspect its actual output. Record exclusions and transformations
with their effect on the sample. Keep unidentified comparisons unknown and distinguish
observations from population or causal claims. Report uncertainty, test statistics and
effect sizes when the chosen inference calls for them. Preserve contradictory results.

Deliver the requested artifacts and enough information to reproduce the computation:
inputs, method and command, plus seeds for stochastic work and environment details that
matter. Put this in the existing report or analysis guidance; a second README, input
hash list, separate audit output or full pipeline skeleton is not required by this skill.

## Manuscript outputs, when requested

Reuse existing paths. For a new analysis, `analysis/` is a useful script location and
`analysis/out/` can hold derived data; create only what the task uses. Figures belong in
`figures/` and table fragments in `tables/` when the manuscript includes them.

Generate figures and tables from the computed results. Use vector output for line art,
appropriate resolution for raster content, labeled units and the target column size.
Match the manuscript's reporting style. Compile after integrating changes that affect
the document and inspect the relevant rendered content.

## References

- `references/analysis-layout.md`: optional script and output layout for reusable analyses.
- `references/reporting.md`: statistical reporting examples, table generation and plot export.

Read a reference with `read_skill_file` only when needed. From a terminal,
`oleafly build --json` compiles the project and `oleafly log --diagnostics --json`
returns build diagnostics; inspect the returned `ok` field.

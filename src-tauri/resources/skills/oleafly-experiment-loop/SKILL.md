---
name: oleafly-experiment-loop
description: Run and interpret experiments for an Oleafly research task using its existing run tools and ledger. Use for tuning, method comparisons or reproduction; choose experiments and stopping decisions from the question and task budget.
license: MIT
compatibility: Made for Oleafly research tasks, which provide start_run, wait_runs, read_run_log, ledger_append and results_table. Commands follow the task's brief (allowed, ask first, or off).
allowed-tools: start_run wait_runs run_status read_run_log cancel_run ledger_append results_table read_file write_file list_files search_project update_todos get_todos remember_note compile
metadata:
  version: "1.1.0"
  skill-author: "Oleafly"
  oleafly:
    tier: native
    phase: research
    tools:
      - start_run
      - wait_runs
      - run_status
      - read_run_log
      - cancel_run
      - ledger_append
      - results_table
      - read_file
      - write_file
      - list_files
      - search_project
      - update_todos
      - get_todos
      - remember_note
      - compile
---

# Oleafly Experiment Loop

Read the task brief for the question, success criteria, metric and budget. Inspect useful
existing results before choosing the next experiment. For a comparison, measure or use a
comparable reference result and keep the evaluation consistent. Record any intentional
change in measurement so unlike results are not treated as directly comparable.

Choose runs that distinguish plausible explanations. A single controlled change can
isolate an effect; factorial or exploratory work can need several factors together. Use
the design that answers the question. Preserve failed and negative results as well as
improvements. The task's criteria determine which implementation to keep.

## Run and inspect

Use `start_run` for long commands in a research task, for example:

```json
{"name": "reference", "command": "python train.py --config configs/base.yaml", "timeout": 30}
```

It returns a run id immediately. `wait_runs` waits for completion and returns state,
exit code, metrics and log tail. Use `read_run_log` for a relevant failure or
`cancel_run` when a run no longer serves the task. Inspect the actual result before
interpreting it or choosing the next run.

Use `ledger_append` to record the hypothesis, change, run id, verdict and interpretation.
The tool attaches the command and metrics from the run. Its `keep`, `discard` and `crash`
labels describe outcomes; discarded results remain available. Update the existing plan
or handoff when the direction changes or work must continue in another session.

## Report

Use `results_table` for tables of recorded metrics and retain its run markers when
inserting them into the manuscript. Explain comparisons using the run ids, settings and
uncertainty that support them. Results from other sources need their own attribution.
Generate requested figures from the recorded results and compile when incorporating
changes into the document.

Finish when the question is answered, the task's stopping condition is met, or the budget
ends. A remaining failure can motivate another informative experiment within that budget.
Report what was learned and any unresolved question in the requested deliverable or
existing handoff; this skill does not require an additional report or hypothesis file.

## Reference

`references/ledger.md` describes the ledger fields used by the task UI.

Parts of this skill follow ideas from OpenResearch (MIT License, copyright 2026 alphaXiv).

---
name: oleafly-development
description: Implement, debug, refactor or review software in the current project. Covers code ownership, existing contracts and behavior-focused verification.
license: CC-BY-4.0
metadata:
  version: "1.2.0"
  skill-author: "Research Workbench contributors"
  oleafly:
    tier: native
    phase: tooling
---

# Project Development

Inspect the affected implementation, its callers and current changes. Use the user's
request and supported contracts to establish the intended behavior. Preserve unrelated
edits and follow the project's build and test commands.

Reuse project functions and maintained components where they fit. Change the module
that owns the behavior, update its callers and remove obsolete internal paths together.
Keep single-use logic local. Validate external inputs at their owning boundary, then
work with the project's types internally. Add error handling for failures that the
operation actually needs to handle.

For a bug, use the observed failure to trace the cause and verify the fix. Select
regressions by the public behavior they protect. A review should identify actionable
findings with locations and impact. Keep supported persisted formats and historical
evidence intact unless the task includes a migration.

Use the host's existing task state for substantial work. Update existing guidance when
the behavior changes and remove this task's disposable outputs. Use Git for source
history and existing task/run records for progress. A routine change does not need a
new report, handoff, manifest or source backup. Preserve evidence needed to explain
acceptance, an important experiment or a useful diagnosis. Report the result and the
checks actually run; name any remaining blocker that affects delivery.

Workflow adapted from HelloAGENTS by Hellowind, inspected at revision 457d724
of https://github.com/Atanycosts/AgentSkills. The original documentation is
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
This adaptation uses Oleafly's existing tools and task lifecycle.

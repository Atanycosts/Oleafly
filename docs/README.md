# Engineering and product documentation

This directory contains public references for people using, integrating, and
developing Oleafly. Product pages explain the application's working surfaces
and their limits. Engineering pages describe the contracts behind them,
including architecture, supported engines, integrations, and release
operations. Where a screen is part of the explanation, the pages reuse the
curated screenshots from the root README.

## Research workspace

Oleafly is being developed around a research team you can direct from the same
workspace where you write. The team's work can span papers, references,
experiment code and runs, data, figures, and equations. You can work by hand or
give a coordinating agent a goal and permission to delegate. When a change
affects related work, the team should be able to find affected passages and
assets, check for inconsistencies in terms, references, and claims, and hand
the review to the responsible member without waiting for you to direct every
step.

You should be able to trace actual actions and handoffs to the affected objects,
versions, and evidence without reading the whole conversation. You can select
and annotate a passage, result, or page region for the team while it works,
redirect it, take over, and decide what to adopt. Agents should reuse the
application's tools within the granted scope, including through MCP and CLI
where those interfaces expose them.

The [DOCX formatting acceptance](agent/status.md#docx-模板排版候选2026-11-21)
covers preparing, reviewing, adopting, and exporting a separate journal-format
candidate entirely in Oleafly. The figure replacement trial is recorded
separately. See [Agent status](agent/status.md) for what has been checked,
[Word documents](Editor.md#word-documents) for editing behavior, and the
[integration overview](research-workbench-integration.md) for how Agent
execution uses Workbench's document and journal services.

## Reference by area

| Area | References |
| --- | --- |
| Product surface | [Features](features.md), [General](General.md), [Project library](ProjectLibrary.md), [Editor](Editor.md), [PDF preview](PDFPreview.md), [Source control](SourceControl.md), [Checkpoints](Checkpoints.md), [Computer Use](desktop-apps.md) |
| Authoring tools | [Keyboard shortcuts](KeyboardShortcuts.md), [AI Copilot](AICopilot.md), [Citations](Citations.md), [Diagram composer](DiagramComposer.md), [Templates](Templates.md), [Tools gallery](Tools.md), [Skills](Skills.md) |
| Document quality | [Preflight](Preflight.md), [Export](Export.md), [Conversion matrix](conversion-matrix.md), [Conversion roadmap](conversion-roadmap.md), [Compilation engines](CompilationEngines.md) |
| Integrations | [Integrations](Integrations.md), [MCP integration](mcp.md), [Document engines](document-engines.md), [Typst toolchain catalog](typst-toolchain.md), [AI model catalog](ai-model-catalog.md) |
| Local Agent and Workbench | [Current status](agent/status.md), [Architecture](agent/architecture.md), [Component reuse](agent/reuse.md), [Integration overview](research-workbench-integration.md) |
| System design | [Product architecture](architecture.md), [Design system](design-system.md), [Development](development.md), [Opening folders from the OS](os-integration.md), [Language-server toolchain](language-server-toolchain.md), [Deferred app zoom experiment](app-zoom-experiment.md) |
| Collaboration | [Oleafly Server](collaboration-server.md) |
| Release operations | [Releasing](releasing.md), [Code signing](signing.md), [Auto-updates](updates.md) |

## Sources of truth

| Fact | Authority |
| --- | --- |
| End-user task guides | Maintained in the separate Oleafly product-docs repository; use the published [product guides](https://oleafly.com/docs/) for reader-facing instructions. |
| Product behavior | The current owning page in this directory, backed by the implementation and scoped verification it cites. |
| Protocol fields and versions | The owning machine-readable contract and implementation. Descriptive pages link to them rather than maintain competing version tables. |
| Root overview and translations | English [`README.md`](../README.md); files in `readme-translations/` are translations that must follow its structure and links. |
| Local Agent and Workbench | [Agent status](agent/status.md), [Agent architecture](agent/architecture.md) and [Workbench domain status](../services/research-workbench/docs/s1-progress.md) each own their scope. The [integration overview](research-workbench-integration.md) routes between them. |
| Generated conversion matrix | Routes come from `REGISTRY` in `packages/conversion-registry/src/index.ts`; `matrix.ts` renders them. Regenerate [the page](conversion-matrix.md) with `pnpm gen:conversion-matrix`. |
| Toolchain catalogs | The generated JSON and manifests under `src-tauri/resources/` and `scripts/`; their linked pages explain the formats and update procedures. |

Many pages here are inherited from upstream Oleafly. Keep inherited wording when it
remains accurate so future upstream merges are easy to review, and make fork-specific
changes in the page that owns the affected fact. Current facts belong in the current
page; dated plans and verification records are history.

The [Word workspace proposal (2026-11-16)](word-workspace-design.md) is a
DOCX-specific design record; use [Word documents](Editor.md#word-documents)
and [Agent status](agent/status.md) for current behavior and progress. The
[fused research-agent design (2026-11-05)](../services/research-workbench/docs/fused-research-agent-architecture.md)
is a frozen design input; use the [integration overview](research-workbench-integration.md)
for current responsibilities.

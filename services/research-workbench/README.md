# Research File Workbench

Local-first tooling for reliable scientific-document inspection and controlled file operations.

This Python service is maintained inside the Oleafly repository at
`services/research-workbench/`. Oleafly owns the native application, Agent execution and project
interface; this service owns captured document bytes, journal rules, versions and evidence.

The historical **Phase 0** baseline and the unreleased, partial S1 read-only DOCX
implementation retain their original scope. Phase 0 covers project contracts, source inventory, environment
inventory, workspace fingerprinting and validation fixtures. The reader handles selected OOXML
structures for fixture-driven review; it does not yet represent a complete DOCX reader and does
not modify manuscripts.

## Repository layout

```text
contracts/          Machine-readable product and Phase 0 inputs
docs/               Human-readable engineering and Phase 0 guidance
annotations/        Independent annotation templates and instructions
schemas/            JSON schemas for generated reports
src/                Reusable Python implementation
tests/              Focused regression tests
tools/              Bounded engineering and Phase 0 operator tools
reports/            Generated, reviewable verification evidence
var/                Ignored development cache and temporary files
```

Author manuscript directories are inputs and remain read-only. Generated files stay inside the
declared application output directory or explicitly selected library, never beside author inputs.

## Oleafly setup

From the Oleafly repository root, install [uv](https://docs.astral.sh/uv/) and run:

```sh
pnpm workbench:setup
pnpm tauri dev
```

The setup command creates this service's `.venv` and installs the package with its developer
extras. `pnpm tauri dev` supplies that interpreter when no explicit
`OLEAFLY_WORKBENCH_PYTHON` is set. Packaged apps retain the existing runtime selector; choose
this environment's Python executable once. Existing journal libraries remain in their selected
application-data directory. A source merge does not relocate data or rewrite saved paths.

The previous standalone Workbench desktop shell is archived locally. Packaging support code
remains for its existing boundary tests; Oleafly is the active application shell.

## Development commands

```powershell
python -m pip install -e ".[dev,fixture-building]"
pwsh -NoProfile -File tools/verify.ps1
```

The verification script stops at the first failed gate and isolates temporary test data under
`var/`. See the [development guide](docs/engineering/development-guide.md) and
[module responsibilities](docs/engineering/layout-and-naming.md). Individual commands:

```powershell
ruff format --check --no-cache .
ruff check --no-cache .
mypy
python -m pytest
rfw-phase0 validate
rfw-phase0 build-reports
```

Earlier integration audits and private execution reports are retained locally outside the
public source snapshot. Their verified scope and remaining acceptance limits stay separate
from the frozen requirement baseline; current integration status is maintained in the
[Oleafly integration guide](../../docs/research-workbench-integration.md).

The CLI may also be run without installation:

```powershell
$env:PYTHONPATH = "src"
python -m research_file_workbench.phase0 validate
python -m research_file_workbench.phase0 build-reports
```

Pinned WPS rendering is performed with `tools/phase0/export-pdf-with-wps.ps1`. The script refuses
to run while an existing WPS Writer process is active, renders an application-owned copy, and
verifies that the source hash remains unchanged.
The profile comes from `contracts/phase0/render-environments.json`. Before opening an input,
an unsaved blank probe identifies the COM window's actual process; its path, executable hash,
version and start time must match the selected profile and a newly started session. The script
never requests application shutdown. Missing window/process identity is a refusal, not a fallback.

Output guards reject reparse points in the entire parent chain, existing output and author-root
overlap. These checks do not constitute an OS sandbox against a hostile concurrent process.
The input interface remains an operator-controlled local CLI, not a claimed isolated Agent runtime.

Contract verification uses the standard library and the existing Poppler `pdfinfo` command to
check physical PDF page counts. `pdfinfo` must be on PATH; failure to inspect is a failed gate.
`validate` and `build-reports` return nonzero if Phase 0 is incomplete, even if JSON is valid.

The process-identity export path has unit and refusal tests; historical live smoke evidence is
stored under `reports/phase0/`. Current implementation status is in `docs/s1-progress.md`.
The root `方案文档.md` is the requirements baseline, including its original planning status.
Passing local checks does not substitute for independent S1 acceptance or a release decision.

## Portable tests and private acceptance evidence

Committed tests retain generated DOCX fixtures, their independent annotations and frozen
synthetic PDF/PNG renders. `tests/phase0/project_factory.py` builds isolated controlled author
and renderer placeholders using `tests/fixtures/phase0/`; these verify validator behavior and
do not attest author content or a real rendering environment.

The historical author source catalog, manuscript render baseline, real manuscript annotations,
raw provider traces, databases and credentials stay local and ignored. `rfw-phase0 validate`
checks those actual environment-bound inputs and fails explicitly when they are absent. Its
result is separate from the portable regression suite. Frozen private bytes are preserved.

## Phase boundaries

- Phase 0 fixes samples, environment, schemas, annotations, capability boundaries, and acceptance
  fixtures.
- S1 implements and validates the DOCX read-only vertical slice.
- S2A adds journal template and rule-pack processing.
- S2B adds proposal preflight and approved DOCX text replacement.

See [docs/phase0/README.md](docs/phase0/README.md) for the Phase 0 deliverables.

The S1 query slice exposes application-owned snapshots through `rfw-s1-query`: catalog discovery,
region/object selection, reviewed page selection, pagination and exact response receipts.
See [on-demand reading](docs/s1-on-demand-reading.md) for commands and limitations, and
[current S1 progress](docs/s1-progress.md) for implementation and acceptance status.

Persistent single-DOCX projects use `rfw-project` for explicit imports, immutable baselines,
versioned observations and restart-safe read responses. See
[project storage](docs/s1-project-storage.md) for commands, concurrency and evidence boundaries.

The journal-world slice provides a local browser workbench for importing journal sources, creating
versioned worlds, binding a retained DOCX project, checking declared page geometry and reviewing
rule evidence. Start it with:

```powershell
$env:PYTHONPATH = "src"
python -m research_file_workbench.workbench.cli --library-root D:/ResearchWorkbench/journal-library init
python -m research_file_workbench.workbench.cli --library-root D:/ResearchWorkbench/journal-library serve
```

This slice supports immediate local world use without a publish gate. It does not claim full journal
compliance, PDF guide semantic extraction, manuscript editing or remote authentication. See the
[journal-world design](docs/journals/journal-world.md).

PDFs, page images and independent mapping records can be retained with `rfw-project register-render`.
Page queries select an explicit bundle and preserve unreviewed/ambiguous coverage. See
[persistent page evidence](docs/s1-page-evidence.md) for commands and trust boundaries.

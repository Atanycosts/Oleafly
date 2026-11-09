# Backend engineering standards

This document is the implementation standard for the Python backend under
`src/research_file_workbench/`. It complements the frozen product requirements and the
module map in `layout-and-naming.md`. It describes the current architecture, not a future
capability list.

## Package boundaries

The backend is split by data ownership and failure semantics:

| Package | Owns | May depend on |
|---|---|---|
| `common` | Hashes, strict JSON, paths, fingerprints and media inspection | `common` and the standard library |
| `phase0` | Contract checks, fixtures, environment and acceptance reports | `common`, `phase0` |
| `docx` | Immutable OOXML observations, query selection and read receipts | `common`, `docx` |
| `projects` | Project SQLite state, source baselines, evidence and saved reads | `common`, `docx`, `projects` |
| `journals` | Retained rule worlds, deterministic analysis and geometry checks | `common`, `docx`, `journals` |
| `workbench` | Composition, local HTTP, browser transport and MCP transport | `common`, `docx`, `projects`, `journals`, `workbench` |

The dependency direction is one-way. `common` never imports a domain package. Domain SQL
helpers accept an existing transaction connection and never commit independently. The HTTP,
CLI, MCP and desktop layers are adapters; they do not introduce a second source of truth.

The local HTTP implementation has three distinct layers: `server.py` owns the listening socket,
startup asset snapshot and public compatibility exports; `request_handler.py` owns request
lifecycle, session/origin refusal and POST framing; `get_routes.py` owns GET route dispatch;
`http_boundary.py` owns reusable wire-field, upload, query and response encoding rules. Journal
storage follows the same split: `store.py` owns the connection/schema/transaction facade, while
`store_records.py`, `store_worlds.py`, `store_bindings.py` and `store_checks.py` execute focused
SQL operations on the caller-owned connection.

## Boundary and core rules

External values enter through one boundary conversion: CLI arguments, HTTP JSON, MCP tool
arguments, SQLite payloads and captured file bytes are validated before they reach core logic.
Unknown fields, duplicate JSON keys, invalid paths and unsupported versions are explicit errors.
The MCP surface is a declared SDK exception: its schema layer ignores unknown tool keys, so the
MCP contract records that limit and handlers must never use ignored keys to broaden a selection.
An error is never converted to an empty collection, a default object or a successful status.

The browser, the operator CLI and the local MCP entry project the same `WorkbenchService`
operations, so a capability added to one surface must be reachable from all three in the same
change. Two records stay operator-only on purpose: author decisions refuse agent proposals, and
render-bundle registration captures independent human evidence.

Core functions receive typed values and return a real result or raise a domain-specific error.
Top-level adapters translate that error into a nonzero CLI exit, an HTTP status, a `ToolError`
or a failed startup. Library code does not print and does not decide a fallback implementation.

Use `dataclass` for immutable internal observations and validated request values, `TypedDict`
for stable JSON shapes, and Pydantic only at a genuinely complex external boundary. Do not
let an unbounded `Any` or a raw untyped `dict` cross package boundaries.

## Persistence and evidence

`ProjectStore` and `WorldStore` own connection and transaction lifetimes. A write operation
must define its idempotency key, compare-and-swap guard, retained bytes, method dependencies
and recovery record before it is implemented. A dependent write rechecks the source baseline
and relevant binding while holding the transaction boundary.

Persisted facts and derived presentation stay separate:

- source bytes, hashes, object observations, world versions and original verdicts are retained;
- validity, staleness, update availability and dispositions are derived from retained facts;
- a read receipt records exactly what was delivered, while a catalog response records no read;
- historical responses are replayed as saved bytes and never execute an old method;
- independent annotations remain independent inputs and are never generated from parser output.

Changing parsing, mapping, query, analysis or validation meaning requires a method version
change. Historical bytes remain unchanged. A compatibility alias or selectable legacy engine
is not a substitute for a versioned boundary.

## File and process safety

Author workspaces are read-only inputs. Product code captures bytes into application-owned
storage and writes generated reports only under `reports/` or `var/`. Every path operation checks
the declared root and reparse-point chain before access. These checks are an application boundary,
not an operating-system sandbox against a hostile concurrent process.

The desktop shell owns the Python process and window lifecycle. The Python service owns HTTP
and product state. The service advertises a dynamically bound IPv4 loopback address only after
its library and static assets validate; the shell never connects to a fixed port or another
process.

## Tests and acceptance

Every observable change gets a focused regression for its success path and its refusal or
integrity path. Tests use temporary application libraries and controlled author copies; they do
not launch Office, rewrite reviewed annotations or mutate author workspaces.

The minimum backend gate is:

```powershell
pwsh -NoProfile -File tools/verify.ps1
```

This runs Ruff formatting, Ruff lint, strict mypy, the Python suite and Phase 0 validation in
the project virtual environment. JavaScript syntax and Rust checks are separate desktop gates.
An environment failure must be reported separately from a product test failure. Passing these
automated checks does not satisfy the outstanding independent S1/IJAM object and page evidence
review documented in `docs/s1-progress.md`.

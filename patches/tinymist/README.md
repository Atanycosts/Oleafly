# Tinymist 0.15.8 editor diagnostic revision patch

This directory contains Oleafly's source patch for stale editor diagnostics in
Tinymist v0.15.8:

- Patch: [`editor-diagnostics-revision.patch`](editor-diagnostics-revision.patch)
- Upstream tag: `v0.15.8`
- Annotated tag object:
  `3d3bf727b433f3474753d036f7c83e5b6ae245a8`
- Dereferenced commit:
  `32f908199ee17ea295512bbc27166e890c438175`
- Repository:
  <https://github.com/Myriad-Dreamin/tinymist/tree/v0.15.8>
- Source archive:
  <https://github.com/Myriad-Dreamin/tinymist/archive/refs/tags/v0.15.8.tar.gz>
- License: [Apache-2.0](https://github.com/Myriad-Dreamin/tinymist/blob/v0.15.8/LICENSE)

The patch preserves the upstream documentation and license. Its instance ID and
request changes are internal to the vendored source build; Oleafly does not
publish modified Tinymist crates.

## Baseline

The patch was made against these pristine v0.15.8 files:

| File | SHA-256 |
| --- | --- |
| `crates/tinymist/src/actor/editor.rs` | `39a86a8730be41888dc9616904bd154516ce4c45e5e4afd7c82dd4bc8f3029b5` |
| `crates/tinymist/src/project.rs` | `3882007ae9cd7481797857c022538b8544cf660369f9d9ed86ebc1d99953941f` |
| `crates/tinymist/src/lsp/workspace_change_tests.rs` | `ae94a8ce9454f5de8e6710477c804005fd1eb0e1ef0b51ef046a99dbc03bbd82` |
| `crates/tinymist-project/src/compiler.rs` | `d272d176a8d565cfd30f759555bf296aa6e40201d72b6a6818490ba0e010e3d5` |

## Problem

Tinymist starts compilation work asynchronously through Rayon. The revision
check in `CompileHandlerImpl::notify_compile` releases its lock before linting,
diagnostic conversion, and the final `EditorRequest::Diag` send. An older
compile can pass that check, be delayed, and publish after a newer compile.
Disabling Tinymist lint does not cover the ordinary compilation diagnostics.

`ProjectInsId` is also reused. A primary reload and a dedicated-project restart
create a new project state while retaining the logical ID, and the new state can
start again at revision 1. ID plus revision therefore cannot distinguish a late
diagnostic from the retired instance.

Project removal had a separate lifecycle gap. `reload_projects` replaced the
project before retiring the old one, and delayed retirement did not reliably
publish a clear when the new instance had not produced diagnostics yet.

## Patch behavior

Each `ProjectInsState` receives a process-local, monotonically increasing
`ProjectInsInstanceId`. Compilation artifacts and reports carry that generation,
and editor diagnostic versions and removal requests preserve it.

The compiler discards an artifact from a retired instance before it can update
a replacement project with the same logical ID. The handler's status and
notified-revision bookkeeping also observes the instance so a delayed old
artifact cannot make revision 1 from the replacement look stale.

`EditorActor` keeps a small per-project ordering gate containing the active
instance, latest accepted revision, and active/removed state:

- A lower revision from the current instance is discarded.
- An equal revision remains valid because one revision can emit more than one
  publication.
- A newer instance begins at any revision, including 1.
- A retired instance becomes a tombstone, so late diagnostics cannot reappear
  before the replacement publishes diagnostics.
- On receipt of `EditorRequest::RemoveProject`, the editor clears the retired
  instance's diagnostics and installs its tombstone. A late removal from an
  old instance cannot clear the replacement.

`reload_projects` now synchronously sends removal requests for every old primary
and dedicated instance before the replacement can compile. Dedicated restart
and `clear_dedicates` use the same instance-qualified removal path.

This patch orders editor diagnostic publication and the compiler bookkeeping
needed for reused project IDs. Export, preview and word-count tasks retain
their existing scheduling and cancellation behavior.

## Regression coverage

The Rust tests cover:

- `diagnostic_revisions_reject_late_publications`
- `editor_actor_rejects_late_diagnostic_revision`
- `editor_actor_applies_diagnostic_revision_to_clear`
- `editor_actor_remove_diagnostic_revision_clears_without_replacement`
- `editor_actor_isolates_restarted_diagnostic_revision`
- `primary_reload_diagnostic_revision_removes_old_instance_without_final_diagnostic`

The LSP workspace-change harness now tracks `(project instance, revision)`
instead of a bare last revision. Its primary-reload regression retires the old
instance without requiring a replacement diagnostic, then attempts to publish
the captured old diagnostic and asserts that the tombstone rejects it.

## Files changed

- `crates/tinymist/src/actor/editor.rs`
- `crates/tinymist/src/lsp/workspace_change_tests.rs`
- `crates/tinymist/src/project.rs`
- `crates/tinymist-project/src/compiler.rs`

Each changed Rust file starts with a `Modified by Oleafly` notice.

## Apply

From the root of an exact v0.15.8 source checkout or extracted archive:

```bash
git apply --check --whitespace=error-all \
  /path/to/Oleafly/patches/tinymist/editor-diagnostics-revision.patch
git apply --whitespace=error-all \
  /path/to/Oleafly/patches/tinymist/editor-diagnostics-revision.patch
```

## Validation

The [source-build workflow](../../.github/workflows/validate-tinymist-patch.yml)
runs for pull requests that change the patch or its validation inputs. It checks
out the exact source commit, applies the patch, and runs the targeted Rust
regressions on the upstream 1.92.0 toolchain. It builds `tinymist-cli`, verifies
the executable's source commit and target, and uses the same diagnostic smoke
as the [packaged server](../../docs/language-server-toolchain.md#optional-current-host-diagnostics-smoke).
Linux x86-64 runs first; the other four supported targets follow only after it
passes. Each successful job uploads a candidate with its SHA-256, source and
patch metadata, and upstream license. These checks do not publish a release or
change the shipping manifest.

On 2026-11-18, [the hosted candidate run](https://github.com/Atanycosts/Oleafly/actions/runs/44232534556)
passed the source tests, binary identity check and LSP smoke on all five targets.
Run artifacts are short-lived verification evidence. The bundled server still
comes from the upstream release archive selected by the shipping manifest.

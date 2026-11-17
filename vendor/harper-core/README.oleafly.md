# Vendored harper-core 2.10.0

This directory contains the source published as `harper-core` 2.10.0. It is
copyright 2024 Automattic Inc. and the Harper contributors, and is licensed
under Apache-2.0; the complete upstream license is in [`LICENSE`](LICENSE).

- Upstream: <https://github.com/automattic/harper>
- Crate: <https://crates.io/crates/harper-core/2.10.0>
- crates.io archive SHA-256:
  `9fa67052c3af56f7e385d64671ac9de2bc8ee05c0e02a9987a1417dd0bbae69d`
- Upstream VCS commit:
  `e2773c6c8b55f028c24574819d266ca03f45c701`

The crate's embedded `Cargo.lock` is intentionally omitted because the
workspace lock file owns dependency resolution. Every other file from the
published package is retained, including Harper's dictionary, rule data, and
test resources.

Oleafly makes two downstream changes:

1. `Cargo.toml` and `Cargo.toml.orig` raise only the `zip` requirement from
   `8.6.0` to `9.1.3`. Cargo reads that as `>=9.1.3, <10`; the workspace
   already resolves `zip` to 9.1.3.
2. `src/weirpack/mod.rs` propagates `ZipFile::name()`'s new
   `ZipResult<Cow<str>>` result with `?` before converting the name to a
   string. zip 9 changed this method from returning `&str`.

The zip upgrade addresses the security advisories
[RUSTSEC-2026-0545](https://rustsec.org/advisories/RUSTSEC-2026-0545),
[RUSTSEC-2026-0546](https://rustsec.org/advisories/RUSTSEC-2026-0546),
[RUSTSEC-2026-0547](https://rustsec.org/advisories/RUSTSEC-2026-0547), and
[RUSTSEC-2026-0548](https://rustsec.org/advisories/RUSTSEC-2026-0548). Their
patched releases are zip 9.0.0 for the first three and zip 9.0.5 for the
fourth.

Remove this copy and its workspace `harper-core` patch when a retained Harper
release depends on a patched zip version and Oleafly has accepted that
release's spelling and grammar behavior. Recheck the advisories at that time.

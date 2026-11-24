# Releasing Oleafly

## The one thing to understand

A release is triggered by pushing a **git tag** shaped like `vX.Y.Z`
(e.g. `v0.2.5`). That tag push starts the **Release** workflow
(`.github/workflows/release.yml`), which builds installers for macOS, Windows,
and Linux and creates a **draft** GitHub Release.

Pushing to `main` does **not** make a release. It only runs tests (CI).
Tag = release; branch = tests.

## Cutting a release

```sh
# 1. Be on an up-to-date main with green CI
git checkout main && git pull

# 2. Bump the version everywhere (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)
./scripts/bump-version.sh 0.2.5

# 3. Commit the bump. Stage the files by name, never with -a, -A or "."
git status --short
git add CHANGELOG.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml Cargo.lock
git commit -m "chore: release v0.2.5"
git push

# 4. Tag it and push the tag: THIS triggers the build
git tag v0.2.5
git push origin v0.2.5
```

Then wait ~15-25 min. The workflow creates a **draft** release at
<https://github.com/Oleafly/Oleafly/releases>. Review the notes and the
attached files. To publish, re-run the Release workflow from the Actions tab
for the same tag with **Publish the release** checked. Nothing is public until
you publish.

## What version number?

Semantic versioning (`MAJOR.MINOR.PATCH`):

- **PATCH** (`0.1.0 → 0.1.1`): bug fixes only.
- **MINOR** (`0.1.0 → 0.2.0`): new features, backward-compatible.
- **MAJOR** (`0.1.0 → 1.0.0`): breaking changes, or the "it's ready" milestone.

## Manual alternative (no tag)

GitHub → **Actions** tab → **Release** → **Run workflow** → enter a tag
(e.g. `v0.2.5`). Same result, handy to re-run if a build failed.

## After publishing

Installed apps check `latest.json` on launch and offer the update. So the
in-app updater only *does* something once there are **two** published releases:
the version a user has installed, and a newer one to update to. Your first
release just establishes the baseline.

## Provenance and SBOMs

Every release build creates GitHub artifact attestations for the files uploaded
by Tauri and for the canonical `latest.json` updater manifest. It also attaches
one SPDX JSON software bill of materials (SBOM) for each supported build target:

- macOS Apple Silicon
- macOS Intel
- Linux x86_64
- Linux ARM64
- Windows x86_64

The workflow verifies the uploaded files against GitHub's attestation service
before a draft is marked complete. Missing SBOMs or invalid attestations keep
the release in draft state.

Anyone can independently verify a downloaded installer with the GitHub CLI:

```sh
gh attestation verify ./Oleafly-installer-file \
  --repo Oleafly/Oleafly \
  --signer-workflow Oleafly/Oleafly/.github/workflows/release.yml
```

To verify the installer's SPDX SBOM attestation as well:

```sh
gh attestation verify ./Oleafly-installer-file \
  --repo Oleafly/Oleafly \
  --signer-workflow Oleafly/Oleafly/.github/workflows/release.yml \
  --predicate-type https://spdx.dev/Document/v2.3
```

## Public Workbench engine

The public Release workflow sets `OLEAFLY_WORKBENCH_BUNDLE_POLICY=public-unbundled`.
It removes any locally staged Workbench engine and checks the staging directory before
Tauri uploads anything. The packaged macOS application is checked again for `rfw-workbench`
and MuPDF/PyMuPDF files. These public builds cannot open Workbench-backed Word working
copies or run Journal checks on any platform. They do not reuse a configured Python, and
the existing `<OLEAFLY_DATA_DIR>/journal-library` stays in place. If you rely on Word working
copies, export the drafts you need and back up that directory before upgrading. See the
[development guide](development.md#journal-workbench-service) for opening a copy of the
library with a trusted checkout.

This is the fail-closed default, not a statement that local bundling is useless.
Normal arm64 macOS builds from a checkout still bundle the engine for local or internal
use. Do not upload those artifacts to a public release.

PyMuPDF/MuPDF is offered under AGPL-3.0 or a commercial licence. A public binary may
not be published merely because the bundle contains a licence text. Before changing the
release policy, record and verify one of these routes for the exact shipped version:

- **AGPL route:** retain the complete corresponding source for MuPDF, PyMuPDF and every
  bundled component, the exact build configuration and scripts, modifications, the AGPL
  text and notices, and an offer/source-location that satisfies the licence. The source
  must correspond to the binaries actually built; a version string or an unrelated
  upstream archive is not enough.
- **Commercial route:** obtain written clearance from the rights holder that expressly
  permits Oleafly to redistribute the exact PyMuPDF/MuPDF version in public desktop
  binaries. Keep the clearance with the release record.

Attestations and SBOMs identify artifacts; they do not supply redistribution rights.
Implement a verifier that checks the chosen evidence against the built bundle, then change
the policy deliberately. Until that exists, public releases must remain engine-free.

## Historical tag rebuilds

The workflow can be dispatched for an older tag while its YAML comes from the current
branch. Every optional build helper is therefore discovered from the checked-out tag:
missing Workbench, language-server, Pandoc, Typst, Biber, VC++ runtime, smoke-test or
changelog scripts are skipped rather than run against files that do not exist. The SBOM
input includes the old tag's actual manifests, and a tag with no Workbench service does
not gain a Workbench smoke or install step. Do not "fix" a historical build by copying
current-tree helper files into its checkout.

## Gotchas

- **The tag must match the manifests.** That's the whole job of
  `bump-version.sh`: run it, don't hand-edit versions.
- **Don't reuse a tag.** To redo `v0.2.5`: delete the remote tag
  (`git push origin :v0.2.5`), delete the draft release, then re-tag.
- **Windows builds are unsigned** until the Azure signing secrets are added,
  and users see a SmartScreen warning on first launch. macOS releases are
  code-signed and notarized. The **updater** artifacts are separately
  minisign-signed (repo secrets `TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). See [signing.md](signing.md) and
  [updates.md](updates.md).

# Developer documentation

[Back to Oleafly](../../README.md)

User guides live in the [Oleafly product docs](https://oleafly.com/docs/overview/).
The references below are for contributors, integrators, and release maintainers.

| Reference | Covers |
| --- | --- |
| [Engineering index](../README.md) | Feature inventories and engineering contracts |
| [Feature reference](../features.md) | The product surface and supported workflows |
| [Tools gallery](../Tools.md) | Built-in converters, research, reference, statistics, and writing tools |
| [Document engines](../document-engines.md) | LaTeX, Typst, and Markdown capabilities |
| [Product architecture](../architecture.md) | System boundaries, package ownership, and extension points |
| [Development](../development.md) | Local setup, tests, and contribution workflow |
| [Language-server toolchain](../language-server-toolchain.md) | Fetching, integrity, and distribution policy |
| [MCP integration](../mcp.md) | External clients, access tokens, and approval policies |
| [Releasing](../releasing.md) | Release workflow and artifact checks |
| [Code signing](../signing.md) | Platform signing requirements |
| [Auto-updates](../updates.md) | Update manifests, signatures, and rollback |
| [Windows v0.4 validation](windows-v0.4-validation.md) | The flow inventory run against a packaged Windows build |
| [Windows lifecycle audit](windows-lifecycle-audit.md) | Process, storage, and terminal lifetimes and their bounds |

## Build from source

Follow [First run](../development.md#first-run) as the single setup procedure
for prerequisites, compiler sidecars, and the first development launch. The
same guide covers [day-to-day builds](../development.md#day-to-day) and
production bundles.

Editor intelligence through TexLab and Tinymist is optional for a local run.
Fetch those language servers with `pnpm language-servers:fetch`. See the
[language-server toolchain](../language-server-toolchain.md) for its integrity,
licensing, and distribution policy.

### Command line

The command-line adapter ships inside the desktop app and has a dedicated
standalone release workflow in
[`release-cli.yml`](../../.github/workflows/release-cli.yml). See
[CLI install](../cli.md#install) for current installation paths and
compatibility. Use `cargo run -p oleafly-cli --bin oleaflyc -- --help` for a
source-checkout build.

## Contribute

Read the [contributing guide](../../CONTRIBUTING.md) for the development workflow,
code conventions, and required checks. Report security issues through the
[security policy](../../SECURITY.md).

## Credits

Oleafly builds on
[Tauri](https://tauri.app/),
[React](https://react.dev/),
[CodeMirror](https://codemirror.net/),
[Tectonic](https://tectonic-typesetting.github.io/),
[Typst](https://typst.app/),
[pdf.js](https://mozilla.github.io/pdf.js/),
[Zustand](https://github.com/pmndrs/zustand),
[Tailwind CSS](https://tailwindcss.com/),
[Harper](https://writewithharper.com/), and
[Hunspell](https://hunspell.github.io/).

Oleafly is licensed under
[AGPL-3.0-or-later](../../LICENSE). Third-party notices are listed in
[THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md).

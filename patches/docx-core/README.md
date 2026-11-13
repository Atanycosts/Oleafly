# DOCX core frame patch

Oleafly pins `@docx-editor.dev/core` 2.36.0. Its npm `gitHead` is
[`86869eedede5b793c910be804db6280b036b0b50`](https://github.com/eigenpal/docx-editor/tree/86869eedede5b793c910be804db6280b036b0b50).
The package uses Apache-2.0. Its existing license and attribution resources remain unchanged.

`multicolumn-frames.source.patch` is the readable source change and regression.
`../@docx-editor.dev__core@2.36.0.patch` installs the compiled ESM/CJS change through
`pnpm-workspace.yaml`. It changes two runtime chunks. Their names stay stable so all
existing subpaths share the same engine instance. Source serialization is unchanged.

The supported subset is an explicit-width page/margin horizontal frame wider than
every section column with `none` or `notBeside` wrap. Each intersected column gets an
existing exclusion zone. Adjacent text-relative frame groups stack in source order.
Narrow, side-wrapped, auto-width and text-horizontal frames keep their existing
multi-column behavior. This patch does not change LibreOffice's DOCX importer.

## Rebuild

Use an ignored scratch directory. Keep two checkouts at the pinned commit, named
`baseline` and `source`. Install the fixed upstream lock's dependencies with Bun
1.4.4 in `source`, and make the same dependencies available to `baseline`.
Do not install the complete upstream toolchain into Oleafly's root dependencies.

Apply the source patch in `source`:

```bash
git apply /absolute/path/to/Oleafly/patches/docx-core/multicolumn-frames.source.patch
```

In each checkout, empty only its generated `packages/core/dist` directory and run
`node ../../node_modules/tsup/dist/cli-default.js` from `packages/core`.
The upstream `tsup` 9.0.0 configuration builds both runtime formats. Retain the
published declarations, CSS, WASM and notices. This change adds no public type or
third-party dependency. Build `i18n` declarations before checking the core types.

Run the source regressions with the upstream Bun test setup:

```bash
bun test packages/core/src/layout/__tests__/paragraph-frame*.test.ts \
  packages/core/src/layout/__tests__/section-preparation.test.ts \
  packages/core/src/layout/__tests__/page-framed-cycle.test.ts \
  packages/core/src/layout/__tests__/exclusion-settle-fail-soft.test.ts
```

Take a pristine npm 2.36.0 package as `npm-original`; `pnpm patch` supplies one.
Map the build's hashed imports back to the pristine package's chunk names:

```bash
node scripts/docx-core-canonicalize.mjs \
  /scratch/baseline/packages/core/dist /scratch/source/packages/core/dist \
  /scratch/npm-original/dist /scratch/mapped
```

The mapper uses output input sets and checks that the baseline matches the npm
runtime after path normalization. Review its changed-file list. Copy those mapped
files into the package edit directory and run `pnpm patch-commit`. Never edit
minified runtime expressions by hand. Verify a frozen install, the installed public
layout APIs and native real-manuscript acceptance after rebuilding.

Keep the source and installed patches together when upgrading. Remove both when
an upstream version implements this behavior and passes the regressions.

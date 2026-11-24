# DOCX core layout and formatting patches

Oleafly pins `@docx-editor.dev/core` 2.36.0 and keeps each unchanged loaded XML
part's original decompressed ZIP entry bytes. A part whose tree or stored bytes
changed still uses canonical serialization. The npm `gitHead` is
[`86869eedede5b793c910be804db6280b036b0b50`](https://github.com/eigenpal/docx-editor/tree/86869eedede5b793c910be804db6280b036b0b50).
The package uses Apache-2.0. Its existing license and attribution resources remain unchanged.

`multicolumn-frames.source.patch` is the readable source change and regression.
`../@docx-editor.dev__core@2.36.0.patch` installs the compiled ESM/CJS change through
`pnpm-workspace.yaml`. It changes the runtime chunks listed by the canonicalizer and the matching public declarations. Their names stay stable so all
existing subpaths share the same engine instance.

`format-execution.source.patch` extends managed transactions with paragraph frame properties, equal-width section columns, disjoint font spans in one paragraph, and `planImportStyles`. Apply it after the layout patch. The style planner imports only selected definitions and their style/numbering closure through the existing fragment merge, renames conflicting IDs, and preserves host defaults and content. Resolvable source theme font references become literal names and override stale literal fallbacks. Unresolved references are removed while existing literal fallbacks are preserved. The host theme is unchanged. Color references use their stored literal fallback. Styles with resource relationships are refused.

`raw-entry-reuse.source.patch` preserves each modeled XML part's original
decompressed ZIP entry when the final part object, its root object, and its entry in
`partBytes` are all unchanged from load. Any edit, normalization, content refresh,
repair, replacement, or copy that changes one of those identities falls back to the
canonical serializer. Only the inflated entry bytes are promised: ZIP compression,
local headers, and the container as a whole may differ. Apply it after the formatting
patch.

`omml-recognition.source.patch` completes the bounded Office Math reader and layout for
matrices and delimiters, including row/cell structure, column alignment, delimiter
characters and separators, plus authored run-hint, kerning, ligature and mixed-font-slot
appearance. It retains hidden n-ary limits in the source model without painting them and
adds a reason and source path to fallbacks for unknown math nodes or invalid structures.
Complex structures that compact linear editing cannot reproduce carry `preserveSource`;
replacement is refused while removal remains available, and reversible compact formulas
remain editable. On the pinned real English and Chinese evaluation manuscripts, all 12 and
100 OMML equations respectively read as complete and paint without fallback. This bounded
support does not claim arbitrary OMML compatibility; unknown semantics still use the
located fallback.

`equation-source-editing.source.patch` extends the bounded reader and painter for
equation arrays, function application, Pandoc matrix/delimiter properties and authored
mathematical alphabets. It adds validated whole-OMML replacement alongside the existing
compact linear operation, and controlled display insertion. Replacement keeps the
existing equation identity and outer paragraph/display wrapper, while inserted contents
receive fresh internal identities. The untracked placement path also handles runless
atomic boundaries such as a simple field. Source records and explicit adoption policy
are application-owned in `src/lib/docx-equations.ts`, submitted with the math operation
as package edits in the existing transaction. Apply this patch after OMML recognition.

`source-element-address.source.patch` adds an optional read-time hook without changing
canonical node identities or serialization. Apply it after the equation patch.
`openHeadlessDocument(bytes, onElementSource?)` and
`readOoxmlPart(xml, { name, contentType, onElementSource? })` pass each original element
as `(partName, nodeId, path)`. The same hook flows through stepped and package reads.
`nodeId` is the existing canonical text-inclusive identity. `path` addresses elements
only: `[0]` is the part root and each following item is the zero-based element position
among its siblings. Text nodes, including whitespace and `xml:space`-governed text, do
not consume positions. The callback runs after the canonical id is assigned and before
child repair, so it reports the original XML element rather than a repaired tree.
Omitting the hook leaves the existing read path and output unchanged.

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
git apply /absolute/path/to/Oleafly/patches/docx-core/format-execution.source.patch
git apply /absolute/path/to/Oleafly/patches/docx-core/raw-entry-reuse.source.patch
git apply /absolute/path/to/Oleafly/patches/docx-core/omml-recognition.source.patch
git apply /absolute/path/to/Oleafly/patches/docx-core/equation-source-editing.source.patch
git apply /absolute/path/to/Oleafly/patches/docx-core/source-element-address.source.patch
```

In each checkout, empty only its generated `packages/core/dist` directory and run
`node ../../node_modules/tsup/dist/cli-default.js` from `packages/core`.
The upstream `tsup` 9.0.0 configuration builds both runtime formats. Retain the
published declarations, CSS, WASM and notices. The formatting extension adds the `setSectionProperties.columns` declaration and `planImportStyles`/`StyleImportResult` exports. Retain the published declaration paths and add those source-owned declarations to the same installed patch. It adds no third-party dependency. Build `i18n` declarations before checking the core types.
The source-address extension adds `OoxmlElementSource`, `onElementSource` metadata and
optional hook parameters to the matching published declarations.

From the patched checkout root, rebuild the declaration chunks named by the package:

```bash
node scripts/build-core-declarations.mjs
```

The build's shared declaration chunks carry content hashes. Use the pristine npm 2.36.0
package as `npm-original`; `pnpm patch` supplies one. Its declarations retain the paths
published by the package, so it is also the stable filename inventory for the patched
build. For the pinned version both inventories contain the same 43 declaration paths.
Map the source build onto those names:

```bash
node /absolute/path/to/Oleafly/scripts/docx-core-declarations.mjs \
  /scratch/source/packages/core/dist \
  /scratch/npm-original/dist \
  /scratch/mapped-declarations
```

The mapping command requires every generated declaration to have exactly one published
file with the same stable key. It refuses duplicate keys and either side of a missing
mapping, rewrites hashed `.js` chunk references, replaces the output directory, and prints
the declaration and changed-file counts. Copy its `.d.ts` files into the package edit
directory together with the canonicalized runtime files. Runtime chunks are mapped by
`docx-core-canonicalize.mjs`; this declaration mapper never invents a new published path.

Run the source regressions with the upstream Bun test setup:

```bash
bun test packages/core/src/layout/__tests__/paragraph-frame*.test.ts \
  packages/core/src/layout/__tests__/section-preparation.test.ts \
  packages/core/src/layout/__tests__/page-framed-cycle.test.ts \
  packages/core/src/layout/__tests__/exclusion-settle-fail-soft.test.ts \
  packages/core/src/store/__tests__/format-execution.test.ts \
  packages/core/src/store/__tests__/style-import.test.ts \
  packages/core/src/store/package/__tests__/original-entry-reuse.test.ts \
  packages/core/src/store/__tests__/revision-id-export.test.ts \
  packages/core/src/automation/__tests__/format-execution.test.ts \
  packages/core/src/automation/__tests__/automation-formatting.test.ts \
  packages/core/src/store/__tests__/omml-*.test.ts \
  packages/core/src/editor/__tests__/surface-equation-source-format.test.ts \
  packages/core/src/store/__tests__/equation-snippet.test.ts \
  packages/core/src/store/__tests__/math-equation-atom.test.ts \
  packages/core/src/layout/__tests__/equation-math-script.test.ts \
  packages/core/src/layout/__tests__/equation-matrix-delimiter.test.ts \
  packages/core/src/layout/__tests__/equation-nary-limits.test.ts \
  packages/core/src/output/__tests__/semantic-paint-equation.test.ts \
  packages/core/src/store/package/__tests__/source-element-address.test.ts
```

Map the build's hashed imports back to the pristine package's chunk names:

```bash
node scripts/docx-core-canonicalize.mjs \
  /scratch/baseline/packages/core/dist /scratch/source/packages/core/dist \
  /scratch/npm-original/dist /scratch/mapped
```

The mapper uses output input sets and checks that the baseline matches the npm
runtime after path normalization. New source modules may join an existing chunk;
its original input members must still identify exactly one output. Remove obsolete
generated runtime chunks before mapping when reusing a build directory, retaining
the current metafile outputs and published static assets. Review its changed-file list. Copy those mapped
files into the package edit directory and run `pnpm patch-commit`. Never edit
minified runtime expressions by hand. Verify a frozen install, the installed public
layout APIs and native real-manuscript acceptance after rebuilding.

Keep the source and installed patches together when upgrading. Remove both when
an upstream version implements this behavior and passes the regressions.

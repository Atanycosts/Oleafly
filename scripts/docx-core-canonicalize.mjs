import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

const [, , baselineRoot, patchedRoot, npmRoot, outputRoot] = process.argv;
if (!outputRoot) {
  console.error(
    'usage: node scripts/docx-core-canonicalize.mjs BASELINE_DIST PATCHED_DIST NPM_DIST OUTPUT_DIR'
  );
  process.exit(2);
}

const runtimePattern = /\.(?:js|cjs|wasm)$/;
const runtimeFiles = (root) =>
  readdirSync(root, { recursive: true })
    .filter((file) => runtimePattern.test(file) && !file.startsWith('metafile-'))
    .sort();

function outputMap(root, kind) {
  const metafile = JSON.parse(readFileSync(join(root, `metafile-${kind}.json`), 'utf8'));
  return metafile.outputs;
}

function signature(output) {
  return JSON.stringify([
    output.entryPoint ?? null,
    Object.keys(output.inputs ?? {})
      .map((file) => file.replace(/^(?:\.\.\/)+source\//, ''))
      .sort()
  ]);
}

function matchByMetafile() {
  const mapping = {};
  for (const kind of ['esm', 'cjs']) {
    const baseline = outputMap(baselineRoot, kind);
    const patched = outputMap(patchedRoot, kind);
    const patchedBySignature = new Map(
      Object.entries(patched).map(([file, output]) => [signature(output), file.slice(5)])
    );

    for (const [file, output] of Object.entries(baseline)) {
      const baselineFile = file.slice(5);
      let patchedFile = patchedBySignature.get(signature(output));
      if (!patchedFile && baselineFile.startsWith('dist-')) {
        const baselineBytes = readFileSync(join(baselineRoot, baselineFile));
        for (const candidate of Object.keys(patched)) {
          const candidateFile = candidate.slice(5);
          if (
            candidateFile.startsWith('dist-') &&
            readFileSync(join(patchedRoot, candidateFile)).equals(baselineBytes)
          ) {
            patchedFile = candidateFile;
            break;
          }
        }
      }
      if (!patchedFile) throw new Error(`No patched output matches ${file}`);
      mapping[patchedFile] = baselineFile;
    }
  }
  return mapping;
}

function matchBaselineToNpm() {
  const baselineFiles = runtimeFiles(baselineRoot);
  const npmFiles = runtimeFiles(npmRoot);
  const remainingBaseline = new Set(baselineFiles);
  const remainingNpm = new Set(npmFiles);
  const mapping = {};

  for (const file of baselineFiles) {
    if (!remainingNpm.has(file)) continue;
    mapping[file] = file;
    remainingBaseline.delete(file);
    remainingNpm.delete(file);
  }

  const sizeGroups = (root, files) => {
    const groups = new Map();
    for (const file of files) {
      const size = statSync(join(root, file)).size;
      groups.set(size, [...(groups.get(size) ?? []), file]);
    }
    return groups;
  };
  const baselineBySize = sizeGroups(baselineRoot, remainingBaseline);
  const npmBySize = sizeGroups(npmRoot, remainingNpm);
  for (const [size, files] of baselineBySize) {
    const candidates = npmBySize.get(size);
    if (files.length !== 1 || candidates?.length !== 1) continue;
    mapping[files[0]] = candidates[0];
    remainingBaseline.delete(files[0]);
    remainingNpm.delete(candidates[0]);
  }

  if (remainingBaseline.size || remainingNpm.size) {
    throw new Error(
      `Cannot match baseline to npm: baseline=${[...remainingBaseline]}, npm=${[...remainingNpm]}`
    );
  }
  return mapping;
}

function remapContents(root, file, mapping) {
  const bytes = readFileSync(join(root, file));
  if (file.endsWith('.wasm')) return bytes;
  let contents = bytes.toString('utf8');
  for (const [from, to] of Object.entries(mapping)) {
    contents = contents.replaceAll(from, to);
    const fromBinding = /^chunk-([^.]+)\.cjs$/.exec(from)?.[1];
    const toBinding = /^chunk-([^.]+)\.cjs$/.exec(to)?.[1];
    if (fromBinding && toBinding) {
      contents = contents.replaceAll(`chunk${fromBinding}_cjs`, `chunk${toBinding}_cjs`);
    }
  }
  return Buffer.from(contents);
}

const patchedToBaseline = matchByMetafile();
const baselineToNpm = matchBaselineToNpm();
for (const [file, npmFile] of Object.entries(baselineToNpm)) {
  if (!remapContents(baselineRoot, file, baselineToNpm).equals(readFileSync(join(npmRoot, npmFile)))) {
    throw new Error(`Baseline does not reproduce npm runtime: ${file} -> ${npmFile}`);
  }
}
const patchedToNpm = Object.fromEntries(
  runtimeFiles(patchedRoot).map((file) => [
    file,
    baselineToNpm[patchedToBaseline[file] ?? file] ?? patchedToBaseline[file] ?? file
  ])
);

if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(join(outputRoot, 'dist'), { recursive: true });

for (const file of runtimeFiles(patchedRoot)) {
  const destination = join(outputRoot, 'dist', patchedToNpm[file]);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, remapContents(patchedRoot, file, patchedToNpm));
}

const changed = [];
const same = [];
for (const file of runtimeFiles(join(outputRoot, 'dist'))) {
  const generated = readFileSync(join(outputRoot, 'dist', file));
  const installed = readFileSync(join(npmRoot, file));
  (generated.equals(installed) ? same : changed).push(file);
}

console.log(
  JSON.stringify(
    {
      mapping: Object.fromEntries(Object.entries(patchedToNpm).filter(([from, to]) => from !== to)),
      unchangedCount: same.length,
      changedCount: changed.length,
      changed
    },
    null,
    2
  )
);

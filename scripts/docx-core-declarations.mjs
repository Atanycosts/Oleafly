// Map one core declaration build onto the stable filenames shipped by the installed package.
// Rollup adds content hashes to shared chunks; the runtime canonicalizer maps those chunks
// separately, while TypeScript must keep the declarations beside their imports.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HASHED_DECLARATION = /-[A-Za-z0-9_-]{8}(?=\.d\.ts$)/

function usage() {
  return (
    'usage: node scripts/docx-core-declarations.mjs ' +
    'GENERATED_DIST PUBLISHED_DIST OUTPUT_DIST'
  )
}

function declarationsIn(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Declaration directory does not exist: ${root}`)
  }
  return readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith('.d.ts'))
    .sort()
}

/** A content-hashed shared chunk maps through its stable prefix; an entry keeps its path. */
function declarationKey(file) {
  return HASHED_DECLARATION.test(file)
    ? `${file.replace(HASHED_DECLARATION, '')}#shared`
    : file
}

function indexByKey(files, kind) {
  const index = new Map()
  for (const file of files) {
    const key = declarationKey(file)
    const collision = index.get(key)
    if (collision) {
      throw new Error(`${kind} declaration collision for ${key}: ${collision} and ${file}`)
    }
    index.set(key, file)
  }
  return index
}

function declarationMapping(generatedRoot, publishedRoot) {
  const generated = declarationsIn(generatedRoot)
  const published = declarationsIn(publishedRoot)
  const generatedByKey = indexByKey(generated, 'Generated')
  const publishedByKey = indexByKey(published, 'Published')

  const missingGenerated = [...publishedByKey]
    .filter(([key]) => !generatedByKey.has(key))
    .map(([, file]) => file)
  const missingPublished = [...generatedByKey]
    .filter(([key]) => !publishedByKey.has(key))
    .map(([, file]) => file)
  if (missingGenerated.length > 0 || missingPublished.length > 0) {
    const sections = []
    if (missingGenerated.length > 0) {
      sections.push(`Generated build is missing:\n${missingGenerated.join('\n')}`)
    }
    if (missingPublished.length > 0) {
      sections.push(`Published package is missing:\n${missingPublished.join('\n')}`)
    }
    throw new Error(sections.join('\n\n'))
  }

  const pairs = generated.map((file) => [file, publishedByKey.get(declarationKey(file))])
  const usedTargets = new Set()
  for (const [source, target] of pairs) {
    if (!target) throw new Error(`No published declaration matches ${source}`)
    if (usedTargets.has(target)) {
      throw new Error(`Multiple generated declarations map to ${target}`)
    }
    usedTargets.add(target)
  }
  return pairs
}

/** Rewrite the hashed `.js` specifiers that TypeScript carries beside declaration imports. */
function remapContents(source, mapping) {
  let contents = source
  for (const [from, to] of mapping) {
    contents = contents.replaceAll(
      from.slice(0, -'.d.ts'.length) + '.js',
      to.slice(0, -'.d.ts'.length) + '.js'
    )
  }
  return contents
}

function contains(parent, child) {
  const relationship = relative(parent, child)
  return (
    relationship === '' ||
    (relationship !== '..' &&
      !relationship.startsWith(`..${sep}`) &&
      !isAbsolute(relationship))
  )
}

export function mapDeclarations(generatedRoot, publishedRoot, outputRoot) {
  const generated = resolve(generatedRoot)
  const published = resolve(publishedRoot)
  const output = resolve(outputRoot)
  if (
    contains(generated, output) ||
    contains(output, generated) ||
    contains(published, output) ||
    contains(output, published)
  ) {
    throw new Error('OUTPUT_DIST must not overlap GENERATED_DIST or PUBLISHED_DIST')
  }

  const mapping = declarationMapping(generated, published)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })

  const changed = []
  for (const [sourceFile, targetFile] of mapping) {
    const contents = remapContents(
      readFileSync(join(generated, sourceFile), 'utf8'),
      mapping
    )
    const destination = join(output, targetFile)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
    if (contents !== readFileSync(join(published, targetFile), 'utf8')) changed.push(targetFile)
  }

  return Object.freeze({
    declarations: mapping.length,
    changed: Object.freeze(changed),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , generatedRoot, publishedRoot, outputRoot] = process.argv
  if (!outputRoot) {
    console.error(usage())
    process.exitCode = 2
  } else {
    try {
      const result = mapDeclarations(generatedRoot, publishedRoot, outputRoot)
      console.log(
        JSON.stringify(
          {
            declarations: result.declarations,
            changed: result.changed.length,
            changedFiles: result.changed,
          },
          null,
          2
        )
      )
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}

#!/usr/bin/env node
'use strict'
// Extract the *code-split* JS application (2.1.242+) out of a Bun standalone
// binary into many files on disk, instead of the single `claude-code.js`
// bundle extract.js produces for <=2.1.241.
//
// Starting with 2.1.242, Bun no longer inlines the whole app as one
// contiguous bundle after the cli.js entrypoint marker. It code-splits into
// hundreds of /$bunfs/root/chunk-*.js files that cli.js (and each other)
// load via static/dynamic `import()`. There is no single blob to grab; every
// embedded module has to be located and extracted individually.
//
// Usage:
//   node extract-chunks.js <path-to-linux-claude-binary>
//   node extract-chunks.js --latest [--arch arm64]
//   node extract-chunks.js --version 2.1.242 [--arch arm64]
//
// Output (in <dir-of-this-script>/bunfs/ by default):
//   bunfs/<mirrored path, "/$bunfs/root/" prefix stripped>   one file per module
//   bunfs/package.json                                      {"type":"module"}
//   bunfs-manifest.json                                      entry point + version

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const { execFileSync } = require('child_process')
const os    = require('os')

const BUNFS_PREFIX     = '/$bunfs/root/'
const BYTECODE_PREFIX  = Buffer.from('// @bun @bytecode')
const NEWLINE           = 0x0a
const MAX_NAME_LEN      = 300 // sanity bound for a path announcement

// ── Step 1: enumerate every NUL-delimited "/$bunfs/root/..." announcement ──

// A table announcement's path chars are restricted to this safe set
// (letters, digits, and a few path-safe symbols) — deliberately narrower
// than "printable ASCII". A quoted in-code reference like
// `import(".../chunk-x.js")` is followed by a `"`, which isn't in this set,
// so scanning stops there and the immediately-next-byte-is-NUL check below
// correctly rejects it as not a real announcement — without needing to also
// check what *precedes* the match (the real cli.js entrypoint path turns out
// not to be reliably preceded by a NUL in 2.1.242+, see extraction notes).
function isPathChar(b) {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
    b === 0x2d /* - */ || b === 0x5f /* _ */ || b === 0x2e /* . */ || b === 0x2f /* / */
}

function findAnnouncements(data) {
  const prefix = Buffer.from(BUNFS_PREFIX)
  const entries = [] // { pathStart, nul } -- nul = offset of the terminating 0x00
  let pos = 0
  while (true) {
    pos = data.indexOf(prefix, pos)
    if (pos === -1) break
    let end = pos + prefix.length
    while (end < data.length && end - pos < MAX_NAME_LEN && isPathChar(data[end])) end++
    if (data[end] === 0 && end > pos) {
      entries.push({ pathStart: pos, nul: end })
      pos = end
    } else {
      pos += 1
    }
  }
  return entries
}

// ── Step 2: resolve each announcement to a module code-start offset ────────
//
// Layout observed: <path>\0[<alias>\0]<bytecode-comment-line>\n<code> for
// bytecode-compiled modules (0 or 1 alias hops, see extract.js), or just
// <path>\0<code> directly for plain-text asset modules (no comment line) —
// seen on vendor bundles like chart.umd.min.js that aren't bytecode-compiled.

// Returns { jsStart, confident }. confident=true means a bytecode comment
// line was actually found (strong evidence this is a real table entry, not
// a quoted in-code reference that happens to butt up against a stray NUL).
// confident=false is the plain-text-asset fallback (needed for vendor
// bundles like chart.umd.min.js, which aren't bytecode-compiled) — much more
// exposed to false positives, so callers should prefer a confident
// resolution for the same name over a non-confident one.
function resolveModuleStart(data, entries, i) {
  let cursor = entries[i].nul + 1
  for (let hop = 0; hop < 2; hop++) {
    if (data.compare(BYTECODE_PREFIX, 0, BYTECODE_PREFIX.length, cursor, cursor + BYTECODE_PREFIX.length) === 0) {
      const lineEnd = data.indexOf(NEWLINE, cursor)
      if (lineEnd !== -1) return { jsStart: lineEnd + 1, confident: true }
    }
    if (i + 1 < entries.length && entries[i + 1].pathStart === cursor) {
      i += 1
      cursor = entries[i].nul + 1
      continue
    }
    break
  }
  return { jsStart: cursor, confident: false }
}

const WRAP_PREFIX = '(function(exports, require, module, __filename, __dirname) {'
const WRAP_SUFFIX = '})'

function stripCjsWrapper(js) {
  if (!js.startsWith(WRAP_PREFIX)) return js
  js = js.slice(WRAP_PREFIX.length)
  if      (js.endsWith(WRAP_SUFFIX + '\n')) js = js.slice(0, -WRAP_SUFFIX.length - 1)
  else if (js.endsWith(WRAP_SUFFIX))        js = js.slice(0, -WRAP_SUFFIX.length)
  return js
}

// ── Step 3: full extraction ─────────────────────────────────────────────────

function extractAllModules(data) {
  const entries = findAnnouncements(data)
  process.stderr.write(`Found ${entries.length} path announcements.\n`)

  // name -> jsStart, for every announcement whose chain resolves successfully.
  // A name can legitimately appear more than once in the file (its real
  // table entry, plus stray matches from in-code string references that
  // happen to sit right before an unrelated NUL byte elsewhere) — keep the
  // first *confident* (bytecode-comment-backed) resolution over any
  // non-confident fallback, since the fallback path is the one exposed to
  // those false positives; never let a later match silently replace an
  // earlier confident one.
  const nameToStart = new Map()
  const nameConfidence = new Map()
  for (let i = 0; i < entries.length; i++) {
    const { pathStart, nul } = entries[i]
    const name = data.toString('ascii', pathStart, nul)
    if (name.length <= BUNFS_PREFIX.length) continue // degenerate/empty name
    const { jsStart, confident } = resolveModuleStart(data, entries, i)
    const existingConfidence = nameConfidence.get(name)
    if (existingConfidence === true) continue // keep the confident one we already have
    if (existingConfidence === false && !confident) continue // keep the first fallback
    nameToStart.set(name, jsStart)
    nameConfidence.set(name, confident)
  }

  const allAnnounceStarts = entries.map(e => e.pathStart).sort((a, b) => a - b)
  function nextBoundary(after) {
    let lo = 0, hi = allAnnounceStarts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (allAnnounceStarts[mid] <= after) lo = mid + 1
      else hi = mid
    }
    return lo < allAnnounceStarts.length ? allAnnounceStarts[lo] : data.length
  }

  // Group names by resolved start so aliases of the same module share one file.
  const startToNames = new Map()
  for (const [name, jsStart] of nameToStart) {
    if (!startToNames.has(jsStart)) startToNames.set(jsStart, [])
    startToNames.get(jsStart).push(name)
  }

  const modules = [] // { names: [...], content: string }
  for (const [jsStart, names] of startToNames) {
    // Only materialize groups that actually contain a .js module — a group
    // made up only of e.g. a ".node" native-addon name has no JS content to
    // extract; it's handled at runtime by the require shim instead.
    if (!names.some(n => n.endsWith('.js'))) continue
    const jsEnd = nextBoundary(jsStart)
    let js = data.slice(jsStart, jsEnd).toString('utf8')
    const nullIdx = js.indexOf('\0')
    if (nullIdx !== -1) js = js.slice(0, nullIdx)
    js = stripCjsWrapper(js.trimEnd())
    modules.push({ names, content: js })
  }
  return modules
}

// ── Step 4: pick one output path per module, rewrite cross-references ──────

function relPathFor(name) {
  // "/$bunfs/root/foo/bar.js" -> "foo/bar.js"
  return name.slice(BUNFS_PREFIX.length)
}

function chooseOutputRelPath(names) {
  // Prefer a .js-suffixed name (skip non-.js aliases like "/$bunfs/root/cli"),
  // and among those the shortest (the canonical short name, not a long
  // source-relative path) so output paths stay flat where possible.
  const jsNames = names.filter(n => n.endsWith('.js'))
  const pool = jsNames.length > 0 ? jsNames : names
  pool.sort((a, b) => a.length - b.length)
  return relPathFor(pool[0])
}

function buildAndWrite(modules, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  // name -> absolute output file path, for every alias of every module.
  const nameToAbsPath = new Map()
  const moduleRecords = [] // { relPath, absPath, content }
  for (const mod of modules) {
    const relPath = chooseOutputRelPath(mod.names)
    const absPath = path.join(outDir, relPath)
    for (const name of mod.names) nameToAbsPath.set(name, absPath)
    moduleRecords.push({ relPath, absPath, content: mod.content })
  }

  // Sort known bunfs names longest-first so rewriting doesn't let a shorter
  // name's replacement clobber part of a longer one that shares a prefix.
  const knownNames = [...nameToAbsPath.keys()].sort((a, b) => b.length - a.length)

  let totalBytes = 0
  const unresolvedRefs = new Set()
  for (const rec of moduleRecords) {
    fs.mkdirSync(path.dirname(rec.absPath), { recursive: true })

    let content = rec.content.split('import.meta.require').join('globalThis.__bunfsRequire')

    // Rewrite every literal reference to a known bunfs module to a path this
    // file can actually resolve at runtime. Static/dynamic `import` specifiers
    // need a path relative to THIS file; anything else referencing a bunfs
    // path (e.g. a worker_threads URL stored as a config string) gets the
    // absolute path instead, since relative-to-this-file would be wrong there.
    for (const name of knownNames) {
      if (!content.includes(name)) continue
      const targetAbs = nameToAbsPath.get(name)
      let rel = path.relative(path.dirname(rec.absPath), targetAbs).split(path.sep).join('/')
      if (!rel.startsWith('.')) rel = './' + rel
      content = content.split(name).join(rel)
    }

    // Anything left pointing at /$bunfs/root/ is a module we never found an
    // announcement for (e.g. a native .node addon) — leave the bunfs-style
    // string in place; globalThis.__bunfsRequire (launcher.js) pattern-matches
    // on it at runtime and returns a stub.
    for (const m of content.matchAll(/\/\$bunfs\/root\/[A-Za-z0-9_\-./]*/g)) {
      unresolvedRefs.add(m[0])
    }

    fs.writeFileSync(rec.absPath, content, 'utf8')
    totalBytes += content.length
  }

  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')

  const entryName = [...nameToAbsPath.keys()].find(n => n.endsWith('src/entrypoints/cli.js'))
  return {
    moduleCount: moduleRecords.length,
    totalBytes,
    entryAbsPath: entryName ? nameToAbsPath.get(entryName) : null,
    unresolvedRefs: [...unresolvedRefs],
  }
}

// ── npm download (same approach as extract.js) ──────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) { request(res.headers.location); return }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    }
    request(url)
  })
}

const NPM_TARGETS = {
  x64: 'linux-x64',
  arm64: 'linux-arm64',
  'x64-musl': 'linux-x64-musl',
  'arm64-musl': 'linux-arm64-musl',
}

async function fetchBinaryFromNpm(version, target) {
  if (!NPM_TARGETS[target]) {
    throw new Error(`Unknown --arch target "${target}". Supported: ${Object.keys(NPM_TARGETS).join(', ')}`)
  }
  const pkg = `@anthropic-ai/claude-code-${NPM_TARGETS[target]}`
  const metaUrl = version === 'latest'
    ? `https://registry.npmjs.org/${pkg}/latest`
    : `https://registry.npmjs.org/${pkg}/${version}`

  process.stderr.write(`Fetching metadata for ${pkg}@${version}...\n`)
  const meta = JSON.parse((await httpsGet(metaUrl)).toString('utf8'))
  const resolvedVersion = meta.version
  const tarballUrl = meta.dist.tarball

  process.stderr.write(`Downloading ${pkg}@${resolvedVersion}...\n`)
  const tarball = await httpsGet(tarballUrl)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-extract-'))
  try {
    const tarPath = path.join(tmpDir, 'pkg.tgz')
    fs.writeFileSync(tarPath, tarball)
    execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir, '--strip-components=1', 'package/claude'])
    const binaryPath = path.join(tmpDir, 'claude')
    if (!fs.existsSync(binaryPath)) throw new Error(`'claude' binary not found in tarball at ${tarPath}`)
    return { data: fs.readFileSync(binaryPath), version: resolvedVersion }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const outDir = path.join(__dirname, 'bunfs')
  const manifestPath = path.join(__dirname, 'bunfs-manifest.json')

  const archIdx = args.indexOf('--arch')
  const arch = archIdx !== -1 ? args[archIdx + 1] : 'x64'
  if (archIdx !== -1) args.splice(archIdx, 2)

  let data, resolvedVersion
  if (args[0] === '--latest') {
    ;({ data, version: resolvedVersion } = await fetchBinaryFromNpm('latest', arch))
  } else if (args[0] === '--version') {
    const v = args[1]
    if (!v) { console.error('--version requires a version argument'); process.exit(1) }
    ;({ data, version: resolvedVersion } = await fetchBinaryFromNpm(v, arch))
  } else if (args[0] && !args[0].startsWith('-')) {
    const binaryPath = path.resolve(args[0])
    if (!fs.existsSync(binaryPath)) { console.error(`File not found: ${binaryPath}`); process.exit(1) }
    data = fs.readFileSync(binaryPath)
    resolvedVersion = 'from local binary'
  } else {
    process.stderr.write([
      'Usage:',
      '  node extract-chunks.js <path-to-claude-binary>',
      '  node extract-chunks.js --latest [--arch arm64]',
      '  node extract-chunks.js --version 2.1.242 [--arch arm64]',
      '',
      `Output: ${outDir}/, ${manifestPath}`,
    ].join('\n') + '\n')
    process.exit(args[0] ? 1 : 0)
  }

  process.stderr.write(`Scanning ${(data.length / 1024 / 1024).toFixed(1)} MB...\n`)
  const modules = extractAllModules(data)
  process.stderr.write(`Resolved ${modules.length} module code blocks.\n`)

  const result = buildAndWrite(modules, outDir)
  if (!result.entryAbsPath) {
    throw new Error('Could not locate the cli.js entrypoint among extracted modules.')
  }
  if (fs.statSync(result.entryAbsPath).size === 0) {
    throw new Error(
      'The cli.js entrypoint extracted to 0 bytes — this release has no JS source\n' +
      '  text embedded at all, only compiled JavaScriptCore bytecode (observed\n' +
      '  starting at 2.1.246). There is no source text here to extract — JSC\n' +
      '  bytecode cannot run on Node\'s V8 engine, be decompiled back to source,\n' +
      '  or be converted to V8 bytecode. This tool cannot port this version.\n' +
      '  2.1.245 is the newest version with real embedded source text.'
    )
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    version: resolvedVersion,
    entry: path.relative(outDir, result.entryAbsPath).split(path.sep).join('/'),
    moduleCount: result.moduleCount,
    totalBytes: result.totalBytes,
    unresolvedRefs: result.unresolvedRefs,
  }, null, 2) + '\n')

  process.stderr.write(`✓ Extracted ${result.moduleCount} modules (${(result.totalBytes / 1024 / 1024).toFixed(1)} MB) → ${outDir}/\n`)
  process.stderr.write(`  Version: ${resolvedVersion}\n`)
  process.stderr.write(`  Entry: ${result.entryAbsPath}\n`)
  process.stderr.write(`  Unresolved bunfs references (native addons etc.): ${result.unresolvedRefs.length}\n`)
  if (result.unresolvedRefs.length > 0 && result.unresolvedRefs.length <= 20) {
    for (const r of result.unresolvedRefs) process.stderr.write(`    ${r}\n`)
  }
}

main().catch(err => {
  console.error(`\n[extract-chunks.js] Error: ${err.stack || err.message}`)
  process.exit(1)
})

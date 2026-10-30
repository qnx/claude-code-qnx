#!/usr/bin/env node
'use strict'
// Extract (or upgrade) claude-code.js from a Bun standalone binary.
//
// Usage:
//   node extract.js <path-to-linux-claude.exe>   # local binary
//   node extract.js --latest                      # download latest linux-x64 from npm
//   node extract.js --version 2.1.142             # specific version from npm
//
// The extracted file is written to <dir-of-this-script>/claude-code.js.
// Run this whenever Anthropic publishes a new Claude Code release.

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const { execFileSync } = require('child_process')
const os    = require('os')

// Markers inside the Bun standalone binary
//
// Bun records the entrypoint module under its long declared path
// (/$bunfs/root/src/entrypoints/cli.js). Up to 2.1.228, the bytecode marker
// comment followed that same path repeated a second time as a self-alias.
// Starting with 2.1.229, Bun canonicalizes the entry to a short alias key
// instead (observed: /$bunfs/root/cli) before the bytecode comment. The
// alias text itself isn't guaranteed to stay "cli" forever, so we don't
// hardcode it — we just skip over *a* short NUL-terminated alias, whatever
// it is, between the declared path and the bytecode comment.
const ENTRY_PATH              = Buffer.from('/$bunfs/root/src/entrypoints/cli.js\x00')
// The comment's trailing tag has changed across releases (seen so far:
// "@bun @bytecode @bun-cjs" with a CJS wrapper, and plain "@bytecode" with
// no wrapper) — match the stable prefix only and scan to end-of-line so
// future tag variants don't need another extractor update.
const BYTECODE_COMMENT_PREFIX = Buffer.from('// @bun @bytecode')
const NEWLINE                 = 0x0a
const MAX_ALIAS_LEN           = 256 // sanity bound for the skipped alias key
const NEXT_SECTION            = Buffer.from('\x00/$bunfs/root/image-processor.js\x00')

// Finds the offset right after the bytecode marker comment line that follows
// the cli.js entrypoint declaration, tolerating 0 or 1 short alias key in
// between (see comment above). Returns -1 if no match is found.
function findEntryEnd(data) {
  let searchFrom = 0
  while (true) {
    const pathPos = data.indexOf(ENTRY_PATH, searchFrom)
    if (pathPos === -1) return -1

    let cursor = pathPos + ENTRY_PATH.length
    // hop 0: comment directly follows the declared path (no alias)
    // hop 1: comment follows one short NUL-terminated alias key
    for (let hop = 0; hop < 2; hop++) {
      if (data.compare(BYTECODE_COMMENT_PREFIX, 0, BYTECODE_COMMENT_PREFIX.length, cursor, cursor + BYTECODE_COMMENT_PREFIX.length) === 0) {
        const lineEnd = data.indexOf(NEWLINE, cursor)
        if (lineEnd !== -1) return lineEnd + 1
      }
      const nextNul = data.indexOf(0, cursor)
      if (nextNul === -1 || nextNul - cursor > MAX_ALIAS_LEN) break
      cursor = nextNul + 1
    }

    searchFrom = pathPos + 1
  }
}

// The outer CJS wrapper Bun injects — Node.js adds its own, so we strip Bun's.
const WRAP_PREFIX = '(function(exports, require, module, __filename, __dirname) {'
const WRAP_SUFFIX = '})'

// ── Extraction ────────────────────────────────────────────────────────────────

function extractFromBinary(binaryPath) {
  const size = fs.statSync(binaryPath).size
  process.stderr.write(`Reading ${binaryPath} (${(size / 1024 / 1024).toFixed(1)} MB)...\n`)
  const data = fs.readFileSync(binaryPath)

  const jsStart = findEntryEnd(data)
  if (jsStart === -1) {
    throw new Error(
      'Entry point marker not found — is this a Claude Code Bun binary?\n' +
      '  Expected entrypoint: /$bunfs/root/src/entrypoints/cli.js\n' +
      '  followed by a comment line starting with: // @bun @bytecode\n' +
      '\n' +
      '  Note: as of 2.1.242, Bun code-splits the app into many\n' +
      '  /$bunfs/root/chunk-*.js files that cli.js loads via dynamic\n' +
      '  import() — a single contiguous bundle no longer exists, so this\n' +
      '  marker will never be found from that release forward. Extracting\n' +
      '  those releases needs a different approach (enumerate every\n' +
      '  /$bunfs/root/*.js module, not just cli.js, and hook ESM import()\n' +
      '  resolution in launcher.js, not just CJS require()) — see README.md.'
    )
  }

  // JS ends just before the next bunfs section (image-processor) or after 20 MB
  let jsEnd = data.indexOf(NEXT_SECTION, jsStart)
  if (jsEnd === -1) jsEnd = jsStart + 20 * 1024 * 1024

  // Decode, drop everything from the first \0 onwards (binary tail)
  let js = data.slice(jsStart, jsEnd).toString('utf8')
  const nullIdx = js.indexOf('\0')
  if (nullIdx !== -1) js = js.slice(0, nullIdx)
  js = js.trimEnd()

  // Strip the outer CJS wrapper so Node.js can require() the file cleanly
  if (js.startsWith(WRAP_PREFIX)) {
    js = js.slice(WRAP_PREFIX.length)
    if      (js.endsWith(WRAP_SUFFIX + '\n')) js = js.slice(0, -WRAP_SUFFIX.length - 1)
    else if (js.endsWith(WRAP_SUFFIX))        js = js.slice(0, -WRAP_SUFFIX.length)
  }

  return js
}

// ── npm download ──────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          request(res.headers.location); return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    }
    request(url)
  })
}

// Target names match Anthropic's optionalDependencies suffixes
// (@anthropic-ai/claude-code-linux-<target>). The extracted JS bundle itself
// is architecture-independent (it's plain text, not compiled code) — this
// only matters for picking the right *source* binary to scan. x64 and arm64
// builds are independently minified (different generated identifiers,
// ~0.03% size delta observed between 2.1.241's x64 and arm64 builds) but are
// the same application; scanning either normally produces an equivalent
// bundle. musl is only relevant if the target QNX Node build links musl
// instead of glibc, which is unlikely — glibc is the default pick.
const NPM_TARGETS = {
  x64: 'linux-x64',
  arm64: 'linux-arm64',
  'x64-musl': 'linux-x64-musl',
  'arm64-musl': 'linux-arm64-musl',
}

async function fetchFromNpm(version, target = 'x64') {
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

    // The tarball contains package/claude (the raw Bun binary, no .exe extension)
    execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir, '--strip-components=1', 'package/claude'])

    const binaryPath = path.join(tmpDir, 'claude')
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`'claude' binary not found in tarball at ${tarPath}`)
    }

    const js = extractFromBinary(binaryPath)
    return { js, version: resolvedVersion }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const outPath = path.join(__dirname, 'claude-code.js')

  // --arch applies to the npm fetch paths only; a local binary file is used as-is.
  const archIdx = args.indexOf('--arch')
  const arch = archIdx !== -1 ? args[archIdx + 1] : 'x64'
  if (archIdx !== -1) args.splice(archIdx, 2)

  let js, resolvedVersion

  if (args[0] === '--latest') {
    ;({ js, version: resolvedVersion } = await fetchFromNpm('latest', arch))
  } else if (args[0] === '--version') {
    const v = args[1]
    if (!v) { console.error('--version requires a version argument'); process.exit(1) }
    ;({ js, version: resolvedVersion } = await fetchFromNpm(v, arch))
  } else if (args[0] && !args[0].startsWith('-')) {
    const binaryPath = path.resolve(args[0])
    if (!fs.existsSync(binaryPath)) {
      console.error(`File not found: ${binaryPath}`); process.exit(1)
    }
    js = extractFromBinary(binaryPath)
    resolvedVersion = 'from local binary'
  } else {
    process.stderr.write([
      'Usage:',
      '  node extract.js <path-to-claude.exe>          # extract from local Linux binary',
      '  node extract.js --latest [--arch arm64]        # download latest from npm',
      '  node extract.js --version 2.1.241 [--arch arm64] # specific version from npm',
      '',
      `  --arch: ${Object.keys(NPM_TARGETS).join(', ')} (default: x64)`,
      '',
      `Output: ${outPath}`,
    ].join('\n') + '\n')
    process.exit(args[0] ? 1 : 0)
  }

  // Write atomically: write to tmp then rename
  const tmpOut = outPath + '.tmp'
  fs.writeFileSync(tmpOut, js, 'utf8')
  fs.renameSync(tmpOut, outPath)

  process.stderr.write(`✓ Extracted ${(js.length / 1024).toFixed(0)} KB → ${outPath}\n`)
  process.stderr.write(`  Version: ${resolvedVersion}\n`)
  process.stderr.write(`  Run: node ${path.join(__dirname, 'launcher.js')}\n`)
}

main().catch(err => {
  console.error(`\n[extract.js] Error: ${err.message}`)
  process.exit(1)
})

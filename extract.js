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
const ENTRY_MARKER  = Buffer.from('/$bunfs/root/src/entrypoints/cli.js\x00// @bun @bytecode @bun-cjs\n')
const NEXT_SECTION  = Buffer.from('\x00/$bunfs/root/image-processor.js\x00')

// The outer CJS wrapper Bun injects — Node.js adds its own, so we strip Bun's.
const WRAP_PREFIX = '(function(exports, require, module, __filename, __dirname) {'
const WRAP_SUFFIX = '})'

// ── Extraction ────────────────────────────────────────────────────────────────

function extractFromBinary(binaryPath) {
  const size = fs.statSync(binaryPath).size
  process.stderr.write(`Reading ${binaryPath} (${(size / 1024 / 1024).toFixed(1)} MB)...\n`)
  const data = fs.readFileSync(binaryPath)

  const markerPos = data.indexOf(ENTRY_MARKER)
  if (markerPos === -1) {
    throw new Error(
      'Entry point marker not found — is this a Claude Code Bun binary?\n' +
      '  Expected marker: /$bunfs/root/src/entrypoints/cli.js'
    )
  }

  const jsStart = markerPos + ENTRY_MARKER.length

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

async function fetchFromNpm(version) {
  const pkg = '@anthropic-ai/claude-code-linux-x64'
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

  let js, resolvedVersion

  if (args[0] === '--latest') {
    ;({ js, version: resolvedVersion } = await fetchFromNpm('latest'))
  } else if (args[0] === '--version') {
    const v = args[1]
    if (!v) { console.error('--version requires a version argument'); process.exit(1) }
    ;({ js, version: resolvedVersion } = await fetchFromNpm(v))
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
      '  node extract.js <path-to-claude.exe>   # extract from local Linux binary',
      '  node extract.js --latest               # download latest from npm',
      '  node extract.js --version 2.1.142      # specific version from npm',
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

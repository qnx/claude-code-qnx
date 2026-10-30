#!/usr/bin/env node
'use strict'
// Claude Code launcher for QNX / any platform where the Bun binary doesn't run.
// Requires Node.js 18+.
//
// Two app layouts are supported, auto-detected by what's on disk:
//   - legacy (<=2.1.241): one bundle file, claude-code.js, loaded via require().
//   - chunked (2.1.242+): a tree of ES modules under bunfs/, produced by
//     extract-chunks.js, loaded via dynamic import() of the recorded entry.
// See bunfs-manifest.json's presence as the switch between the two.

const Module = require('module')
const path   = require('path')
const fs     = require('fs')
const { createRequire } = require('module')
const { pathToFileURL } = require('url')

// ── 1. Install Bun API shim ───────────────────────────────────────────────────
require('./bun-shim.js')

const manifestPath = process.env.CLAUDE_CODE_MANIFEST ||
  path.join(__dirname, 'bunfs-manifest.json')

if (fs.existsSync(manifestPath)) {
  runChunked(manifestPath)
} else {
  runLegacy()
}

// ── Chunked (2.1.242+) ───────────────────────────────────────────────────────

function runChunked(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bunfsDir = path.join(path.dirname(manifestPath), 'bunfs')
  const entryPath = path.join(bunfsDir, manifest.entry)

  if (!fs.existsSync(entryPath)) {
    console.error(`[claude-qnx] Entry module not found: ${entryPath}`)
    console.error(`  Re-run: node ${path.join(__dirname, 'extract-chunks.js')} --version <ver>`)
    process.exit(1)
  }

  // Real require(), rooted at bunfs/ so "ajv", "react", "worker_threads" etc.
  // resolve against this project's node_modules — needed because extracted
  // ES modules can't have their own implicit `require`; an unqualified
  // `require(...)` in any module in this realm resolves against whatever
  // property sits on globalThis, which is what we're setting here.
  const realRequire = createRequire(path.join(bunfsDir, 'package.json'))

  // import.meta.require(id) (a Bun-only ESM extension — no Node equivalent)
  // gets textually rewritten by extract-chunks.js to
  // globalThis.__bunfsRequire(id). Used for two things: real npm packages
  // (delegate to realRequire), and native .node addons / other assets that
  // were never extracted (clipboard, image-processor, audio-capture) — for
  // those, return an empty stub so the app starts without that feature
  // rather than crashing.
  function bunfsRequire(id) {
    if (typeof id === 'string' && (id.endsWith('.node') || id.includes('/$bunfs/'))) {
      return {}
    }
    return realRequire(id)
  }
  globalThis.require = bunfsRequire
  globalThis.__bunfsRequire = bunfsRequire

  import(pathToFileURL(entryPath).href).catch(err => {
    console.error(err)
    process.exit(1)
  })
}

// ── Legacy (<=2.1.241) ───────────────────────────────────────────────────────

function runLegacy() {
  // The compiled JS bundle references native addons via Bun's virtual
  // filesystem. On QNX these ELF .node files won't run; we return empty
  // stubs so the app can start — the features they provide (screen capture,
  // audio) are simply absent.
  const _origLoad = Module._load
  Module._load = function bunfsInterceptor(request, parent, isMain) {
    if (request.startsWith('/$bunfs/') || request.startsWith('$bunfs/')) {
      if (path.extname(request) === '.node') return {}
      return { exports: {} }
    }
    return _origLoad.apply(this, arguments)
  }

  const claudeCodePath = process.env.CLAUDE_CODE_JS ||
    path.join(__dirname, 'claude-code.js')

  if (!fs.existsSync(claudeCodePath)) {
    console.error(`[claude-qnx] claude-code.js not found at: ${claudeCodePath}`)
    console.error()
    console.error('  Extract it from the Linux binary first:')
    console.error(`    node ${path.join(__dirname, 'extract.js')} /path/to/claude.exe`)
    console.error('  Or download a specific version automatically:')
    console.error(`    node ${path.join(__dirname, 'extract.js')} --version 2.1.241`)
    process.exit(1)
  }

  require(claudeCodePath)
}

#!/usr/bin/env node
'use strict'
// Claude Code launcher for QNX / any platform where the Bun binary doesn't run.
// Requires Node.js 18+.

const Module = require('module')
const path   = require('path')
const fs     = require('fs')

// ── 1. Install Bun API shim ───────────────────────────────────────────────────
require('./bun-shim.js')

// ── 2. Intercept require() for /$bunfs/ virtual paths ────────────────────────
// The compiled JS bundle references native addons via Bun's virtual filesystem.
// On QNX these ELF .node files won't run; we return empty stubs so the app can
// start — the features they provide (screen capture, audio) are simply absent.
const _origLoad = Module._load
Module._load = function bunfsInterceptor(request, parent, isMain) {
  if (request.startsWith('/$bunfs/') || request.startsWith('$bunfs/')) {
    if (path.extname(request) === '.node') {
      // Native addon stub — image-processor.node, audio-capture.node
      return {}
    }
    // .js files in bunfs shouldn't be require()'d separately (all bundled), but
    // return an empty module just in case rather than crashing.
    return { exports: {} }
  }
  return _origLoad.apply(this, arguments)
}

// ── 3. Locate claude-code.js ──────────────────────────────────────────────────
// Resolution order:
//   $CLAUDE_CODE_JS           — explicit override
//   <dir of this file>/claude-code.js  — default install location
const claudeCodePath = process.env.CLAUDE_CODE_JS ||
  path.join(__dirname, 'claude-code.js')

if (!fs.existsSync(claudeCodePath)) {
  console.error(`[claude-qnx] claude-code.js not found at: ${claudeCodePath}`)
  console.error()
  console.error('  Extract it from the Linux binary first:')
  console.error(`    node ${path.join(__dirname, 'extract.js')} /path/to/claude.exe`)
  console.error('  Or download the latest version automatically:')
  console.error(`    node ${path.join(__dirname, 'extract.js')} --latest`)
  process.exit(1)
}

// ── 4. Run the app ────────────────────────────────────────────────────────────
require(claudeCodePath)

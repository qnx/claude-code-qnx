'use strict'
// Bun API polyfill for running Claude Code under Node.js on QNX.
// Provides global.Bun with Node.js equivalents of the ~22 Bun APIs the app uses.

const cp = require('child_process')
const path = require('path')

// ── FNV-1a 64-bit hash ────────────────────────────────────────────────────────
// Bun.hash() returns a BigInt; callers do .toString(), .toString(36), or &0xffffffffn.
const FNV_PRIME  = 1099511628211n
const FNV_OFFSET = 14695981039346656037n

function fnv1a64(input, seed = FNV_OFFSET) {
  let hash = BigInt.asUintN(64, seed)
  const buf = typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : Buffer.isBuffer(input) ? input : Buffer.from(String(input))
  for (const byte of buf) {
    hash = BigInt.asUintN(64, hash ^ BigInt(byte))
    hash = BigInt.asUintN(64, hash * FNV_PRIME)
  }
  return hash
}

// ── Semver ────────────────────────────────────────────────────────────────────
function semverParts(v) {
  // Handles "1.2.3", "1.2.3-pre.1", etc.  Pre-release always sorts lower.
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(-(.+))?/)
  if (!m) return [0, 0, 0, false]
  return [+m[1], +m[2], +m[3], Boolean(m[4])]
}

function semverOrder(a, b) {
  const [a1,a2,a3,ap] = semverParts(a)
  const [b1,b2,b3,bp] = semverParts(b)
  for (const [x, y] of [[a1,b1],[a2,b2],[a3,b3]]) {
    if (x !== y) return x > y ? 1 : -1
  }
  // Pre-release sorts lower than release (1.0.0-pre < 1.0.0)
  if (ap !== bp) return ap ? -1 : 1
  return 0
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g

function stripANSI(str) {
  return str.replace(ANSI_RE, '')
}

// Display-width of a string (accounts for wide CJK, strips ANSI, ignores combiners).
// Used by Claude's TUI; accuracy matters for column alignment.
function bunStringWidth(str) {
  const clean = stripANSI(str)
  let w = 0
  for (const char of clean) {
    const cp = char.codePointAt(0)
    if (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F)) continue // control chars: 0
    // Combining / zero-width
    if ((cp >= 0x0300 && cp <= 0x036F) ||
        (cp >= 0x1AB0 && cp <= 0x1AFF) ||
        (cp >= 0x20D0 && cp <= 0x20FF) ||
        (cp >= 0xFE20 && cp <= 0xFE2F) ||
        cp === 0x200B || cp === 0xFEFF) continue
    // Wide (East Asian full-width)
    if ((cp >= 0x1100 && cp <= 0x115F) ||
        cp === 0x2329 || cp === 0x232A  ||
        (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3040 && cp <= 0xA4C6) ||
        (cp >= 0xA960 && cp <= 0xA97C) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE10 && cp <= 0xFE19) ||
        (cp >= 0xFE30 && cp <= 0xFE6B) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        cp >= 0x1B000) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

// Word-wrap preserving ANSI codes (best-effort; no hyphenation).
function bunWrapAnsi(str, cols, opts) {
  if (!cols || cols <= 0) return str
  const sw = bunStringWidth
  return str.split('\n').map(line => {
    if (sw(line) <= cols) return line
    const words = line.split(' ')
    const out = []
    let cur = '', curW = 0
    for (const word of words) {
      const ww = sw(word)
      const gap = cur ? 1 : 0
      if (curW + gap + ww <= cols) {
        cur = cur ? cur + ' ' + word : word
        curW += gap + ww
      } else {
        if (cur) out.push(cur)
        // Long words that exceed cols: hard-wrap them
        if (ww > cols) {
          let remaining = word
          while (sw(remaining) > cols) {
            out.push(remaining.slice(0, cols))
            remaining = remaining.slice(cols)
          }
          cur = remaining; curW = sw(remaining)
        } else {
          cur = word; curW = ww
        }
      }
    }
    if (cur) out.push(cur)
    return out.join('\n')
  }).join('\n')
}

// ── Optional npm packages (loaded if installed alongside launcher.js) ─────────
let jsYaml
try { jsYaml = require('js-yaml') } catch {}

// ── Bun.spawn → child_process bridge ─────────────────────────────────────────
// Only the stdout.text() pattern is needed for tool version checks.
// PTY-related spawns (--bg-pty-host) are stubs — that feature needs native PTY.
function bunSpawn(cmd, opts = {}) {
  const { stdin = 'ignore', stdout = 'inherit', stderr = 'inherit',
          cwd, env, argv0, detached = false } = opts
  const mapStdio = s => (s === 'pipe' ? 'pipe' : s === 'ignore' ? 'ignore' : 'inherit')

  const proc = cp.spawn(cmd[0], cmd.slice(1), {
    cwd, env: env ?? process.env, argv0,
    detached,
    stdio: [mapStdio(stdin), mapStdio(stdout), mapStdio(stderr)],
  })

  // Attach .text() to stdout so Bun's `await proc.stdout.text()` pattern works
  if (proc.stdout) {
    proc.stdout.text = () => new Promise((res, rej) => {
      const chunks = []
      proc.stdout.on('data', c => chunks.push(c))
      proc.stdout.on('end', () => res(Buffer.concat(chunks).toString('utf8')))
      proc.stdout.on('error', rej)
    })
  }

  if (detached) proc.unref()

  const exited = new Promise((res, rej) => {
    proc.on('close', (code, sig) => res(sig != null ? 128 : (code ?? 1)))
    proc.on('error', rej)
  })

  return {
    get pid()        { return proc.pid },
    get exitCode()   { return proc.exitCode },
    get signalCode() { return proc.signalCode },
    get killed()     { return proc.killed },
    stdin:  proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited,
    kill(signal) { proc.kill(signal) },
  }
}

// ── global.Bun ────────────────────────────────────────────────────────────────
global.Bun = {
  version: '1.3.14-qnx-shim',

  hash(input, seed) {
    const s = seed !== undefined ? BigInt.asUintN(64, BigInt(seed)) : FNV_OFFSET
    return fnv1a64(input, s)
  },

  which(cmd) {
    try {
      const r = cp.spawnSync('which', [cmd], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
      return r.status === 0 ? (r.stdout.trim().split('\n')[0] || null) : null
    } catch { return null }
  },

  semver: {
    order: semverOrder,
    satisfies(v, range) { return true }, // stub — not called in the current source
  },

  YAML: {
    parse(s) {
      if (jsYaml) return jsYaml.load(s)
      throw new Error('[bun-shim] YAML.parse unavailable — run: npm install js-yaml')
    },
    stringify(obj, _replacer, indent) {
      if (jsYaml) return jsYaml.dump(obj, { indent: indent ?? 2 })
      throw new Error('[bun-shim] YAML.stringify unavailable — run: npm install js-yaml')
    },
  },

  // Already guarded with ?. in source — null is fine
  JSONL: { parseChunk: null },

  spawn: bunSpawn,

  wrapAnsi: bunWrapAnsi,
  stripANSI: stripANSI,

  stringWidth(str, opts) {
    return bunStringWidth(str)
  },

  // Returns [] so JY() (embedded-file check) returns false → app runs in non-compiled mode
  embeddedFiles: [],

  // No-ops / stubs for non-critical APIs
  gc()                 { if (typeof global.gc === 'function') global.gc() },
  generateHeapSnapshot() { return new ArrayBuffer(0) },

  // PTY terminal emulator — only needed for --bg-pty-host mode, not basic CLI
  Terminal: null,

  // JS transpiler — only used for the interactive REPL
  Transpiler: null,

  stdin: process.stdin,
}

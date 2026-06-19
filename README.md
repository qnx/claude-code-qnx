# Claude Code: Standard vs QNX Port

## Quick start

See [INSTALL.md](INSTALL.md) for full setup instructions. Once installed, extract the JS bundle and launch:

```sh
npm install -g @anthropic-ai/claude-code
node extract.js $(npm root -g)/@anthropic-ai/claude-code/bin/claude.exe
claude-qnx
```

The two-step extraction above makes explicit what is happening: `npm install` downloads the official Claude Code package (which contains the Linux Bun binary), and `extract.js` reads the JS application bundle out of that binary. The shorthand `node extract.js --latest` does the same thing in one step — it fetches the binary directly from the npm registry without a global install.

---

## Standard Claude Code (`claude` binary)

The official `claude` binary is a **Bun standalone executable** — a self-contained runtime (Bun v1.3.14, JavaScriptCore/WebKit engine) with the entire Claude Code JavaScript application embedded inside it.

**At runtime:**
1. The binary is executed directly — no interpreter is invoked
2. Bun's runtime starts, locates the embedded JS bundle using an internal marker string and loads it directly from the binary
3. All `require()` calls resolve against Bun's virtual filesystem (`/$bunfs/`) — no files on disk
4. Native addons (`image-processor.node`, `audio-capture.node`) provide PTY/media features

**Platform support:** Linux x64/arm64, macOS, Windows. QNX and FreeBSD are not supported because the Bun runtime has not been ported to them.

---

## QNX Claude (`qnx-claude`)

The QNX port re-uses the exact same JavaScript application, but swaps the Bun runtime for Node.js (v18+), which does run on QNX.

**Files:**

| File | Role |
|------|------|
| `extract.js` | One-time tool: reads the JS bundle out of the Linux Bun binary and writes it to `claude-code.js` |
| `claude-code.js` | The extracted 14 MB JS application — identical to what runs inside the official binary |
| `bun-shim.js` | Polyfill that creates `global.Bun` with Node.js implementations of the ~22 Bun APIs the app uses |
| `launcher.js` | Entry point: installs the shim, intercepts `/$bunfs/` virtual paths, then `require()`s `claude-code.js` |
| `claude-qnx` | Shell wrapper: `exec node launcher.js "$@"` |

**At runtime:**
1. `node launcher.js` starts under QNX's Node.js
2. `bun-shim.js` installs `global.Bun` before any app code runs
3. A `Module._load` hook intercepts any `require('/$bunfs/...')` calls — `.node` native addons are stubbed with `{}`, so the app starts cleanly without PTY/media features
4. `claude-code.js` is loaded and runs normally under V8

**Bun APIs shimmed:**

| API | Implementation |
|-----|---------------|
| `Bun.hash()` | FNV-1a 64-bit (returns BigInt) |
| `Bun.which()` | `spawnSync('which', ...)` |
| `Bun.semver.order()` | Inline semver comparator |
| `Bun.spawn()` | `child_process.spawn` with `.stdout.text()` bridge |
| `Bun.stringWidth()` | Inline Unicode east-Asian width calculator |
| `Bun.wrapAnsi()` | Inline word-wrapper |
| `Bun.stripANSI()` | Regex strip |
| `Bun.YAML` | Delegates to `js-yaml` if installed |
| `Bun.gc()` | Calls `global.gc()` if exposed |
| `Bun.embeddedFiles` | `[]` (signals non-compiled mode to the app) |
| `Bun.Terminal` | `null` (PTY feature, not needed) |
| `Bun.Transpiler` | `null` (REPL feature, not needed) |

**What's missing vs standard:**
- Screen/audio capture (Linux ELF `.node` addons, not applicable to QNX)
- PTY host mode (`--bg-pty-host`), which requires a native QNX PTY module

**External npm deps required on QNX:**
- `ws` — WebSocket (bundled inside Bun but must be installed separately under Node.js)
- `js-yaml` — only needed if YAML config files are used

---

## How launcher.js works

`launcher.js` is the Node.js entry point that bridges the gap between the extracted JS bundle and the Node.js runtime. When you invoke `claude-qnx` the execution chain is:

```
claude-qnx  (shell script)
  → node launcher.js
    → require('./bun-shim.js')   installs global.Bun polyfill
    → Module._load hook          intercepts /$bunfs/ virtual paths
    → require('./claude-code.js') the app runs
```

It does three things before handing off to the app:

1. **Installs the Bun shim** — `bun-shim.js` creates `global.Bun` with Node.js implementations of all Bun APIs the app uses. This must happen before any app code runs.
2. **Intercepts virtual filesystem paths** — hooks `Module._load` so any `require('/$bunfs/...')` call (Bun's internal virtual filesystem) is caught rather than crashing Node.js. Native addons (`.node` files) are stubbed with empty objects; other bunfs paths return an empty module.
3. **Loads the app** — `require('./claude-code.js')` hands control to the extracted JS bundle, which runs normally under V8.

`launcher.js` locates `claude-code.js` relative to its own directory (`__dirname`), which can be overridden with the `CLAUDE_CODE_JS` environment variable.

---

## Upgrading

When Anthropic ships a new Claude Code version, only `claude-code.js` needs updating — the shim and launcher don't change.

```sh
node extract.js --latest
```

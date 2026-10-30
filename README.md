# Claude Code: Standard vs QNX Port

## Quick start

See [INSTALL.md](INSTALL.md) for full setup instructions. Once installed, install dependencies, extract the JS application, and launch:

```sh
cd /usr/lib/claude-code
npm install
node extract-chunks.js --version 2.1.245   # newest version this port can run — see below
claude-qnx
```

Pin to **2.1.245** explicitly — it is this port's current ceiling (see
"Known compatibility ceiling"). `extract-chunks.js` and the older
single-bundle `extract.js` both support `--version <ver>` (fetches straight
from npm) or a local path to an already-downloaded Linux `claude` binary —
e.g. from `npm install -g @anthropic-ai/claude-code`, if you'd rather not
let the extractor re-download one itself.

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

## QNX Claude (`claude-code-qnx`)

The QNX port re-uses the exact same JavaScript application, but swaps the Bun runtime for Node.js (v18+), which does run on QNX.

There are **two extraction layouts**, because Bun's packaging changed
mid-stream (see "Known compatibility ceiling"), and `launcher.js`
auto-detects which one is on disk:

**Legacy layout (≤2.1.241) — one bundle file:**

| File | Role |
|------|------|
| `extract.js` | Reads the one contiguous JS bundle out of the Linux Bun binary, writes `claude-code.js` |
| `claude-code.js` | The extracted JS application (CommonJS) — identical to what runs inside the official binary |

**Chunked layout (2.1.242–2.1.245) — a tree of ES modules:**

| File | Role |
|------|------|
| `extract-chunks.js` | Finds every embedded `/$bunfs/root/*.js` module (not just the entrypoint — Bun code-splits the app into hundreds of files from 2.1.242 on), extracts each, and rewrites every cross-module `/$bunfs/...` reference to a real relative file path |
| `bunfs/` | One `.js` file per extracted module, mirroring its original `/$bunfs/root/...` path, plus a `package.json` (`{"type":"module"}`) so Node treats them as ES modules |
| `bunfs-manifest.json` | Records the entry module's path, module count, and any bunfs references that couldn't be resolved (native `.node` addons) |

**Shared, either layout:**

| File | Role |
|------|------|
| `bun-shim.js` | Polyfill that creates `global.Bun` with Node.js implementations of the ~22 Bun APIs the app uses |
| `launcher.js` | Entry point — see "How launcher.js works" |
| `claude-qnx` | Shell wrapper: `exec node launcher.js "$@"` |

**At runtime (chunked layout):**
1. `node launcher.js` starts under QNX's Node.js, sees `bunfs-manifest.json` on disk, and takes the chunked path
2. `bun-shim.js` installs `global.Bun` before any app code runs
3. `globalThis.require`/`globalThis.__bunfsRequire` are installed — real packages (`ajv`, `react`, `worker_threads`, ...) resolve via a real `createRequire()` rooted at `bunfs/`; anything ending in `.node` (or still carrying a `/$bunfs/` path — i.e. an addon or asset `extract-chunks.js` never found real content for) is stubbed to `{}`
4. The entry module is loaded via dynamic `import()` of its real file path — no custom ESM loader/`module.register()` hook needed, because every chunk-to-chunk `import` specifier was already rewritten to a plain relative path at extraction time

**At runtime (legacy layout):**
1. `node launcher.js` starts, finds no manifest, takes the legacy path
2. `bun-shim.js` installs `global.Bun`
3. A `Module._load` hook intercepts any `require('/$bunfs/...')` call — `.node` native addons are stubbed with `{}`
4. `claude-code.js` is `require()`'d and runs normally under V8

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
`ws` (WebSocket) and `js-yaml` are declared in `package.json` and installed via `sudo npm install` in the install directory. Both are bundled inside the Bun binary and must be provided separately when running under Node.js.

---

## How launcher.js works

`launcher.js` is the Node.js entry point that bridges the gap between the extracted JS application and the Node.js runtime. It auto-detects the layout by checking for `bunfs-manifest.json`:

```
claude-qnx  (shell script)
  → node launcher.js
    → require('./bun-shim.js')          installs global.Bun polyfill
    ├─ bunfs-manifest.json exists?
    │    yes → chunked path:
    │           globalThis.require / __bunfsRequire installed
    │           import(<entry file under bunfs/>)   the app runs as ESM
    │    no  → legacy path:
    │           Module._load hook       intercepts /$bunfs/ virtual paths
    │           require('./claude-code.js')   the app runs as CJS
```

Either path installs the Bun shim first — that must happen before any app
code runs, in both layouts.

In the **chunked** path, `extract-chunks.js` already rewrote every
chunk-to-chunk `import`/`import()` specifier to a real relative file path at
extraction time (see its module docstring), so `launcher.js` itself needs no
custom ESM resolution hook — it just resolves and imports the entry file
like any normal Node ESM entry point. The only runtime interception left is
for things that were never real files to begin with: `globalThis.require`
and `globalThis.__bunfsRequire` (the latter is what `import.meta.require` —
a Bun-only extension with no Node equivalent — gets rewritten to) both point
at one function that delegates to a real `createRequire()` for actual
packages, and returns `{}` for anything ending in `.node` or still carrying
a `/$bunfs/` path (native addons, or an asset `extract-chunks.js` couldn't
resolve).

`launcher.js` locates the app relative to its own directory (`__dirname`),
overridable with `CLAUDE_CODE_MANIFEST` (chunked) or `CLAUDE_CODE_JS` (legacy).

---

## Upgrading

```sh
# chunked layout, 2.1.242–2.1.245:
node /usr/lib/claude-code/extract-chunks.js --version 2.1.245

# legacy layout, <=2.1.241 (e.g. if you specifically want an older version):
node /usr/lib/claude-code/extract.js --version 2.1.241
```

Don't use `--latest` on either tool — "latest" means "latest on npm" (2.1.303
as of this writing), not "latest this port can run." Always pin a version
explicitly; see "Known compatibility ceiling" for why 2.1.245 is as far as
either tool goes.

On an aarch64 target, add `--arch arm64` (or `arm64-musl` / `x64-musl` to
match the target's libc) so the binary is pulled from the matching native
npm package rather than x64's — see "Installing on a new QNX system" below.

### Known compatibility ceiling

Three breaking changes upstream, two fixed here and one that's a hard wall
(see `compatible-version.txt` / `incompatible-versions.txt`):

- **2.1.229** *(fixed)*: the bytecode marker comment after the entrypoint
  path started following a short canonical alias (e.g. `/$bunfs/root/cli`)
  instead of the long path repeated — `extract.js` now tolerates either form.
- **2.1.242** *(fixed, by `extract-chunks.js`)*: Bun started code-splitting
  the app into hundreds of `/$bunfs/root/chunk-*.js` files that `cli.js`
  loads via dynamic `import()` at runtime, instead of one contiguous bundle.
  The bytecode marker comment also simplified to plain `// @bun @bytecode`
  (no `@bun-cjs`/CJS-wrapper suffix) for ESM modules. `extract-chunks.js`
  locates every such module (not just `cli.js`), extracts each one, and
  rewrites cross-module references to real relative paths — see "QNX Claude"
  above and the extensive comments in `extract-chunks.js` itself.
- **2.1.246** *(hard wall — not fixed, and not fixable this way)*: the
  `cli.js` entrypoint (and nearly everything else) stops carrying any JS
  **source text** at all. What's embedded from this version on is compiled
  JavaScriptCore bytecode plus a deduplicated string-constant table (Bun's
  `StandaloneModuleGraph` optional `HAS_LINKED_BYTECODE_PAYLOAD` /
  `HAS_BYTECODE_STRING_TABLE` sections — see `oven-sh/bun`'s
  `src/standalone_graph/StandaloneModuleGraph.rs`), not readable source next
  to a marker comment. There is nothing to text-scrape: JSC bytecode cannot
  run on Node's V8 engine, be decompiled back to equivalent source, or be
  translated to V8 bytecode. `extract-chunks.js` detects this (an empty
  `cli.js` after extraction) and fails loudly rather than producing a broken
  install. Porting past 2.1.245 is a different, much larger project than
  this repo — either a real port of the Bun runtime (and the JSC engine it
  embeds) to QNX, or a from-scratch JSC bytecode interpreter — not an
  extension of the extraction approach used here.

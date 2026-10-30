# Installing Claude Code on QNX

This guide covers installing and running Claude Code on a self-hosted QNX developer desktop using the Node.js-based launcher in this repo.

## Prerequisites

- QNX 8.0 or later, x86_64 or aarch64
- Node.js 18 or later (with `npm`), **native to your QNX system's own CPU
  architecture** — this repo only re-hosts Claude Code's JS application; it
  does not provide or build Node.js itself. On aarch64, confirm `apk`'s QNX
  package repo actually ships an aarch64 `nodejs`/`npm` build before relying
  on the command below — if it doesn't, porting Node.js to QNX/aarch64 first
  is a separate prerequisite this guide does not cover.
- Internet access from your QNX system

If Node.js and npm are not yet installed:

```sh
sudo apk update
sudo apk add npm
```

If you have not already configured npm to install global packages without root, do so now:

```sh
npm config set prefix '~/.local'
```

Make sure `~/.local/bin` is in your `PATH`.

## Step 1 — Get the files onto your QNX system

Clone this repository directly on your QNX system and take ownership of the install directory.

**If this chunked-layout support has already been merged into `main`:**

```sh
sudo git clone https://github.com/qnx/claude-code-qnx.git /usr/lib/claude-code
sudo chown -R $(whoami) /usr/lib/claude-code
```

**If it's still an open, unmerged pull request** (e.g. you're following along
before it's been reviewed, or the branch lives only on a fork), add
`--branch <branch-name>` pointing at that PR's source branch and repository
URL instead — for example:

```sh
sudo git clone https://github.com/<fork-owner>/claude-code-qnx.git --branch <branch-name> /usr/lib/claude-code
sudo chown -R $(whoami) /usr/lib/claude-code
```

Everything from Step 2 onward is identical either way.

## Step 2 — Extract the JavaScript application

Claude Code's application code is distributed inside the official Linux Bun binary. You need to extract it once — and re-run this step whenever Anthropic releases a new version.

```sh
cd /usr/lib/claude-code
node extract-chunks.js --version 2.1.245
```

This produces a `bunfs/` directory (~40 MB, one file per embedded module)
and `bunfs-manifest.json` in the install directory. Neither is committed to
this repo — they're generated artifacts refreshed on each extraction.

Pin to **2.1.245** explicitly rather than using `--latest` — 2.1.245 is the
newest release either extractor in this repo can read; everything from
2.1.246 on ships compiled bytecode instead of the JS source text this
approach depends on, which is a hard wall, not a bug to fix later. See
`compatible-version.txt` / `incompatible-versions.txt` and the "Known
compatibility ceiling" section of README.md for the full version-by-version
breakdown.

(If you specifically want an older, pre-2.1.242 version instead, use
`extract.js --version <ver>` — the single-bundle legacy tool — rather than
`extract-chunks.js`; `launcher.js` auto-detects either output.)

On an **aarch64** target, add `--arch arm64` so the binary is pulled from the
`arm64` native package instead of `x64` (use `arm64-musl` if the target
Node.js build links musl instead of glibc):

```sh
node extract-chunks.js --version 2.1.245 --arch arm64
```

The extracted JS files are plain JavaScript (ES modules) — the same files
work on any CPU architecture that can run them. What's architecture-specific
is the Node.js binary that runs them (see Prerequisites above); the
`--arch` choice is only about which native build gets *scanned* to produce
those files, not about runtime compatibility.

## Step 3 — Install npm dependencies

```sh
cd /usr/lib/claude-code
npm install
npm list --depth=0
```

`npm list --depth=0` is a quick sanity check — it should show `ws` and
`js-yaml` installed with no `UNMET DEPENDENCY` warnings. If either is
missing, re-run `npm install` before moving on.

## Step 4 — Add `claude-qnx` to your PATH

```sh
sudo chmod +x /usr/lib/claude-code/claude-qnx
sudo ln -s /usr/lib/claude-code/claude-qnx /usr/bin/claude-qnx
```

## Step 5 — Run Claude Code

Run it from outside the install directory, so you're also confirming the
`PATH` symlink from Step 4 actually resolves:

```sh
cd && claude-qnx --version
claude-qnx
```

> **Optional — API key.** Set `ANTHROPIC_API_KEY` as an environment variable
> (add it to `~/.profile` or `~/.bashrc` to make it permanent) if you want
> to skip the interactive prompt:
>
> ```sh
> export ANTHROPIC_API_KEY=sk-ant-...
> ```
>
> If you skip this, `claude-qnx` will prompt you for a key on first run and
> provide a URL to obtain one.

---

## Upgrading

When Anthropic releases a new Claude Code version, only the extracted application needs updating — the launcher and shim do not change:

```sh
node /usr/lib/claude-code/extract-chunks.js --version 2.1.245
```

(Not `--latest` — see the compatibility note in Step 2. Check
`compatible-version.txt` before assuming a newer release than 2.1.245 will work.)

---

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (optional — skips the first-run prompt) |
| `CLAUDE_CODE_DIR` | Override the install directory (default: directory containing the `claude-qnx` script) |
| `CLAUDE_CODE_JS` | Legacy layout only: override the path to `claude-code.js` (default: `$CLAUDE_CODE_DIR/claude-code.js`) |
| `CLAUDE_CODE_MANIFEST` | Chunked layout only: override the path to `bunfs-manifest.json` (default: `$CLAUDE_CODE_DIR/bunfs-manifest.json`) |

---

## Troubleshooting

**`Cannot find module 'ws'`** or **`Cannot find module 'js-yaml'`**  
Run `npm install` in the install directory. These packages are declared in `package.json` and should have been installed in Step 3.

**`Entry module not found`**  
Run `node /usr/lib/claude-code/extract-chunks.js --version 2.1.245` to generate the `bunfs/` tree. See Step 2.

**`Error: Cannot find module '/$bunfs/...'`**  
This should not happen — the launcher intercepts all `/$bunfs/` paths. If it does, open an issue with the full stack trace.

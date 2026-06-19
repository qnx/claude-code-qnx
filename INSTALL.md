# Installing Claude Code on QNX

This guide covers installing and running Claude Code on a self-hosted QNX developer desktop using the Node.js-based launcher in this repo.

## Prerequisites

- QNX 8.0 or later
- Node.js 18 or later (with `npm`)
- Internet access from your QNX system

If Node.js and npm are not yet installed:

```sh
sudo apk add npm
```

If you have not already configured npm to install global packages without root, do so now:

```sh
npm config set prefix '~/.local'
```

Make sure `~/.local/bin` is in your `PATH`.

## Step 1 — Get the files onto your QNX system

Clone this repository directly on your QNX system and take ownership of the install directory:

```sh
sudo git clone https://github.com/qnx/claude-code-qnx.git /usr/lib/claude-code
sudo chown -R $(whoami) /usr/lib/claude-code
```

## Step 2 — Extract the JavaScript bundle

Claude Code's application code is distributed inside the official Linux Bun binary. You need to extract it once — and re-run this step whenever Anthropic releases a new version.

```sh
cd /usr/lib/claude-code
node extract.js --latest
```

This produces `claude-code.js` (~14 MB) in the install directory. It is not committed to this repo because it is a generated artifact that must be refreshed on each Claude Code release.

## Step 3 — Install npm dependencies

```sh
cd /usr/lib/claude-code
npm install
```

## Step 4 — Set your API key (optional)

If you have an Anthropic API key you can set it as an environment variable:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Add this to your shell profile (`~/.profile` or `~/.bashrc`) to make it permanent.

If you skip this step, `claude-qnx` will prompt you for a key on first run and provide a URL to obtain one.

## Step 5 — Add `claude-qnx` to your PATH

```sh
sudo chmod +x /usr/lib/claude-code/claude-qnx
sudo ln -s /usr/lib/claude-code/claude-qnx /usr/bin/claude-qnx
```

## Step 6 — Run Claude Code

```sh
claude-qnx --version
claude-qnx
```

---

## Upgrading

When Anthropic releases a new Claude Code version, only the JS bundle needs updating — the launcher and shim do not change:

```sh
node /usr/lib/claude-code/extract.js --latest
```

---

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) |
| `CLAUDE_CODE_DIR` | Override the install directory (default: directory containing the `claude-qnx` script) |
| `CLAUDE_CODE_JS` | Override the path to `claude-code.js` (default: `$CLAUDE_CODE_DIR/claude-code.js`) |

---

## Troubleshooting

**`Cannot find module 'ws'`** or **`Cannot find module 'js-yaml'`**  
Run `npm install` in the install directory. These packages are declared in `package.json` and should have been installed in Step 3.

**`claude-code.js not found`**  
Run `node /usr/lib/claude-code/extract.js --latest` to generate it. See Step 2.

**`Error: Cannot find module '/$bunfs/...'`**  
This should not happen — the launcher intercepts all `/$bunfs/` paths. If it does, open an issue with the full stack trace.

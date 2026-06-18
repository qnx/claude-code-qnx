# Installing Claude Code on QNX

This guide covers installing and running Claude Code on a self-hosted QNX developer desktop using the Node.js-based launcher in this repo.

## Prerequisites

- QNX 8.0 or later
- Node.js 18 or later (with `npm`)
- An [Anthropic API key](https://console.anthropic.com/)
- Internet access from your QNX system

## Step 1 — Get the files onto your QNX system

Clone this repository directly on your QNX system:

```sh
git clone https://github.com/qnx/claude-code-qnx.git /usr/lib/claude-code
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
npm install ws
```

Optionally, if you use YAML configuration files:

```sh
npm install js-yaml
```

## Step 4 — Set your API key

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Add this to your shell profile (`~/.profile` or `~/.bashrc`) to make it permanent.

## Step 5 — Add `claude` to your PATH

```sh
chmod +x /usr/lib/claude-code/claude
ln -s /usr/lib/claude-code/claude /usr/bin/claude
```

## Step 6 — Run Claude Code

```sh
claude --version
claude
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
| `CLAUDE_CODE_DIR` | Override the install directory (default: directory containing the `claude` script) |
| `CLAUDE_CODE_JS` | Override the path to `claude-code.js` (default: `$CLAUDE_CODE_DIR/claude-code.js`) |

---

## Troubleshooting

**`Cannot find module 'ws'`**  
Run `npm install ws` in the install directory.

**`Cannot find module 'js-yaml'`**  
Run `npm install js-yaml` in the install directory (only needed for YAML config support).

**`claude-code.js not found`**  
Run `node extract.js --latest` to generate it. See Step 2.

**`Error: Cannot find module '/$bunfs/...'`**  
This should not happen — the launcher intercepts all `/$bunfs/` paths. If it does, open an issue with the full stack trace.

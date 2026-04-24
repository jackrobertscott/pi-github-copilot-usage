# pi-github-copilot-usage

Pi extension that shows your GitHub Copilot plan usage in pi's footer.

## What it displays

- Used vs allocated Copilot request quota, for example `179.2/1.5k`
- The relevant quota bucket (`premium`, `chat`, `completions`, etc.)
- A `/copilot-usage` command for a detailed refresh summary

## How it works

The extension reads your existing GitHub Copilot auth from `~/.pi/agent/auth.json`, then calls GitHub's Copilot user endpoint to read `quota_snapshots`.

For premium plans, GitHub may report fractional usage because some models consume more than `1x` premium interaction per request.

## Usage

1. Start pi in this repo, or run `/reload` if pi was already open.
2. Look at the footer for the `🐙 Copilot ...` status.
3. Run `/copilot-usage` for a detailed refresh.

## Development

```bash
npm install
npm run check
```

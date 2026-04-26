# pi-github-copilot-usage

Pi extension that shows your GitHub Copilot plan usage in pi's footer.

## What it displays

- A low-profile footer status with used vs allocated Copilot quota, percent left, and the current GitHub Copilot model's premium-request cost per user message, for example `copilot 179.2/1.5k 88% left 1 req/msg`
- Overage-aware usage when requests exceed the included plan amount, including ratios like `1.6k/1.5k` and explicit overage display
- The relevant quota bucket (`premium`, `chat`, `completions`, etc.) when it is useful to show
- A `/copilot-usage` command that shows all available quota snapshots in a width-aware CLI table, plus the selected GitHub Copilot model and its per-message premium-request cost

## How it works

The extension reads your existing GitHub Copilot auth from `~/.pi/agent/auth.json`, then calls GitHub's Copilot user endpoint to read `quota_snapshots`.

For premium plans, GitHub may report fractional usage because some models consume more than `1x` premium interaction per request. The extension fetches the latest model multipliers from GitHub Docs (`data/tables/copilot/model-multipliers.yml`) and uses them to show the selected GitHub Copilot model's per-message premium-request cost.

GitHub's API does not currently expose per-day Copilot usage history, so this extension does not attempt to infer or estimate daily usage.

## Usage

1. Start pi in this repo, or run `/reload` if pi was already open.
2. Look at the footer for the `copilot ...` status.
3. Run `/copilot-usage` for a detailed CLI table view.

## Development

```bash
npm install
npm run check
```

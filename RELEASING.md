# Release Policy & Versioning Rules

## 1. Strict Owner-Only Release Rule

> **Mandatory Rule:** Publishing a new release, merging `dev` into `main`, pushing tags (`v*`), or creating a GitHub Release **MUST NEVER** happen automatically or without **explicit approval from the repository owner (`DanielLetto2020`)**.

- Ongoing development always happens on the **local-only `dev`** branch (`dev` is never pushed to GitHub).
- The **`main`** branch is the only public branch on GitHub, strictly reserved for approved releases and protected by GitHub Repository Rulesets.
- Release tags (`v*`) are protected by GitHub Repository Rulesets so only the repository owner/admin can create, update, or delete them.
- The manual helper script [`scripts/release.sh`](scripts/release.sh) **refuses to run** unless `--approved` is explicitly passed after owner sign-off.

## 2. Branching Model

| Branch | Visibility | Purpose |
| :--- | :--- | :--- |
| `dev` | **Local-only** (never pushed) | Active local development, fixes, new features, tests |
| `main` | **Public** (default branch on GitHub) | Clean released snapshots pushed only by the repository owner after explicit release approval |

## 3. Versioning Scheme (`3.0.<commit_count>`)

Releases follow the extension's commit-based patch numbering:

- Initial release: **`3.0.0`** (tag `v3.0.0`)
- Subsequent releases: **`3.0.<N>`** (`3.0.1`, `3.0.2`, ..., `3.0.1252`), where `<N>` is the commit count on `dev` since `v3.0.0`:

```sh
git rev-list --count v3.0.0..dev
```

## 4. Files to Sync on Version Bump

When preparing an approved release for `3.0.<N>`, keep the version string consistent across:

- `extension/manifest.json` (`"version"`)
- `bridge.py` (`VERSION`)
- `INSTALL.json` (`"version"`)
- `extension/dom.js` (`__maxBrowserDomVersion`)
- `extension/advanced.js` (runtime version check & fallback)
- `extension/features.js` / `extension/v3.js` (fallback version strings)
- `extension/popup.html` / `extension/popup.js`
- `extension/about.html` / `extension/about.js`
- `test/browser.test.js` / `test/live_smoke.py`
- `README.md` / `README.ru.md` badges

## 5. Pre-Release Checklist

1. Confirm explicit release approval from the repository owner.
2. Verify current branch is `dev` with a clean working tree.
3. Compute `<N>` (`git rev-list --count v3.0.0..dev`) and update version references to `3.0.<N>` on `dev`.
4. Run full verification:
   ```sh
   ./install.sh --no-hosts --test
   ./scripts/check_privacy.sh
   ```
5. Execute the approved release script (or merge `dev` -> `main`, create annotated tag `v3.0.<N>`, build clean `.zip` via `git archive`).
6. Write clear, human-friendly bilingual release notes (see template below) highlighting what changed, why it matters, and how to upgrade.
7. Switch local workspace back to `dev`.

## 6. Release Notes Template

```markdown
## Max Browser MCP v3.0.<N>

### What's New / Что нового
- Clear user-facing feature summaries

### Speed & Token Savings / Скорость и экономия токенов
- Any optimizations, defaults, or profile updates

### Fixes & Reliability / Исправления и стабильность
- Concrete bug fixes verified by tests

### Upgrade / Обновление
1. Download `max-browser-mcp-v3.0.<N>.zip` (or `git pull`).
2. Run `./install.sh` and click **Reload** on Max Browser in `chrome://extensions`.
```

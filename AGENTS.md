# Repository Guidelines

- **Development branch**: Always work on the **local-only `dev`** branch. Never push `dev` to `origin`, and never push directly to `main` without owner approval (`main` is the only public branch on GitHub).
- **Release approval required**: Never merge `dev` into `main`, create `v*` tags, bump release versions, or publish GitHub Releases without explicit permission from the repository owner (`DanielLetto2020`). See [RELEASING.md](RELEASING.md).
- **Versioning**: Releases follow `3.0.0`, `3.0.1`, ..., `3.0.<commit_count>`, where the third number equals the number of development commits since `v3.0.0`.
- **No AI attribution**: Never add co-authorship, generator trailers, or AI session links to commits, pull requests, release notes, or repository files.
- **No secrets or personal paths**: Never commit tokens, API keys, `.env` files, Unix sockets (`run/`), compiled artifacts (`__pycache__/`, `dist/`), or machine-specific home directory paths. Run `./scripts/check_privacy.sh` before committing.
- **Tests before commit**: Always run `./install.sh --no-hosts --test` and ensure all Python and Node unit checks pass.

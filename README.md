# scb-mac-setup-tool

The macOS setup tool of Suno CoverBot, mirrored here **only** so its tests can run on GitHub's real macOS runners (free for public repositories).

- No secrets, bot, database or extension source live here. The tool downloads the *public* extension package from the production site and verifies it.
- `Actions > Mac Journey` builds the `.app` as a `.tar.gz`, installs it with the generated one-liner, drives a real Chrome and proves the LaunchAgent updater.
- The source of truth is the private project; this copy is refreshed by `scripts/ci/publish-mac-ci-repo.sh` there.

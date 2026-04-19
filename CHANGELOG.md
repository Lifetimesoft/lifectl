# Changelog

All notable changes to `@lifetimesoft/lifectl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.0.4] - 2026-04-18

### Fixed

- Force re-login when refresh token is invalid despite a still-valid access token
- `isTokenExpired` now compares timestamps in seconds instead of milliseconds

---

## [0.0.3]

### Added

- `log` command — stream agent logs from the runtime
- `restart` command — restart a running agent
- `--name` option for `run` command
- `--name` and `--status` filter options for `ps` command

### Changed

- Agent registry structure updated to support versioning

### Fixed

- Race conditions, resource leaks, and edge cases in AI agent commands
- Split agent image and agent container handling
- Security fixes: Code Injection, Path Traversal, Log Injection

---

## [0.0.2]

### Added

- `agent push` — package and push agent to registry (tar.gz)
- `agent pull` — pull agent by name and version
- `agent list` — list available agents (local + remote)
- `agent.json` — local manifest saved on pull
- Agent version tracking on pull
- Auto refresh token when access token expires

### Changed

- Switched packaging format from zip to tar.gz

---

## [0.0.1]

### Added

- Initial release of `lifectl` CLI
- `login` / `logout` commands with API authentication
- Session management — check if already logged in
- Call `cli-logout` on logout
- Package configuration for npm publish

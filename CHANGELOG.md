# Changelog

All notable changes to `@lifetimesoft/lifectl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.0.6] - 2026-04-23

### Fixed

- **WebSocket connectivity** — resolved multiple WebSocket connection issues that prevented agents from maintaining persistent connections to the platform
  - Fixed missing WebSocket dependencies (`ws`, `@types/ws`) in agent-sdk
  - Fixed middleware routing for WebSocket upgrade requests in app-main
  - Fixed AuthCli middleware blocking WebSocket upgrade requests (now detects `Upgrade: websocket` header)
  - Added proper WebSocket route handling in app-main (`GET /cli/*`)
- **Agent configuration updates** — fixed issue where agent config changes from the platform UI weren't being sent to running agents
  - Fixed config update WebSocket messages to send full config object instead of just scheduler config
  - Agents now properly reload configuration when changed through the platform dashboard
- **Cron expression validation** — fixed UI validation issues with cron expressions containing step syntax
  - Fixed parsing of expressions like `*/5` (every 5 units) in platform UI
  - Added support for both 5-field and 6-field cron expressions in UI validation
  - Improved cron description text (e.g., "every 5 hours" instead of "at */5:00")

### Enhanced

- **Error handling** — improved error messages for WebSocket connection failures and cron validation
- **Logging** — cleaned up debug logs from production deployments while maintaining essential error logging

---

## [0.0.5] - 2026-04-21

### Added

- `detectPackageManager()` — auto-detects bun / pnpm / yarn / npm from lock files; priority: bun > pnpm > yarn > npm
- `resolveNodeBinScript()` — resolves `.cmd` wrapper on Windows for detached process spawning
- `AGENT_REFRESH_TOKEN` env var injected into agent process for WebSocket token auto-refresh
- `instance_id` stored in `containers.json` for reliable restart/start without parsing `run_id`
- Fallback: parse `instance_id` from `run_id` for older `containers.json` entries

### Changed

- `run` command — calls `/agents/run` on SaaS to get `ctx` (includes `config.scheduler`), injects as `AGENT_CTX` env var; uses local `agent-runtime` binary instead of spawning agent directly
- `start` command — calls `/agents/restart` on SaaS to reuse existing instance row; handles expired instance error with clear message
- `restart` command — calls `/agents/restart` on SaaS; handles expired instance error
- `stop` command — calls `/agents/stopped` on SaaS to notify platform of clean shutdown
- `rm` command — calls `DELETE /agents/instance` on SaaS before local cleanup
- `spawnProcess()` — accepts optional `env` param for injecting agent environment variables

### Removed

- `spawnSync`, `ALLOWED_RUNTIMES`, `validateCmd()` — replaced by `detectPackageManager()` and `agent-runtime`
- Heartbeat logic from lifectl — fully managed by `agent-sdk` runtime via WebSocket

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

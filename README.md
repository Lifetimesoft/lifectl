# @lifetimesoft/lifectl

> Run AI agents easily — powered by Lifetimesoft CLI platform.

**lifectl** is a CLI tool for running and managing AI agents with a Docker-like experience, built on top of a scalable SaaS platform.

---

## ✨ Features

* 📦 Pull agents from registry
* ▶️ Run agents locally with named containers
* 🧠 Plug-and-play agent system
* 🔐 Secure authentication via SaaS
* ⚡ Lightweight and fast
* 🔄 Versioned agents
* 📋 Docker-style container lifecycle (run/start/stop/restart/rm)
* 📝 Log rotation with follow mode
* 🔍 Compatibility check before pull (capabilities-based)

---

## 🚀 Quick Start

### Install

```bash
npm install -g @lifetimesoft/lifectl
```

### Run your first agent

```bash
lifectl auth login
lifectl ai agent run hello-world-agent
lifectl ai agent ps
```

![lifectl ai agent demo](assets/lifectl-ai-agent-01.gif)

---

## 🧩 CLI Structure

```bash
lifectl <app> <sub-app> <command>
```

### Apps

* `auth` → Authentication
* `ai` → AI services

---

## 🤖 AI Module

### Agent — Image Management

```bash
lifectl ai agent pull <name>          # Pull agent from registry
lifectl ai agent pull <name>:<ver>    # Pull specific version
lifectl ai agent push                 # Build + push agent to registry
lifectl ai agent list                 # List pulled agents
lifectl ai agent rma <name>           # Remove agent (all versions)
lifectl ai agent rma <name>:<ver>     # Remove specific version
lifectl ai agent rma <agentId>        # Remove by agent ID (from list)
```

---

### Agent — Container Management

```bash
lifectl ai agent run <name>                      # Run agent (pull if needed)
lifectl ai agent run <name>:<ver>                # Run specific version
lifectl ai agent run <agentId>                   # Run by agent ID
lifectl ai agent run <name> --name <alias>       # Run with a custom container name

lifectl ai agent ps                              # List running containers
lifectl ai agent ps -a                           # List all containers (running + stopped)
lifectl ai agent ps --name <name>                # Filter by agent name or alias
lifectl ai agent ps --status running             # Filter by status

lifectl ai agent start <containerId|alias|name>  # Start a stopped container
lifectl ai agent stop <name|alias|containerId>   # Stop a container
lifectl ai agent restart <name|alias|containerId># Restart a container
lifectl ai agent rm <containerId|alias|name>     # Remove a stopped container

lifectl ai agent logs <name|alias|containerId>   # Show logs
lifectl ai agent logs <name> -n 100              # Show last N lines
lifectl ai agent logs <name> -f                  # Follow logs
```

---

### Named containers

```bash
lifectl ai agent run my-agent --name web
lifectl ai agent logs web
lifectl ai agent stop web
```

---

### Example output of `list`

```
AGENT ID      NAME               VERSION  RUNTIME  PULLED AT
a3f9c12b4e07  hello-world-agent  1.0.0    node     06/04/2026 20:09
b7d2e45f1c08  my-other-agent     2.1.0    python   05/04/2026 15:30
```

### Example output of `ps`

```
CONTAINER ID  AGENT ID      NAME                        VERSION  STATUS      PID    STARTED AT
a3f9c12b4e07  b7d2e45f1c08  hello-world-agent (web)     1.0.0    🟢 running  12345  06/04/2026 20:09
c1e8f23a9d05  b7d2e45f1c08  hello-world-agent           1.0.0    ⚫ stopped  12346  05/04/2026 15:30
```

---

## 📦 Push Workflow

`lifectl ai agent push` runs the following steps automatically:

1. **Build** — runs `npm run build` (or bun/pnpm/yarn equivalent) if `package.json` has a `build` script
2. **Verify** — checks that the entrypoint declared in `agent.json` (`main`) exists after build
3. **Pack** — creates a `.tar.gz` of the project (respecting `.agentignore`)
4. **Upload** — pushes the bundle to the registry

The built `dist/` is included in the bundle so hosts can run the agent immediately after pull.

---

## ▶️ Run Workflow

`lifectl ai agent run` runs the following steps:

1. **Compatibility check** — calls `/agents/info?host=node` to verify the agent supports the Node.js host
2. **Pull** — downloads the agent bundle if not already local
3. **Install dependencies** — runs `npm install` once per version to get `node_modules` (agent-runtime binary + external deps like playwright)
4. **Start** — spawns `agent-runtime` as a detached background process

> **No build step at run time** — `dist/index.js` is already built and included in the bundle from `push`.

---

## 🔍 Capabilities & Compatibility

Before pulling an agent, lifectl checks if the agent is compatible with the Node.js host by calling `/agents/info?host=node`.

Agents declare their required capabilities in `agent.json`:

```json
{
  "capabilities": {
    "system": {
      "required": true,
      "features": ["fs", "browser-automation"]
    }
  }
}
```

| Capability | Node host |
|---|---|
| `ai.chat` | ✅ |
| `ai.image` | ✅ |
| `ai.video` | ✅ |
| `system.fs` | ✅ |
| `system.browser-automation` | ✅ |

Agents with no `capabilities` field are compatible with all hosts.

If an agent requires capabilities the host does not support, `pull` and `run` will fail with a clear error message.

---

## 🏗 Architecture

```
~/.lifectl/
  agents/
    registry.json          ← local agent registry
    <name>/<version>/      ← extracted agent bundle
      agent.json
      package.json
      dist/index.js        ← pre-built bundle (from push)
      node_modules/        ← installed at run time
      .install.lock        ← prevents concurrent installs
  containers/
    containers.json        ← container registry
    <containerId>/
      agent.pid
      agent.log
      agent.log.1          ← rotated logs
```

**Concepts:**

* **Agent bundle** — pre-built `.tar.gz` containing `dist/` (no `node_modules`)
* **Container** — a running instance of an agent (one process per container)
* **agent-runtime** — the Node.js process runner from `@lifetimesoft/agent-sdk`

---

## 📦 Package Manager Detection

Dependencies are installed automatically based on the lock file in the agent directory:

| Lock file | Package manager |
|---|---|
| `bun.lockb` | `bun install` |
| `pnpm-lock.yaml` | `pnpm install` |
| `yarn.lock` | `yarn install` |
| `package-lock.json` | `npm install` |
| *(none)* | `npm install` (fallback) |

---

## 🛣 Roadmap

* [x] CLI foundation
* [x] Authentication (device flow)
* [x] Agent registry (push/publish)
* [x] Auto-build on push
* [x] Capabilities-based compatibility check
* [x] Agent pull system
* [x] Versioned agents
* [x] Local agent registry
* [x] Agent runtime (local execution)
* [x] Container model (run/start/stop/ps/rm)
* [x] Log rotation
* [x] Multi-container per agent
* [x] Named containers
* [x] Container filtering
* [x] Auto package manager detection (bun/pnpm/yarn/npm)
* [x] SaaS integration (ctx, WebSocket heartbeat, lifecycle)
* [x] Scheduler support (none / interval / cron)
* [x] Manual trigger and config hot-reload via platform dashboard
* [ ] Sandbox execution

---

## 🔐 Security

* Token-based authentication
* Shell metacharacter blocking
* Path traversal protection
* PID validation before kill
* PID reuse detection (Linux)
* Atomic install lock (prevents concurrent installs)
* Atomic container writes (prevents corruption)

---

## 🤝 Contributing

```bash
git clone https://github.com/lifetimesoft/lifectl
cd lifectl
npm install
npm run build
```

---

## 📄 License

Apache-2.0 license

---

## 🌐 Lifetimesoft

* [`@lifetimesoft/agent-sdk`](https://www.npmjs.com/package/@lifetimesoft/agent-sdk) — SDK for building portable AI agents
* [`chrome-extension-host`](https://github.com/Lifetimesoft/chrome-extension-host) — Chrome Extension Host for browser-based agents

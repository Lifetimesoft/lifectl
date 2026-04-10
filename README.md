# lifectl

> Run AI agents like running containers.

**lifectl** is a CLI tool for pulling, running, and managing AI agents — locally or from a remote registry.

---

## ✨ Features

* 📦 Pull agents from registry
* ▶️ Run agents locally
* 🧠 Plug-and-play agent system
* 🔐 Secure authentication via SaaS
* ⚡ Lightweight and fast
* 🔄 Versioned agents

---

## 🚀 Quick Start

### Install

```bash
npm install -g lifectl
```

---

## 📚 Commands

### Auth

```bash
lifectl auth login       # Login via browser
lifectl auth logout      # Logout
```

### AI Agent — Image

```bash
lifectl ai agent pull <name>          # Pull agent from registry
lifectl ai agent pull <name>:<ver>    # Pull specific version
lifectl ai agent push                 # Push agent to registry
lifectl ai agent list                 # List pulled agents
lifectl ai agent rma <name>           # Remove agent (all versions)
lifectl ai agent rma <name>:<ver>     # Remove specific version
```

### AI Agent — Container

```bash
lifectl ai agent run <name>           # Run agent (pull if needed, create new container)
lifectl ai agent run <name>:<ver>     # Run specific version
lifectl ai agent ps                   # List all containers
lifectl ai agent start <containerId>  # Start a stopped container
lifectl ai agent stop <name>          # Stop container by name
lifectl ai agent stop <containerId>   # Stop container by id
lifectl ai agent restart <name>       # Restart container by name
lifectl ai agent restart <containerId># Restart container by id
lifectl ai agent rm <containerId>     # Remove a stopped container
lifectl ai agent logs <name>          # Show last 50 lines of log
lifectl ai agent logs <containerId>   # Show logs by container id
lifectl ai agent logs <name> -n 100   # Show last N lines
lifectl ai agent logs <name> -f       # Follow log output
```

#### Example output of `list`

```
AGENT ID      NAME               VERSION  RUNTIME  PULLED AT
a3f9c12b4e07  hello-world-agent  1.0.0    node     06/04/2026 20:09
b7d2e45f1c08  my-other-agent     2.1.0    python   05/04/2026 15:30
```

#### Example output of `ps`

```
CONTAINER ID  AGENT ID      NAME               VERSION  STATUS      PID    STARTED AT
a3f9c12b4e07  b7d2e45f1c08  hello-world-agent  1.0.0    🟢 running  12345  06/04/2026 20:09
c1e8f23a9d05  b7d2e45f1c08  hello-world-agent  1.0.0    ⚫ stopped  12346  05/04/2026 15:30
```

#### Allowed runtimes

Agents can only use these runtimes in `agent.json` scripts:

```
node  python  python3  deno  bun  npx  ts-node  tsx
```

---

## 🏗 Architecture

```
~/.lifectl/
  agents/
    registry.json          ← image registry
    <name>/<version>/      ← agent files
  containers/
    containers.json        ← container registry
    <containerId>/         ← per-process folder
      agent.pid
      agent.log
```

* **lifectl CLI** → control agents
* **Agent Registry** → store & version agents
* **Container Runtime** → isolated process per run
* **SaaS Platform** → monitoring & management

---

## 🛣 Roadmap

* [x] CLI foundation
* [x] Authentication (device flow)
* [x] Agent registry (push/publish)
* [x] Agent pull system
* [x] Versioned agents
* [x] Local agent registry (registry.json)
* [x] Agent runtime (local execution)
* [x] Agent process manager (PID-based)
* [x] Docker-style container model (run/start/stop/ps/rm)
* [x] Agent image management (list/rma)
* [x] Log rotation
* [x] Multi-container per agent
* [ ] SaaS dashboard integration
* [ ] Multi-agent workflows
* [ ] Agent environment variables support
* [ ] Run agent on sandbox

---

## 🔐 Security

* Token-based authentication
* No credentials stored in plain text
* Runtime whitelist — only `node`, `python`, `python3`, `deno`, `bun`, `npx`, `ts-node`, `tsx` are allowed
* PID reuse detection — verifies process start time before kill (Linux)
* tar path traversal protection — blocks `..` entries during agent extraction
* Shell metacharacter blocking — `;`, `&`, `|`, `` ` ``, `$`, `<`, `>`
* Path traversal protection — agents are isolated under `~/.lifectl/agents/`
* PID validation before kill — prevents stale or invalid PID attacks

---

## 🧪 Status

> ⚠️ This project is in early development.

APIs and features may change.

---

## 🤝 Contributing

Contributions are welcome!

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

## 🌐 LifetimeSoft

Building tools for AI automation and agent-based systems.

---

## ⭐ Support

If you find this project useful, consider giving it a star ⭐

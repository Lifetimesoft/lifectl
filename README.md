# lifectl

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

---

## 🚀 Quick Start

### Install

```bash
npm install -g lifectl
```

### Run your first agent

```bash
lifectl auth login
lifectl ai agent run hello-world-agent
lifectl ai agent ps
```

---

## 🧩 CLI Structure

lifectl is organized into apps and sub-commands:

```bash
lifectl <app> <sub-app> <command>
```

### Apps

* `auth` → Authentication
* `ai` → AI services

### Example

```bash
lifectl auth login
lifectl ai agent run hello-world
```

---

## 🤖 AI Module

### Agent — Image Management

```bash
lifectl ai agent pull <name>          # Pull agent from registry
lifectl ai agent pull <name>:<ver>    # Pull specific version
lifectl ai agent push                 # Push agent to registry
lifectl ai agent list                 # List pulled agents
lifectl ai agent rma <name>           # Remove agent (all versions)
lifectl ai agent rma <name>:<ver>     # Remove specific version
```

---

### Agent — Container Management

```bash
lifectl ai agent run <name>                      # Run agent (pull if needed)
lifectl ai agent run <name>:<ver>                # Run specific version
lifectl ai agent run <name> --name <alias>       # Run with a custom container name

lifectl ai agent ps                              # List all containers
lifectl ai agent ps --name <name>                # Filter by agent name or alias
lifectl ai agent ps --status running             # Filter by status
lifectl ai agent ps --name <name> --status stopped

lifectl ai agent start <containerId>             # Start a stopped container
lifectl ai agent stop <name|alias|containerId>   # Stop a container
lifectl ai agent restart <name|alias|containerId># Restart a container
lifectl ai agent rm <containerId>                # Remove a stopped container

lifectl ai agent logs <name|alias|containerId>   # Show logs
lifectl ai agent logs <name> -n 100              # Show last N lines
lifectl ai agent logs <name> -f                  # Follow logs
```

---

### Named containers

Assign a custom name to a container for easier management:

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

---

### Example output of `ps`

```
CONTAINER ID  AGENT ID      NAME                        VERSION  STATUS      PID    STARTED AT
a3f9c12b4e07  b7d2e45f1c08  hello-world-agent (web)     1.0.0    🟢 running  12345  06/04/2026 20:09
c1e8f23a9d05  b7d2e45f1c08  hello-world-agent           1.0.0    ⚫ stopped  12346  05/04/2026 15:30
```

---

### Allowed runtimes

Agents can only use these runtimes in `agent.json` scripts:

```
node  python  python3  deno  bun  npx  ts-node  tsx
```

---

## 🏗 Architecture

```
~/.lifectl/
  agents/
    registry.json          ← agent registry (local)
    <name>/<version>/      ← agent files
      agent.json
      .install.lock        ← prevents concurrent installs
  containers/
    containers.json        ← container registry
    <containerId>/         ← per-process folder
      agent.pid
      agent.log
      agent.log.1          ← rotated logs
```

**Concepts:**

* **lifectl CLI** → entry point for all apps
* **Agent Registry** → stores versioned agents
* **Container Runtime** → runs agents as isolated processes
* **SaaS Platform** → authentication & future services

---

## 🔮 Future Apps

lifectl is designed as a modular CLI platform.

Upcoming apps:

* `deploy` → Deploy applications
* `logs` → Centralized logging
* `billing` → Usage and cost management

---

## 🛣 Roadmap

* [x] CLI foundation
* [x] Authentication (device flow)
* [x] Agent registry (push/publish)
* [x] Agent pull system
* [x] Versioned agents
* [x] Local agent registry
* [x] Agent runtime (local execution)
* [x] Container model (run/start/stop/ps/rm)
* [x] Log rotation
* [x] Multi-container per agent
* [x] Named containers
* [x] Container filtering
* [ ] SaaS dashboard integration
* [ ] Multi-agent workflows
* [ ] Environment variables support
* [ ] Sandbox execution

---

## 🔐 Security

* Token-based authentication
* Runtime whitelist enforcement
* Shell metacharacter blocking
* Path traversal protection
* PID validation before kill
* PID reuse detection (Linux)
* Atomic install lock (prevents concurrent install)
* Atomic container writes (prevents corruption)

---

## 🧪 Status

> ⚠️ This project is in early development.

APIs and features may change.

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

Building tools for AI automation and agent-based systems.

---

## ⭐ Support

If you find this project useful, consider giving it a star ⭐

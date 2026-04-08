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

### AI Agent

```bash
lifectl ai agent pull <name>          # Pull agent from registry
lifectl ai agent push                 # Push agent to registry
lifectl ai agent start <name>         # Start latest version
lifectl ai agent start <name>:<ver>   # Start specific version
lifectl ai agent stop <name>          # Stop latest version
lifectl ai agent stop <name>:<ver>    # Stop specific version
lifectl ai agent list                 # List installed agents
```

#### Example output of `list`

```
STATUS      NAME               VERSION  RUNTIME  INSTALLED  PULLED AT
🟢 running  hello-world-agent  1.0.0    node     no         06/04/2026 20:09
⚫ stopped  my-other-agent     2.1.0    python   no         05/04/2026 15:30
```

#### Allowed runtimes

Agents can only use these runtimes in `agent.json` scripts:

```
node  python  python3  deno  bun
```

---

## 🏗 Architecture

* **lifectl CLI** → control agents
* **Agent Registry** → store & version agents
* **Agent Runtime** → execute agents safely
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
* [ ] SaaS dashboard integration
* [ ] Multi-agent workflows
* [ ] Show logs when starting agent
* [ ] Agent environment variables support
* [ ] Run agent on sandbox

---

## 🔐 Security

* Token-based authentication
* No credentials stored in plain text
* Runtime whitelist — only `node`, `python`, `python3`, `deno`, `bun` are allowed
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

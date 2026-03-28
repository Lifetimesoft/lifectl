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
* 🔄 Versioned agents (coming soon)

---

## 🚀 Quick Start

### Install

```bash
npm install -g lifectl
```

---

### Login

```bash
lifectl auth login
```

---

> ⚠️ `pull` and `run` commands are not yet available. See [Roadmap](#-roadmap).

---

## 📚 Commands

```bash
lifectl auth login       # Login via browser
lifectl auth logout      # Logout

lifectl pull <agent>     # Download agent
lifectl run <agent>      # Run agent
lifectl stop <agent>     # Stop agent

lifectl ps               # List running agents
lifectl list             # List installed agents
lifectl rm <agent>       # Remove agent

lifectl push <agent>     # Publish agent (coming soon)
lifectl help             # Show help
```

---

## 🧠 What is an Agent?

An **Agent** is a self-contained unit of code that can:

* Receive input
* Use tools (AI, browser, API, etc.)
* Execute tasks automatically

Example:

```js
export default async function run(ctx) {
    const result = await ctx.llm.generate({
        prompt: "Write a comment about Bitcoin"
    });

    await ctx.browser.postComment(result);
}
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
* [ ] Agent pull system
* [ ] Agent runtime (local execution)
* [ ] Agent process manager
* [ ] Agent registry (push/publish)
* [ ] SaaS dashboard integration
* [ ] Multi-agent workflows

---

## 🔐 Security

* Token-based authentication
* No credentials stored in plain text
* Sandboxed agent execution (planned)

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
npm run dev
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

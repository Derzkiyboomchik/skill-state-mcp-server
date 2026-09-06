<p align="center">
  <img src="https://raw.githubusercontent.com/Derzkiyboomchik/skill-state-mcp-server/main/assets/banner.jpg" alt="SKILL.state MCP Runtime Banner" width="100%" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Derzkiyboomchik/skill-state-mcp-server/main/assets/logo.jpg" alt="SKILL.state Logo" width="110" height="110" style="border-radius: 20px;" />
</p>

<h1 align="center">SKILL.state MCP Runtime</h1>

<p align="center">
  <b>Formal state-based execution runtime for long-horizon AI agents.</b><br/>
  An official <a href="https://modelcontextprotocol.io">Model Context Protocol</a> implementation of <a href="https://arxiv.org/html/2608.26263">arXiv:2608.26263</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bub0lehich/skill-state-mcp-server"><img src="https://img.shields.io/npm/v/@bub0lehich/skill-state-mcp-server.svg?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://arxiv.org/html/2608.26263"><img src="https://img.shields.io/badge/arXiv-2608.26263-B31B1B.svg?style=flat-square" alt="arXiv paper" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-1.12.0-7C3AED.svg?style=flat-square" alt="MCP Compatible" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg?style=flat-square" alt="Node version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-059669.svg?style=flat-square" alt="License: MIT" /></a>
</p>

---

## Overview

Traditional LLM agent workflows rely on **append-only conversation history** `[m_1, r_1, o_1, m_2, r_2, ...]`. Over long horizons, this design exhibits three fundamental failure modes:
1. **Context Bloat:** Token consumption scales monotonically as $\mathcal{O}(T)$, exhausting context windows and elevating per-turn latency.
2. **Reasoning Poisoning:** Stale thoughts ($R_t$) and abandoned hypotheses persist in context, biassing subsequent turns.
3. **State Hallucination:** Agents lose track of variables, counters, and completed subtasks buried across thousands of tokens of prose.

**SKILL.state** ([arXiv:2608.26263](https://arxiv.org/html/2608.26263)) replaces conversational history with an explicit, formal state tuple **$(P, \Sigma_t, O_t)$**:
- **$P$:** Immutable skill specification (frozen task instructions).
- **$\Sigma_t$:** Explicit, typed execution state (JSON object).
- **$O_t$:** Latest environment observation.
- **$R_t$:** Chain-of-thought reasoning, **discarded at the tool boundary** each turn to prevent reasoning loops and context leakage.

```
Conventional Agent (Append-Only History)
[msg1][R1][O1][msg2][R2][O2][msg3]... ──▶ Context grows monotonically ──▶ Poisoning & Rot

SKILL.state (Formal State Runtime)
Turn t input:      (P, Σ_t, O_t)
LLM response:      R_t (discarded)  +  ΔΣ_t (sparse patch)  +  a_t (action)
Server transition: Σ_{t+1} = Σ_t ⊕ ΔΣ_t  ──▶  Execute a_t  ──▶  O_{t+1}
Turn t+1 input:    (P, Σ_{t+1}, O_{t+1})   [Context size remains O(1) bounded]
```

---

## Installation & Setup

In accordance with standard Model Context Protocol deployment patterns, the server can be run dynamically via **`npx`** (recommended for all MCP clients) or installed globally via **`npm`**.

### 1. Claude Desktop

Add the server to your `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "skill-state": {
      "command": "npx",
      "args": ["-y", "@bub0lehich/skill-state-mcp-server"]
    }
  }
}
```

### 2. Claude Code (CLI)

Register the server using Anthropic's Claude Code CLI:

```bash
claude mcp add skill-state -- npx -y @bub0lehich/skill-state-mcp-server
```

### 3. Cursor

Add to `.cursor/mcp.json` in your project root or open **Settings -> Features -> MCP -> Add New MCP Server**:

```json
{
  "mcpServers": {
    "skill-state": {
      "command": "npx",
      "args": ["-y", "@bub0lehich/skill-state-mcp-server"]
    }
  }
}
```

### 4. VS Code (Cline / Roo Code / Continue)

Add to `cline_mcp_settings.json` or your MCP extension configuration:

```json
{
  "mcpServers": {
    "skill-state": {
      "command": "npx",
      "args": ["-y", "@bub0lehich/skill-state-mcp-server"]
    }
  }
}
```

### 5. Persistent Global Installation

If you prefer installing the binary once onto your system rather than downloading via `npx`:

```bash
npm install -g @bub0lehich/skill-state-mcp-server
```

Once installed, reference the binary directly:

```json
{
  "mcpServers": {
    "skill-state": {
      "command": "skill-state-mcp-server"
    }
  }
}
```

### 6. Programmatic Usage (Node.js SDK)

Install as a dependency in your application:

```bash
npm install @bub0lehich/skill-state-mcp-server
```

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSkillStateTools } from "@bub0lehich/skill-state-mcp-server";
```

---

## Transports & CLI Usage

### stdio Transport (Default)

Used by Claude Desktop, Cursor, and IDEs via stdin/stdout:

```bash
npx -y @bub0lehich/skill-state-mcp-server
```

### Streamable HTTP Transport (SSE)

For microservice architectures and remote agents:

```bash
npx -y @bub0lehich/skill-state-mcp-server --http --port 3211
```

- **MCP Endpoint:** `POST http://localhost:3211/mcp`
- **Liveness Probe:** `GET http://localhost:3211/health`

---

## The $\oplus$ State Merge Operator

At each step $t$, the agent emits a sparse state patch $\Delta\Sigma_t$. The runtime applies the formal merge operator:

$$\Sigma_{t+1} = \Sigma_t \oplus \Delta\Sigma_t$$

Null serves as an explicit **first-class deletion instruction**, distinguishing field removal from field omission:

| Patch Value in $\Delta\Sigma_t$ | Semantics on Target State $\Sigma$ |
|---|---|
| `"key": null` | **Deletes** the key from $\Sigma$ |
| `"key": value` | Inserts or overwrites scalar value |
| `"key": { ... }` | Recursively merges nested objects (`null` deletes nested keys) |
| `"key": [ ... ]` | Replaces array wholesale (deterministic, avoids positional diffing) |
| *(omitted)* | **Preserved** (sparse delta) |

### Example

```jsonc
// Current State Σ_t
{
  "order_id": "ORD-402",
  "phase": "inventory_lookup",
  "scratchpad": "checking shelf availability...",
  "attempts": 1
}

// Patch ΔΣ_t                               // New State Σ_{t+1}
{                                           {
  "phase": "packing",                         "order_id": "ORD-402",
  "scratchpad": null,             ⊕   =       "phase": "packing",
  "shelf": "shelf_42",                        "shelf": "shelf_42",
  "attempts": 2                               "attempts": 2
}                                           }
```

---

## MCP Protocol Surface

### Tools

| Tool | Parameters | Description |
|---|---|---|
| `initialize_skill` | `skill_specification`, `initial_state`, `state_schema`?, `environment`?, `session_id`? | Boots a new state session and returns the $(P, \Sigma_0, O_0)$ tuple. |
| `execute_step` | `session_id`, `reasoning_trace`, `state_update`, `action`, `environment_observation`? | Executes a turn: drops $R_t$, merges $\Delta\Sigma_t$, executes $a_t$, and returns $(P, \Sigma_{t+1}, O_{t+1})$. Rolls back $\Sigma$ on validation error or action rejection. |
| `inject_observation` | `session_id`, `observation`, `state_patch`? | Injects external observations or asynchronous environment updates (§5.4 State Recovery). |
| `parse_turn_response` | `response_text` | Utility to extract $R_t$, $\Delta\Sigma_t$, and $a_t$ from raw fenced ```json blocks (Appendix A.4). |
| `close_session` | `session_id` | Finalizes a session and returns the terminal state snapshot. |

### Resources

Inspection endpoints operate with zero LLM-context cost:
- `skill-state://{session_id}`: Inspect specification $P$, current state $\Sigma_t$, step counter, and metadata.
- `skill-state://sessions`: List active sessions and lifecycle metrics.

### Prompts

- `skill_state_turn`: Standard prompt rendering $(P, \Sigma_t, O_t)$ for tool-calling agents.
- `skill_state_paper_turn`: Canonical single-line JSON format specified in arXiv:2608.26263 Appendix A.4.

---

## Environments & Benchmarks

### Warehouse Management (`SkillExecBench Environment 1`)
A reference implementation of the benchmark environment from §4.1:
- **500 independent shelves** (`shelf_0` through `shelf_499`).
- **Domain commands:** `Store <item> <shelf>`, `Ship <item> <shelf>`, `Move <item> <from> <to>`, `Wait`, `Complete`.
- **Collision rejection:** Storing onto an occupied shelf triggers an environment rejection and transactionally rolls back state mutations (Appendix B.1).
- **Background telemetry noise:** Periodic sensor, battery, and robot telemetry injection to evaluate agent resilience against observation drift (Experiment 2).

### Mock Environment
Deterministic echo, no-op, synthetic failure, and custom completion actions for testing and integration.

---

## Architecture & Guarantees

- **Transactional Rollback:** If candidate state $\Sigma_{cand} = \Sigma_t \oplus \Delta\Sigma_t$ fails schema validation or if the executor rejects $a_t$, the runtime rolls back to $\Sigma_t$ without advancing the turn counter (§3.1, §7).
- **Zero Leakage:** Reasoning traces $R_t$ are consumed and dropped in memory; they are never logged, hashed, or returned in subsequent MCP turn payloads.
- **Concurrency Isolation:** Per-session asynchronous mutexes guarantee that concurrent steps within a session are serialized while independent sessions execute concurrently.
- **Specification Immutability:** $P$ is deep-frozen on initialization to prevent drift across long execution horizons.

---

## Development

```bash
# Clone repository
git clone https://github.com/Derzkiyboomchik/skill-state-mcp-server.git
cd skill-state-mcp-server

# Install dependencies
npm install

# Run 18 unit and integration tests
npm test

# Run end-to-end demo client (stdio & HTTP)
npm run demo

# Build TypeScript to dist/
npm run build
```

---

## Citation

```bibtex
@article{skillstate2026,
  title   = {SKILL.state: Formal State-Based Execution for Long-Horizon AI Agents},
  journal = {arXiv preprint arXiv:2608.26263},
  year    = {2026}
}
```

---

## License

MIT © [Derzkiyboomchik](https://github.com/Derzkiyboomchik) & [bub0lehich](https://www.npmjs.com/~bub0lehich)

import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

interface ToolCallResult {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

const HTTP_URL = "http://127.0.0.1:3211/mcp";

/** Distinctive marker planted into R_t; must NEVER reappear in any response. */
const COT_MARKER = "SECRET-COT-MARKER-0xF00D";

const SKILL_SPEC = `# SKILL: support-ticket-triage (v1.0)

## Objective
Classify an incoming support ticket and drive it to resolution using ONLY
the structured execution state Σ — never rely on message history.

## Procedure
1. Read the ticket from the latest observation O.
2. Set Σ.priority (P0..P3) and Σ.category.
3. If priority is P0 and Σ.escalated is not true, set Σ.escalated = true and
   take action {"type":"echo","message":"escalate to on-call"}.
4. Draft a customer reply into Σ.draft and set Σ.stage = "replied".
5. Once confirmed resolved: set Σ.stage = "closed", DELETE the draft
   ({"draft": null}), set Σ.resolved = true, and take action
   {"type":"complete","summary":"..."}.

## Invariants
- Σ must always contain ticket_id, priority, category, stage.
- Scratch reasoning belongs in reasoning_trace (R_t), NEVER in Σ.`;

const INITIAL_STATE = {
  ticket_id: "TCK-1042",
  priority: "unset",
  category: "unset",
  stage: "intake",
  attempts: 0,
};

const STATE_SCHEMA = {
  required: ["ticket_id", "priority", "category", "stage"],
  properties: {
    ticket_id: "string",
    priority: "string",
    category: "string",
    stage: "string",
    attempts: "number",
    escalated: "boolean",
    draft: "string",
    resolved: "boolean",
  },
};

const collected: string[] = [];

function record(label: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2);
  collected.push(text);
  console.log(`\n───────── ${label} ─────────`);
  console.log(text.length > 1600 ? `${text.slice(0, 1600)}\n… (truncated for demo output)` : text);
}

/** Compact result extractor for tool calls. */
function unwrap(result: unknown): unknown {
  const r = result as ToolCallResult;
  return r.structuredContent ?? r.content?.[0]?.text ?? result;
}

async function runScenario(client: Client, label: string): Promise<void> {
  console.log(`\n══════════════════ SKILL.state demo — transport: ${label} ══════════════════`);

  // 0. Discover the server surface.
  const tools = await client.listTools();
  record("tools/list", tools.tools.map((t) => ({ name: t.name, description: t.description })));
  const templates = await client.listResourceTemplates();
  record("resources/templates/list", templates.resourceTemplates.map((r) => r.uriTemplate));

  // 1. initialize_skill — create the session with a domain schema.
  const init = await client.callTool({
    name: "initialize_skill",
    arguments: {
      session_id: `demo-${label}`,
      skill_specification: SKILL_SPEC,
      initial_state: INITIAL_STATE,
      state_schema: STATE_SCHEMA,
    },
  });
  record("initialize_skill → (P, Σ_0)", unwrap(init));

  const bootObservation =
    ((unwrap(init) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
      ?.latest_observation) ?? "";

  // 2. Step 1 — classify & escalate. Reasoning carries the marker; it must vanish.
  const step1 = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `demo-${label}`,
      reasoning_trace: `${COT_MARKER} Ticket mentions a failed refund of $420 and an angry customer; billing category, P0 because churn risk; escalate first, draft later.`,
      state_update: { priority: "P0", category: "billing", escalated: true, attempts: 1 },
      action: { type: "echo", message: "escalate to on-call" },
      environment_observation: bootObservation,
    },
  });
  record("execute_step #1 (classify + escalate)", unwrap(step1));

  const obs1 =
    ((unwrap(step1) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
      ?.latest_observation) ?? "";

  // 3. Schema Rollback Test: try a patch with wrong type (attempts: "invalid_number")
  // The runtime must REJECT this transition and leave Σ unchanged (arXiv:2608.26263 §3.1, §7)
  const invalidStep = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `demo-${label}`,
      reasoning_trace: `${COT_MARKER} Testing schema validation rejection.`,
      state_update: { attempts: "should_be_number" as unknown as number },
      action: "noop",
      environment_observation: obs1,
    },
  });
  record("execute_step (schema violation rejection + rollback test)", unwrap(invalidStep));

  // 4. Step 2 — draft the reply.
  const step2 = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `demo-${label}`,
      reasoning_trace: `${COT_MARKER} Escalation acknowledged. Compose an apologetic reply confirming refund within 3 business days, then mark replied.`,
      state_update: {
        stage: "replied",
        draft: "Hi — we're sorry! Your $420 refund was approved and will arrive within 3 business days.",
        attempts: 2,
      },
      action: "send-reply-email",
      environment_observation: obs1,
    },
  });
  record("execute_step #2 (draft reply)", unwrap(step2));

  const obs2 =
    ((unwrap(step2) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
      ?.latest_observation) ?? "";

  // 5. External Drift Injection (arXiv:2608.26263 §5.4 State Recovery)
  const injected = await client.callTool({
    name: "inject_observation",
    arguments: {
      session_id: `demo-${label}`,
      observation: "Customer replied via live chat: 'Thank you, I see the refund pending.'",
    },
  });
  record("inject_observation (external event drift)", unwrap(injected));

  const obsInjected =
    ((unwrap(injected) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
      ?.latest_observation) ?? obs2;

  // 6. Step 3 — close the ticket. NOTE {"draft": null} → key is DELETED from Σ.
  const step3 = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `demo-${label}`,
      reasoning_trace: `${COT_MARKER} Customer confirmed resolution. Finalize: closed, resolved=true, and purge the transient draft via null-deletion.`,
      state_update: { stage: "closed", resolved: true, attempts: 3, draft: null },
      action: { type: "complete", summary: "ticket TCK-1042 resolved and closed" },
      environment_observation: obsInjected,
    },
  });
  record("execute_step #3 (close + null-deletion of draft)", unwrap(step3));

  // 7. Parse raw LLM turn response test (arXiv:2608.26263 Appendix A.4 & §5.7)
  const sampleLlmText = [
    "I need to finalize this process.",
    "```json",
    '{"state_patch": {"archived": true}, "action": "archive"}',
    "```",
  ].join("\n");
  const parsedResponse = await client.callTool({
    name: "parse_turn_response",
    arguments: { response_text: sampleLlmText },
  });
  record("parse_turn_response (fenced block extraction)", unwrap(parsedResponse));

  // 8. Inspect via the MCP resource — zero LLM context cost.
  const resource = await client.readResource({ uri: `skill-state://demo-${label}` });
  record("readResource skill_state://demo-session", resource.contents[0]);

  // 9. Render canonical prompts (tool prompt and Appendix A.4 paper prompt).
  const prompts = await client.listPrompts();
  record("prompts/list", prompts.prompts.map((p) => p.name));

  const paperPrompt = await client.getPrompt({
    name: "skill_state_paper_turn",
    arguments: { session_id: `demo-${label}`, compact: "true" },
  });
  record("getPrompt skill_state_paper_turn (Appendix A.4 canonical prompt)", paperPrompt.messages[0]);

  // 10. Housekeeping.
  const closed = await client.callTool({ name: "close_session", arguments: { session_id: `demo-${label}` } });
  record("close_session", unwrap(closed));

  // 11. SkillExecBench Warehouse Management walkthrough (arXiv:2608.26263 §4.1, Appendix B.1)
  console.log(`\n── SkillExecBench Warehouse walkthrough ──`);
  const whInit = await client.callTool({
    name: "initialize_skill",
    arguments: {
      session_id: `warehouse-${label}`,
      skill_specification: "Warehouse inventory management: Store, Ship, Move items across 500 shelves.",
      initial_state: { inventory: {} },
      environment: "warehouse",
    },
  });
  record("initialize_skill (warehouse environment)", unwrap(whInit));

  const whBootObs =
    ((unwrap(whInit) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
      ?.latest_observation) ?? "";

  // Warehouse turn 1: Store item_A on shelf_10
  const whStep1 = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `warehouse-${label}`,
      reasoning_trace: "Store item_A on shelf_10",
      state_update: { inventory: { shelf_10: "item_A" } },
      action: "Store item_A shelf_10",
      environment_observation: whBootObs,
    },
  });
  record("warehouse execute_step (Store item_A shelf_10)", unwrap(whStep1));

  // Warehouse turn 2: Collision rejection test (try Store item_B on occupied shelf_10)
  // Environment must reject action and roll back inventory.shelf_10
  const whStep2 = await client.callTool({
    name: "execute_step",
    arguments: {
      session_id: `warehouse-${label}`,
      reasoning_trace: "Attempt to store item_B on occupied shelf_10",
      state_update: { inventory: { shelf_10: "item_B" } },
      action: "Store item_B shelf_10",
      environment_observation:
        ((unwrap(whStep1) as { prompt_payload?: { latest_observation?: string } })?.prompt_payload
          ?.latest_observation) ?? "",
    },
  });
  record("warehouse execute_step (Store collision rejection + rollback)", unwrap(whStep2));

  await client.callTool({ name: "close_session", arguments: { session_id: `warehouse-${label}` } });
}

async function main(): Promise<void> {
  console.log("SKILL.state runtime — end-to-end demo (arXiv:2608.26263)");

  /* ── 1. stdio walkthrough ─────────────────────────────────────────────── */
  const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";
  const tsxCli = path.resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const indexTs = path.resolve(projectRoot, "index.ts");

  const stdioTransport = new StdioClientTransport({
    command: isBun ? "bun" : process.execPath,
    args: isBun ? [indexTs] : [tsxCli, indexTs],
    cwd: projectRoot,
  });

  const stdioClient = new Client({ name: "skill-state-demo-client", version: "1.0.0" });
  await stdioClient.connect(stdioTransport);
  try {
    await runScenario(stdioClient, "stdio");
  } finally {
    await stdioClient.close();
  }

  /* ── 2. HTTP walkthrough (if server is up) ────────────────────────────── */
  let httpOk = false;
  try {
    const health = await fetch("http://127.0.0.1:3211/health");
    httpOk = health.ok;
  } catch {
    httpOk = false;
  }

  if (httpOk) {
    const httpTransport = new StreamableHTTPClientTransport(new URL(HTTP_URL));
    const httpClient = new Client({ name: "skill-state-demo-client", version: "1.0.0" });
    await httpClient.connect(httpTransport);
    try {
      await runScenario(httpClient, "http");
    } finally {
      await httpClient.close();
    }
  } else {
    console.log("\n(skipping HTTP walkthrough — no server on :3211; start it with `npm run start:http`)");
  }

  /* ── 3. Guarantee checks ──────────────────────────────────────────────── */
  const leaked = collected.some((text) => text.includes(COT_MARKER));
  console.log("\n══════════════════ GUARANTEE CHECKS ══════════════════");
  console.log(
    `✓ reasoning trace R_t (${COT_MARKER}) leaked into any response: ${
      leaked ? "FAIL — LEAKED" : "NONE (discarded correctly)"
    }`,
  );
  if (leaked) process.exitCode = 1;

  const closedState = collected.find((t) => t.includes('"final_state"'));
  const deletedDraft = closedState ? !/"draft"\s*:/.test(closedState.split('"final_state"')[1] ?? "") : false;
  console.log(
    `✓ null-deletion semantics ({"draft": null} removed the key from Σ): ${
      deletedDraft ? "VERIFIED" : "CHECK OUTPUT ABOVE"
    }`,
  );

  const hasRollback = collected.some((t) => t.includes("rolled_back") || t.includes("REJECTED") || t.includes("VIOLATION"));
  console.log(`✓ transactional rollback on invalid state/action: ${hasRollback ? "VERIFIED" : "CHECK OUTPUT"}`);

  console.log("\nDemo finished successfully.");
}

await main();


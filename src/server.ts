/**
 * SKILL.state — MCP server surface.
 *
 * Exposes the runtime to MCP clients via:
 *
 *   TOOLS
 *     - initialize_skill : create a session, returns the initial (P, Σ_0) payload.
 *     - execute_step     : one full step — discard R_t, apply ΔΣ_t via ⊕,
 *                          execute a_t, return the strict next-turn tuple
 *                          (P, Σ_{t+1}, O_{t+1}).
 *     - close_session    : remove a session (housekeeping).
 *
 *   RESOURCES (zero LLM-context cost — for developers & inspectors)
 *     - skill-state://{session_id} : live P + Σ + metadata of one session.
 *     - skill-state://sessions     : index of all active sessions.
 *
 *     NOTE: the paper writes this URI as `skill_state://`, but underscores are
 *     ILLEGAL in URI schemes (RFC 3986 §3.1 — scheme = ALPHA *( ALPHA / DIGIT /
 *     "+" / "-" / "." )), and the MCP SDK validates every URI as a WHATWG URL.
 *     The runtime therefore uses the RFC-compliant `skill-state://` scheme.
 *
 *   PROMPTS
 *     - skill_state_turn : renders the exact (P, Σ_t, O_t) working context for
 *                          one agent turn, for clients that want a prebuilt
 *                          message instead of raw tool JSON.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JsonObject, compactStringify, extractJsonFromFencedBlock, isPlainObject, stringify } from "./json.js";
import { SessionError, SkillSession, globalSessionStore as store } from "./state.js";
import {
  CloseSessionInputSchema,
  ExecuteStepInputSchema,
  InitializeSkillInputSchema,
  InjectObservationInputSchema,
  ParseTurnResponseInputSchema,
  SkillStatePaperTurnPromptArgsSchema,
  SkillStateTurnPromptArgsSchema,
} from "./schemas.js";

export const SERVER_INFO = { name: "skill-state-runtime", version: "1.0.0" } as const;

const SERVER_INSTRUCTIONS = [
  "You are connected to a SKILL.state runtime (arXiv:2608.26263).",
  "There is NO conversation history: at every step you receive exactly three things —",
  "the immutable skill spec P, the current execution state Σ (JSON), and the latest",
  "observation O. Keep ALL bookkeeping inside Σ via state_update (ΔΣ_t); put ALL",
  "deliberation inside reasoning_trace (R_t), which the runtime permanently discards.",
  "Never expect earlier tool results to be replayed — the prompt_payload IS your entire context.",
].join(" ");

/* ───────────────────────────── helpers ─────────────────────────────────── */

/** Wrap data as a tool result: pretty JSON text + machine-readable structuredContent. */
function jsonResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: stringify(data) }],
    structuredContent: data,
  };
}

/** Convert domain errors into isError tool results (keeps MCP clients happy). */
function errorResult(error: unknown) {
  const message =
    error instanceof SessionError
      ? error.message
      : `SKILL.state runtime error: ${error instanceof Error ? error.message : String(error)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Compact metadata block attached to every tool response. */
function metaBlock(session: SkillSession, extra: Record<string, unknown> = {}) {
  return {
    step: session.meta.stepCount,
    status: session.meta.status,
    reasoning_retained: session.meta.reasoningRetained, // always false, by design
    ...extra,
  };
}

/** Render P in a readable block, regardless of whether it is markdown or JSON. */
function renderSpec(spec: SkillSession["spec"]): string {
  return typeof spec === "string" ? spec : stringify(spec);
}

/** Render the canonical SKILL.state turn prompt for one session. */
function renderTurnPrompt(session: SkillSession): string {
  const observation = session.meta.lastObservation ?? "(no observation yet)";
  return [
    `You are executing skill session "${session.id}" under the SKILL.state protocol (arXiv:2608.26263).`,
    `There is no conversation history. Your ENTIRE working context is the tuple below.`,
    ``,
    `## P — Skill Specification (immutable)`,
    renderSpec(session.spec),
    ``,
    `## Σ_${session.meta.stepCount} — Current Execution State (step ${session.meta.stepCount}, status: ${session.meta.status})`,
    stringify(session.state),
    ``,
    `## O — Latest Environment Observation`,
    observation,
    ``,
    `## Required response format`,
    `1. R_t — reason as much as you need inside reasoning_trace (it will be DISCARDED by the runtime).`,
    `2. ΔΣ_t — a sparse JSON patch in state_update. Use null to DELETE a key, e.g. {"draft": null}.`,
    `3. a_t — the next action in the action field (string or JSON object).`,
    `Call the execute_step tool with exactly these three fields plus session_id="${session.id}"`,
    `and environment_observation set to the observation above.`,
  ].join("\n");
}

/**
 * Render the prompt strictly following arXiv:2608.26263 Appendix A.4:
 *
 *   Instructions:
 *   {skill.instructions}
 *
 *   Skill Execution State:
 *   ```json
 *   {json.dumps(state, separators=(',', ':'))}
 *   ```
 *   Latest Observation: {observation}
 */
function renderPaperTurnPrompt(session: SkillSession, compact = true): string {
  const observation = session.meta.lastObservation ?? "(no observation yet)";
  const stateStr = compact ? compactStringify(session.state) : stringify(session.state);
  return [
    `Instructions:`,
    renderSpec(session.spec),
    ``,
    `Skill Execution State:`,
    `\`\`\`json`,
    stateStr,
    `\`\`\``,
    `Latest Observation: ${observation}`,
    ``,
    `Provide your response with:`,
    ``,
    `1. Step-by-step reasoning (will be discarded after execution)`,
    `2. A JSON block fenced with json ... containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }`,
  ].join("\n");
}

/* ───────────────────────────── server factory ──────────────────────────── */

/**
 * Build a fully-configured McpServer instance.
 *
 * A fresh instance is created per transport (one for stdio, one per MCP client
 * session in HTTP mode). All instances share the process-wide SessionStore, so
 * skill sessions survive MCP reconnects and are safe across concurrent clients.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  /* ── Tool: initialize_skill ──────────────────────────────────────────── */

  server.registerTool(
    "initialize_skill",
    {
      title: "Initialize a SKILL.state session",
      description:
        "Create a new SKILL.state execution session. " +
        "Stores the immutable skill specification P and the initial execution state Σ_0, " +
        "then returns the initial prompt payload (P, Σ_0, boot observation). From this point " +
        "on, the LLM must treat that payload as its ENTIRE context — there is no message history. " +
        "Advances happen exclusively through execute_step.",
      inputSchema: InitializeSkillInputSchema,
    },
    async ({ session_id, skill_specification, initial_state, state_schema, environment }) => {
      try {
        const session = store.create(session_id, skill_specification, initial_state, {
          stateSchema: state_schema,
          environment,
        });
        return jsonResult({
          session_id: session.id,
          environment: session.environment,
          prompt_payload: {
            skill_spec: session.spec,
            current_state: session.state,
            latest_observation: session.meta.lastObservation,
          },
          meta: metaBlock(session),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* ── Tool: execute_step ──────────────────────────────────────────────── */

  server.registerTool(
    "execute_step",
    {
      title: "Execute one SKILL.state step",
      description:
        "Advance a skill session by exactly one step t → t+1. " +
        "INPUT: reasoning_trace R_t (Chain-of-Thought — discarded by the runtime and never stored), " +
        "state_update ΔΣ_t (sparse JSON patch; null deletes a key), action a_t, and the " +
        "environment_observation O_t you consumed this turn. " +
        "LOGIC: validate ΔΣ_t → apply Σ_{t+1} = Σ_t ⊕ ΔΣ_t (null-deletion semantics) → execute a_t " +
        "→ obtain observation O_{t+1}. " +
        "OUTPUT: the strict next-turn tuple {skill_spec: P, current_state: Σ_{t+1}, latest_observation: O_{t+1}}. " +
        "Nothing else is retained — no history, no reasoning, no old observations.",
      inputSchema: ExecuteStepInputSchema,
    },
    async ({ session_id, reasoning_trace, state_update, action, environment_observation }) => {
      /**
       * R_t DISCARD POINT ────────────────────────────────────────────────────
       * `reasoning_trace` is intentionally not referenced anywhere beyond this
       * `void` statement. It is never persisted, logged, hashed, echoed back,
       * or included in any subsequent prompt. This is the mechanism by which
       * SKILL.state eliminates context bloat and context poisoning.
       * ─────────────────────────────────────────────────────────────────────
       */
      void reasoning_trace;

      try {
        const { step, state, outcome, warning } = await store.runStep(session_id, {
          stateUpdate: state_update as JsonObject,
          action: action as never,
          consumedObservation: environment_observation,
        });
        const session = store.require(session_id);
        return jsonResult({
          session_id: session.id,
          step,
          prompt_payload: {
            skill_spec: session.spec,
            current_state: state,
            latest_observation: outcome.observation,
          },
          meta: metaBlock(session, {
            action_status: outcome.status,
            ...(warning ? { warning } : {}),
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* ── Tool: inject_observation ───────────────────────────────────────── */

  server.registerTool(
    "inject_observation",
    {
      title: "Inject an external observation or state change",
      description:
        "Deliver an asynchronous environment observation / event alert into an active session " +
        "(e.g. background alerts, customer orders, or external world drift per arXiv:2608.26263 §5.4). " +
        "Does not advance the step count.",
      inputSchema: InjectObservationInputSchema,
    },
    async ({ session_id, observation, state_patch }) => {
      try {
        const result = await store.injectObservation(session_id, observation, state_patch as JsonObject | undefined);
        const session = store.require(session_id);
        return jsonResult({
          session_id,
          prompt_payload: {
            skill_spec: session.spec,
            current_state: result.state,
            latest_observation: result.observation,
          },
          meta: metaBlock(session),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* ── Tool: parse_turn_response ────────────────────────────────────────── */

  server.registerTool(
    "parse_turn_response",
    {
      title: "Parse a raw LLM fenced response",
      description:
        "Parses a raw LLM response string containing free-form reasoning and a fenced ```json " +
        "block { 'state_patch': {...}, 'action': '...' } per arXiv:2608.26263 Appendix A.4. " +
        "Separates the reasoning trace R_t (for discarding) from the structured payload, " +
        "mitigating JSON syntax slips (arXiv:2608.26263 §5.7).",
      inputSchema: ParseTurnResponseInputSchema,
    },
    async ({ response_text }) => {
      const parsed = extractJsonFromFencedBlock(response_text);
      if (!parsed.ok) {
        return errorResult(`Failed to extract JSON block: ${parsed.error}`);
      }
      const block = parsed.value;
      const state_patch = isPlainObject(block.state_patch) ? block.state_patch : {};
      const action = block.action ?? "";
      // Extract reasoning trace (text outside the fenced block)
      const cleanedReasoning = response_text.replace(/```(?:json)?[\s\S]*?```/gi, "").trim();
      return jsonResult({
        reasoning_trace: cleanedReasoning || "(none)",
        state_update: state_patch,
        action,
      });
    },
  );

  /* ── Tool: close_session ─────────────────────────────────────────────── */

  server.registerTool(
    "close_session",
    {
      title: "Close a SKILL.state session",
      description:
        "Housekeeping: permanently remove a skill session and its execution state from the runtime. " +
        "Returns the final Σ snapshot for auditability before deletion.",
      inputSchema: CloseSessionInputSchema,
    },
    async ({ session_id }) => {
      try {
        const session = store.require(session_id);
        const finalState = session.state;
        const stepCount = session.meta.stepCount;
        store.close(session_id);
        return jsonResult({
          session_id,
          closed: true,
          final_step: stepCount,
          final_state: finalState,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* ── Resource: skill_state://{session_id} ────────────────────────────── */

  server.registerResource(
    "skill-session",
    new ResourceTemplate("skill-state://{session_id}", {
      list: async () => ({
        resources: store.list().map((summary) => ({
          uri: `skill-state://${summary.session_id}`,
          name: `SKILL.state session: ${summary.session_id}`,
          description: `step ${summary.step_count} · ${summary.status} · keys: ${summary.state_keys.join(", ") || "(empty)"}`,
          mimeType: "application/json" as const,
        })),
      }),
    }),
    {
      title: "SKILL.state session inspector",
      description:
        "Read-only inspection of one skill session: the immutable spec P, the live execution state Σ, " +
        "and server-side metadata. Reading this resource consumes ZERO LLM context tokens — " +
        "it exists so developers can debug without polluting the agent's context window.",
      mimeType: "application/json",
    },
    async (uri, { session_id }) => {
      const id = Array.isArray(session_id) ? session_id[0] : session_id;
      const session = store.require(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: stringify({
              session_id: session.id,
              skill_spec: session.spec,
              execution_state: session.state,
              metadata: session.meta,
            }),
          },
        ],
      };
    },
  );

  /* ── Resource: skill_state://sessions (index) ────────────────────────── */

  server.registerResource(
    "sessions-index",
    "skill-state://sessions",
    {
      title: "SKILL.state session index",
      description:
        "Index of all active skill sessions with step counts, statuses and state keys. " +
        "Developer-facing inspection only; never fed to the LLM.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: stringify({
            active_sessions: store.list().length,
            reasoning_retained: false,
            sessions: store.list(),
          }),
        },
      ],
    }),
  );

  /* ── Prompt: skill_state_turn ────────────────────────────────────────── */

  server.registerPrompt(
    "skill_state_turn",
    {
      title: "SKILL.state turn prompt",
      description:
        "Render the exact (P, Σ_t, O_t) working context for one agent turn as a ready-to-send message. " +
        "Use this when a client wants the runtime to format the turn instead of consuming raw tool JSON.",
      argsSchema: SkillStateTurnPromptArgsSchema,
    },
    async ({ session_id }) => {
      const session = store.require(session_id);
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: renderTurnPrompt(session) },
          },
        ],
      };
    },
  );

  /* ── Prompt: skill_state_paper_turn (arXiv:2608.26263 Appendix A.4) ──── */

  server.registerPrompt(
    "skill_state_paper_turn",
    {
      title: "SKILL.state canonical paper turn prompt",
      description:
        "Render the canonical working context strictly formatted per arXiv:2608.26263 Appendix A.4, " +
        "including single-line compact JSON state and response formatting instructions.",
      argsSchema: SkillStatePaperTurnPromptArgsSchema,
    },
    async ({ session_id, compact }) => {
      const session = store.require(session_id);
      const isCompact = compact !== "false";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: renderPaperTurnPrompt(session, isCompact),
            },
          },
        ],
      };
    },
  );

  return server;
}

export { renderTurnPrompt, renderPaperTurnPrompt };


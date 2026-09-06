/**
 * SKILL.state — strict Zod validation schemas for the MCP tool inputs.
 *
 * Every payload crossing the MCP tool boundary is validated here BEFORE it can
 * touch the session store. In particular:
 *  - ΔΣ_t MUST be a JSON object (record of string → JSON value),
 *  - a_t MUST be a non-empty string or a JSON object,
 *  - R_t is accepted as an opaque string ONLY so it can be explicitly
 *    discarded — nothing downstream ever reads it.
 */

import { z } from "zod";
import { JsonObject, JsonValue } from "./json.js";

/**
 * Recursive JSON value schema — compatible with zod v3 and v4 usage patterns.
 * Uses `z.lazy` for recursion and `z.record(key, value)` (two-argument form).
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A JSON object — required shape for Σ (state) and ΔΣ (updates). */
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);

/* ── Tool: initialize_skill ─────────────────────────────────────────────── */

export const InitializeSkillInputSchema = {
  session_id: z
    .string()
    .min(1)
    .describe(
      "Unique identifier for this skill session, e.g. 'triage-ticket-1042'. " +
        "Must not collide with an existing active session.",
    ),
  skill_specification: z
    .union([z.string().min(1), JsonObjectSchema])
    .describe(
      "P — the IMMUTABLE procedural skill specification. A markdown instruction " +
        "document or a structured JSON object. It is deep-frozen by the runtime " +
        "and returned verbatim in every subsequent turn payload.",
    ),
  initial_state: JsonObjectSchema.default({})
    .describe(
      "Σ_0 — the starting structured execution state as a JSON object. " +
        "Defaults to an empty object. This is the ONLY state the LLM will ever see.",
    ),
  state_schema: JsonObjectSchema.optional()
    .describe(
      "Optional domain schema for execution state Σ (arXiv:2608.26263 §3.1, §7). " +
        "Can specify required keys (with expected primitive types like 'string', 'number', 'boolean', 'object', 'array') " +
        "and disallowed unexpected keys. If Σ violates this schema, the step is rolled back.",
    ),
  environment: z
    .enum(["mock", "warehouse"])
    .default("mock")
    .describe(
      "Execution environment: 'mock' (default generic mock) or 'warehouse' (SkillExecBench Environment 1).",
    ),
};

export type InitializeSkillInput = {
  session_id: string;
  skill_specification: string | JsonObject;
  initial_state: JsonObject;
  state_schema?: JsonObject;
  environment?: "mock" | "warehouse";
};

/* ── Tool: execute_step ─────────────────────────────────────────────────── */

export const ExecuteStepInputSchema = {
  session_id: z
    .string()
    .min(1)
    .describe("Identifier of the active skill session to advance by one step."),
  reasoning_trace: z
    .string()
    .describe(
      "R_t — your free-form Chain-of-Thought for this step. " +
        "WARNING: the runtime DISCARDS this field entirely. It is never stored, " +
        "logged, hashed or replayed. Write reasoning here instead of polluting Σ.",
    ),
  state_update: JsonObjectSchema.describe(
    "ΔΣ_t — sparse JSON patch to apply as Σ_{t+1} = Σ_t ⊕ ΔΣ_t. " +
      "NULL-DELETION SEMANTICS: {'key': null} deletes 'key' from Σ; a value " +
      "inserts/updates the key; nested objects merge recursively; arrays replace " +
      "wholesale. Keys absent from ΔΣ_t are left untouched.",
  ),
  action: z
    .union([z.string().min(1), JsonObjectSchema])
    .describe(
      "a_t — the action to execute. A free-text command or a structured JSON " +
        "action, e.g. {'type':'echo','message':'...'}, {'type':'fail','reason':'...'}, " +
        "{'type':'complete','summary':'...'}. The mock executor produces O_{t+1}.",
    ),
  environment_observation: z
    .string()
    .describe(
      "O_t — the latest observation you (the model) consumed this turn, i.e. the " +
        "'latest_observation' from the previous tool response. The runtime uses it " +
        "for context-drift detection, then discards it.",
    ),
};

export type ExecuteStepInput = {
  session_id: string;
  reasoning_trace: string;
  state_update: JsonObject;
  action: string | JsonObject;
  environment_observation: string;
};

/* ── Tool: close_session ────────────────────────────────────────────────── */

export const CloseSessionInputSchema = {
  session_id: z.string().min(1).describe("Identifier of the session to remove from the runtime."),
};

export type CloseSessionInput = { session_id: string };

/* ── Tool: inject_observation ────────────────────────────────────────── */

export const InjectObservationInputSchema = {
  session_id: z.string().min(1).describe("Identifier of the active skill session."),
  observation: z
    .string()
    .min(1)
    .describe(
      "External environment observation / event alert to inject as the latest observation O_t " +
        "(e.g. 'Customer ordered item_12', background alert, or external state drift per arXiv:2608.26263 §5.4).",
    ),
  state_patch: JsonObjectSchema.optional().describe(
    "Optional external state mutation to merge into Σ via ⊕ (e.g. when an external actor modified the world state).",
  ),
};

export type InjectObservationInput = {
  session_id: string;
  observation: string;
  state_patch?: JsonObject;
};

/* ── Tool: parse_turn_response ─────────────────────────────────────────── */

export const ParseTurnResponseInputSchema = {
  response_text: z
    .string()
    .min(1)
    .describe(
      "Raw text response from the LLM containing free-form reasoning and a fenced ```json block " +
        "conforming to Appendix A.4: { 'state_patch': {...}, 'action': '...' }.",
    ),
};

export type ParseTurnResponseInput = {
  response_text: string;
};

/* ── Prompts ────────────────────────────────────────────────────────────── */

export const SkillStateTurnPromptArgsSchema = {
  session_id: z.string().min(1).describe("Session whose (P, Σ, O) tuple should be rendered."),
};

export const SkillStatePaperTurnPromptArgsSchema = {
  session_id: z.string().min(1).describe("Session whose (P, Σ, O) tuple should be rendered."),
  compact: z
    .string()
    .optional()
    .describe(
      "Whether to serialize Σ using single-line compact JSON matching the paper ('true' or 'false', default 'true').",
    ),
};


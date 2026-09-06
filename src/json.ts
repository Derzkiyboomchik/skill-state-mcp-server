/**
 * Minimal JSON value modelling used across the SKILL.state runtime.
 *
 * The SKILL.state architecture (arXiv:2608.26263) treats the execution state Σ
 * as a plain, serialisable JSON object so that:
 *  - it can be transmitted verbatim as part of every LLM turn payload,
 *  - it can be merged deterministically via the ⊕ operator (see `state.ts`),
 *  - it can be inspected losslessly through MCP resources.
 */

/** Any legal JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — the shape of Σ (execution state) and ΔΣ (state updates). */
export type JsonObject = { [key: string]: JsonValue };

/** Runtime type guard for plain JSON objects (excludes arrays and null). */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural deep clone of a JSON value — keeps caller objects from leaking into session state. */
export function deepClone<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  const out: JsonObject = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = deepClone(val);
  }
  return out as T;
}

/** Recursively freezes a value. Used to make the skill specification P strictly immutable. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const val of Object.values(value as Record<string, unknown>)) {
      deepFreeze(val);
    }
    Object.freeze(value);
  }
  return value;
}

/** Pretty-printer used for tool text output and resource contents. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Compact single-line serializer matching the paper's Appendix A.4 `{json.dumps(state, separators=(',', ':'))}`. */
export function compactStringify(value: unknown): string {
  return JSON.stringify(value);
}

/** Safe JSON parser returning a result object rather than throwing. */
export function safeParseJson<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extracts a JSON object from a raw LLM text response.
 * Handles:
 *  1. Markdown fenced JSON block (```json ... ``` or ``` ... ```)
 *  2. Raw unadorned JSON text { ... }
 */
export function extractJsonFromFencedBlock(text: string): { ok: true; value: JsonObject } | { ok: false; error: string } {
  const trimmed = text.trim();
  // 1. Try markdown fenced block
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = fenceRegex.exec(trimmed);
  const target = match ? match[1].trim() : trimmed;

  const parsed = safeParseJson(target);
  if (parsed.ok && isPlainObject(parsed.value)) {
    return { ok: true, value: parsed.value };
  }

  // 2. Fallback: look for first { and matching last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const subParse = safeParseJson(candidate);
    if (subParse.ok && isPlainObject(subParse.value)) {
      return { ok: true, value: subParse.value };
    }
  }

  return {
    ok: false,
    error: parsed.ok
      ? "Extracted JSON is not a plain object"
      : `Failed to parse JSON from response: ${parsed.error}`,
  };
}


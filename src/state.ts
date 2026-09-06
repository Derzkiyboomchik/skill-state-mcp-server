/**
 * SKILL.state — session store and the ⊕ merge operator.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE (arXiv:2608.26263)
 * ─────────────────────────────────────────────────────────────────────────────
 * Conventional LLM agents replay an append-only message history, so every
 * reasoning trace, tool result and dead-end accumulates in the context window
 * ("context bloat") and stale/incorrect content keeps influencing later turns
 * ("context poisoning").
 *
 * SKILL.state replaces that history with an explicit, mutable execution state.
 * At any step t the model is given ONLY:
 *
 *   1. P    — the immutable procedural skill specification,
 *   2. Σ_t  — the current structured execution state (JSON object),
 *   3. O_t  — the latest environment observation.
 *
 * The model answers with:
 *   1. R_t   — Chain-of-Thought reasoning (DISCARDED by this runtime),
 *   2. ΔΣ_t  — a structured state update (JSON patch, null-deletion semantics),
 *   3. a_t   — the next action to execute.
 *
 * The server computes  Σ_{t+1} = Σ_t ⊕ ΔΣ_t  (see `mergeState`), executes a_t
 * to obtain O_{t+1}, and the next turn payload is (P, Σ_{t+1}, O_{t+1}).
 * Nothing else is retained — in particular R_t is never stored, logged or
 * replayed, which is what eliminates context bloat and context poisoning.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONCURRENCY MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * - The JS event loop is single-threaded, so every synchronous mutation of a
 *   session is atomic.
 * - A step may contain `await` points (action execution). To keep each step of
 *   ONE session strictly serialised (read Σ_t → apply ΔΣ_t → execute a_t →
 *   write O_{t+1}), every session owns an async mutex (`Mutex`).
 * - DIFFERENT sessions hold DIFFERENT mutexes, so concurrent skill sessions
 *   never block each other.
 * - `P` is deep-frozen at creation time and can never be mutated through the
 *   store API; Σ can only change through the ⊕ operator.
 */

import { JsonObject, JsonValue, deepClone, deepFreeze, isPlainObject } from "./json.js";
import { ExecutionOutcome, executeAction } from "./executor.js";

/* ────────────────────────────── Error types ────────────────────────────── */

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string, activeIds: string[]) {
    super(
      `Unknown SKILL.state session "${sessionId}". Active sessions: ${
        activeIds.length > 0 ? activeIds.join(", ") : "(none)"
      }. Call initialize_skill first.`,
    );
    this.name = "SessionNotFoundError";
  }
}

export class SessionExistsError extends SessionError {
  constructor(sessionId: string) {
    super(
      `SKILL.state session "${sessionId}" already exists. Close it with close_session or pick another session_id.`,
    );
    this.name = "SessionExistsError";
  }
}

export class SessionLimitError extends SessionError {
  constructor(limit: number) {
    super(
      `Session limit reached (${limit}). Close idle sessions with close_session or raise SKILL_STATE_MAX_SESSIONS.`,
    );
    this.name = "SessionLimitError";
  }
}

/* ──────────────────────────── Session model ────────────────────────────── */

/** Server-side metadata for one skill session (never fed to the LLM as history). */
export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  /** Number of completed steps t. Incremented once per successful execute_step call. */
  stepCount: number;
  status: "active" | "completed";
  /**
   * Hard invariant of the SKILL.state runtime: reasoning traces R_t are
   * discarded at the tool boundary and are NEVER retained. This flag exists
   * so inspectors can verify the guarantee.
   */
  reasoningRetained: false;
  /** a_t of the most recent step (metadata for resource inspection only). */
  lastAction: JsonValue | null;
  /** O_{t+1} most recently produced by the executor (inspection only). */
  lastObservation: string | null;
  /** Execution environment (mock, warehouse, etc.). */
  environment: string;
}

/** One active skill session: immutable spec P + mutable execution state Σ. */
export interface SkillSession {
  id: string;
  /** P — deep-frozen at creation; never mutated. */
  spec: JsonValue;
  /** Σ — the ONLY mutable surface, always a plain JSON object. */
  state: JsonObject;
  /** Optional domain schema for state validation (arXiv:2608.26263 §3.1, §7). */
  stateSchema?: JsonObject;
  environment: string;
  meta: SessionMeta;
}

/** Compact summary used by the `skill_state://sessions` index resource. */
export interface SessionSummary {
  session_id: string;
  status: SessionMeta["status"];
  step_count: number;
  created_at: string;
  updated_at: string;
  state_keys: string[];
  environment: string;
  spec_preview: string;
}

/* ───────────────────── State Schema Validation (arXiv:2608.26263) ──────── */

export interface SchemaValidationResult {
  valid: boolean;
  reason?: string;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isPlainObject(value);
  if (expected === "string" || expected === "number" || expected === "boolean") return typeof value === expected;
  if (expected === "any") return true;
  return true;
}

/**
 * Validates state Σ against a domain schema.
 * Supports:
 *  - JSON-schema-like: `{ required: ["k1"], properties: { k1: "string" }, additionalProperties: false }`
 *  - Type dictionary: `{ k1: "string", k2: "number?", k3: "boolean" }`
 */
export function validateStateSchema(state: JsonObject, schema?: JsonObject): SchemaValidationResult {
  if (!schema || !isPlainObject(schema)) return { valid: true };

  // Case A: JSON-schema-like
  if (Array.isArray(schema.required) || isPlainObject(schema.properties)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (typeof req === "string" && (!(req in state) || state[req] === null || state[req] === undefined)) {
          return { valid: false, reason: `Missing required state field "${req}"` };
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      const props = schema.properties as JsonObject;
      for (const [key, expected] of Object.entries(props)) {
        if (key in state && state[key] !== null && state[key] !== undefined) {
          const typeStr =
            typeof expected === "string"
              ? expected
              : isPlainObject(expected) && typeof expected.type === "string"
              ? expected.type
              : undefined;
          if (typeStr && !matchesType(state[key], typeStr)) {
            return { valid: false, reason: `State field "${key}" has type "${typeof state[key]}", expected "${typeStr}"` };
          }
        }
      }
    }
    if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
      const allowed = new Set(Object.keys(schema.properties as JsonObject));
      for (const key of Object.keys(state)) {
        if (!allowed.has(key)) {
          return { valid: false, reason: `Unexpected state field "${key}" not allowed by schema` };
        }
      }
    }
    return { valid: true };
  }

  // Case B: type dictionary
  for (const [key, typeDef] of Object.entries(schema)) {
    if (typeof typeDef === "string") {
      const isOptional = typeDef.endsWith("?");
      const expectedType = isOptional ? typeDef.slice(0, -1) : typeDef;
      const exists = key in state && state[key] !== null && state[key] !== undefined;

      if (!exists && !isOptional) {
        return { valid: false, reason: `Missing required state field "${key}"` };
      }
      if (exists && !matchesType(state[key], expectedType)) {
        return { valid: false, reason: `State field "${key}" has type "${typeof state[key]}", expected "${expectedType}"` };
      }
    }
  }

  return { valid: true };
}

/* ────────────────────── ⊕ merge operator (null-deletion) ───────────────── */

/**
 * The SKILL.state merge operator ⊕ with NULL-DELETION SEMANTICS:
 *
 *     Σ_{t+1} = Σ_t ⊕ ΔΣ_t
 *
 * Rules (applied key by key, recursively for nested objects):
 *   1. ΔΣ_t[key] === null                       → key is EXPLICITLY DELETED from Σ.
 *      Null is a first-class "delete this" instruction — this is how the
 *      runtime distinguishes "clear the field" from "leave the field alone"
 *      without any diff/patch format beyond plain JSON.
 *   2. ΔΣ_t[key] is a plain JSON object         → recursive merge against the
 *      existing object at that key (or against {} if the key is new), so
 *      nested nulls delete nested keys too.
 *   3. Any other value (string/number/boolean/array) → REPLACES the key.
 *      Arrays are replaced wholesale — no positional diffing, keeping the
 *      operator deterministic and trivially auditable.
 *
 * Examples:
 *   {a:1, b:2}        ⊕ {b:null}          → {a:1}
 *   {a:1}             ⊕ {a:2}             → {a:2}
 *   {o:{x:1,y:2}}     ⊕ {o:{y:null,z:3}}  → {o:{x:1,z:3}}
 *   {tags:["a","b"]}  ⊕ {tags:["c"]}      → {tags:["c"]}
 *   {a:1}             ⊕ {a:null, b:2}     → {b:2}
 *
 * Keys absent from ΔΣ_t are left untouched: the update is a sparse patch.
 *
 * @param current Σ_t — the current execution state.
 * @param delta   ΔΣ_t — the model-provided state update.
 * @returns a brand-new object; neither Σ_t nor ΔΣ_t is mutated.
 */
export function mergeState(current: JsonObject, delta: JsonObject): JsonObject {
  const next: JsonObject = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) {
      // Rule 1 — null-deletion semantics.
      delete next[key];
    } else if (isPlainObject(value)) {
      // Rule 2 — recursive merge for nested objects.
      const base = isPlainObject(next[key]) ? (next[key] as JsonObject) : {};
      const merged = mergeState(base, value);
      // If the key is brand new and the delta only contained nulls, the
      // effective result is "no key" — don't materialise an empty object.
      if (key in next || Object.keys(merged).length > 0) {
        next[key] = merged;
      }
    } else if (Array.isArray(value)) {
      // Rule 3 — arrays replace wholesale (cloned for isolation).
      next[key] = deepClone(value);
    } else {
      // Rule 3 — scalars replace.
      next[key] = value;
    }
  }
  return next;
}

/* ─────────────────────────── Async mutex ───────────────────────────────── */

/**
 * Minimal promise-chain mutex. Guarantees that the critical sections of one
 * session execute strictly in submission order, even across await points.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive even if a step throws, but never expose the error
    // to subsequent callers.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/* ─────────────────────────── Session store ─────────────────────────────── */

export interface StepInput {
  /** ΔΣ_t — validated by the Zod schema before reaching this point. */
  stateUpdate: JsonObject;
  /** a_t — handed to the executor. */
  action: JsonValue;
  /** O_t — the observation the model just consumed; used for drift detection. */
  consumedObservation: string;
}

export interface StepOutput {
  /** t+1 — the step number AFTER applying the update (or current step if rolled back). */
  step: number;
  /** Σ_{t+1} — the new execution state (or untouched Σ_t if rolled back). */
  state: JsonObject;
  /** Result of executing a_t, including the new observation O_{t+1}. */
  outcome: ExecutionOutcome;
  /** Non-fatal warnings (e.g. observation drift or rejection notices) surfaced to the caller. */
  warning?: string;
  /** True if ΔΣ_t was rolled back due to schema violation or action rejection. */
  rolledBack?: boolean;
}

export interface CreateSessionOptions {
  stateSchema?: JsonObject;
  environment?: "mock" | "warehouse" | string;
}

interface StoreLimits {
  maxSessions: number;
  sessionTtlMs: number;
}

function readLimits(): StoreLimits {
  const maxSessions = Number(process.env.SKILL_STATE_MAX_SESSIONS) || 256;
  const ttlHours = Number(process.env.SKILL_STATE_SESSION_TTL_HOURS) || 24;
  return { maxSessions, sessionTtlMs: ttlHours * 60 * 60 * 1000 };
}

/**
 * In-memory registry of active skill sessions.
 *
 * Safety properties:
 *  - Sessions are keyed by caller-chosen `session_id`.
 *  - Every mutating operation on a session runs under that session's mutex.
 *  - Idle sessions are lazily evicted after `SKILL_STATE_SESSION_TTL_HOURS`
 *    (default 24h) so long-running deployments don't leak memory.
 *  - A hard cap (`SKILL_STATE_MAX_SESSIONS`, default 256) bounds memory use.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SkillSession>();
  private readonly locks = new Map<string, Mutex>();
  private readonly limits: StoreLimits;

  constructor(limits: StoreLimits = readLimits()) {
    this.limits = limits;
  }

  /** Create a new session. `spec` becomes immutable; `initialState` is cloned. */
  create(
    sessionId: string,
    spec: JsonValue,
    initialState: JsonObject,
    options: CreateSessionOptions = {},
  ): SkillSession {
    this.sweep();
    if (this.sessions.has(sessionId)) {
      throw new SessionExistsError(sessionId);
    }
    if (this.sessions.size >= this.limits.maxSessions) {
      throw new SessionLimitError(this.limits.maxSessions);
    }

    // Validate initial state against schema if provided
    if (options.stateSchema) {
      const check = validateStateSchema(initialState, options.stateSchema);
      if (!check.valid) {
        throw new SessionError(`Initial state violates state_schema: ${check.reason}`);
      }
    }

    const env = options.environment ?? "mock";
    const now = new Date().toISOString();
    const session: SkillSession = {
      id: sessionId,
      // P is immutable: cloned, then deep-frozen so even a malicious in-process
      // consumer cannot mutate the specification after creation.
      spec: deepFreeze(deepClone(spec)),
      state: deepClone(initialState),
      stateSchema: options.stateSchema ? deepClone(options.stateSchema) : undefined,
      environment: env,
      meta: {
        createdAt: now,
        updatedAt: now,
        stepCount: 0,
        status: "active",
        // SKILL.state invariant — reasoning traces never survive the tool call.
        reasoningRetained: false,
        lastAction: null,
        lastObservation: `Session "${sessionId}" initialized (step 0). Awaiting the first execute_step call.`,
        environment: env,
      },
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Look up a session without throwing. */
  get(sessionId: string): SkillSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Look up a session or throw a descriptive SessionNotFoundError. */
  require(sessionId: string): SkillSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId, this.activeIds());
    }
    return session;
  }

  /**
   * Run one full SKILL.state step under the session's mutex with transactional rollback:
   *
   *   1. (R_t has already been discarded at the tool boundary — it never
   *      reaches this method.)
   *   2. Detect observation drift between the O_t the model claims to have
   *      consumed and the O_t this runtime last issued (non-fatal warning).
   *   3. Compute candidate state:  Σ_{cand} = Σ_t ⊕ ΔΣ_t.
   *   4. Validate Σ_{cand} against domain schema (arXiv:2608.26263 §3.1, §7).
   *      If invalid: rollback! Σ_t is untouched.
   *   5. Execute a_t → obtain O_{t+1}. If rejected by environment: rollback!
   *   6. Commit: persist Σ_{t+1} = Σ_{cand} and metadata. No message history is written.
   */
  async runStep(sessionId: string, input: StepInput): Promise<StepOutput> {
    return this.lockFor(sessionId).run(async () => {
      const session = this.require(sessionId);

      // Context-drift detection: compare the observation the model says it
      // consumed against the one the runtime actually issued for step t.
      let warning: string | undefined;
      if (
        session.meta.lastObservation !== null &&
        input.consumedObservation !== session.meta.lastObservation
      ) {
        warning =
          "environment_observation does not match the latest observation the runtime issued — " +
          "possible context drift or hallucinated observation. The authoritative observation " +
          "is returned in prompt_payload.latest_observation.";
      }

      // 3. Compute candidate state Σ_{cand} = Σ_t ⊕ ΔΣ_t (null-deletion merge).
      const candidateState = mergeState(session.state, input.stateUpdate);

      // 4. Validate Σ_{cand} against domain schema (arXiv:2608.26263 §3.1, §7)
      if (session.stateSchema) {
        const check = validateStateSchema(candidateState, session.stateSchema);
        if (!check.valid) {
          const rejectOutcome: ExecutionOutcome = {
            status: "failed",
            rejectStateTransition: true,
            observation: `[STATE SCHEMA VIOLATION] ${check.reason}. State Σ_${session.meta.stepCount} remains unchanged (rollback-retry).`,
          };
          session.meta.lastObservation = rejectOutcome.observation;
          session.meta.updatedAt = new Date().toISOString();
          return {
            step: session.meta.stepCount,
            state: session.state,
            outcome: rejectOutcome,
            warning: (warning ? `${warning}; ` : "") + `State schema violation: ${check.reason}`,
            rolledBack: true,
          };
        }
      }

      // 5. Execute a_t → O_{t+1}.
      let outcome: ExecutionOutcome;
      try {
        outcome = await executeAction(
          input.action,
          session.meta.stepCount + 1,
          session.environment,
          { sessionId, currentState: candidateState },
        );
      } catch (err) {
        outcome = {
          status: "failed",
          rejectStateTransition: true,
          observation: `Action execution error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Check if the environment rejected the action (arXiv:2608.26263 Appendix B.1)
      if (outcome.rejectStateTransition) {
        session.meta.lastAction = deepClone(input.action);
        session.meta.lastObservation = outcome.observation;
        session.meta.updatedAt = new Date().toISOString();
        return {
          step: session.meta.stepCount,
          state: session.state, // Rollback! Untouched.
          outcome,
          warning: (warning ? `${warning}; ` : "") + "Action was rejected by environment; state patch rolled back.",
          rolledBack: true,
        };
      }

      // 6. Commit candidate state: Σ_{t+1} = Σ_{cand}
      session.state = candidateState;
      session.meta.stepCount += 1;
      const step = session.meta.stepCount;

      session.meta.lastAction = deepClone(input.action);
      session.meta.lastObservation = outcome.observation;
      session.meta.updatedAt = new Date().toISOString();
      if (outcome.status === "completed") {
        session.meta.status = "completed";
      }

      return { step, state: session.state, outcome, warning, rolledBack: false };
    });
  }

  /**
   * Injects an asynchronous observation / alert or external state change
   * without advancing the agent turn (arXiv:2608.26263 §5.4 State Recovery).
   */
  async injectObservation(
    sessionId: string,
    observation: string,
    statePatch?: JsonObject,
  ): Promise<{ state: JsonObject; observation: string }> {
    return this.lockFor(sessionId).run(async () => {
      const session = this.require(sessionId);
      if (statePatch && isPlainObject(statePatch)) {
        session.state = mergeState(session.state, statePatch);
      }
      session.meta.lastObservation = observation;
      session.meta.updatedAt = new Date().toISOString();
      return { state: session.state, observation };
    });
  }

  /** Remove a session entirely. Returns true if it existed. */
  close(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    this.locks.delete(sessionId);
    return deleted;
  }

  /** Compact summaries for the index resource. */
  list(): SessionSummary[] {
    this.sweep();
    return [...this.sessions.values()].map((session) => ({
      session_id: session.id,
      status: session.meta.status,
      step_count: session.meta.stepCount,
      created_at: session.meta.createdAt,
      updated_at: session.meta.updatedAt,
      state_keys: Object.keys(session.state),
      environment: session.environment,
      spec_preview:
        typeof session.spec === "string"
          ? session.spec.replace(/\s+/g, " ").slice(0, 80)
          : "(structured JSON spec)",
    }));
  }

  activeIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Lazily evict sessions that have been idle beyond the TTL. */
  private sweep(): void {
    const cutoff = Date.now() - this.limits.sessionTtlMs;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.meta.updatedAt) < cutoff) {
        this.sessions.delete(id);
        this.locks.delete(id);
      }
    }
  }

  private lockFor(sessionId: string): Mutex {
    let lock = this.locks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(sessionId, lock);
    }
    return lock;
  }
}

/**
 * Process-wide singleton store. HTTP transport may spin up one McpServer per
 * MCP client session, but SKILL.state skill sessions live here, shared and
 * concurrency-safe across all of them.
 */
export const globalSessionStore = new SessionStore();


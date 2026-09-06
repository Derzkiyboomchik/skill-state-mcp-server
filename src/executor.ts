/**
 * SKILL.state — action executors.
 *
 * The SKILL.state runtime separates the STATE MACHINE from the EXECUTION ENVIRONMENT.
 * `a_t` is handed to an executor which produces the next observation O_{t+1}.
 *
 * Includes:
 *  1. Default deterministic Mock executor (echo, noop, fail, complete, free text).
 *  2. WarehouseExecutor: exact implementation of SkillExecBench Environment 1
 *     (arXiv:2608.26263 §4.1, Appendix B.1) with 500 shelves, action validation
 *     (Store, Ship, Move, Wait), transition rejection on invalid actions, and
 *     optional telemetry noise (Appendix C).
 *  3. Pluggable executor registry.
 */

import { JsonObject, JsonValue, isPlainObject, stringify } from "./json.js";

/** Status of one action execution. */
export type ExecutionStatus = "ok" | "failed" | "completed";

/** The result of executing a_t: an observation string O_{t+1} plus status. */
export interface ExecutionOutcome {
  status: ExecutionStatus;
  /** O_{t+1} — the observation string handed back to the LLM in the next turn. */
  observation: string;
  /**
   * When true, the environment rejected this action (e.g. invalid shelf placement).
   * Per arXiv:2608.26263 Appendix B.1, this triggers a rollback of ΔΣ_t.
   */
  rejectStateTransition?: boolean;
}

export interface ExecutionContext {
  sessionId: string;
  currentState: JsonObject;
}

export interface ActionExecutor {
  execute(action: JsonValue, step: number, context?: ExecutionContext): Promise<ExecutionOutcome>;
}

/* ────────────────────────── Default Mock Executor ───────────────────────── */

interface MockAction {
  type?: string;
  message?: string;
  reason?: string;
  summary?: string;
  reject_transition?: boolean;
  [key: string]: unknown;
}

function mockPrefix(step: number): string {
  return `[MOCK ENV · step ${step}]`;
}

export class MockExecutor implements ActionExecutor {
  async execute(action: JsonValue, step: number): Promise<ExecutionOutcome> {
    await Promise.resolve();
    const prefix = mockPrefix(step);

    if (typeof action === "string") {
      return {
        status: "ok",
        observation: `${prefix} Generic action executed successfully: "${action}". No side effects. (mock)`,
      };
    }

    if (isPlainObject(action)) {
      const mock = action as MockAction;
      switch (mock.type) {
        case "echo":
          return {
            status: "ok",
            observation: `${prefix} echo → ${String(mock.message ?? "(empty message)")}. (mock)`,
          };
        case "noop":
          return {
            status: "ok",
            observation: `${prefix} no-op action acknowledged; environment unchanged. (mock)`,
          };
        case "fail":
          return {
            status: "failed",
            rejectStateTransition: Boolean(mock.reject_transition),
            observation: `${prefix} ACTION FAILED — ${String(mock.reason ?? "unspecified mock failure")}. Recover per skill procedure P. (mock)`,
          };
        case "complete":
          return {
            status: "completed",
            observation: `${prefix} SKILL COMPLETE — ${String(mock.summary ?? "all objectives met")}. (mock)`,
          };
        default:
          return {
            status: "ok",
            observation: `${prefix} Structured action executed: ${stringify(action)}. (mock)`,
          };
      }
    }

    return {
      status: "ok",
      observation: `${prefix} Action executed: ${stringify(action)}. (mock)`,
    };
  }
}

/* ──────────────── SkillExecBench Warehouse Management ──────────────────── */

/**
 * Deterministic simulation of Environment 1: Warehouse Management (arXiv:2608.26263 §4.1 & B.1).
 *
 * State: 500 independent shelves (`shelf_0` to `shelf_499`), each holding an item string or null.
 * Actions:
 *  - Store <item_id> <shelf_id>
 *  - Ship <item_id> <shelf_id>
 *  - Move <item_id> <old_shelf_id> <new_shelf_id>
 *  - Wait
 *
 * Rules:
 *  - Store validates shelf is empty before placing item.
 *  - Ship removes item.
 *  - Invalid actions return local error observation and reject state transition.
 */
export class WarehouseExecutor implements ActionExecutor {
  private readonly shelves = new Map<string, string | null>();
  public noiseLevel: "none" | "low" | "medium" | "high" = "none";

  constructor(shelfCount = 500) {
    for (let i = 0; i < shelfCount; i++) {
      this.shelves.set(`shelf_${i}`, null);
    }
  }

  getShelf(id: string): string | null | undefined {
    return this.shelves.get(id);
  }

  setShelf(id: string, item: string | null): void {
    this.shelves.set(id, item);
  }

  getOccupiedShelves(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [shelf, item] of this.shelves.entries()) {
      if (item !== null) out[shelf] = item;
    }
    return out;
  }

  private generateTelemetry(): string {
    if (this.noiseLevel === "none") return "";
    const snippets = [
      "Battery: 85%, Temperature: 45C, CPU Load: 72%, Speed: 1.2 m/s, Nav Confidence: 95.4%",
      "[Sensor] Humidity: 45%, Temp: 22.3C, Light: 310 lux, CO2: 450 ppm",
      "[Camera OCR] Forklift parked. Worker entered Zone A. Safety Vest Detected.",
    ];
    return `\n\n--- BACKGROUND TELEMETRY ---\n${snippets[Math.floor(Math.random() * snippets.length)]}`;
  }

  async execute(action: JsonValue, step: number): Promise<ExecutionOutcome> {
    const rawAction =
      typeof action === "string"
        ? action.trim()
        : isPlainObject(action) && typeof action.command === "string"
        ? (action.command as string).trim()
        : "";

    const parts = rawAction.split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const noise = this.generateTelemetry();

    if (verb === "store") {
      const itemId = parts[1];
      const shelfId = parts[2];
      if (!itemId || !shelfId) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] Error: Usage: Store <item_id> <shelf_id>${noise}`,
        };
      }
      if (!this.shelves.has(shelfId)) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] Error: Shelf "${shelfId}" does not exist.${noise}`,
        };
      }
      const existing = this.shelves.get(shelfId);
      if (existing !== null && existing !== undefined) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] REJECTED: Shelf "${shelfId}" is already occupied by "${existing}". Cannot store "${itemId}". State transition rejected.${noise}`,
        };
      }
      this.shelves.set(shelfId, itemId);
      return {
        status: "ok",
        observation: `[WAREHOUSE · step ${step}] Success: Stored "${itemId}" on ${shelfId}.${noise}`,
      };
    }

    if (verb === "ship") {
      const itemId = parts[1];
      const shelfId = parts[2];
      if (!itemId || !shelfId) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] Error: Usage: Ship <item_id> <shelf_id>${noise}`,
        };
      }
      const current = this.shelves.get(shelfId);
      if (current !== itemId) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] REJECTED: Shelf "${shelfId}" does not contain "${itemId}" (contains "${current ?? "empty"}"). State transition rejected.${noise}`,
        };
      }
      this.shelves.set(shelfId, null);
      return {
        status: "ok",
        observation: `[WAREHOUSE · step ${step}] Success: Shipped "${itemId}" from ${shelfId}.${noise}`,
      };
    }

    if (verb === "move") {
      const itemId = parts[1];
      const oldShelf = parts[2];
      const newShelf = parts[3];
      if (!itemId || !oldShelf || !newShelf) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] Error: Usage: Move <item_id> <old_shelf> <new_shelf>${noise}`,
        };
      }
      if (this.shelves.get(oldShelf) !== itemId) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] REJECTED: Old shelf "${oldShelf}" does not contain "${itemId}". State transition rejected.${noise}`,
        };
      }
      if (this.shelves.get(newShelf) !== null) {
        return {
          status: "failed",
          rejectStateTransition: true,
          observation: `[WAREHOUSE · step ${step}] REJECTED: New shelf "${newShelf}" is already occupied. State transition rejected.${noise}`,
        };
      }
      this.shelves.set(oldShelf, null);
      this.shelves.set(newShelf, itemId);
      return {
        status: "ok",
        observation: `[WAREHOUSE · step ${step}] Success: Moved "${itemId}" from ${oldShelf} to ${newShelf}.${noise}`,
      };
    }

    if (verb === "wait") {
      return {
        status: "ok",
        observation: `[WAREHOUSE · step ${step}] Wait acknowledged; warehouse inventory unchanged.${noise}`,
      };
    }

    if (verb === "complete") {
      return {
        status: "completed",
        observation: `[WAREHOUSE · step ${step}] TASK COMPLETE.${noise}`,
      };
    }

    return {
      status: "failed",
      rejectStateTransition: true,
      observation: `[WAREHOUSE · step ${step}] Unknown action "${rawAction}". Allowed actions: Store, Ship, Move, Wait, Complete.${noise}`,
    };
  }
}

/* ────────────────────────── Executor Registry ───────────────────────────── */

const executors = new Map<string, ActionExecutor>([
  ["mock", new MockExecutor()],
  ["warehouse", new WarehouseExecutor()],
]);

export function getExecutor(name = "mock"): ActionExecutor {
  const executor = executors.get(name);
  if (!executor) {
    throw new Error(`Unknown environment executor "${name}". Registered: ${[...executors.keys()].join(", ")}`);
  }
  return executor;
}

export function registerExecutor(name: string, executor: ActionExecutor): void {
  executors.set(name, executor);
}

/** Backwards-compatible convenience function. */
export async function executeAction(
  action: JsonValue,
  step: number,
  environment = "mock",
  context?: ExecutionContext,
): Promise<ExecutionOutcome> {
  const executor = getExecutor(environment);
  return executor.execute(action, step, context);
}


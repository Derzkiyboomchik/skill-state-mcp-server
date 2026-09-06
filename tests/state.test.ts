import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionStore,
  SessionExistsError,
  SessionNotFoundError,
  validateStateSchema,
} from "../src/state.js";

test("validateStateSchema: type checking and required fields", () => {
  const schema = {
    required: ["id", "count"],
    properties: { id: "string", count: "number", active: "boolean" },
    additionalProperties: false,
  };

  // Valid
  const valid = validateStateSchema({ id: "abc", count: 10, active: true }, schema);
  assert.equal(valid.valid, true);

  // Missing required
  const missing = validateStateSchema({ count: 10 }, schema);
  assert.equal(missing.valid, false);
  assert.match(missing.reason!, /Missing required state field "id"/);

  // Wrong type
  const wrongType = validateStateSchema({ id: "abc", count: "ten" as unknown as number }, schema);
  assert.equal(wrongType.valid, false);
  assert.match(wrongType.reason!, /expected "number"/);

  // Unexpected property
  const unexpected = validateStateSchema({ id: "abc", count: 10, extra: 123 }, schema);
  assert.equal(unexpected.valid, false);
  assert.match(unexpected.reason!, /Unexpected state field "extra"/);
});

test("SessionStore: session lifecycle and immutable P", () => {
  const store = new SessionStore();
  const spec = { instructions: "Do step A then B", version: 1 };
  const session = store.create("sess-1", spec, { step: 0 });

  assert.equal(session.id, "sess-1");
  assert.deepEqual(session.state, { step: 0 });

  // P must be frozen and cannot be mutated
  assert.throws(() => {
    (session.spec as { version: number }).version = 2;
  });

  // Duplicate ID throws SessionExistsError
  assert.throws(() => {
    store.create("sess-1", spec, {});
  }, SessionExistsError);

  // Unknown ID throws SessionNotFoundError
  assert.throws(() => {
    store.require("non-existent");
  }, SessionNotFoundError);

  // Close session
  const closed = store.close("sess-1");
  assert.equal(closed, true);
  assert.equal(store.get("sess-1"), undefined);
});

test("SessionStore: transactional rollback on schema violation", async () => {
  const store = new SessionStore();
  const schema = { required: ["ticket_id", "attempts"], properties: { attempts: "number" } };

  store.create(
    "sess-val",
    "Ticket triage procedure",
    { ticket_id: "TCK-1", attempts: 1 },
    { stateSchema: schema },
  );

  // Attempt invalid update (attempts becomes string)
  const result = await store.runStep("sess-val", {
    stateUpdate: { attempts: "invalid" as unknown as number },
    action: "noop",
    consumedObservation: store.require("sess-val").meta.lastObservation!,
  });

  assert.equal(result.rolledBack, true);
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.step, 0, "Step count must NOT advance on rollback");

  // State must remain at step 0 values
  const currentSession = store.require("sess-val");
  assert.deepEqual(currentSession.state, { ticket_id: "TCK-1", attempts: 1 });
  assert.equal(currentSession.meta.stepCount, 0);
});

test("SessionStore: transactional rollback on rejected action", async () => {
  const store = new SessionStore();
  store.create("sess-reject", "Test skill", { count: 0 });

  // Action fails with reject_transition: true
  const result = await store.runStep("sess-reject", {
    stateUpdate: { count: 1 },
    action: { type: "fail", reason: "Shelf full", reject_transition: true },
    consumedObservation: store.require("sess-reject").meta.lastObservation!,
  });

  assert.equal(result.rolledBack, true);
  assert.equal(result.step, 0);
  assert.deepEqual(store.require("sess-reject").state, { count: 0 });
});

test("SessionStore: drift detection produces warning", async () => {
  const store = new SessionStore();
  store.create("sess-drift", "Test skill", { count: 0 });

  const result = await store.runStep("sess-drift", {
    stateUpdate: { count: 1 },
    action: "noop",
    consumedObservation: "hallucinated observation that doesn't match",
  });

  assert.ok(result.warning);
  assert.match(result.warning!, /possible context drift/);
  assert.equal(result.step, 1);
  assert.deepEqual(result.state, { count: 1 });
});

test("SessionStore: injectObservation updates state and observation without advancing step", async () => {
  const store = new SessionStore();
  store.create("sess-inject", "Test skill", { count: 0 });

  const injected = await store.injectObservation(
    "sess-inject",
    "External alert: Shipment arrived",
    { external_event: "shipment_1" },
  );

  assert.equal(injected.observation, "External alert: Shipment arrived");
  assert.deepEqual(injected.state, { count: 0, external_event: "shipment_1" });

  const session = store.require("sess-inject");
  assert.equal(session.meta.stepCount, 0, "Step count remains 0");
  assert.equal(session.meta.lastObservation, "External alert: Shipment arrived");
});

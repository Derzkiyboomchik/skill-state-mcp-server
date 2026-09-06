import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeState } from "../src/state.js";

test("mergeState: basic scalar updates and inserts", () => {
  const current = { a: 1, b: "hello" };
  const delta = { b: "world", c: true };
  const result = mergeState(current, delta);

  assert.deepEqual(result, { a: 1, b: "world", c: true });
  assert.deepEqual(current, { a: 1, b: "hello" }, "Original current state must not be mutated");
});

test("mergeState: null-deletion removes keys", () => {
  const current = { ticket_id: "TCK-1", stage: "replied", draft: "hello", attempts: 2 };
  const delta = { stage: "closed", draft: null, resolved: true };
  const result = mergeState(current, delta);

  assert.deepEqual(result, {
    ticket_id: "TCK-1",
    stage: "closed",
    resolved: true,
    attempts: 2,
  });
  assert.equal("draft" in result, false, "draft key must be physically deleted from Σ");
});

test("mergeState: recursive object merge and nested null-deletion", () => {
  const current = {
    user: { name: "Alice", active: true, profile: { city: "Paris", zip: 75000 } },
    tags: ["a"],
  };
  const delta = {
    user: { active: null, profile: { city: "Lyon" }, role: "admin" },
  };
  const result = mergeState(current, delta);

  assert.deepEqual(result, {
    user: { name: "Alice", profile: { city: "Lyon", zip: 75000 }, role: "admin" },
    tags: ["a"],
  });
  assert.equal("active" in (result.user as Record<string, unknown>), false);
});

test("mergeState: array replacement is wholesale without positional diffing", () => {
  const current = { items: ["a", "b", "c"], counter: 1 };
  const delta = { items: ["x", "y"] };
  const result = mergeState(current, delta);

  assert.deepEqual(result, { items: ["x", "y"], counter: 1 });
});

test("mergeState: sparse patch leaves untouched keys unchanged", () => {
  const current = { k1: "v1", k2: "v2", k3: "v3" };
  const delta = { k2: "v2-updated" };
  const result = mergeState(current, delta);

  assert.deepEqual(result, { k1: "v1", k2: "v2-updated", k3: "v3" });
});

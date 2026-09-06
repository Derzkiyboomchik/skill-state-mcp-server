import { test } from "node:test";
import assert from "node:assert/strict";
import { WarehouseExecutor } from "../src/executor.js";

test("WarehouseExecutor: 500 shelves initialization", () => {
  const wh = new WarehouseExecutor(500);
  assert.equal(wh.getShelf("shelf_0"), null);
  assert.equal(wh.getShelf("shelf_499"), null);
  assert.equal(wh.getShelf("shelf_500"), undefined);
});

test("WarehouseExecutor: Store action on empty shelf succeeds", async () => {
  const wh = new WarehouseExecutor(500);
  const outcome = await wh.execute("Store item_42 shelf_15", 1);

  assert.equal(outcome.status, "ok");
  assert.match(outcome.observation, /Success: Stored "item_42" on shelf_15/);
  assert.equal(wh.getShelf("shelf_15"), "item_42");
});

test("WarehouseExecutor: Store on occupied shelf rejects state transition", async () => {
  const wh = new WarehouseExecutor(500);
  await wh.execute("Store item_42 shelf_15", 1);

  // Try storing another item on shelf_15
  const collision = await wh.execute("Store item_99 shelf_15", 2);
  assert.equal(collision.status, "failed");
  assert.equal(collision.rejectStateTransition, true);
  assert.match(collision.observation, /REJECTED: Shelf "shelf_15" is already occupied/);
  // Original item remains
  assert.equal(wh.getShelf("shelf_15"), "item_42");
});

test("WarehouseExecutor: Ship action removes item", async () => {
  const wh = new WarehouseExecutor(500);
  await wh.execute("Store item_42 shelf_15", 1);

  const ship = await wh.execute("Ship item_42 shelf_15", 2);
  assert.equal(ship.status, "ok");
  assert.match(ship.observation, /Success: Shipped "item_42" from shelf_15/);
  assert.equal(wh.getShelf("shelf_15"), null);
});

test("WarehouseExecutor: Move action moves item and validates destination", async () => {
  const wh = new WarehouseExecutor(500);
  await wh.execute("Store item_42 shelf_15", 1);

  // Move from shelf_15 to shelf_20
  const move = await wh.execute("Move item_42 shelf_15 shelf_20", 2);
  assert.equal(move.status, "ok");
  assert.match(move.observation, /Success: Moved "item_42" from shelf_15 to shelf_20/);
  assert.equal(wh.getShelf("shelf_15"), null);
  assert.equal(wh.getShelf("shelf_20"), "item_42");
});

test("WarehouseExecutor: telemetry noise injection", async () => {
  const wh = new WarehouseExecutor(50);
  wh.noiseLevel = "high";

  const outcome = await wh.execute("Wait", 1);
  assert.equal(outcome.status, "ok");
  assert.match(outcome.observation, /--- BACKGROUND TELEMETRY ---/);
});

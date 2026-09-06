import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveRunRegistry } from "../src/active-runs.js";

const input = (order: string) => ({ order, message: { role: "user" as const, content: order } });

test("active run registry isolates sessions and removes only the matching handle", () => {
  const registry = new ActiveRunRegistry();
  const first = registry.start("one", "owner");
  const second = registry.start("two", "owner");
  assert.throws(() => registry.start("one", "owner"), /already has an active run/);
  registry.finish(first);
  assert.equal(registry.has("one"), false);
  assert.equal(registry.has("two"), true);
  registry.finish(second);
});

test("steer accepts only the active request author and drains in transport order", () => {
  const registry = new ActiveRunRegistry();
  const run = registry.start("one", "owner");
  assert.equal(registry.steer("one", "other", input("20")), false);
  assert.equal(registry.steer("one", "owner", input("20")), true);
  assert.equal(registry.steer("one", "owner", input("10")), true);
  assert.deepEqual(run.drainPending().map(item => item.order), ["10", "20"]);
  assert.deepEqual(run.drainPending(), []);
});

test("final response sealing prevents late steer from being lost", () => {
  const registry = new ActiveRunRegistry();
  const run = registry.start("one", "owner");
  assert.deepEqual(run.drainPendingOrSeal(), []);
  assert.equal(registry.steer("one", "owner", input("30")), false);
});

test("final response sealing drains already pending steer before closing", () => {
  const registry = new ActiveRunRegistry();
  const run = registry.start("one", "owner");
  assert.equal(registry.steer("one", "owner", input("20")), true);
  assert.deepEqual(run.drainPendingOrSeal().map(item => item.order), ["20"]);
  assert.equal(registry.steer("one", "owner", input("30")), true);
  assert.deepEqual(run.drainPendingOrSeal().map(item => item.order), ["30"]);
  assert.deepEqual(run.drainPendingOrSeal(), []);
  assert.equal(registry.steer("one", "owner", input("40")), false);
});

test("stop is session-scoped, permission-aware and idempotent", () => {
  const registry = new ActiveRunRegistry();
  const run = registry.start("one", "speaker");
  registry.start("two", "other");
  assert.equal(registry.requestStop("missing", "speaker", "owner"), "idle");
  assert.equal(registry.requestStop("one", "stranger", "owner"), "forbidden");
  assert.equal(registry.requestStop("one", "owner", "owner"), "stopping");
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(registry.requestStop("one", "speaker", "owner"), "already-stopping");
  assert.equal(registry.snapshot("two")?.stopRequested, false);
});

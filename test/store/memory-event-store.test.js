"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { EventStoreError, createMemoryEventStore } = require("../../src/store");

function action(actionId = "action-1", payload = { targetSeatId: "seat-7" }) {
  return { schemaVersion: 1, actionId, gameId: "game-1", actorSeatId: "seat-1", expectedVersion: "visible-version", type: "VOTE_CAST", payload };
}

function event(seq, actionId = "action-1", overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    gameId: "game-1",
    seq,
    type: "VOTE_RECORDED",
    at: "2026-10-23T10:00:00.000Z",
    causationId: actionId,
    payload: { voterSeatId: "seat-1", targetSeatId: "seat-7" },
    ...overrides,
  };
}

function expectCode(code, callback, latestSeq) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof EventStoreError, true);
    assert.equal(error.code, code);
    if (latestSeq !== undefined) assert.equal(error.latestSeq, latestSeq);
    return true;
  });
}

describe("memory event store", () => {
  it("appends batches and returns isolated load results", () => {
    const store = createMemoryEventStore();
    assert.deepEqual(Object.keys(store).sort(), ["append", "eventsAfter", "findAction", "load"]);
    assert.deepEqual(store.load("game-1"), { gameId: "game-1", latestSeq: 0, events: [] });

    const events = [event(1), event(2)];
    const result = store.append("game-1", 0, events, action());
    assert.deepEqual(result, {
      gameId: "game-1",
      previousSeq: 0,
      latestSeq: 2,
      events,
    });

    events[0].payload.targetSeatId = "mutated-input";
    result.events[0].payload.targetSeatId = "mutated-result";
    const loaded = store.load("game-1");
    assert.equal(loaded.events[0].payload.targetSeatId, "seat-7");
    loaded.events[0].payload.targetSeatId = "mutated-load";
    assert.equal(store.load("game-1").events[0].payload.targetSeatId, "seat-7");
  });

  it("returns the first result for an identical retry before checking stale sequence", () => {
    const store = createMemoryEventStore();
    const originalAction = action();
    const first = store.append("game-1", 0, [event(1)], originalAction);
    const reorderedAction = {
      payload: { targetSeatId: "seat-7" },
      type: "VOTE_CAST",
      expectedVersion: "visible-version",
      gameId: "game-1",
      actorSeatId: "seat-1",
      actionId: "action-1",
      schemaVersion: 1,
    };
    const retry = store.append("game-1", 0, [event(1)], reorderedAction);
    assert.deepEqual(retry, first);
    assert.deepEqual(store.findAction("game-1", reorderedAction), first);
    retry.events[0].type = "MUTATED";
    assert.equal(store.append("game-1", 0, [event(1)], originalAction).events[0].type, "VOTE_RECORDED");
  });

  it("rejects actionId reuse with different content", () => {
    const store = createMemoryEventStore();
    store.append("game-1", 0, [event(1)], action());
    expectCode(
      "ACTION_ID_CONFLICT",
      () => store.append("game-1", 0, [event(1)], action("action-1", { targetSeatId: "seat-8" })),
      1,
    );
    assert.equal(store.load("game-1").latestSeq, 1);
  });

  it("uses actionId scope per game", () => {
    const store = createMemoryEventStore();
    store.append("game-1", 0, [event(1)], action());
    const otherAction = { ...action(), gameId: "game-2" };
    const otherEvent = event(1, "action-1", { gameId: "game-2", eventId: "other-1" });
    assert.equal(store.append("game-2", 0, [otherEvent], otherAction).latestSeq, 1);
  });

  it("isolates identical action IDs by the authenticated actor", () => {
    const store = createMemoryEventStore();
    const first = action();
    const second = { ...action(), actorSeatId: "seat-2" };
    store.append("game-1", 0, [event(1)], first);
    assert.equal(store.findAction("game-1", second), null);
    const ownResult = store.append("game-1", 1, [event(2, "action-1", {
      payload: { voterSeatId: "seat-2", targetSeatId: "seat-7" },
    })], second);
    assert.equal(ownResult.latestSeq, 2);
    assert.equal(store.findAction("game-1", first).latestSeq, 1);
    assert.equal(store.findAction("game-1", second).events[0].payload.voterSeatId, "seat-2");
  });

  it("rejects clone failures without leaving events or idempotency records", () => {
    const store = createMemoryEventStore();
    const uncloneableAction = action("bad-action", { callback() {} });
    expectCode("INVALID_REQUEST", () => store.append("game-1", 0, [event(1, "bad-action")], uncloneableAction));
    assert.equal(store.load("game-1").latestSeq, 0);
    assert.equal(store.findAction("game-1", uncloneableAction), null);
    const uncloneableEvent = event(1, "action-1", { payload: { callback() {} } });
    expectCode("INVALID_REQUEST", () => store.append("game-1", 0, [uncloneableEvent], action()));
    assert.equal(store.load("game-1").latestSeq, 0);
    assert.equal(store.append("game-1", 0, [event(1)], action()).latestSeq, 1);
  });

  it("enforces optimistic concurrency before mutating", () => {
    const store = createMemoryEventStore();
    store.append("game-1", 0, [event(1)], action());
    expectCode(
      "SEQUENCE_CONFLICT",
      () => store.append("game-1", 0, [event(1, "action-2")], action("action-2")),
      1,
    );
    assert.equal(store.load("game-1").latestSeq, 1);
  });

  it("validates every event before atomically appending the batch", () => {
    const invalidEvents = [
      [null],
      [[]],
      [event(1, "action-2", { gameId: "other" })],
      [event(2, "action-2")],
      [event(1, "action-2", { eventId: 4 })],
      [event(1, "action-2", { eventId: "" })],
      [event(1, "action-2", { schemaVersion: 2 })],
      [event(1, "action-2", { type: "" })],
      [event(1, "action-2", { type: 4 })],
      [event(1, "action-2", { at: "not-a-time" })],
      [event(1, "action-2", { at: 42 })],
      [event(1, "different-action")],
      [event(1, "action-2"), event(2, "action-2", { eventId: "event-1" })],
    ];

    for (const events of invalidEvents) {
      const store = createMemoryEventStore();
      expectCode("INVALID_EVENT_BATCH", () => store.append("game-1", 0, events, action("action-2")));
      assert.deepEqual(store.load("game-1").events, []);
      assert.equal(store.append("game-1", 0, [event(1, "action-2")], action("action-2")).latestSeq, 1);
    }

    const store = createMemoryEventStore();
    store.append("game-1", 0, [event(1)], action());
    expectCode(
      "INVALID_EVENT_BATCH",
      () => store.append("game-1", 1, [event(2, "action-2", { eventId: "event-1" })], action("action-2")),
    );
    assert.equal(store.load("game-1").latestSeq, 1);
  });

  it("validates append input", () => {
    const cases = [
      ["", 0, [event(1)], action()],
      [4, 0, [event(1)], action()],
      ["game-1", -1, [event(1)], action()],
      ["game-1", 0.5, [event(1)], action()],
      ["game-1", Number.MAX_SAFE_INTEGER + 1, [event(1)], action()],
      ["game-1", 0, null, action()],
      ["game-1", 0, [], action()],
      ["game-1", 0, [event(1)], null],
      ["game-1", 0, [event(1)], []],
      ["game-1", 0, [event(1)], { actionId: 4 }],
      ["game-1", 0, [event(1)], { actionId: "" }],
      ["game-1", 0, [event(1)], { ...action(), gameId: "other" }],
      ["game-1", 0, [event(1)], { ...action(), schemaVersion: 2 }],
      ["game-1", 0, [event(1)], { ...action(), actorSeatId: "" }],
      ["game-1", 0, [event(1)], { ...action(), actorSeatId: 4 }],
      ["game-1", 0, [event(1)], { ...action(), type: "" }],
      ["game-1", 0, [event(1)], { ...action(), type: 4 }],
      ["game-1", 0, [event(1)], { ...action(), expectedVersion: "" }],
      ["game-1", 0, [event(1)], { ...action(), expectedVersion: 4 }],
    ];
    for (const args of cases) {
      const store = createMemoryEventStore();
      expectCode("INVALID_REQUEST", () => store.append(...args));
    }
  });

  it("reads events after a sequence with copy isolation", () => {
    const store = createMemoryEventStore();
    const firstAction = action();
    store.append("game-1", 0, [event(1)], firstAction);
    store.append("game-1", 1, [event(2, "action-2")], action("action-2"));
    assert.deepEqual(store.eventsAfter("game-1", 0).map((item) => item.seq), [1, 2]);
    assert.deepEqual(store.eventsAfter("game-1", 1).map((item) => item.seq), [2]);
    assert.deepEqual(store.eventsAfter("game-1", 2), []);
    const copy = store.eventsAfter("game-1", 0);
    copy[0].type = "MUTATED";
    assert.equal(store.eventsAfter("game-1", 0)[0].type, "VOTE_RECORDED");

    for (const invalid of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
      expectCode("INVALID_REQUEST", () => store.eventsAfter("game-1", invalid));
    }
    expectCode("SEQUENCE_CONFLICT", () => store.eventsAfter("game-1", 3), 2);
    expectCode("INVALID_REQUEST", () => store.eventsAfter("", 0));
    expectCode("INVALID_REQUEST", () => store.load(4));
  });
});

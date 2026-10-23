"use strict";
const assert = require("node:assert/strict");
const { it } = require("node:test");
const { createPersistentRooms } = require("../../src/persistence/room-repository");

function memoryRepository() {
  let record = null;
  let fail = false;
  return {
    load: () => structuredClone(record),
    save(snapshot, { expectedRevision }) {
      if (fail) throw new Error("disk full");
      assert.equal(expectedRevision, record?.revision || 0);
      record = { revision: expectedRevision + 1, snapshot: structuredClone(snapshot) };
      return record;
    },
    fail: () => { fail = true; },
  };
}

it("persists room commands and restores tokens with disconnected seats", () => {
  const repository = memoryRepository();
  const rooms = createPersistentRooms({ repository, clock: () => 1000 });
  const created = rooms.createRoom({ sessionId: "visitor", nickname: "恢复玩家", idempotencyKey: "create" });
  rooms.setReady({ roomId: created.roomId, seatToken: created.seatToken, ready: true, idempotencyKey: "ready" });
  const loaded = createPersistentRooms({ repository, clock: () => 2000 });
  const input = { roomId: created.roomId, seatToken: created.seatToken };
  assert.equal(loaded.getSnapshot(input).seats[0].ready, true);
  assert.equal(loaded.getSnapshot(input).seats[0].connected, false);
  loaded.reconnect(input);
  assert.equal(loaded.getSnapshot(input).seats[0].connected, true);
  assert.equal(loaded.serialize().rooms.length, 1);
  const revision = repository.load().revision;
  loaded.tick();
  assert.equal(repository.load().revision, revision);
});

it("rolls back in-memory changes if the atomic database commit fails", () => {
  const repository = memoryRepository();
  const rooms = createPersistentRooms({ repository });
  const created = rooms.createRoom({ sessionId: "visitor", nickname: "玩家", idempotencyKey: "create" });
  const input = { roomId: created.roomId, seatToken: created.seatToken };
  repository.fail();
  assert.throws(() => rooms.setReady({ ...input, ready: true, idempotencyKey: "ready" }), /disk full/);
  assert.equal(rooms.getSnapshot(input).seats[0].ready, false);
});

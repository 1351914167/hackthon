"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const { COMMANDS, ROLE_DECK, createInitialState, decide, replay } = require("../../src/game");
const { createMemoryEventStore } = require("../../src/store");
const { projectForViewer } = require("../../src/projection");

it("retries an authenticated intent before deciding against a newer authority sequence", () => {
  const seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `seat-${index + 1}`, ready: true }));
  const initial = createInitialState({ roomId: "room-1", gameId: "game-1", hostSeatId: "seat-1", seats });
  const roleAssignments = Object.fromEntries(seats.map((seat, index) => [seat.seatId, ROLE_DECK[index]]));
  const store = createMemoryEventStore();
  let state = initial;
  let decisions = 0;

  // This is the application boundary: authenticate actor, resolve retry, verify
  // the actor's visible version, then inject the internal sequence into decide.
  function dispatch(intent) {
    const cached = store.findAction(state.gameId, intent);
    if (cached) return cached;
    const view = projectForViewer(state, { type: "PLAYER", seatId: intent.actorSeatId });
    if (intent.expectedVersion !== view.version) throw new Error("VIEW_CONFLICT");
    const command = { ...intent, expectedSeq: state.seq };
    const events = decide(state, command, { at: "2026-10-23T10:00:00.000Z", roleAssignments });
    decisions += 1;
    const next = replay(state, events);
    const result = store.append(state.gameId, state.seq, events, intent);
    state = next;
    return result;
  }

  const intent = {
    schemaVersion: 1,
    gameId: initial.gameId,
    actorSeatId: "seat-1",
    actionId: "start-1",
    type: COMMANDS.GAME_START,
    expectedVersion: projectForViewer(state, { type: "PLAYER", seatId: "seat-1" }).version,
    payload: {},
  };
  const first = dispatch(intent);
  assert.equal(first.events.length, 11);
  assert.deepEqual(dispatch(structuredClone(intent)), first);
  assert.equal(decisions, 1);
  assert.equal(store.load(state.gameId).latestSeq, 11);
  assert.deepEqual(replay(initial, store.load(state.gameId).events), state);

  assert.throws(() => dispatch({ ...intent, payload: { changed: true } }), { code: "ACTION_ID_CONFLICT" });
  assert.throws(() => dispatch({ ...intent, actorSeatId: "seat-2" }), /VIEW_CONFLICT/);
  assert.throws(() => dispatch({ ...intent, actionId: "start-2" }), /VIEW_CONFLICT/);
  assert.equal(store.load(state.gameId).latestSeq, 11);
});

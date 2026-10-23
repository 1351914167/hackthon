"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  COMMANDS,
  EVENTS,
  GameRuleError,
  PHASES,
  ROLES,
  ROLE_DECK,
  RULESET_ID,
  SCHEMA_VERSION,
  TEAMS,
  assertInvariant,
  createInitialState,
  decide,
  determineWinner,
  evolve,
  replay,
  roleTeam,
} = require("../../src/game");

const AT = "2026-10-23T10:00:00.000Z";
const DEADLINE = "2026-10-23T10:01:00.000Z";
const seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `seat-${index + 1}`, ready: true }));
const roles = {
  "seat-1": ROLES.WEREWOLF,
  "seat-2": ROLES.WEREWOLF,
  "seat-3": ROLES.WEREWOLF,
  "seat-4": ROLES.SEER,
  "seat-5": ROLES.WITCH,
  "seat-6": ROLES.HUNTER,
  "seat-7": ROLES.VILLAGER,
  "seat-8": ROLES.VILLAGER,
  "seat-9": ROLES.VILLAGER,
};

let actionNumber = 0;

function command(state, type, actorSeatId, payload = {}) {
  actionNumber += 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    actionId: `action-${actionNumber}`,
    gameId: state.gameId,
    expectedSeq: state.seq,
    type,
    actorSeatId,
    payload,
  };
}

function context(extra = {}) {
  return { at: AT, deadlineAt: DEADLINE, ...extra };
}

function apply(state, type, actorSeatId, payload = {}, extraContext = {}) {
  const input = command(state, type, actorSeatId, payload);
  const events = decide(state, input, context(extraContext));
  return { state: replay(state, events), events, command: input };
}

function initial(overrides = {}) {
  return createInitialState({
    roomId: "room-1",
    gameId: "game-1",
    hostSeatId: "seat-1",
    seats,
    ...overrides,
  });
}

function started() {
  const state = initial();
  return apply(state, COMMANDS.GAME_START, "seat-1", {}, { roleAssignments: roles }).state;
}

function inPhase(phase, overrides = {}) {
  const state = started();
  state.phase = phase;
  state.round = phase === PHASES.ROLE_REVEAL ? 0 : 1;
  state.deadlineAt = DEADLINE;
  Object.assign(state, structuredClone(overrides));
  assertInvariant(state);
  return state;
}

function dead(state, seatId, reasons = ["EXILED"]) {
  state.seats.find((seat) => seat.seatId === seatId).alive = false;
  state.deaths.push({ seatId, reasons, round: state.round });
  return state;
}

function timeout(state) {
  return apply(state, COMMANDS.PHASE_TIMEOUT, undefined, {}, { trusted: true });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error instanceof GameRuleError && error.code === code);
}

describe("state creation and invariants", () => {
  it("creates the standard lobby and exports stable constants", () => {
    const state = initial();
    assert.equal(state.phase, PHASES.LOBBY);
    assert.equal(state.seats.length, 9);
    assert.equal(state.witchInventory.antidote, 1);
    assert.equal(ROLE_DECK.length, 9);
    assert.equal(RULESET_ID, "standard-9-v1");
    assert.equal(roleTeam(ROLES.WEREWOLF), TEAMS.WEREWOLF);
    assert.equal(roleTeam(ROLES.SEER), TEAMS.GOOD);
    assert.equal(assertInvariant(state), true);
  });

  it("rejects invalid initial state inputs", () => {
    for (const overrides of [
      { roomId: "" },
      { gameId: "" },
      { hostSeatId: "" },
      { rulesetId: "future" },
      { seats: seats.slice(0, 8) },
      { seats: [...seats.slice(0, 8), { seatId: "seat-8" }] },
      { seats: [...seats.slice(0, 8), { seatId: "" }] },
      { hostSeatId: "seat-99" },
    ]) expectCode("INVALID_REQUEST", () => initial(overrides));
  });

  it("rejects corrupted state invariants", () => {
    const cases = [
      (state) => { state.schemaVersion = 2; },
      (state) => { state.phase = "UNKNOWN"; },
      (state) => { state.seq = -1; },
      (state) => { state.seats.pop(); },
      (state) => { state.seats[1].seatId = "seat-1"; },
      (state) => { state.hostSeatId = "missing"; },
      (state) => { state.seats[0].alive = "yes"; },
      (state) => { state.witchInventory.antidote = 2; },
      (state) => { state.roles = { "missing-seat": ROLES.SEER }; },
    ];
    for (const corrupt of cases) {
      const state = initial();
      corrupt(state);
      expectCode("INVALID_STATE", () => assertInvariant(state));
    }

    const badDeck = started();
    badDeck.roles["seat-9"] = ROLES.SEER;
    expectCode("INVALID_STATE", () => assertInvariant(badDeck));

    const duplicateDeath = started();
    dead(duplicateDeath, "seat-7");
    duplicateDeath.deaths.push(structuredClone(duplicateDeath.deaths[0]));
    expectCode("INVALID_STATE", () => assertInvariant(duplicateDeath));

    const mismatchedAlive = started();
    mismatchedAlive.seats[0].alive = false;
    expectCode("INVALID_STATE", () => assertInvariant(mismatchedAlive));

    const winnerInProgress = started();
    winnerInProgress.winner = TEAMS.GOOD;
    expectCode("INVALID_STATE", () => assertInvariant(winnerInProgress));

    const gameOverWithoutWinner = started();
    gameOverWithoutWinner.phase = PHASES.GAME_OVER;
    expectCode("INVALID_STATE", () => assertInvariant(gameOverWithoutWinner));
  });
});

describe("lobby and game start", () => {
  it("records ready state, starts only by host, and replays deterministically", () => {
    let state = initial({ seats: seats.map((seat) => ({ ...seat, ready: false })) });
    const readyResult = apply(state, COMMANDS.ROOM_READY_SET, "seat-1", { ready: true });
    assert.equal(readyResult.events[0].type, EVENTS.PRIVATE_ACTION_RECORDED);
    assert.equal(readyResult.state.seats[0].ready, true);
    state = initial();
    const startCommand = command(state, COMMANDS.GAME_START, "seat-1");
    const events = decide(state, startCommand, context({ roleAssignments: roles }));
    const next = replay(state, events);
    assert.deepEqual(replay(state, events), next);
    assert.equal(events.length, 11);
    assert.equal(events[0].type, EVENTS.GAME_STARTED);
    assert.equal(events.at(-1).type, EVENTS.PHASE_CHANGED);
    assert.equal(next.phase, PHASES.ROLE_REVEAL);
    assert.deepEqual(next.roles, roles);
    assert.equal(next.seq, 11);
    assert.equal(events[0].eventId, "game-1:1");
    assert.equal(events[0].causationId, startCommand.actionId);
  });

  it("validates lobby commands and trusted role assignments", () => {
    const notReady = initial({ seats: seats.map((seat, index) => ({ ...seat, ready: index !== 8 })) });
    expectCode("ACTION_NOT_ALLOWED", () => apply(notReady, COMMANDS.GAME_START, "seat-1", {}, { roleAssignments: roles }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(initial(), COMMANDS.GAME_START, "seat-2", {}, { roleAssignments: roles }));
    expectCode("INVALID_REQUEST", () => apply(initial(), COMMANDS.GAME_START, "seat-1", {}, { roleAssignments: null }));
    expectCode("INVALID_REQUEST", () => apply(initial(), COMMANDS.GAME_START, "seat-1", {}, { roleAssignments: [] }));
    expectCode("INVALID_REQUEST", () => apply(initial(), COMMANDS.GAME_START, "seat-1", {}, { roleAssignments: { ...roles, "seat-9": ROLES.SEER } }));
    expectCode("INVALID_REQUEST", () => apply(initial(), COMMANDS.ROOM_READY_SET, "seat-1", { ready: "yes" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(initial(), COMMANDS.ROOM_READY_SET, "missing", { ready: true }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(started(), COMMANDS.ROOM_READY_SET, "seat-1", { ready: true }));
  });
});

describe("command envelopes", () => {
  it("rejects malformed, stale, cross-game, and unknown commands", () => {
    const state = initial();
    const base = command(state, COMMANDS.ROOM_READY_SET, "seat-1", { ready: true });
    for (const bad of [
      null,
      { ...base, schemaVersion: 2 },
      { ...base, actionId: "" },
      { ...base, gameId: "other" },
      { ...base, expectedSeq: 99 },
      { ...base, type: "UNKNOWN" },
    ]) {
      const code = bad?.expectedSeq === 99 ? "SEQUENCE_CONFLICT" : "INVALID_REQUEST";
      expectCode(code, () => decide(state, bad, context()));
    }
    expectCode("INVALID_REQUEST", () => decide(state, base, {}));
  });
});

describe("night actions", () => {
  it("moves from reveal through wolf targeting and applies strict majority", () => {
    let state = started();
    state = timeout(state).state;
    assert.equal(state.phase, PHASES.NIGHT_WOLF);
    assert.equal(state.round, 1);

    state = apply(state, COMMANDS.WOLF_TARGET_SET, "seat-1", { targetSeatId: "seat-7" }).state;
    state = apply(state, COMMANDS.WOLF_TARGET_SET, "seat-2", { targetSeatId: "seat-8" }).state;
    state = apply(state, COMMANDS.WOLF_TARGET_SET, "seat-2", { targetSeatId: "seat-7" }).state;
    state = apply(state, COMMANDS.WOLF_TARGET_SET, "seat-3", { targetSeatId: null }).state;
    state = timeout(state).state;
    assert.equal(state.phase, PHASES.NIGHT_WITCH);
    assert.equal(state.night.wolfAttackTarget, "seat-7");

    const noMajority = inPhase(PHASES.NIGHT_WOLF, {
      night: { wolfTargets: { "seat-1": "seat-7", "seat-2": "seat-8", "seat-3": "seat-9" }, wolfAttackTarget: null, witchAction: null, seerTarget: null },
    });
    assert.equal(timeout(noMajority).state.night.wolfAttackTarget, null);
  });

  it("rejects illegal wolf actions", () => {
    const state = inPhase(PHASES.NIGHT_WOLF);
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.WOLF_TARGET_SET, "seat-4", { targetSeatId: "seat-7" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.WOLF_TARGET_SET, "seat-1", { targetSeatId: "seat-1" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.WOLF_TARGET_SET, "seat-1", { targetSeatId: "missing" }));
    const deadWolf = dead(structuredClone(state), "seat-1");
    expectCode("ACTION_NOT_ALLOWED", () => apply(deadWolf, COMMANDS.WOLF_TARGET_SET, "seat-1", { targetSeatId: "seat-7" }));
  });

  it("supports witch skip, first-night self-save, poison, and inventory rules", () => {
    let save = inPhase(PHASES.NIGHT_WITCH);
    save.night.wolfAttackTarget = "seat-5";
    save = apply(save, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "SAVE" }).state;
    assert.deepEqual(save.night.witchAction, { kind: "SAVE", targetSeatId: "seat-5" });

    let poison = inPhase(PHASES.NIGHT_WITCH);
    poison = apply(poison, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "POISON", targetSeatId: "seat-7" }).state;
    assert.deepEqual(poison.night.witchAction, { kind: "POISON", targetSeatId: "seat-7" });
    assert.deepEqual(apply(poison, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "SKIP" }).state.night.witchAction, { kind: "SKIP" });

    const secondNightSelfSave = inPhase(PHASES.NIGHT_WITCH, { round: 2 });
    secondNightSelfSave.night.wolfAttackTarget = "seat-5";
    expectCode("ACTION_NOT_ALLOWED", () => apply(secondNightSelfSave, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "SAVE" }));
    const noAttack = inPhase(PHASES.NIGHT_WITCH);
    expectCode("ACTION_NOT_ALLOWED", () => apply(noAttack, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "SAVE" }));
    const noAntidote = inPhase(PHASES.NIGHT_WITCH, { witchInventory: { antidote: 0, poison: 1 } });
    noAntidote.night.wolfAttackTarget = "seat-7";
    expectCode("ACTION_NOT_ALLOWED", () => apply(noAntidote, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "SAVE" }));
    const noPoison = inPhase(PHASES.NIGHT_WITCH, { witchInventory: { antidote: 1, poison: 0 } });
    expectCode("ACTION_NOT_ALLOWED", () => apply(noPoison, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "POISON", targetSeatId: "seat-7" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(poison, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "POISON", targetSeatId: "seat-5" }));
    expectCode("INVALID_REQUEST", () => apply(poison, COMMANDS.WITCH_ACTION_SET, "seat-5", { kind: "BOTH" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(poison, COMMANDS.WITCH_ACTION_SET, "seat-4", { kind: "SKIP" }));
  });

  it("records only the seer's final target at timeout", () => {
    let state = inPhase(PHASES.NIGHT_SEER);
    state = apply(state, COMMANDS.SEER_TARGET_SET, "seat-4", { targetSeatId: "seat-1" }).state;
    state = apply(state, COMMANDS.SEER_TARGET_SET, "seat-4", { targetSeatId: "seat-7" }).state;
    const result = timeout(state);
    assert.equal(result.events.filter((event) => event.type === EVENTS.SEER_RESULT_RECORDED).length, 1);
    assert.deepEqual(result.state.seerResults[0], {
      seerSeatId: "seat-4",
      targetSeatId: "seat-7",
      team: TEAMS.GOOD,
      round: 1,
    });

    const skipped = timeout(inPhase(PHASES.NIGHT_SEER));
    assert.equal(skipped.events.some((event) => event.type === EVENTS.SEER_RESULT_RECORDED), false);
    expectCode("ACTION_NOT_ALLOWED", () => apply(inPhase(PHASES.NIGHT_SEER), COMMANDS.SEER_TARGET_SET, "seat-5", { targetSeatId: "seat-1" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(inPhase(PHASES.NIGHT_SEER), COMMANDS.SEER_TARGET_SET, "seat-4", { targetSeatId: "seat-4" }));
  });

  it("moves from witch to seer on timeout", () => {
    const result = timeout(inPhase(PHASES.NIGHT_WITCH));
    assert.equal(result.state.phase, PHASES.NIGHT_SEER);
  });
});

describe("dawn resolution", () => {
  it("saves a wolf target and consumes only the antidote", () => {
    const state = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: "seat-7", witchAction: { kind: "SAVE", targetSeatId: "seat-7" }, seerTarget: null },
    });
    const result = timeout(state);
    assert.equal(result.state.phase, PHASES.DAY_SPEECH);
    assert.equal(result.state.deaths.length, 0);
    assert.deepEqual(result.state.witchInventory, { antidote: 0, poison: 1 });
  });

  it("resolves wolf attack and poison simultaneously in seat order", () => {
    const state = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: "seat-8", witchAction: { kind: "POISON", targetSeatId: "seat-7" }, seerTarget: null },
    });
    const result = timeout(state);
    assert.deepEqual(result.state.deaths.map((death) => death.seatId), ["seat-7", "seat-8"]);
    assert.deepEqual(result.state.witchInventory, { antidote: 1, poison: 0 });
    assert.equal(result.state.phase, PHASES.DAY_SPEECH);
  });

  it("does not let a poisoned hunter shoot, including combined causes", () => {
    const poisoned = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: null, witchAction: { kind: "POISON", targetSeatId: "seat-6" }, seerTarget: null },
    });
    assert.equal(timeout(poisoned).state.phase, PHASES.DAY_SPEECH);

    const combined = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: "seat-6", witchAction: { kind: "POISON", targetSeatId: "seat-6" }, seerTarget: null },
    });
    const result = timeout(combined);
    assert.equal(result.state.phase, PHASES.DAY_SPEECH);
    assert.deepEqual(result.state.deaths[0].reasons, ["WOLF_ATTACK", "WITCH_POISON"]);
  });

  it("puts a wolf-killed hunter into pending before victory", () => {
    const state = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: "seat-6", witchAction: null, seerTarget: null },
    });
    const result = timeout(state);
    assert.equal(result.state.phase, PHASES.HUNTER_SHOT);
    assert.deepEqual(result.state.pendingHunter, { seatId: "seat-6", resumePhase: PHASES.DAY_SPEECH });
    assert.equal(result.state.winner, null);
  });

  it("finishes at dawn when poison kills the last wolf and consumes poison", () => {
    const state = inPhase(PHASES.NIGHT_SEER, {
      night: { wolfTargets: {}, wolfAttackTarget: null, witchAction: { kind: "POISON", targetSeatId: "seat-3" }, seerTarget: null },
    });
    dead(state, "seat-1");
    dead(state, "seat-2");
    const result = timeout(state).state;
    assert.equal(result.phase, PHASES.GAME_OVER);
    assert.equal(result.winner, TEAMS.GOOD);
    assert.equal(result.witchInventory.poison, 0);
  });
});

describe("speech and voting", () => {
  it("advances speech in seat order by finish or timeout", () => {
    let state = inPhase(PHASES.DAY_SPEECH, {
      speechOrder: ["seat-1", "seat-2"],
      speechIndex: 0,
    });
    state = apply(state, COMMANDS.SPEECH_FINISH, "seat-1").state;
    assert.equal(state.phase, PHASES.DAY_SPEECH);
    assert.equal(state.speechIndex, 1);
    state = timeout(state).state;
    assert.equal(state.phase, PHASES.DAY_VOTE);
    assert.deepEqual(state.votes, {});

    const wrongSpeaker = inPhase(PHASES.DAY_SPEECH, { speechOrder: ["seat-1"], speechIndex: 0 });
    expectCode("ACTION_NOT_ALLOWED", () => apply(wrongSpeaker, COMMANDS.SPEECH_FINISH, "seat-2"));
  });

  it("records changed votes and reveals a unique winner", () => {
    let state = inPhase(PHASES.DAY_VOTE);
    state = apply(state, COMMANDS.VOTE_CAST, "seat-4", { targetSeatId: "seat-1" }).state;
    state = apply(state, COMMANDS.VOTE_CAST, "seat-4", { targetSeatId: "seat-2" }).state;
    state = apply(state, COMMANDS.VOTE_CAST, "seat-5", { targetSeatId: "seat-2" }).state;
    state = apply(state, COMMANDS.VOTE_CAST, "seat-6", { targetSeatId: null }).state;
    const result = timeout(state);
    assert.equal(result.state.deaths[0].seatId, "seat-2");
    assert.equal(result.state.voteHistory[0].exiledSeatId, "seat-2");
    assert.equal(result.state.voteHistory[0].ballots.length, 9);
    assert.equal(result.state.phase, PHASES.NIGHT_WOLF);
    assert.equal(result.state.round, 2);
  });

  it("does not exile on a tie or no votes", () => {
    let tied = inPhase(PHASES.DAY_VOTE);
    tied = apply(tied, COMMANDS.VOTE_CAST, "seat-4", { targetSeatId: "seat-1" }).state;
    tied = apply(tied, COMMANDS.VOTE_CAST, "seat-5", { targetSeatId: "seat-2" }).state;
    assert.equal(timeout(tied).state.voteHistory[0].exiledSeatId, null);
    assert.equal(timeout(inPhase(PHASES.DAY_VOTE)).state.voteHistory[0].exiledSeatId, null);
  });

  it("rejects illegal votes", () => {
    const state = inPhase(PHASES.DAY_VOTE);
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.VOTE_CAST, "seat-1", { targetSeatId: "seat-1" }));
    const deadVoter = dead(structuredClone(state), "seat-7");
    expectCode("ACTION_NOT_ALLOWED", () => apply(deadVoter, COMMANDS.VOTE_CAST, "seat-7", { targetSeatId: "seat-1" }));
  });
});

describe("hunter and victory", () => {
  it("lets an exiled hunter shoot before deciding the game", () => {
    let state = inPhase(PHASES.DAY_VOTE);
    for (const voter of ["seat-1", "seat-2", "seat-3"]) {
      state = apply(state, COMMANDS.VOTE_CAST, voter, { targetSeatId: "seat-6" }).state;
    }
    state = timeout(state).state;
    assert.equal(state.phase, PHASES.HUNTER_SHOT);
    assert.equal(state.pendingHunter.resumePhase, PHASES.NIGHT_WOLF);
    state = apply(state, COMMANDS.HUNTER_SHOT_SET, "seat-6", { targetSeatId: "seat-1" }).state;
    assert.equal(state.seats.find((seat) => seat.seatId === "seat-1").alive, false);
    assert.equal(state.phase, PHASES.NIGHT_WOLF);
  });

  it("waits for hunter and lets the shot kill the last wolf", () => {
    let state = inPhase(PHASES.HUNTER_SHOT, {
      pendingHunter: { seatId: "seat-6", resumePhase: PHASES.DAY_SPEECH },
    });
    dead(state, "seat-6", ["WOLF_ATTACK"]);
    dead(state, "seat-1");
    dead(state, "seat-2");
    state = apply(state, COMMANDS.HUNTER_SHOT_SET, "seat-6", { targetSeatId: "seat-3" }).state;
    assert.equal(state.phase, PHASES.GAME_OVER);
    assert.equal(state.winner, TEAMS.GOOD);
    assert.equal(state.finishReason, "ALL_WEREWOLVES_DEAD");
  });

  it("supports hunter give-up and timeout, then applies wolf parity", () => {
    for (const useTimeout of [false, true]) {
      let state = inPhase(PHASES.HUNTER_SHOT, {
        pendingHunter: { seatId: "seat-6", resumePhase: PHASES.NIGHT_WOLF },
      });
      dead(state, "seat-6", ["EXILED"]);
      for (const goodSeat of ["seat-4", "seat-5", "seat-7"]) dead(state, goodSeat);
      state = useTimeout
        ? timeout(state).state
        : apply(state, COMMANDS.HUNTER_SHOT_SET, "seat-6", { targetSeatId: null }).state;
      assert.equal(state.phase, PHASES.GAME_OVER);
      assert.equal(state.winner, TEAMS.WEREWOLF);
      assert.equal(state.finishReason, "WEREWOLF_PARITY");
    }
  });

  it("resumes the pending phase after a hunter timeout without a winner", () => {
    const state = inPhase(PHASES.HUNTER_SHOT, {
      pendingHunter: { seatId: "seat-6", resumePhase: PHASES.DAY_SPEECH },
    });
    dead(state, "seat-6", ["WOLF_ATTACK"]);
    const result = timeout(state).state;
    assert.equal(result.phase, PHASES.DAY_SPEECH);
    assert.equal(result.pendingHunter, null);
  });

  it("rejects a non-pending hunter action and invalid target", () => {
    const state = inPhase(PHASES.HUNTER_SHOT, {
      pendingHunter: { seatId: "seat-6", resumePhase: PHASES.DAY_SPEECH },
    });
    dead(state, "seat-6", ["WOLF_ATTACK"]);
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.HUNTER_SHOT_SET, "seat-5", { targetSeatId: "seat-1" }));
    expectCode("ACTION_NOT_ALLOWED", () => apply(state, COMMANDS.HUNTER_SHOT_SET, "seat-6", { targetSeatId: "seat-6" }));
  });

  it("computes all winner branches", () => {
    const goodWin = started();
    dead(goodWin, "seat-1");
    dead(goodWin, "seat-2");
    dead(goodWin, "seat-3");
    assert.deepEqual(determineWinner(goodWin), { winner: TEAMS.GOOD, reason: "ALL_WEREWOLVES_DEAD" });

    const wolfWin = started();
    for (const seatId of ["seat-4", "seat-5", "seat-6"]) dead(wolfWin, seatId);
    assert.deepEqual(determineWinner(wolfWin), { winner: TEAMS.WEREWOLF, reason: "WEREWOLF_PARITY" });
    assert.equal(determineWinner(started()), null);
  });
});

describe("events and replay safety", () => {
  function validEvent(state, type, payload = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: `manual-${state.seq + 1}`,
      gameId: state.gameId,
      seq: state.seq + 1,
      type,
      at: AT,
      causationId: "manual-action",
      payload,
    };
  }

  it("rejects malformed and unknown events", () => {
    const state = initial();
    const base = validEvent(state, EVENTS.GAME_STARTED, { rulesetId: RULESET_ID });
    for (const bad of [
      null,
      { ...base, schemaVersion: 2 },
      { ...base, gameId: "other" },
      { ...base, seq: 2 },
      { ...base, eventId: "" },
      { ...base, at: "" },
      { ...base, causationId: "" },
      { ...base, type: "UNKNOWN" },
    ]) expectCode("INVALID_EVENT", () => evolve(state, bad));
    expectCode("INVALID_EVENT", () => evolve(started(), validEvent(started(), EVENTS.GAME_STARTED, { rulesetId: RULESET_ID })));
    expectCode("INVALID_EVENT", () => evolve(state, validEvent(state, EVENTS.GAME_STARTED, { rulesetId: "other" })));
  });

  it("validates role, death, finish, reveal, and phase events", () => {
    const lobby = initial();
    for (const payload of [
      { seatId: "missing", role: ROLES.SEER, team: TEAMS.GOOD },
      { seatId: "seat-1", role: "UNKNOWN", team: TEAMS.GOOD },
      { seatId: "seat-1", role: ROLES.WEREWOLF, team: TEAMS.GOOD },
    ]) expectCode("INVALID_EVENT", () => evolve(lobby, validEvent(lobby, EVENTS.ROLE_ASSIGNED, payload)));

    const withRole = evolve(lobby, validEvent(lobby, EVENTS.ROLE_ASSIGNED, { seatId: "seat-1", role: ROLES.WEREWOLF, team: TEAMS.WEREWOLF }));
    expectCode("INVALID_EVENT", () => evolve(withRole, validEvent(withRole, EVENTS.ROLE_ASSIGNED, { seatId: "seat-1", role: ROLES.WEREWOLF, team: TEAMS.WEREWOLF })));

    const live = started();
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.PLAYER_DIED, { seatId: "missing", reasons: ["EXILED"] })));
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.PLAYER_DIED, { seatId: "seat-7", reasons: [] })));
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.GAME_FINISHED, { winner: "OTHER", reason: "x" })));
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.ROLES_REVEALED, { roles })));
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.PHASE_CHANGED, { phase: "OTHER", round: 1 })));
    expectCode("INVALID_EVENT", () => evolve(live, validEvent(live, EVENTS.PHASE_CHANGED, { phase: PHASES.DAY_VOTE, round: 1 })));
    expectCode("INVALID_EVENT", () => evolve(lobby, validEvent(lobby, EVENTS.PHASE_CHANGED, { phase: PHASES.ROLE_REVEAL, round: 0 })));

    const gameOver = structuredClone(live);
    gameOver.phase = PHASES.GAME_OVER;
    gameOver.winner = TEAMS.GOOD;
    gameOver.finishReason = "ALL_WEREWOLVES_DEAD";
    expectCode("INVALID_EVENT", () => evolve(gameOver, validEvent(gameOver, EVENTS.ROLES_REVEALED, { roles: { ...roles, "seat-9": ROLES.SEER } })));
    expectCode("INVALID_EVENT", () => evolve(gameOver, validEvent(gameOver, EVENTS.ROLES_REVEALED, { roles: null })));

    const reorderedRoles = Object.fromEntries(Object.entries(roles).reverse());
    assert.deepEqual(evolve(gameOver, validEvent(gameOver, EVENTS.ROLES_REVEALED, { roles: reorderedRoles })).roles, roles);
  });

  it("validates private result event payloads", () => {
    const seer = inPhase(PHASES.NIGHT_SEER);
    const seerPayload = { seerSeatId: "seat-4", targetSeatId: "seat-1", team: TEAMS.WEREWOLF, round: 1 };
    const withResult = evolve(seer, validEvent(seer, EVENTS.SEER_RESULT_RECORDED, seerPayload));
    for (const payload of [
      { ...seerPayload, seerSeatId: "seat-5" },
      { ...seerPayload, targetSeatId: "missing" },
      { ...seerPayload, team: TEAMS.GOOD },
      { ...seerPayload, round: 2 },
    ]) expectCode("INVALID_EVENT", () => evolve(seer, validEvent(seer, EVENTS.SEER_RESULT_RECORDED, payload)));
    expectCode("INVALID_EVENT", () => evolve(withResult, validEvent(withResult, EVENTS.SEER_RESULT_RECORDED, seerPayload)));
    expectCode("INVALID_EVENT", () => evolve(started(), validEvent(started(), EVENTS.SEER_RESULT_RECORDED, seerPayload)));

    const vote = inPhase(PHASES.DAY_VOTE);
    const votePayload = { voterSeatId: "seat-4", targetSeatId: "seat-1" };
    assert.equal(evolve(vote, validEvent(vote, EVENTS.VOTE_RECORDED, votePayload)).votes["seat-4"], "seat-1");
    for (const payload of [
      { voterSeatId: "missing", targetSeatId: "seat-1" },
      { voterSeatId: "seat-4", targetSeatId: "missing" },
      { voterSeatId: "seat-4", targetSeatId: "seat-4" },
    ]) expectCode("INVALID_EVENT", () => evolve(vote, validEvent(vote, EVENTS.VOTE_RECORDED, payload)));
    expectCode("INVALID_EVENT", () => evolve(started(), validEvent(started(), EVENTS.VOTE_RECORDED, votePayload)));
    assert.equal(evolve(vote, validEvent(vote, EVENTS.VOTE_RECORDED, { voterSeatId: "seat-4", targetSeatId: null })).votes["seat-4"], null);

    const voteResult = { round: 1, ballots: [], exiledSeatId: null };
    assert.equal(evolve(vote, validEvent(vote, EVENTS.VOTE_RESULT_REVEALED, voteResult)).voteHistory.length, 1);
    for (const payload of [
      { ...voteResult, round: 2 },
      { ...voteResult, ballots: null },
    ]) expectCode("INVALID_EVENT", () => evolve(vote, validEvent(vote, EVENTS.VOTE_RESULT_REVEALED, payload)));
    expectCode("INVALID_EVENT", () => evolve(started(), validEvent(started(), EVENTS.VOTE_RESULT_REVEALED, voteResult)));
  });

  it("rejects unknown private actions and non-array replay", () => {
    const state = initial();
    expectCode("INVALID_EVENT", () => evolve(state, validEvent(state, EVENTS.PRIVATE_ACTION_RECORDED, { actionType: "UNKNOWN" })));
    expectCode("INVALID_REQUEST", () => replay(state, null));
  });

  it("uses safe defaults for optional event payload fields", () => {
    const lobby = initial();
    expectCode("INVALID_EVENT", () => evolve(lobby, { ...validEvent(lobby, EVENTS.GAME_STARTED), payload: undefined }));

    const speech = inPhase(PHASES.DAY_SPEECH, { speechOrder: ["seat-1"], speechIndex: 0 });
    const event = validEvent(speech, EVENTS.PHASE_CHANGED, { phase: PHASES.DAY_SPEECH, round: 1 });
    const next = evolve(speech, event);
    assert.deepEqual(next.speechOrder, ["seat-1"]);
    assert.equal(next.speechIndex, 0);
    assert.equal(next.deadlineAt, null);

    const reveal = started();
    const noDeadline = apply(reveal, COMMANDS.PHASE_TIMEOUT, undefined, {}, { trusted: true, deadlineAt: null });
    assert.equal(noDeadline.state.deadlineAt, null);
  });

  it("rejects untrusted or invalid phase timeouts", () => {
    const timed = started();
    expectCode("ACTION_NOT_ALLOWED", () => apply(timed, COMMANDS.PHASE_TIMEOUT));
    const lobby = initial();
    expectCode("ACTION_NOT_ALLOWED", () => timeout(lobby));
  });
});

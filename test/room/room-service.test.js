"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { COMMANDS, PHASES, ROLES, TEAMS } = require("../../src/game");
const { RoomServiceError, createRoomService } = require("../../src/room");

function harness(overrides = {}) {
  let now = Date.parse("2026-10-23T10:00:00.000Z");
  let idNumber = 0;
  let tokenNumber = 0;
  const service = createRoomService({
    clock: () => now,
    randomInt: () => 0,
    createId: (kind) => `${kind}-${++idNumber}`,
    createToken: () => `seat-token-${String(++tokenNumber).padStart(8, "0")}`,
    durations: Object.fromEntries(Object.values(PHASES).map((phase) => [phase, 100])),
    ...overrides,
  });
  return {
    service,
    now: () => now,
    setNow: (value) => { now = value; },
    advance: (milliseconds) => { now += milliseconds; },
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function createNine(testHarness) {
  const { service } = testHarness;
  const first = service.createRoom({ sessionId: "session-1", nickname: "Player 1", idempotencyKey: "create-1" });
  const players = [{ seatId: "seat-1", token: first.seatToken }];
  for (let number = 2; number <= 9; number += 1) {
    const joined = service.joinRoom({
      roomId: first.roomId,
      sessionId: `session-${number}`,
      nickname: `Player ${number}`,
      idempotencyKey: `join-${number}`,
    });
    players.push({ seatId: `seat-${number}`, token: joined.seatToken });
  }
  for (const [index, player] of players.entries()) {
    service.setReady({
      roomId: first.roomId,
      seatToken: player.token,
      ready: true,
      idempotencyKey: `ready-${index + 1}`,
    });
  }
  return { roomId: first.roomId, players };
}

function startNine(testHarness) {
  const { roomId, players } = createNine(testHarness);
  const result = testHarness.service.startGame({
    roomId,
    seatToken: players[0].token,
    idempotencyKey: "start-game",
  });
  return { roomId, players, gameId: result.gameId, snapshot: result.snapshot };
}

function snapshot(service, roomId, player) {
  return service.getSnapshot({ roomId, seatToken: player.token });
}

function dispatch(service, roomId, player, gameId, type, payload = {}, actionId = `${type}-${player.seatId}`) {
  const visible = snapshot(service, roomId, player);
  return service.dispatchAction({
    roomId,
    seatToken: player.token,
    action: { schemaVersion: 1, actionId, gameId, expectedVersion: visible.version, type, payload },
  });
}

function tickDeadline(testHarness, roomId) {
  const current = testHarness.service.getSnapshot({ roomId });
  const deadline = Date.parse(current.game.deadlineAt);
  testHarness.setNow(deadline);
  const result = testHarness.service.tick();
  assert.equal(result.length, 1);
  return testHarness.service.getSnapshot({ roomId });
}

function playersByRole(service, roomId, players) {
  return Object.fromEntries(players.map((player) => [snapshot(service, roomId, player).game.self.role, player]));
}

function playGoodVictory(testHarness, game) {
  const { service } = testHarness;
  if (service.getSnapshot({ roomId: game.roomId }).game.phase === PHASES.ROLE_REVEAL) tickDeadline(testHarness, game.roomId);
  const getWolves = () => game.players.filter((player) => snapshot(service, game.roomId, player).game.self.role === ROLES.WEREWOLF && snapshot(service, game.roomId, player).game.self.alive);
  for (let round = 1; round <= 3; round += 1) {
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    let publicState = tickDeadline(testHarness, game.roomId);
    while (publicState.game.phase === PHASES.DAY_SPEECH) publicState = tickDeadline(testHarness, game.roomId);
    const target = getWolves()[0];
    const voters = game.players.filter((player) => player.seatId !== target.seatId && snapshot(service, game.roomId, player).game.self.alive).slice(0, 3);
    for (const voter of voters) dispatch(service, game.roomId, voter, game.gameId, COMMANDS.VOTE_CAST, { targetSeatId: target.seatId }, `vote-${round}-${voter.seatId}`);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
  }
  return service.getSnapshot({ roomId: game.roomId });
}

function advanceNightToVote(testHarness, roomId) {
  tickDeadline(testHarness, roomId);
  tickDeadline(testHarness, roomId);
  let state = tickDeadline(testHarness, roomId);
  while (state.game.phase === PHASES.DAY_SPEECH) state = tickDeadline(testHarness, roomId);
  assert.equal(state.game.phase, PHASES.DAY_VOTE);
  return state;
}

describe("room lobby lifecycle", () => {
  it("creates, joins, readies, and exposes only public metadata", () => {
    const { service } = harness();
    const created = service.createRoom({ sessionId: "session-1", nickname: "  Host  ", idempotencyKey: "create" });
    assert.equal(created.snapshot.status, "LOBBY");
    assert.equal(created.snapshot.seats[0].nickname, "Host");
    assert.equal(created.snapshot.selfSeatId, "seat-1");
    assert.equal(created.snapshot.game, null);
    assert.match(created.snapshot.version, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(created.snapshot).includes(created.seatToken), false);

    const joined = service.joinRoom({ roomId: created.roomId, sessionId: "session-2", nickname: "Guest", idempotencyKey: "join" });
    assert.equal(joined.snapshot.seats.length, 2);
    const ready = service.setReady({ roomId: created.roomId, seatToken: joined.seatToken, ready: true, idempotencyKey: "ready" });
    assert.equal(ready.snapshot.seats.find((seat) => seat.seatId === "seat-2").ready, true);
    const publicSnapshot = service.getSnapshot({ roomId: created.roomId });
    assert.equal(publicSnapshot.selfSeatId, null);
    assert.equal(JSON.stringify(publicSnapshot).includes("session-"), false);
    assert.equal(JSON.stringify(publicSnapshot).includes("seat-token"), false);
  });

  it("makes room writes idempotent and detects conflicting reuse", () => {
    const { service } = harness();
    const input = { sessionId: "session-1", nickname: "Host", idempotencyKey: "same" };
    const first = service.createRoom(input);
    assert.deepEqual(service.createRoom({ ...input }), first);
    expectCode("ACTION_ID_CONFLICT", () => service.createRoom({ ...input, nickname: "Other" }));

    const ready = { roomId: first.roomId, seatToken: first.seatToken, ready: true, idempotencyKey: "ready" };
    assert.deepEqual(service.setReady(ready), service.setReady({ ...ready }));
    expectCode("ACTION_ID_CONFLICT", () => service.setReady({ ...ready, ready: false }));
  });

  it("enforces capacity, unique session occupancy, and pregame seat reuse", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const { roomId, players } = createNine(testHarness);
    expectCode("ROOM_FULL", () => service.joinRoom({ roomId, sessionId: "session-10", nickname: "Extra", idempotencyKey: "join-10" }));
    expectCode("ACTION_NOT_ALLOWED", () => service.joinRoom({ roomId, sessionId: "session-1", nickname: "Again", idempotencyKey: "again" }));

    service.leaveRoom({ roomId, seatToken: players[4].token, idempotencyKey: "leave-5" });
    const replacement = service.joinRoom({ roomId, sessionId: "session-10", nickname: "Replacement", idempotencyKey: "replace" });
    assert.equal(replacement.snapshot.selfSeatId, "seat-5");
  });

  it("gives a disconnected host 30 seconds to reconnect and migrates on timeout or leave", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const created = service.createRoom({ sessionId: "session-1", nickname: "Host", idempotencyKey: "create" });
    const second = service.joinRoom({ roomId: created.roomId, sessionId: "session-2", nickname: "Second", idempotencyKey: "join-2" });
    const third = service.joinRoom({ roomId: created.roomId, sessionId: "session-3", nickname: "Third", idempotencyKey: "join-3" });

    const disconnected = service.disconnect({ roomId: created.roomId, seatToken: created.seatToken });
    assert.equal(disconnected.snapshot.hostSeatId, "seat-1");
    assert.equal(disconnected.snapshot.seats[0].connected, false);
    testHarness.advance(29_999);
    service.tick();
    assert.equal(service.getSnapshot({ roomId: created.roomId }).hostSeatId, "seat-1");
    assert.equal(service.reconnect({ roomId: created.roomId, seatToken: created.seatToken }).snapshot.hostSeatId, "seat-1");

    service.disconnect({ roomId: created.roomId, seatToken: created.seatToken });
    testHarness.advance(30_000);
    service.tick();
    assert.equal(service.getSnapshot({ roomId: created.roomId }).hostSeatId, "seat-2");
    assert.equal(service.reconnect({ roomId: created.roomId, seatToken: created.seatToken }).snapshot.hostSeatId, "seat-2");
    assert.equal(service.leaveRoom({ roomId: created.roomId, seatToken: second.seatToken, idempotencyKey: "leave-2" }).snapshot.hostSeatId, "seat-1");
    const left = service.leaveRoom({ roomId: created.roomId, seatToken: third.seatToken, idempotencyKey: "leave-3" });
    assert.equal(left.destroyed, false);
    expectCode("INVALID_SEAT_TOKEN", () => service.reconnect({ roomId: created.roomId, seatToken: second.seatToken }));
    const destroyed = service.leaveRoom({ roomId: created.roomId, seatToken: created.seatToken, idempotencyKey: "leave-1" });
    assert.equal(destroyed.destroyed, true);
    expectCode("ROOM_NOT_FOUND", () => service.getSnapshot({ roomId: created.roomId }));
  });

  it("validates common lobby errors", () => {
    const { service } = harness();
    for (const invalid of [null, {}, { sessionId: "s", nickname: "", idempotencyKey: "k" }, { sessionId: "s", nickname: "x".repeat(25), idempotencyKey: "k" }]) {
      expectCode("INVALID_REQUEST", () => service.createRoom(invalid));
    }
    const created = service.createRoom({ sessionId: "s", nickname: "Host", idempotencyKey: "create" });
    expectCode("INVALID_SEAT_TOKEN", () => service.setReady({ roomId: created.roomId, seatToken: "bad", ready: true, idempotencyKey: "ready" }));
    expectCode("INVALID_REQUEST", () => service.getSnapshot(null));
    expectCode("INVALID_REQUEST", () => service.getSnapshot({ roomId: "" }));
    expectCode("INVALID_SEAT_TOKEN", () => service.getSnapshot({ roomId: created.roomId, seatToken: "" }));
    expectCode("ROOM_NOT_FOUND", () => service.joinRoom({ roomId: "missing", sessionId: "x", nickname: "X", idempotencyKey: "x" }));
    expectCode("INVALID_REQUEST", () => service.joinRoom({ sessionId: "x", nickname: "X", idempotencyKey: "x" }));
    expectCode("ACTION_NOT_ALLOWED", () => service.dispatchAction({ roomId: created.roomId, seatToken: created.seatToken, action: {} }));
    expectCode("INVALID_REQUEST", () => service.dispatchAction(null));

    const other = service.createRoom({ sessionId: "other", nickname: "Other", idempotencyKey: "other" });
    expectCode("INVALID_SEAT_TOKEN", () => service.getSnapshot({ roomId: other.roomId, seatToken: created.seatToken }));
  });
});

describe("game start and command dispatch", () => {
  it("requires host, nine ready connected seats, and starts with private roles", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const created = service.createRoom({ sessionId: "s1", nickname: "Host", idempotencyKey: "create" });
    expectCode("ACTION_NOT_ALLOWED", () => service.startGame({ roomId: created.roomId, seatToken: created.seatToken, idempotencyKey: "early" }));

    const { roomId, players } = createNine(harness());
    void roomId;
    void players;

    const full = createNine(testHarness);
    expectCode("ACTION_NOT_ALLOWED", () => service.startGame({ roomId: full.roomId, seatToken: full.players[1].token, idempotencyKey: "guest-start" }));
    service.disconnect({ roomId: full.roomId, seatToken: full.players[8].token });
    expectCode("ACTION_NOT_ALLOWED", () => service.startGame({ roomId: full.roomId, seatToken: full.players[0].token, idempotencyKey: "offline-start" }));
    service.reconnect({ roomId: full.roomId, seatToken: full.players[8].token });
    const started = service.startGame({ roomId: full.roomId, seatToken: full.players[0].token, idempotencyKey: "start" });
    assert.equal(started.snapshot.status, "ACTIVE");
    assert.equal(started.snapshot.game.phase, PHASES.ROLE_REVEAL);
    assert.equal(started.snapshot.game.self.role !== null, true);
    assert.equal(service.getSnapshot({ roomId: full.roomId }).game.self, undefined);
    assert.equal(service.getSnapshot({ roomId: full.roomId }).game.revealedRoles, undefined);
    expectCode("ACTION_NOT_ALLOWED", () => service.joinRoom({ roomId: full.roomId, sessionId: "late", nickname: "Late", idempotencyKey: "late" }));
    expectCode("ACTION_NOT_ALLOWED", () => service.setReady({ roomId: full.roomId, seatToken: full.players[0].token, ready: false, idempotencyKey: "ready-after-start" }));
    expectCode("ACTION_NOT_ALLOWED", () => service.startGame({ roomId: full.roomId, seatToken: full.players[0].token, idempotencyKey: "start-again" }));
  });

  it("uses safe random assignments and rejects invalid random output", () => {
    const invalidHarness = harness({ randomInt: () => 99 });
    const full = createNine(invalidHarness);
    expectCode("INVALID_REQUEST", () => invalidHarness.service.startGame({ roomId: full.roomId, seatToken: full.players[0].token, idempotencyKey: "start" }));
    assert.equal(invalidHarness.service.getSnapshot({ roomId: full.roomId }).status, "LOBBY");
  });

  it("rejects a generated game ID already used by another room", () => {
    let roomNumber = 0;
    const testHarness = harness({ createId: (kind) => kind === "game" ? "game-fixed" : `room-${++roomNumber}` });
    const first = startNine(testHarness);
    assert.equal(first.gameId, "game-fixed");
    const created = testHarness.service.createRoom({ sessionId: "second-1", nickname: "Second 1", idempotencyKey: "second-create" });
    const second = { roomId: created.roomId, players: [{ token: created.seatToken }] };
    for (let number = 2; number <= 9; number += 1) {
      second.players.push({ token: testHarness.service.joinRoom({ roomId: second.roomId, sessionId: `second-${number}`, nickname: `Second ${number}`, idempotencyKey: `second-join-${number}` }).seatToken });
    }
    second.players.forEach((player, index) => testHarness.service.setReady({ roomId: second.roomId, seatToken: player.token, ready: true, idempotencyKey: `second-ready-${index}` }));
    expectCode("ID_COLLISION", () => testHarness.service.startGame({ roomId: second.roomId, seatToken: second.players[0].token, idempotencyKey: "second-start" }));
    assert.equal(testHarness.service.getSnapshot({ roomId: second.roomId }).status, "LOBBY");
  });

  it("checks idempotency before view version and keeps private actions private", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    const roles = playersByRole(service, game.roomId, game.players);
    const wolves = game.players.filter((player) => snapshot(service, game.roomId, player).game.self.role === ROLES.WEREWOLF);
    const villager = roles[ROLES.VILLAGER];
    const villagerBefore = snapshot(service, game.roomId, villager).version;
    const wolf = wolves[0];
    const target = game.players.find((player) => !wolves.includes(player));
    const before = snapshot(service, game.roomId, wolf);
    const action = {
      schemaVersion: 1,
      actionId: "wolf-choice",
      gameId: game.gameId,
      expectedVersion: before.version,
      type: COMMANDS.WOLF_TARGET_SET,
      payload: { targetSeatId: target.seatId },
    };
    const first = service.dispatchAction({ roomId: game.roomId, seatToken: wolf.token, action });
    assert.equal(first.idempotent, false);
    assert.equal(snapshot(service, game.roomId, villager).version, villagerBefore);
    const retry = service.dispatchAction({ roomId: game.roomId, seatToken: wolf.token, action });
    assert.equal(retry.idempotent, true);
    expectCode("ACTION_ID_CONFLICT", () => service.dispatchAction({
      roomId: game.roomId,
      seatToken: wolf.token,
      action: { ...action, payload: { targetSeatId: villager.seatId } },
    }));
  });

  it("rejects stale views, forged actors, trusted commands, and wrong game IDs", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    const stale = snapshot(service, game.roomId, game.players[0]);
    tickDeadline(testHarness, game.roomId);
    expectCode("VIEW_CONFLICT", () => service.dispatchAction({
      roomId: game.roomId,
      seatToken: game.players[0].token,
      action: { schemaVersion: 1, actionId: "stale", gameId: game.gameId, expectedVersion: stale.version, type: COMMANDS.WOLF_TARGET_SET, payload: { targetSeatId: "seat-9" } },
    }));
    for (const action of [
      { schemaVersion: 1, actionId: "actor", gameId: game.gameId, expectedVersion: stale.version, type: COMMANDS.WOLF_TARGET_SET, payload: {}, actorSeatId: "seat-2" },
      { schemaVersion: 1, actionId: "seq", gameId: game.gameId, expectedVersion: stale.version, type: COMMANDS.WOLF_TARGET_SET, payload: {}, expectedSeq: 1 },
      { schemaVersion: 1, actionId: "wrong", gameId: "wrong", expectedVersion: stale.version, type: COMMANDS.WOLF_TARGET_SET, payload: {} },
    ]) expectCode("INVALID_REQUEST", () => service.dispatchAction({ roomId: game.roomId, seatToken: game.players[0].token, action }));

    const current = snapshot(service, game.roomId, game.players[0]);
    for (const type of [COMMANDS.PHASE_TIMEOUT, COMMANDS.GAME_START, COMMANDS.ROOM_READY_SET]) {
      expectCode("ACTION_NOT_ALLOWED", () => service.dispatchAction({
        roomId: game.roomId,
        seatToken: game.players[0].token,
        action: { schemaVersion: 1, actionId: `forbidden-${type}`, gameId: game.gameId, expectedVersion: current.version, type, payload: {} },
      }));
    }
  });

  it("supports explicit speech, last-word, and hunter commands", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    let state = tickDeadline(testHarness, game.roomId);
    const firstSpeaker = game.players.find((player) => player.seatId === state.game.currentSpeakerSeatId);
    dispatch(service, game.roomId, firstSpeaker, game.gameId, COMMANDS.SPEECH_FINISH, {}, "speech-first");
    state = service.getSnapshot({ roomId: game.roomId });
    while (state.game.phase === PHASES.DAY_SPEECH) state = tickDeadline(testHarness, game.roomId);

    const hunter = game.players.find((player) => snapshot(service, game.roomId, player).game.self.role === ROLES.HUNTER);
    const voters = game.players.filter((player) => player.seatId !== hunter.seatId).slice(0, 3);
    for (const voter of voters) dispatch(service, game.roomId, voter, game.gameId, COMMANDS.VOTE_CAST, { targetSeatId: hunter.seatId }, `hunter-vote-${voter.seatId}`);
    tickDeadline(testHarness, game.roomId);
    dispatch(service, game.roomId, hunter, game.gameId, COMMANDS.LAST_WORD_FINISH, {}, "hunter-last-word");
    const shot = dispatch(service, game.roomId, hunter, game.gameId, COMMANDS.HUNTER_SHOT_SET, { targetSeatId: null }, "hunter-give-up");
    assert.equal(shot.snapshot.game.phase, PHASES.NIGHT_WOLF);
  });

  it("finishes the final speech and a non-hunter last word explicitly", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    let state = tickDeadline(testHarness, game.roomId);
    while (state.game.phase === PHASES.DAY_SPEECH && state.game.currentSpeakerSeatId !== "seat-9") state = tickDeadline(testHarness, game.roomId);
    const finalSpeaker = game.players.find((player) => player.seatId === state.game.currentSpeakerSeatId);
    state = dispatch(service, game.roomId, finalSpeaker, game.gameId, COMMANDS.SPEECH_FINISH, {}, "final-speech").snapshot;
    assert.equal(state.game.phase, PHASES.DAY_VOTE);
    const nonHunter = game.players.find((player) => snapshot(service, game.roomId, player).game.self.role !== ROLES.HUNTER);
    const voters = game.players.filter((player) => player.seatId !== nonHunter.seatId).slice(0, 2);
    for (const voter of voters) dispatch(service, game.roomId, voter, game.gameId, COMMANDS.VOTE_CAST, { targetSeatId: nonHunter.seatId }, `nonhunter-vote-${voter.seatId}`);
    tickDeadline(testHarness, game.roomId);
    state = dispatch(service, game.roomId, nonHunter, game.gameId, COMMANDS.LAST_WORD_FINISH, {}, "nonhunter-last").snapshot;
    assert.equal(state.game.phase, PHASES.NIGHT_WOLF);
  });

  it("prevents disconnected players from acting", () => {
    const testHarness = harness();
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    const wolf = game.players.find((player) => snapshot(testHarness.service, game.roomId, player).game.self.role === ROLES.WEREWOLF);
    const visible = snapshot(testHarness.service, game.roomId, wolf);
    testHarness.service.disconnect({ roomId: game.roomId, seatToken: wolf.token });
    expectCode("ACTION_NOT_ALLOWED", () => testHarness.service.dispatchAction({
      roomId: game.roomId,
      seatToken: wolf.token,
      action: { schemaVersion: 1, actionId: "offline", gameId: game.gameId, expectedVersion: visible.version, type: COMMANDS.WOLF_TARGET_SET, payload: { targetSeatId: "seat-9" } },
    }));
  });

  it("acknowledges a retried final hunter action after the room is finished", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    const roleOf = (player) => snapshot(service, game.roomId, player).game.self.role;
    const wolves = game.players.filter((player) => roleOf(player) === ROLES.WEREWOLF);
    const hunter = game.players.find((player) => roleOf(player) === ROLES.HUNTER);

    for (let index = 0; index < 2; index += 1) {
      advanceNightToVote(testHarness, game.roomId);
      const target = wolves[index];
      const voters = game.players.filter((player) => player.seatId !== target.seatId && snapshot(service, game.roomId, player).game.self.alive).slice(0, 3);
      for (const voter of voters) dispatch(service, game.roomId, voter, game.gameId, COMMANDS.VOTE_CAST, { targetSeatId: target.seatId }, `setup-vote-${index}-${voter.seatId}`);
      tickDeadline(testHarness, game.roomId);
      tickDeadline(testHarness, game.roomId);
    }

    advanceNightToVote(testHarness, game.roomId);
    const hunterVoters = game.players.filter((player) => player.seatId !== hunter.seatId && snapshot(service, game.roomId, player).game.self.alive).slice(0, 3);
    for (const voter of hunterVoters) dispatch(service, game.roomId, voter, game.gameId, COMMANDS.VOTE_CAST, { targetSeatId: hunter.seatId }, `hunter-final-vote-${voter.seatId}`);
    tickDeadline(testHarness, game.roomId);
    dispatch(service, game.roomId, hunter, game.gameId, COMMANDS.LAST_WORD_FINISH, {}, "final-last-word");

    const visible = snapshot(service, game.roomId, hunter);
    const action = {
      schemaVersion: 1,
      actionId: "winning-hunter-shot",
      gameId: game.gameId,
      expectedVersion: visible.version,
      type: COMMANDS.HUNTER_SHOT_SET,
      payload: { targetSeatId: wolves[2].seatId },
    };
    const first = service.dispatchAction({ roomId: game.roomId, seatToken: hunter.token, action });
    assert.equal(first.snapshot.status, "FINISHED");
    assert.equal(first.snapshot.game.result.winner, TEAMS.GOOD);
    const retry = service.dispatchAction({ roomId: game.roomId, seatToken: hunter.token, action });
    assert.equal(retry.acknowledged, true);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.snapshot.status, "FINISHED");
  });
});

describe("trusted deadlines and complete game", () => {
  it("does not advance before a deadline and advances the matching phase at it", () => {
    const testHarness = harness();
    const game = startNine(testHarness);
    const deadline = Date.parse(game.snapshot.game.deadlineAt);
    assert.deepEqual(testHarness.service.tick(deadline - 1), []);
    assert.equal(testHarness.service.getSnapshot({ roomId: game.roomId }).game.phase, PHASES.ROLE_REVEAL);
    assert.equal(testHarness.service.tick(deadline)[0].phase, PHASES.NIGHT_WOLF);
    assert.deepEqual(testHarness.service.tick(deadline), []);
    assert.deepEqual(testHarness.service.tick(new Date(deadline)), []);
    assert.deepEqual(testHarness.service.tick(new Date(deadline).toISOString()), []);
  });

  it("plays and replays a meaningful nine-player good victory", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    const finished = playGoodVictory(testHarness, game);
    assert.equal(finished.status, "FINISHED");
    assert.equal(finished.game.phase, PHASES.GAME_OVER);
    assert.equal(finished.game.result.winner, TEAMS.GOOD);
    assert.equal(finished.game.revealedRoles.length, 9);
    assert.equal(JSON.stringify(finished).includes('"seq"'), false);
    assert.equal(JSON.stringify(finished).includes("eventId"), false);
  });

  it("times out a legally pending hunter", () => {
    const testHarness = harness({ durations: {
      [PHASES.ROLE_REVEAL]: 8,
      [PHASES.NIGHT_WOLF]: 30,
      [PHASES.NIGHT_WITCH]: 20,
      [PHASES.NIGHT_SEER]: 20,
      [PHASES.DAWN_RESOLUTION]: 0,
      [PHASES.DAY_SPEECH]: 60,
      [PHASES.DAY_VOTE]: 30,
      [PHASES.LAST_WORD]: 30,
      [PHASES.HUNTER_SHOT]: 20,
    } });
    const { service } = testHarness;
    const game = startNine(testHarness);
    tickDeadline(testHarness, game.roomId);
    const wolves = game.players.filter((player) => snapshot(service, game.roomId, player).game.self.role === ROLES.WEREWOLF);
    const hunter = game.players.find((player) => snapshot(service, game.roomId, player).game.self.role === ROLES.HUNTER);
    for (const wolf of wolves.slice(0, 2)) dispatch(service, game.roomId, wolf, game.gameId, COMMANDS.WOLF_TARGET_SET, { targetSeatId: hunter.seatId }, `kill-hunter-${wolf.seatId}`);
    tickDeadline(testHarness, game.roomId);
    tickDeadline(testHarness, game.roomId);
    const pending = tickDeadline(testHarness, game.roomId);
    assert.equal(pending.game.phase, PHASES.HUNTER_SHOT);
    assert.equal(Date.parse(pending.game.deadlineAt) - testHarness.now(), 20);
    assert.equal(tickDeadline(testHarness, game.roomId).game.phase, PHASES.DAY_SPEECH);
  });

  it("lets only the host restart a finished room with readiness cleared", () => {
    const testHarness = harness();
    const { service } = testHarness;
    const game = startNine(testHarness);
    playGoodVictory(testHarness, game);
    expectCode("ACTION_NOT_ALLOWED", () => service.restartGame({ roomId: game.roomId, seatToken: game.players[1].token, idempotencyKey: "guest-restart" }));
    const restarted = service.restartGame({ roomId: game.roomId, seatToken: game.players[0].token, idempotencyKey: "restart" });
    assert.equal(restarted.snapshot.status, "LOBBY");
    assert.equal(restarted.snapshot.game, null);
    assert.equal(restarted.snapshot.seats.every((seat) => seat.ready === false), true);
    assert.deepEqual(service.restartGame({ roomId: game.roomId, seatToken: game.players[0].token, idempotencyKey: "restart" }), restarted);
    expectCode("ACTION_NOT_ALLOWED", () => service.restartGame({ roomId: game.roomId, seatToken: game.players[0].token, idempotencyKey: "restart-again" }));
  });
});

describe("security and dependency validation", () => {
  it("validates service options, generated IDs, tokens, clock values, and seat writes", () => {
    for (const options of [null, [], { clock: 4 }, { store: {} }, { durations: { [PHASES.DAY_VOTE]: 0.5 } }, { hostDisconnectGraceMs: -1 }]) {
      expectCode("INVALID_REQUEST", () => createRoomService(options));
    }

    const badId = harness({ createId: () => "__proto__" });
    expectCode("INVALID_REQUEST", () => badId.service.createRoom({ sessionId: "s", nickname: "N", idempotencyKey: "k" }));
    const collision = harness({ createId: () => "room-one" });
    collision.service.createRoom({ sessionId: "s1", nickname: "N", idempotencyKey: "k1" });
    expectCode("ID_COLLISION", () => collision.service.createRoom({ sessionId: "s2", nickname: "N", idempotencyKey: "k2" }));
    const badToken = harness({ createToken: () => "short" });
    expectCode("TOKEN_GENERATION_FAILED", () => badToken.service.createRoom({ sessionId: "s", nickname: "N", idempotencyKey: "k" }));

    const invalidClock = harness({ clock: () => "not-a-date" });
    const full = createNine(invalidClock);
    expectCode("INVALID_REQUEST", () => invalidClock.service.startGame({ roomId: full.roomId, seatToken: full.players[0].token, idempotencyKey: "start" }));

    const valid = harness();
    const created = valid.service.createRoom({ sessionId: "s", nickname: "N", idempotencyKey: "k" });
    for (const request of [null, {}, { roomId: created.roomId, seatToken: created.seatToken, idempotencyKey: "x", ready: "yes" }]) {
      expectCode("INVALID_REQUEST", () => valid.service.setReady(request));
    }
    expectCode("INVALID_REQUEST", () => valid.service.disconnect(null));
    expectCode("INVALID_REQUEST", () => valid.service.tick("not-a-date"));

    const two = harness({ hostDisconnectGraceMs: 0 });
    const host = two.service.createRoom({ sessionId: "h", nickname: "H", idempotencyKey: "h" });
    const guest = two.service.joinRoom({ roomId: host.roomId, sessionId: "g", nickname: "G", idempotencyKey: "g" });
    two.service.disconnect({ roomId: host.roomId, seatToken: host.seatToken });
    two.service.disconnect({ roomId: host.roomId, seatToken: guest.seatToken });
    two.service.tick();
    assert.equal(two.service.reconnect({ roomId: host.roomId, seatToken: guest.seatToken }).snapshot.hostSeatId, "seat-2");
  });

  it("uses default cryptographic dependencies for a real start", () => {
    const service = createRoomService();
    const first = service.createRoom({ sessionId: "default-1", nickname: "P1", idempotencyKey: "create" });
    const players = [{ token: first.seatToken }];
    for (let number = 2; number <= 9; number += 1) {
      players.push({ token: service.joinRoom({ roomId: first.roomId, sessionId: `default-${number}`, nickname: `P${number}`, idempotencyKey: `join-${number}` }).seatToken });
    }
    players.forEach((player, index) => service.setReady({ roomId: first.roomId, seatToken: player.token, ready: true, idempotencyKey: `ready-${index}` }));
    assert.equal(service.startGame({ roomId: first.roomId, seatToken: first.seatToken, idempotencyKey: "start" }).snapshot.status, "ACTIVE");
  });
});

describe("serialization", () => {
  it("restores rooms, tokens, game history, deadlines, and idempotency", () => {
    const firstHarness = harness();
    const game = startNine(firstHarness);
    tickDeadline(firstHarness, game.roomId);
    const serialized = firstHarness.service.serialize();
    const secondHarness = harness({ restoredState: serialized });
    assert.deepEqual(secondHarness.service.getSnapshot({ roomId: game.roomId, seatToken: game.players[0].token }), firstHarness.service.getSnapshot({ roomId: game.roomId, seatToken: game.players[0].token }));
    assert.equal(secondHarness.service.reconnect({ roomId: game.roomId, seatToken: game.players[0].token }).snapshot.selfSeatId, "seat-1");
  });

  it("rejects invalid restored state and invalid dependencies", () => {
    expectCode("INVALID_REQUEST", () => createRoomService({ restoredState: {} }));
    expectCode("INVALID_REQUEST", () => createRoomService({ clock: 4 }));
    expectCode("INVALID_REQUEST", () => createRoomService({ durations: { [PHASES.DAY_VOTE]: -1 } }));
  });

  it("rejects malformed room entries, duplicate tokens, and mismatched histories", () => {
    const baseHarness = harness();
    const first = baseHarness.service.createRoom({ sessionId: "s1", nickname: "P1", idempotencyKey: "create" });
    const second = baseHarness.service.createRoom({ sessionId: "s2", nickname: "P2", idempotencyKey: "create-2" });
    const serialized = baseHarness.service.serialize();

    const malformed = cloneForTest(serialized);
    malformed.rooms[0].status = "OTHER";
    expectCode("INVALID_REQUEST", () => harness({ restoredState: malformed }));

    const duplicate = cloneForTest(serialized);
    duplicate.rooms[1].seats[0].seatToken = duplicate.rooms[0].seats[0].seatToken;
    expectCode("INVALID_REQUEST", () => harness({ restoredState: duplicate }));

    assert.notEqual(first.roomId, second.roomId);
    const gameHarness = harness();
    startNine(gameHarness);
    const mismatched = gameHarness.service.serialize();
    mismatched.rooms[0].game.state.round = 99;
    expectCode("INVALID_REQUEST", () => harness({ restoredState: mismatched }));
  });
});

function cloneForTest(value) {
  return structuredClone(value);
}

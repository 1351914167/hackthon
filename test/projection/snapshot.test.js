"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  COMMANDS,
  PHASES,
  ROLES,
  SCHEMA_VERSION,
  TEAMS,
  createInitialState,
  decide,
  replay,
} = require("../../src/game");
const { ProjectionError, VIEWER_TYPES, projectForViewer } = require("../../src/projection");

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

function initial(readySeats = seats) {
  return createInitialState({ roomId: "room-1", gameId: "game-1", hostSeatId: "seat-1", seats: readySeats });
}

function started() {
  const state = initial();
  const command = {
    schemaVersion: SCHEMA_VERSION,
    actionId: "start",
    gameId: state.gameId,
    expectedSeq: 0,
    actorSeatId: "seat-1",
    type: COMMANDS.GAME_START,
    payload: {},
  };
  return replay(state, decide(state, command, {
    at: "2026-10-23T10:00:00.000Z",
    deadlineAt: "2026-10-23T10:01:00.000Z",
    roleAssignments: roles,
  }));
}

function inPhase(phase, overrides = {}) {
  const state = started();
  state.phase = phase;
  state.round = phase === PHASES.ROLE_REVEAL ? 0 : 1;
  Object.assign(state, structuredClone(overrides));
  return state;
}

function player(seatId) {
  return { type: VIEWER_TYPES.PLAYER, seatId };
}

const spectator = { type: VIEWER_TYPES.SPECTATOR };

function kill(state, seatId, reasons = ["EXILED"]) {
  state.seats.find((seat) => seat.seatId === seatId).alive = false;
  state.deaths.push({ seatId, reasons, round: state.round });
  return state;
}

function keysDeep(value, result = []) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    keysDeep(child, result);
  }
  return result;
}

function expectViewerError(viewer) {
  assert.throws(
    () => projectForViewer(started(), viewer),
    (error) => error instanceof ProjectionError && error.code === "INVALID_VIEWER",
  );
}

describe("public snapshot", () => {
  it("projects only public fields for spectators", () => {
    const state = inPhase(PHASES.DAY_SPEECH, {
      speechOrder: ["seat-2", "seat-4"],
      speechIndex: 1,
      deaths: [{ seatId: "seat-7", reasons: ["WOLF_ATTACK"], round: 1 }],
      voteHistory: [{ round: 1, ballots: [], exiledSeatId: null }],
    });
    state.seats.find((seat) => seat.seatId === "seat-7").alive = false;
    state.night = {
      wolfTargets: { "seat-1": "seat-8", "seat-2": "seat-8" },
      wolfAttackTarget: "seat-8",
      witchAction: { kind: "POISON", targetSeatId: "seat-9" },
      seerTarget: "seat-1",
    };
    state.seerResults = [{ seerSeatId: "seat-4", targetSeatId: "seat-1", team: TEAMS.WEREWOLF, round: 1 }];
    state.votes = { "seat-1": "seat-2" };
    state.seatToken = "secret-token";
    state.events = [{ type: "ROLE_ASSIGNED" }];

    const snapshot = projectForViewer(state, spectator);
    assert.equal(snapshot.currentSpeakerSeatId, "seat-4");
    assert.equal(snapshot.seats.find((seat) => seat.seatId === "seat-7").alive, false);
    assert.deepEqual(snapshot.deaths, state.deaths);
    assert.deepEqual(snapshot.voteHistory, state.voteHistory);
    assert.equal(snapshot.result, null);
    assert.equal("self" in snapshot, false);
    assert.equal("wolfTeammates" in snapshot, false);
    assert.equal("revealedRoles" in snapshot, false);

    const serialized = JSON.stringify(snapshot);
    for (const secret of ["secret-token", "wolfTargets", "wolfAttackTarget", "witchAction", "seerTarget", "ROLE_ASSIGNED"]) {
      assert.equal(serialized.includes(secret), false);
    }
    const forbiddenKeys = ["roles", "night", "votes", "pendingHunter", "events", "seatToken", "tokens", "seq", "eventId", "causationId"];
    assert.deepEqual(keysDeep(snapshot).filter((key) => forbiddenKeys.includes(key)), []);
    assert.match(snapshot.version, /^[a-f\d]{64}$/);

    snapshot.deaths[0].reasons[0] = "MUTATED";
    snapshot.voteHistory[0].round = 99;
    snapshot.seats[0].alive = false;
    assert.equal(state.deaths[0].reasons[0], "WOLF_ATTACK");
    assert.equal(state.voteHistory[0].round, 1);
    assert.equal(state.seats[0].alive, true);
  });

  it("uses null speaker outside speech and exposes a finished result", () => {
    let state = started();
    function run(type, actorSeatId, payload = {}) {
      const command = { schemaVersion: 1, actionId: `finish-${state.seq}`, gameId: state.gameId,
        expectedSeq: state.seq, type, actorSeatId, payload };
      state = replay(state, decide(state, command, { trusted: true, at: "2026-10-23T10:00:00.000Z" }));
    }
    run(COMMANDS.PHASE_TIMEOUT);
    for (const targetSeatId of ["seat-1", "seat-2", "seat-3"]) {
      for (let nightPhase = 0; nightPhase < 3; nightPhase += 1) run(COMMANDS.PHASE_TIMEOUT);
      while (state.phase === PHASES.DAY_SPEECH) {
        run(COMMANDS.SPEECH_FINISH, state.speechOrder[state.speechIndex]);
      }
      run(COMMANDS.VOTE_CAST, "seat-7", { targetSeatId });
      run(COMMANDS.PHASE_TIMEOUT);
      run(COMMANDS.LAST_WORD_FINISH, targetSeatId);
    }
    assert.equal(state.phase, PHASES.GAME_OVER);
    const snapshot = projectForViewer(state, spectator);
    assert.equal(snapshot.currentSpeakerSeatId, null);
    assert.deepEqual(snapshot.result, { winner: TEAMS.GOOD, reason: "ALL_WEREWOLVES_DEAD" });
    assert.equal(snapshot.revealedRoles.length, 9);
    assert.deepEqual(snapshot.revealedRoles[0], { seatId: "seat-1", role: ROLES.WEREWOLF, team: TEAMS.WEREWOLF });
    assert.deepEqual(snapshot.revealedRoles[3], { seatId: "seat-4", role: ROLES.SEER, team: TEAMS.GOOD });
  });

  it("validates viewer descriptors", () => {
    for (const viewer of [null, [], {}, { type: "ADMIN" }, player("missing")]) expectViewerError(viewer);
    assert.equal(projectForViewer(started(), spectator).gameId, "game-1");
  });

  it("whitelists nested public and private fields instead of copying audit metadata", () => {
    const state = inPhase(PHASES.DAY_SPEECH, { speechOrder: ["seat-4"], speechIndex: 0 });
    const canary = "must-never-reach-client";
    kill(state, "seat-7");
    state.deaths[0].internalAudit = { canary };
    state.voteHistory.push({
      round: 1,
      exiledSeatId: "seat-7",
      internalAudit: canary,
      ballots: [{ voterSeatId: "seat-1", targetSeatId: "seat-7", audit: canary }],
    });
    state.seerResults.push({ seerSeatId: "seat-4", targetSeatId: "seat-1", team: TEAMS.WEREWOLF, round: 1, audit: canary });
    state.witchInventory.internalAudit = canary;
    const spectatorView = projectForViewer(state, spectator);
    assert.deepEqual(spectatorView.deaths, [{ seatId: "seat-7", reasons: ["EXILED"], round: 1 }]);
    assert.deepEqual(spectatorView.voteHistory, [{
      round: 1,
      exiledSeatId: "seat-7",
      ballots: [{ voterSeatId: "seat-1", targetSeatId: "seat-7" }],
    }]);
    for (const viewer of [spectator, ...seats.map((seat) => player(seat.seatId))]) {
      assert.equal(JSON.stringify(projectForViewer(state, viewer)).includes(canary), false);
    }
  });

  it("does not reveal the number of private actions through versions or snapshot contents", () => {
    const initial = inPhase(PHASES.NIGHT_WOLF);
    const beforePublic = projectForViewer(initial, spectator);
    const beforeVillager = projectForViewer(initial, player("seat-7"));
    const beforeWolf = projectForViewer(initial, player("seat-1"));
    let state = initial;
    for (const targetSeatId of ["seat-7", "seat-8", null]) {
      const command = {
        schemaVersion: 1,
        gameId: state.gameId,
        actionId: `wolf-${state.seq}`,
        expectedSeq: state.seq,
        actorSeatId: "seat-1",
        type: COMMANDS.WOLF_TARGET_SET,
        payload: { targetSeatId },
      };
      state = replay(state, decide(state, command, { at: "2026-10-23T10:00:00.000Z" }));
      assert.deepEqual(projectForViewer(state, spectator), beforePublic);
      assert.deepEqual(projectForViewer(state, player("seat-7")), beforeVillager);
      assert.notEqual(projectForViewer(state, player("seat-1")).version, beforeWolf.version);
    }
    state.deadlineAt = "2026-10-23T10:02:00.000Z";
    assert.notEqual(projectForViewer(state, spectator).version, beforePublic.version);
  });
});

describe("private player snapshot", () => {
  it("shows lobby self state without assigning a role", () => {
    const state = initial(seats.map((seat, index) => ({ ...seat, ready: index !== 8 })));
    const host = projectForViewer(state, player("seat-1"));
    assert.equal(host.self.role, null);
    assert.equal(host.self.team, null);
    assert.deepEqual(host.self.abilities, {});
    assert.deepEqual(host.self.seerResults, []);
    assert.deepEqual(host.self.availableActions, [COMMANDS.ROOM_READY_SET]);

    state.seats[8].ready = true;
    assert.deepEqual(projectForViewer(state, player("seat-1")).self.availableActions, [COMMANDS.ROOM_READY_SET, COMMANDS.GAME_START]);
    assert.deepEqual(projectForViewer(state, player("seat-2")).self.availableActions, [COMMANDS.ROOM_READY_SET]);
  });

  it("shows only a living wolf its teammates", () => {
    const state = inPhase(PHASES.NIGHT_WOLF);
    const wolf = projectForViewer(state, player("seat-1"));
    assert.equal(wolf.self.role, ROLES.WEREWOLF);
    assert.equal(wolf.self.team, TEAMS.WEREWOLF);
    assert.deepEqual(wolf.self.availableActions, [COMMANDS.WOLF_TARGET_SET]);
    assert.deepEqual(wolf.wolfTeammates.map((teammate) => teammate.seatId), ["seat-2", "seat-3"]);

    const villager = projectForViewer(state, player("seat-7"));
    assert.equal(villager.self.role, ROLES.VILLAGER);
    assert.equal("wolfTeammates" in villager, false);

    kill(state, "seat-1");
    const deadWolf = projectForViewer(state, player("seat-1"));
    assert.equal(deadWolf.self.role, ROLES.WEREWOLF);
    assert.deepEqual(deadWolf.self.availableActions, []);
    assert.equal("wolfTeammates" in deadWolf, false);
    assert.equal(JSON.stringify(deadWolf).includes("seat-2\",\"role\":\"WEREWOLF"), false);
  });

  it("shows witch inventory and the authorized wolf target only during her phase", () => {
    const state = inPhase(PHASES.NIGHT_WITCH, {
      witchInventory: { antidote: 0, poison: 1 },
      night: { wolfTargets: { "seat-1": "seat-5" }, wolfAttackTarget: "seat-5", witchAction: null, seerTarget: null },
    });
    const witch = projectForViewer(state, player("seat-5"));
    assert.deepEqual(witch.self.abilities, { antidote: 0, poison: 1 });
    assert.equal(witch.self.wolfAttackTarget, "seat-5");
    assert.deepEqual(witch.self.availableActions, [COMMANDS.WITCH_ACTION_SET]);

    const outsider = projectForViewer(state, player("seat-7"));
    assert.equal("wolfAttackTarget" in outsider.self, false);
    assert.equal(JSON.stringify(outsider).includes("wolfAttackTarget"), false);

    state.phase = PHASES.NIGHT_SEER;
    assert.equal("wolfAttackTarget" in projectForViewer(state, player("seat-5")).self, false);
    kill(state, "seat-5", ["WITCH_POISON"]);
    state.phase = PHASES.NIGHT_WITCH;
    assert.equal("wolfAttackTarget" in projectForViewer(state, player("seat-5")).self, false);
  });

  it("filters seer results to the viewing seer", () => {
    const state = inPhase(PHASES.NIGHT_SEER, {
      seerResults: [
        { seerSeatId: "seat-4", targetSeatId: "seat-1", team: TEAMS.WEREWOLF, round: 1 },
        { seerSeatId: "other-seer", targetSeatId: "seat-2", team: TEAMS.WEREWOLF, round: 0 },
      ],
    });
    const seer = projectForViewer(state, player("seat-4"));
    assert.deepEqual(seer.self.availableActions, [COMMANDS.SEER_TARGET_SET]);
    assert.deepEqual(seer.self.seerResults, [{ seerSeatId: "seat-4", targetSeatId: "seat-1", team: TEAMS.WEREWOLF, round: 1 }]);
    seer.self.seerResults[0].team = TEAMS.GOOD;
    assert.equal(state.seerResults[0].team, TEAMS.WEREWOLF);
    assert.deepEqual(projectForViewer(state, player("seat-7")).self.seerResults, []);
    assert.equal(JSON.stringify(projectForViewer(state, spectator)).includes("other-seer"), false);
  });

  it("projects hunter, speech, vote, and idle actions", () => {
    const hunterState = inPhase(PHASES.HUNTER_SHOT, {
      pendingHunter: { seatId: "seat-6", resumePhase: PHASES.DAY_SPEECH },
    });
    kill(hunterState, "seat-6", ["WOLF_ATTACK"]);
    const hunter = projectForViewer(hunterState, player("seat-6"));
    assert.deepEqual(hunter.self.abilities, { canShoot: true });
    assert.deepEqual(hunter.self.availableActions, [COMMANDS.HUNTER_SHOT_SET]);
    assert.deepEqual(projectForViewer(hunterState, player("seat-7")).self.availableActions, []);

    const idleHunter = projectForViewer(inPhase(PHASES.ROLE_REVEAL), player("seat-6"));
    assert.deepEqual(idleHunter.self.abilities, { canShoot: false });
    assert.deepEqual(idleHunter.self.availableActions, []);

    const speechState = inPhase(PHASES.DAY_SPEECH, { speechOrder: ["seat-7", "seat-8"], speechIndex: 0 });
    assert.deepEqual(projectForViewer(speechState, player("seat-7")).self.availableActions, [COMMANDS.SPEECH_FINISH]);
    assert.deepEqual(projectForViewer(speechState, player("seat-8")).self.availableActions, []);

    const voteState = inPhase(PHASES.DAY_VOTE);
    assert.deepEqual(projectForViewer(voteState, player("seat-7")).self.availableActions, [COMMANDS.VOTE_CAST]);
    kill(voteState, "seat-7");
    assert.deepEqual(projectForViewer(voteState, player("seat-7")).self.availableActions, []);
  });

  it("gives the exiled player a last-word action even though the player is dead", () => {
    const state = inPhase(PHASES.LAST_WORD, {
      pendingLastWord: { seatId: "seat-7", hunterEligible: false },
    });
    kill(state, "seat-7");
    const self = projectForViewer(state, player("seat-7"));
    assert.equal(self.currentSpeakerSeatId, "seat-7");
    assert.deepEqual(self.self.availableActions, [COMMANDS.LAST_WORD_FINISH]);
    assert.deepEqual(projectForViewer(state, player("seat-8")).self.availableActions, []);
    assert.equal(projectForViewer(state, spectator).currentSpeakerSeatId, "seat-7");
  });

  it("restores the player's own final selection without revealing other selections", () => {
    const vote = inPhase(PHASES.DAY_VOTE);
    assert.deepEqual(projectForViewer(vote, player("seat-7")).self.currentAction, {
      type: COMMANDS.VOTE_CAST, submitted: false, targetSeatId: null,
    });
    vote.votes["seat-7"] = null;
    vote.votes["seat-8"] = "seat-1";
    assert.deepEqual(projectForViewer(vote, player("seat-7")).self.currentAction, {
      type: COMMANDS.VOTE_CAST, submitted: true, targetSeatId: null,
    });
    vote.votes["seat-7"] = "seat-2";
    assert.equal(projectForViewer(vote, player("seat-7")).self.currentAction.targetSeatId, "seat-2");
    assert.equal(projectForViewer(vote, player("seat-9")).self.currentAction.targetSeatId, null);
    kill(vote, "seat-7");
    assert.equal(projectForViewer(vote, player("seat-7")).self.currentAction, null);

    const wolf = inPhase(PHASES.NIGHT_WOLF);
    assert.equal(projectForViewer(wolf, player("seat-1")).self.currentAction.submitted, false);
    wolf.night.wolfTargets["seat-1"] = null;
    assert.deepEqual(projectForViewer(wolf, player("seat-1")).self.currentAction, {
      type: COMMANDS.WOLF_TARGET_SET, submitted: true, targetSeatId: null,
    });
    wolf.night.wolfTargets["seat-1"] = "seat-7";
    assert.equal(projectForViewer(wolf, player("seat-1")).self.currentAction.targetSeatId, "seat-7");
    assert.equal(projectForViewer(wolf, player("seat-2")).self.currentAction.targetSeatId, null);

    const witch = inPhase(PHASES.NIGHT_WITCH);
    assert.deepEqual(projectForViewer(witch, player("seat-5")).self.currentAction, {
      type: COMMANDS.WITCH_ACTION_SET, submitted: false, kind: null, targetSeatId: null,
    });
    for (const action of [{ kind: "SKIP" }, { kind: "POISON", targetSeatId: "seat-1" }]) {
      witch.night.witchAction = action;
      assert.deepEqual(projectForViewer(witch, player("seat-5")).self.currentAction, {
        type: COMMANDS.WITCH_ACTION_SET, submitted: true, kind: action.kind, targetSeatId: action.targetSeatId ?? null,
      });
    }

    const seer = inPhase(PHASES.NIGHT_SEER);
    assert.equal(projectForViewer(seer, player("seat-4")).self.currentAction.submitted, false);
    seer.night.seerTarget = "seat-1";
    assert.deepEqual(projectForViewer(seer, player("seat-4")).self.currentAction, {
      type: COMMANDS.SEER_TARGET_SET, submitted: true, targetSeatId: "seat-1",
    });
  });
});

"use strict";

const { createHash } = require("node:crypto");
const { PHASES, ROLES, TEAMS, assertInvariant, roleTeam } = require("../game");

const VIEWER_TYPES = Object.freeze({
  PLAYER: "PLAYER",
  SPECTATOR: "SPECTATOR",
});

class ProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectionError(code, message);
}

function projectForViewer(state, viewer) {
  assertInvariant(state);
  validateViewer(state, viewer);

  const currentSpeakerSeatId = state.phase === PHASES.DAY_SPEECH
    ? (state.speechOrder[state.speechIndex] ?? null)
    : (state.phase === PHASES.LAST_WORD ? state.pendingLastWord.seatId : null);
  const snapshot = {
    schemaVersion: state.schemaVersion,
    roomId: state.roomId,
    gameId: state.gameId,
    rulesetId: state.rulesetId,
    phase: state.phase,
    round: state.round,
    deadlineAt: state.deadlineAt,
    hostSeatId: state.hostSeatId,
    seats: state.seats.map((seat) => ({ seatId: seat.seatId, ready: seat.ready, alive: seat.alive })),
    currentSpeakerSeatId,
    deaths: state.deaths.map(({ seatId, reasons, round }) => ({ seatId, reasons: [...reasons], round })),
    voteHistory: state.voteHistory.map(({ round, exiledSeatId, ballots }) => ({
      round,
      exiledSeatId,
      ballots: ballots.map(({ voterSeatId, targetSeatId }) => ({ voterSeatId, targetSeatId })),
    })),
    result: state.winner ? { winner: state.winner, reason: state.finishReason } : null,
  };

  if (viewer.type === VIEWER_TYPES.PLAYER) {
    snapshot.self = projectSelf(state, viewer.seatId);
    if (snapshot.self.alive && snapshot.self.role === ROLES.WEREWOLF) {
      snapshot.wolfTeammates = Object.entries(state.roles)
        .filter(([seatId, role]) => seatId !== viewer.seatId && role === ROLES.WEREWOLF)
        .map(([seatId, role]) => ({ seatId, role, team: TEAMS.WEREWOLF }));
    }
  }

  if (state.phase === PHASES.GAME_OVER) {
    snapshot.revealedRoles = state.seats.map((seat) => ({
      seatId: seat.seatId,
      role: state.roles[seat.seatId],
      team: roleTeam(state.roles[seat.seatId]),
    }));
  }
  // Private actions by other players must not change this player's observable
  // version. Never expose or hash the authority sequence into a client DTO.
  snapshot.version = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return snapshot;
}

function validateViewer(state, viewer) {
  if (!viewer || typeof viewer !== "object" || Array.isArray(viewer) || !Object.values(VIEWER_TYPES).includes(viewer.type)) {
    fail("INVALID_VIEWER", "Viewer must be a player or spectator");
  }
  if (viewer.type === VIEWER_TYPES.PLAYER && !state.seats.some((seat) => seat.seatId === viewer.seatId)) {
    fail("INVALID_VIEWER", "Player viewer must occupy a seat");
  }
}

function projectSelf(state, seatId) {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  const role = state.roles[seatId] || null;
  const self = {
    seatId,
    ready: seat.ready,
    alive: seat.alive,
    role,
    team: role ? roleTeam(role) : null,
    abilities: projectAbilities(state, role, seatId),
    seerResults: role === ROLES.SEER
      ? state.seerResults.filter((result) => result.seerSeatId === seatId)
        .map(({ seerSeatId, targetSeatId, team, round }) => ({ seerSeatId, targetSeatId, team, round }))
      : [],
    currentAction: seat.alive ? projectCurrentAction(state, role, seatId) : null,
    availableActions: availableActions(state, role, seatId, seat.alive),
  };
  if (role === ROLES.WITCH && seat.alive && state.phase === PHASES.NIGHT_WITCH) {
    self.wolfAttackTarget = state.night.wolfAttackTarget;
  }
  return self;
}

function projectAbilities(state, role, seatId) {
  if (role === ROLES.WITCH) {
    return { antidote: state.witchInventory.antidote, poison: state.witchInventory.poison };
  }
  if (role === ROLES.HUNTER) {
    return { canShoot: state.phase === PHASES.HUNTER_SHOT && state.pendingHunter?.seatId === seatId };
  }
  return {};
}

function projectCurrentAction(state, role, seatId) {
  if (state.phase === PHASES.DAY_VOTE) {
    return { type: "VOTE_CAST", submitted: Object.hasOwn(state.votes, seatId), targetSeatId: state.votes[seatId] ?? null };
  }
  if (state.phase === PHASES.NIGHT_WOLF && role === ROLES.WEREWOLF) {
    return { type: "WOLF_TARGET_SET", submitted: Object.hasOwn(state.night.wolfTargets, seatId), targetSeatId: state.night.wolfTargets[seatId] ?? null };
  }
  if (state.phase === PHASES.NIGHT_WITCH && role === ROLES.WITCH) {
    const action = state.night.witchAction;
    return { type: "WITCH_ACTION_SET", submitted: action !== null, kind: action?.kind ?? null, targetSeatId: action?.targetSeatId ?? null };
  }
  if (state.phase === PHASES.NIGHT_SEER && role === ROLES.SEER) {
    return { type: "SEER_TARGET_SET", submitted: state.night.seerTarget !== null, targetSeatId: state.night.seerTarget };
  }
  return null;
}

function availableActions(state, role, seatId, alive) {
  if (state.phase === PHASES.LOBBY) {
    const actions = ["ROOM_READY_SET"];
    if (seatId === state.hostSeatId && state.seats.every((seat) => seat.ready)) actions.push("GAME_START");
    return actions;
  }
  if (state.phase === PHASES.LAST_WORD && state.pendingLastWord.seatId === seatId) return ["LAST_WORD_FINISH"];
  if (state.phase === PHASES.HUNTER_SHOT && state.pendingHunter?.seatId === seatId) return ["HUNTER_SHOT_SET"];
  if (!alive) return [];
  if (state.phase === PHASES.NIGHT_WOLF && role === ROLES.WEREWOLF) return ["WOLF_TARGET_SET"];
  if (state.phase === PHASES.NIGHT_WITCH && role === ROLES.WITCH) return ["WITCH_ACTION_SET"];
  if (state.phase === PHASES.NIGHT_SEER && role === ROLES.SEER) return ["SEER_TARGET_SET"];
  if (state.phase === PHASES.DAY_SPEECH && state.speechOrder[state.speechIndex] === seatId) return ["SPEECH_FINISH"];
  if (state.phase === PHASES.DAY_VOTE) return ["VOTE_CAST"];
  return [];
}

module.exports = { ProjectionError, VIEWER_TYPES, projectForViewer };

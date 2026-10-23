"use strict";

const { isDeepStrictEqual } = require("node:util");

const SCHEMA_VERSION = 1;
const RULESET_ID = "standard-9-v1";

const PHASES = Object.freeze({
  LOBBY: "LOBBY",
  ROLE_REVEAL: "ROLE_REVEAL",
  NIGHT_WOLF: "NIGHT_WOLF",
  NIGHT_WITCH: "NIGHT_WITCH",
  NIGHT_SEER: "NIGHT_SEER",
  DAWN_RESOLUTION: "DAWN_RESOLUTION",
  DAY_SPEECH: "DAY_SPEECH",
  DAY_VOTE: "DAY_VOTE",
  LAST_WORD: "LAST_WORD",
  HUNTER_SHOT: "HUNTER_SHOT",
  GAME_OVER: "GAME_OVER",
});

const ROLES = Object.freeze({
  WEREWOLF: "WEREWOLF",
  SEER: "SEER",
  WITCH: "WITCH",
  HUNTER: "HUNTER",
  VILLAGER: "VILLAGER",
});

const TEAMS = Object.freeze({
  WEREWOLF: "WEREWOLF",
  GOOD: "GOOD",
});

const COMMANDS = Object.freeze({
  ROOM_READY_SET: "ROOM_READY_SET",
  GAME_START: "GAME_START",
  WOLF_TARGET_SET: "WOLF_TARGET_SET",
  WITCH_ACTION_SET: "WITCH_ACTION_SET",
  SEER_TARGET_SET: "SEER_TARGET_SET",
  SPEECH_FINISH: "SPEECH_FINISH",
  VOTE_CAST: "VOTE_CAST",
  LAST_WORD_FINISH: "LAST_WORD_FINISH",
  HUNTER_SHOT_SET: "HUNTER_SHOT_SET",
  PHASE_TIMEOUT: "PHASE_TIMEOUT",
});

const EVENTS = Object.freeze({
  GAME_STARTED: "GAME_STARTED",
  ROLE_ASSIGNED: "ROLE_ASSIGNED",
  PHASE_CHANGED: "PHASE_CHANGED",
  PRIVATE_ACTION_RECORDED: "PRIVATE_ACTION_RECORDED",
  SEER_RESULT_RECORDED: "SEER_RESULT_RECORDED",
  PLAYER_DIED: "PLAYER_DIED",
  VOTE_RECORDED: "VOTE_RECORDED",
  VOTE_RESULT_REVEALED: "VOTE_RESULT_REVEALED",
  GAME_FINISHED: "GAME_FINISHED",
  ROLES_REVEALED: "ROLES_REVEALED",
});

const ROLE_DECK = Object.freeze([
  ROLES.WEREWOLF,
  ROLES.WEREWOLF,
  ROLES.WEREWOLF,
  ROLES.SEER,
  ROLES.WITCH,
  ROLES.HUNTER,
  ROLES.VILLAGER,
  ROLES.VILLAGER,
  ROLES.VILLAGER,
]);

const TIMED_PHASES = new Set([
  PHASES.ROLE_REVEAL,
  PHASES.NIGHT_WOLF,
  PHASES.NIGHT_WITCH,
  PHASES.NIGHT_SEER,
  PHASES.DAY_SPEECH,
  PHASES.DAY_VOTE,
  PHASES.LAST_WORD,
  PHASES.HUNTER_SHOT,
]);

const PHASE_TRANSITIONS = Object.freeze({
  [PHASES.LOBBY]: new Set([PHASES.ROLE_REVEAL]),
  [PHASES.ROLE_REVEAL]: new Set([PHASES.NIGHT_WOLF]),
  [PHASES.NIGHT_WOLF]: new Set([PHASES.NIGHT_WITCH]),
  [PHASES.NIGHT_WITCH]: new Set([PHASES.NIGHT_SEER]),
  [PHASES.NIGHT_SEER]: new Set([PHASES.DAWN_RESOLUTION]),
  [PHASES.DAWN_RESOLUTION]: new Set([PHASES.DAY_SPEECH, PHASES.HUNTER_SHOT]),
  [PHASES.DAY_SPEECH]: new Set([PHASES.DAY_SPEECH, PHASES.DAY_VOTE]),
  [PHASES.DAY_VOTE]: new Set([PHASES.NIGHT_WOLF, PHASES.LAST_WORD]),
  [PHASES.LAST_WORD]: new Set([PHASES.NIGHT_WOLF, PHASES.HUNTER_SHOT]),
  [PHASES.HUNTER_SHOT]: new Set([PHASES.NIGHT_WOLF, PHASES.DAY_SPEECH]),
  [PHASES.GAME_OVER]: new Set(),
});

class GameRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new GameRuleError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function roleTeam(role) {
  if (!ROLE_DECK.includes(role)) fail("INVALID_STATE", "Unknown role");
  return role === ROLES.WEREWOLF ? TEAMS.WEREWOLF : TEAMS.GOOD;
}

function sortedSeatIds(seats) {
  return seats.map((seat) => seat.seatId).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function createInitialState(input) {
  if (!isRecord(input)) fail("INVALID_REQUEST", "Initial game input must be an object");
  const { roomId, gameId, hostSeatId, seats, rulesetId = RULESET_ID } = input;
  if (!isSafeId(roomId) || !isSafeId(gameId) || !isSafeId(hostSeatId) || rulesetId !== RULESET_ID ||
      !Array.isArray(seats) || seats.length !== 9) {
    fail("INVALID_REQUEST", "A standard-9 game requires room, game, host, and exactly nine seats");
  }
  if (!isSafeId(hostSeatId) || seats.some((seat) => !isRecord(seat))) {
    fail("INVALID_REQUEST", "Host and seats must use valid objects and identifiers");
  }
  const seatIds = seats.map((seat) => seat.seatId);
  if (seatIds.some((seatId) => !isSafeId(seatId)) || new Set(seatIds).size !== 9) {
    fail("INVALID_REQUEST", "Seat identifiers must be nine unique non-empty strings");
  }
  if (!seatIds.includes(hostSeatId)) fail("INVALID_REQUEST", "Host must occupy a seat");

  const state = {
    schemaVersion: SCHEMA_VERSION,
    rulesetId,
    roomId,
    gameId,
    hostSeatId,
    phase: PHASES.LOBBY,
    started: false,
    round: 0,
    seq: 0,
    deadlineAt: null,
    seats: seats.map((seat) => ({ seatId: seat.seatId, ready: Boolean(seat.ready), alive: true })),
    roles: {},
    witchInventory: { antidote: 1, poison: 1 },
    night: { wolfTargets: {}, wolfAttackTarget: null, witchAction: null, seerTarget: null },
    seerResults: [],
    speechOrder: [],
    speechIndex: null,
    votes: {},
    voteHistory: [],
    deaths: [],
    pendingLastWord: null,
    pendingHunter: null,
    hunterShotTarget: null,
    hunterResolved: false,
    winner: null,
    finishReason: null,
  };
  assertInvariant(state);
  return state;
}

function assertInvariant(state) {
  if (!isRecord(state) || state.schemaVersion !== SCHEMA_VERSION || state.rulesetId !== RULESET_ID) {
    fail("INVALID_STATE", "Unsupported state schema or ruleset");
  }
  if (!Object.values(PHASES).includes(state.phase) || typeof state.started !== "boolean" ||
      typeof state.hunterResolved !== "boolean" ||
      !isSafeId(state.roomId) || !isSafeId(state.gameId) || !isSafeId(state.hostSeatId) ||
      !Number.isInteger(state.seq) || state.seq < 0 ||
      !Number.isInteger(state.round) || state.round < 0 ||
      (state.deadlineAt !== null && (typeof state.deadlineAt !== "string" || !state.deadlineAt))) {
    fail("INVALID_STATE", "State phase and sequence must be valid");
  }
  if (!Array.isArray(state.seats) || !isRecord(state.roles) || !isRecord(state.witchInventory) ||
      !isRecord(state.night) || !isRecord(state.night.wolfTargets) || !isRecord(state.votes) ||
      !Array.isArray(state.seerResults) || !Array.isArray(state.speechOrder) || !Array.isArray(state.voteHistory) ||
      !Array.isArray(state.deaths)) {
    fail("INVALID_STATE", "State collections are malformed");
  }
  if (state.seats.some((seat) => !isRecord(seat) || !isSafeId(seat.seatId))) {
    fail("INVALID_STATE", "Seats must contain safe identifiers");
  }
  const seatIds = state.seats.map((seat) => seat.seatId);
  if (state.seats.length !== 9 || new Set(seatIds).size !== 9 || !seatIds.includes(state.hostSeatId)) {
    fail("INVALID_STATE", "State must retain nine unique seats and a seated host");
  }
  if (state.seats.some((seat) => typeof seat.alive !== "boolean" || typeof seat.ready !== "boolean")) {
    fail("INVALID_STATE", "Seat flags must be boolean");
  }
  if (![0, 1].includes(state.witchInventory.antidote) || ![0, 1].includes(state.witchInventory.poison)) {
    fail("INVALID_STATE", "Witch inventory must be zero or one");
  }

  const assignments = Object.entries(state.roles);
  if (assignments.some(([seatId, role]) => !seatIds.includes(seatId) || !ROLE_DECK.includes(role))) {
    fail("INVALID_STATE", "Role assignments must reference known seats and roles");
  }
  if (state.phase !== PHASES.LOBBY || assignments.length === 9) {
    const assignedRoles = assignments.map(([, role]) => role).sort();
    const expectedRoles = [...ROLE_DECK].sort();
    if (assignments.length !== 9 || assignedRoles.some((role, index) => role !== expectedRoles[index])) {
      fail("INVALID_STATE", "Started games must retain the standard role deck");
    }
  }
  if ((state.phase !== PHASES.LOBBY || assignments.length > 0) && !state.started) {
    fail("INVALID_STATE", "Started state marker is inconsistent");
  }

  const optionalSeatIds = [state.night.wolfAttackTarget, state.night.seerTarget];
  if (optionalSeatIds.some((seatId) => seatId !== null && !seatIds.includes(seatId)) ||
      (state.night.witchAction !== null && !isRecord(state.night.witchAction)) ||
      state.speechOrder.some((seatId) => !seatIds.includes(seatId)) ||
      new Set(state.speechOrder).size !== state.speechOrder.length ||
      (state.speechIndex !== null && (!Number.isInteger(state.speechIndex) || state.speechIndex < 0))) {
    fail("INVALID_STATE", "Turn and night state are malformed");
  }

  if (state.deaths.some((death) => !isRecord(death) || !seatIds.includes(death.seatId) ||
      !Array.isArray(death.reasons) || !death.reasons.length || !Number.isInteger(death.round) || death.round < 1)) {
    fail("INVALID_STATE", "Death records are malformed");
  }
  const deathSeatIds = state.deaths.map((death) => death.seatId);
  if (new Set(deathSeatIds).size !== deathSeatIds.length) fail("INVALID_STATE", "A player may die only once");
  for (const seat of state.seats) {
    if (seat.alive === deathSeatIds.includes(seat.seatId)) fail("INVALID_STATE", "Alive flags must agree with deaths");
  }
  if ((state.phase === PHASES.GAME_OVER) !== Boolean(state.winner) ||
      (state.winner !== null && !Object.values(TEAMS).includes(state.winner))) {
    fail("INVALID_STATE", "Only completed games have a winner");
  }
  if ((state.phase === PHASES.LAST_WORD) !== Boolean(state.pendingLastWord)) {
    fail("INVALID_STATE", "Only the last-word phase has a pending last word");
  }
  if ((state.phase === PHASES.HUNTER_SHOT) !== Boolean(state.pendingHunter)) {
    fail("INVALID_STATE", "Only the hunter phase has a pending hunter");
  }
  if (state.hunterShotTarget !== null && state.phase !== PHASES.HUNTER_SHOT) {
    fail("INVALID_STATE", "A hunter target exists only during the hunter phase");
  }
  if (state.hunterResolved && state.phase !== PHASES.HUNTER_SHOT) {
    fail("INVALID_STATE", "Hunter resolution proof exists only during the hunter phase");
  }
  if (state.pendingLastWord && (!isRecord(state.pendingLastWord) || !seatIds.includes(state.pendingLastWord.seatId) ||
      typeof state.pendingLastWord.hunterEligible !== "boolean" || isLivingSeat(state, state.pendingLastWord.seatId) ||
      state.pendingLastWord.hunterEligible !== (state.roles[state.pendingLastWord.seatId] === ROLES.HUNTER) ||
      !state.deaths.find((death) => death.seatId === state.pendingLastWord.seatId)?.reasons.includes("EXILED"))) {
    fail("INVALID_STATE", "Pending last word is malformed");
  }
  if (state.pendingHunter && (!isRecord(state.pendingHunter) || state.roles[state.pendingHunter.seatId] !== ROLES.HUNTER ||
      isLivingSeat(state, state.pendingHunter.seatId) ||
      ![PHASES.DAY_SPEECH, PHASES.NIGHT_WOLF].includes(state.pendingHunter.resumePhase))) {
    fail("INVALID_STATE", "Pending hunter is malformed");
  }
  if (state.hunterShotTarget !== null && (!isSafeId(state.hunterShotTarget) ||
      !state.seats.some((seat) => seat.seatId === state.hunterShotTarget))) {
    fail("INVALID_STATE", "Hunter target is malformed");
  }
  for (const dictionary of [state.night.wolfTargets, state.votes]) {
    if (Object.entries(dictionary).some(([actorSeatId, targetSeatId]) =>
      !seatIds.includes(actorSeatId) || (targetSeatId !== null && !seatIds.includes(targetSeatId)))) {
      fail("INVALID_STATE", "Action dictionaries reference unknown seats");
    }
  }
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) &&
    value !== "constructor" && value !== "prototype" && value !== "__proto__";
}

function requireSeat(state, seatId) {
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  if (!seat) fail("ACTION_NOT_ALLOWED", "Actor does not occupy this game");
  return seat;
}

function requireAliveActor(state, command) {
  const seat = requireSeat(state, command.actorSeatId);
  if (!seat.alive) fail("ACTION_NOT_ALLOWED", "Dead players cannot act");
  return seat;
}

function requirePhase(state, phase) {
  if (state.phase !== phase) fail("ACTION_NOT_ALLOWED", `Command is not allowed during ${state.phase}`);
}

function requireTarget(state, actorSeatId, targetSeatId, allowNull = false) {
  if (allowNull && targetSeatId === null) return null;
  const target = state.seats.find((seat) => seat.seatId === targetSeatId);
  if (!target || !target.alive || target.seatId === actorSeatId) {
    fail("ACTION_NOT_ALLOWED", "Target must be another living player");
  }
  return target;
}

function validateCommand(state, command) {
  if (!command || command.schemaVersion !== SCHEMA_VERSION || typeof command.actionId !== "string" || !command.actionId) {
    fail("INVALID_REQUEST", "Command schema and actionId are required");
  }
  if (command.gameId !== state.gameId) fail("INVALID_REQUEST", "Command gameId does not match state");
  if (command.expectedSeq !== state.seq) fail("SEQUENCE_CONFLICT", "Command expectedSeq is stale");
  if (!Object.values(COMMANDS).includes(command.type)) fail("INVALID_REQUEST", "Unknown command type");
}

function eventFor(state, command, context, type, payload) {
  if (typeof context.at !== "string" || !context.at) fail("INVALID_REQUEST", "Event time must be injected");
  const seq = state.seq + 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `${state.gameId}:${seq}`,
    gameId: state.gameId,
    seq,
    type,
    at: context.at,
    causationId: command.actionId,
    payload,
  };
}

function decide(state, command, context = {}) {
  assertInvariant(state);
  validateCommand(state, command);

  let draft = clone(state);
  const events = [];
  const emit = (type, payload) => {
    const event = eventFor(draft, command, context, type, payload);
    const next = evolve(draft, event);
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, next);
    events.push(event);
  };
  const changePhase = (phase, extra = {}) => emit(EVENTS.PHASE_CHANGED, {
    phase,
    round: extra.round ?? draft.round,
    deadlineAt: context.deadlineAt ?? null,
    ...extra,
  });

  switch (command.type) {
    case COMMANDS.ROOM_READY_SET: {
      requirePhase(draft, PHASES.LOBBY);
      const actor = requireSeat(draft, command.actorSeatId);
      if (typeof command.payload?.ready !== "boolean") fail("INVALID_REQUEST", "ready must be boolean");
      emit(EVENTS.PRIVATE_ACTION_RECORDED, {
        actionType: command.type,
        actorSeatId: actor.seatId,
        ready: command.payload.ready,
      });
      break;
    }
    case COMMANDS.GAME_START: {
      requirePhase(draft, PHASES.LOBBY);
      if (command.actorSeatId !== draft.hostSeatId) fail("ACTION_NOT_ALLOWED", "Only the host can start the game");
      if (draft.seats.some((seat) => !seat.ready)) fail("ACTION_NOT_ALLOWED", "All seats must be ready");
      const assignments = normalizeAssignments(draft, context.roleAssignments);
      emit(EVENTS.GAME_STARTED, { rulesetId: RULESET_ID, seatIds: sortedSeatIds(draft.seats) });
      for (const { seatId, role } of assignments) emit(EVENTS.ROLE_ASSIGNED, { seatId, role, team: roleTeam(role) });
      changePhase(PHASES.ROLE_REVEAL, { round: 0 });
      break;
    }
    case COMMANDS.WOLF_TARGET_SET: {
      requirePhase(draft, PHASES.NIGHT_WOLF);
      requireAliveActor(draft, command);
      if (draft.roles[command.actorSeatId] !== ROLES.WEREWOLF) fail("ACTION_NOT_ALLOWED", "Only a living werewolf can choose a target");
      const targetSeatId = command.payload?.targetSeatId ?? null;
      requireTarget(draft, command.actorSeatId, targetSeatId, true);
      emit(EVENTS.PRIVATE_ACTION_RECORDED, { actionType: command.type, actorSeatId: command.actorSeatId, targetSeatId });
      break;
    }
    case COMMANDS.WITCH_ACTION_SET: {
      requirePhase(draft, PHASES.NIGHT_WITCH);
      requireAliveActor(draft, command);
      if (draft.roles[command.actorSeatId] !== ROLES.WITCH) fail("ACTION_NOT_ALLOWED", "Only the living witch can use potions");
      const action = normalizeWitchAction(draft, command.actorSeatId, command.payload);
      emit(EVENTS.PRIVATE_ACTION_RECORDED, { actionType: command.type, actorSeatId: command.actorSeatId, action });
      break;
    }
    case COMMANDS.SEER_TARGET_SET: {
      requirePhase(draft, PHASES.NIGHT_SEER);
      requireAliveActor(draft, command);
      if (draft.roles[command.actorSeatId] !== ROLES.SEER) fail("ACTION_NOT_ALLOWED", "Only the living seer can inspect a player");
      const target = requireTarget(draft, command.actorSeatId, command.payload?.targetSeatId);
      emit(EVENTS.PRIVATE_ACTION_RECORDED, { actionType: command.type, actorSeatId: command.actorSeatId, targetSeatId: target.seatId });
      break;
    }
    case COMMANDS.SPEECH_FINISH: {
      requirePhase(draft, PHASES.DAY_SPEECH);
      requireAliveActor(draft, command);
      if (draft.speechOrder[draft.speechIndex] !== command.actorSeatId) fail("ACTION_NOT_ALLOWED", "Only the current speaker can finish");
      advanceSpeech(draft, changePhase);
      break;
    }
    case COMMANDS.VOTE_CAST: {
      requirePhase(draft, PHASES.DAY_VOTE);
      requireAliveActor(draft, command);
      const targetSeatId = command.payload?.targetSeatId ?? null;
      requireTarget(draft, command.actorSeatId, targetSeatId, true);
      emit(EVENTS.VOTE_RECORDED, { voterSeatId: command.actorSeatId, targetSeatId });
      break;
    }
    case COMMANDS.LAST_WORD_FINISH: {
      requirePhase(draft, PHASES.LAST_WORD);
      if (draft.pendingLastWord.seatId !== command.actorSeatId) fail("ACTION_NOT_ALLOWED", "Only the exiled player can finish the last word");
      finishLastWord(draft, emit, changePhase);
      break;
    }
    case COMMANDS.HUNTER_SHOT_SET: {
      requirePhase(draft, PHASES.HUNTER_SHOT);
      if (!draft.pendingHunter || draft.pendingHunter.seatId !== command.actorSeatId) {
        fail("ACTION_NOT_ALLOWED", "Only the pending hunter can shoot");
      }
      const resumePhase = draft.pendingHunter.resumePhase;
      const targetSeatId = command.payload?.targetSeatId ?? null;
      requireTarget(draft, command.actorSeatId, targetSeatId, true);
      emit(EVENTS.PRIVATE_ACTION_RECORDED, { actionType: command.type, actorSeatId: command.actorSeatId, targetSeatId });
      if (targetSeatId) emit(EVENTS.PLAYER_DIED, { seatId: targetSeatId, reasons: ["HUNTER_SHOT"], round: draft.round });
      finishResolution(draft, emit, changePhase, resumePhase);
      break;
    }
    case COMMANDS.PHASE_TIMEOUT: {
      if (context.trusted !== true) fail("ACTION_NOT_ALLOWED", "Only the trusted scheduler can time out a phase");
      if (!TIMED_PHASES.has(draft.phase)) fail("ACTION_NOT_ALLOWED", "The current phase has no timeout transition");
      handleTimeout(draft, emit, changePhase);
      break;
    }
  }

  return events;
}

function normalizeAssignments(state, roleAssignments) {
  if (!roleAssignments || typeof roleAssignments !== "object" || Array.isArray(roleAssignments)) {
    fail("INVALID_REQUEST", "Trusted role assignments are required");
  }
  const seatIds = sortedSeatIds(state.seats);
  const assignmentKeys = Object.keys(roleAssignments).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const roles = assignmentKeys.map((seatId) => roleAssignments[seatId]).sort();
  const expectedRoles = [...ROLE_DECK].sort();
  if (assignmentKeys.length !== 9 || assignmentKeys.some((seatId, index) => seatId !== seatIds[index]) ||
      roles.some((role, index) => role !== expectedRoles[index])) {
    fail("INVALID_REQUEST", "Assignments must map every seat to the standard role deck");
  }
  return seatIds.map((seatId) => ({ seatId, role: roleAssignments[seatId] }));
}

function normalizeWitchAction(state, witchSeatId, payload) {
  const kind = payload?.kind;
  if (kind === "SKIP") return { kind };
  if (kind === "SAVE") {
    if (!state.witchInventory.antidote || !state.night.wolfAttackTarget) fail("ACTION_NOT_ALLOWED", "Antidote cannot be used now");
    if (state.night.wolfAttackTarget === witchSeatId && state.round !== 1) fail("ACTION_NOT_ALLOWED", "The witch can self-save only on the first night");
    return { kind, targetSeatId: state.night.wolfAttackTarget };
  }
  if (kind === "POISON") {
    if (!state.witchInventory.poison) fail("ACTION_NOT_ALLOWED", "Poison has already been used");
    const target = requireTarget(state, witchSeatId, payload?.targetSeatId);
    return { kind, targetSeatId: target.seatId };
  }
  fail("INVALID_REQUEST", "Witch action must be SAVE, POISON, or SKIP");
}

function advanceSpeech(state, changePhase) {
  if (state.speechIndex + 1 < state.speechOrder.length) {
    changePhase(PHASES.DAY_SPEECH, {
      speechOrder: state.speechOrder,
      speechIndex: state.speechIndex + 1,
      currentSpeakerSeatId: state.speechOrder[state.speechIndex + 1],
    });
  } else {
    changePhase(PHASES.DAY_VOTE);
  }
}

function handleTimeout(state, emit, changePhase) {
  switch (state.phase) {
    case PHASES.ROLE_REVEAL:
      changePhase(PHASES.NIGHT_WOLF, { round: 1 });
      return;
    case PHASES.NIGHT_WOLF:
      changePhase(PHASES.NIGHT_WITCH);
      return;
    case PHASES.NIGHT_WITCH:
      changePhase(PHASES.NIGHT_SEER);
      return;
    case PHASES.NIGHT_SEER:
      resolveNight(state, emit, changePhase);
      return;
    case PHASES.DAY_SPEECH:
      advanceSpeech(state, changePhase);
      return;
    case PHASES.DAY_VOTE:
      resolveVote(state, emit, changePhase);
      return;
    case PHASES.LAST_WORD:
      finishLastWord(state, emit, changePhase);
      return;
    case PHASES.HUNTER_SHOT:
      emit(EVENTS.PRIVATE_ACTION_RECORDED, {
        actionType: COMMANDS.HUNTER_SHOT_SET,
        actorSeatId: state.pendingHunter.seatId,
        targetSeatId: null,
        timedOut: true,
      });
      finishResolution(state, emit, changePhase);
      return;
  }
}

function resolveNight(state, emit, changePhase) {
  if (state.night.seerTarget) {
    emit(EVENTS.SEER_RESULT_RECORDED, {
      seerSeatId: roleSeatId(state, ROLES.SEER),
      targetSeatId: state.night.seerTarget,
      team: roleTeam(state.roles[state.night.seerTarget]),
      round: state.round,
    });
  }
  changePhase(PHASES.DAWN_RESOLUTION);

  const reasonsBySeat = new Map();
  const saved = state.night.witchAction?.kind === "SAVE" ? state.night.witchAction.targetSeatId : null;
  if (state.night.wolfAttackTarget && state.night.wolfAttackTarget !== saved) {
    reasonsBySeat.set(state.night.wolfAttackTarget, ["WOLF_ATTACK"]);
  }
  if (state.night.witchAction?.kind === "POISON") {
    const poisoned = state.night.witchAction.targetSeatId;
    const reasons = reasonsBySeat.get(poisoned) || [];
    reasons.push("WITCH_POISON");
    reasonsBySeat.set(poisoned, reasons);
  }
  for (const seatId of sortedSeatIds(state.seats).filter((seatId) => reasonsBySeat.has(seatId))) {
    emit(EVENTS.PLAYER_DIED, { seatId, reasons: reasonsBySeat.get(seatId), round: state.round });
  }

  const hunterSeatId = findShootableHunter(state, reasonsBySeat);
  if (hunterSeatId) {
    changePhase(PHASES.HUNTER_SHOT, { pendingHunter: { seatId: hunterSeatId, resumePhase: PHASES.DAY_SPEECH } });
  } else {
    finishResolution(state, emit, changePhase, PHASES.DAY_SPEECH);
  }
}

function resolveVote(state, emit, changePhase) {
  const result = buildVoteResult(state);
  const { exiledSeatId } = result;
  emit(EVENTS.VOTE_RESULT_REVEALED, result);
  if (exiledSeatId) emit(EVENTS.PLAYER_DIED, { seatId: exiledSeatId, reasons: ["EXILED"], round: state.round });

  if (exiledSeatId) {
    changePhase(PHASES.LAST_WORD, {
      pendingLastWord: { seatId: exiledSeatId, hunterEligible: state.roles[exiledSeatId] === ROLES.HUNTER },
    });
  } else {
    finishResolution(state, emit, changePhase, PHASES.NIGHT_WOLF);
  }
}

function buildVoteResult(state) {
  const counts = new Map();
  for (const targetSeatId of Object.values(state.votes)) {
    if (targetSeatId) counts.set(targetSeatId, (counts.get(targetSeatId) || 0) + 1);
  }
  let exiledSeatId = null;
  let highScore = 0;
  let tied = false;
  for (const [seatId, count] of counts) {
    if (count > highScore) {
      exiledSeatId = seatId;
      highScore = count;
      tied = false;
    } else if (count === highScore) {
      tied = true;
    }
  }
  if (tied) exiledSeatId = null;
  const ballots = sortedSeatIds(state.seats)
    .filter((seatId) => state.seats.find((seat) => seat.seatId === seatId).alive)
    .map((voterSeatId) => ({ voterSeatId, targetSeatId: state.votes[voterSeatId] ?? null }));
  return { round: state.round, ballots, exiledSeatId };
}

function finishLastWord(state, emit, changePhase) {
  if (state.pendingLastWord.hunterEligible) {
    changePhase(PHASES.HUNTER_SHOT, {
      pendingHunter: { seatId: state.pendingLastWord.seatId, resumePhase: PHASES.NIGHT_WOLF },
    });
  } else {
    finishResolution(state, emit, changePhase, PHASES.NIGHT_WOLF);
  }
}

function finishResolution(state, emit, changePhase, explicitResumePhase) {
  const outcome = determineWinner(state);
  if (outcome) {
    emit(EVENTS.GAME_FINISHED, outcome);
    emit(EVENTS.ROLES_REVEALED, { roles: clone(state.roles) });
    return;
  }
  const resumePhase = explicitResumePhase || state.pendingHunter?.resumePhase;
  if (resumePhase === PHASES.DAY_SPEECH) {
    const speechOrder = sortedSeatIds(state.seats).filter((seatId) => state.seats.find((seat) => seat.seatId === seatId).alive);
    changePhase(PHASES.DAY_SPEECH, { speechOrder, speechIndex: 0, currentSpeakerSeatId: speechOrder[0] });
  } else {
    changePhase(PHASES.NIGHT_WOLF, { round: state.round + 1 });
  }
}

function determineWinner(state) {
  let wolves = 0;
  let good = 0;
  for (const seat of state.seats) {
    if (!seat.alive) continue;
    if (state.roles[seat.seatId] === ROLES.WEREWOLF) wolves += 1;
    else good += 1;
  }
  if (wolves === 0) return { winner: TEAMS.GOOD, reason: "ALL_WEREWOLVES_DEAD" };
  if (wolves >= good) return { winner: TEAMS.WEREWOLF, reason: "WEREWOLF_PARITY" };
  return null;
}

function findShootableHunter(state, reasonsBySeat) {
  const hunterSeatId = roleSeatId(state, ROLES.HUNTER);
  const reasons = reasonsBySeat.get(hunterSeatId);
  return reasons && reasons.includes("WOLF_ATTACK") && !reasons.includes("WITCH_POISON") ? hunterSeatId : null;
}

function roleSeatId(state, role) {
  return Object.keys(state.roles).find((seatId) => state.roles[seatId] === role);
}

function resolveWolfTarget(state) {
  const livingWolves = state.seats.filter((seat) => seat.alive && state.roles[seat.seatId] === ROLES.WEREWOLF);
  const counts = new Map();
  for (const wolf of livingWolves) {
    const target = state.night.wolfTargets[wolf.seatId];
    if (target) counts.set(target, (counts.get(target) || 0) + 1);
  }
  for (const [target, count] of counts) {
    if (count > livingWolves.length / 2) return target;
  }
  return null;
}

function evolve(state, event) {
  assertInvariant(state);
  if (!isRecord(event) || event.schemaVersion !== SCHEMA_VERSION || event.gameId !== state.gameId || event.seq !== state.seq + 1 ||
      typeof event.eventId !== "string" || !event.eventId || typeof event.at !== "string" || !event.at ||
      typeof event.causationId !== "string" || !event.causationId || !Object.values(EVENTS).includes(event.type) ||
      !isRecord(event.payload)) {
    fail("INVALID_EVENT", "Event envelope, version, type, or sequence is invalid");
  }

  const next = clone(state);
  next.seq = event.seq;
  const payload = event.payload;
  switch (event.type) {
    case EVENTS.GAME_STARTED:
      if (next.phase !== PHASES.LOBBY || next.started || payload.rulesetId !== RULESET_ID ||
          !isDeepEqual(payload.seatIds, sortedSeatIds(next.seats)) || Object.keys(next.roles).length !== 0) {
        fail("INVALID_EVENT", "GAME_STARTED is invalid here");
      }
      next.started = true;
      break;
    case EVENTS.ROLE_ASSIGNED:
      if (next.phase !== PHASES.LOBBY || !next.started || Object.hasOwn(next.roles, payload.seatId) || !isSafeId(payload.seatId) ||
          !next.seats.some((seat) => seat.seatId === payload.seatId) ||
          !ROLE_DECK.includes(payload.role) || payload.team !== roleTeam(payload.role)) {
        fail("INVALID_EVENT", "ROLE_ASSIGNED payload is invalid");
      }
      const assignedCount = Object.values(next.roles).filter((role) => role === payload.role).length;
      const allowedCount = ROLE_DECK.filter((role) => role === payload.role).length;
      if (assignedCount >= allowedCount) fail("INVALID_EVENT", "ROLE_ASSIGNED exceeds the role deck");
      next.roles[payload.seatId] = payload.role;
      break;
    case EVENTS.PRIVATE_ACTION_RECORDED:
      evolvePrivateAction(next, payload);
      break;
    case EVENTS.SEER_RESULT_RECORDED:
      if (next.phase !== PHASES.NIGHT_SEER || next.roles[payload.seerSeatId] !== ROLES.SEER ||
          !next.seats.some((seat) => seat.seatId === payload.targetSeatId && seat.alive) ||
          payload.team !== roleTeam(next.roles[payload.targetSeatId]) || payload.round !== next.round ||
          next.seerResults.some((result) => result.round === payload.round)) {
        fail("INVALID_EVENT", "SEER_RESULT_RECORDED payload is invalid");
      }
      next.seerResults.push(clone(payload));
      break;
    case EVENTS.PHASE_CHANGED:
      evolvePhaseChanged(next, payload);
      break;
    case EVENTS.PLAYER_DIED: {
      const seat = next.seats.find((candidate) => candidate.seatId === payload.seatId);
      if (!seat || !seat.alive || payload.round !== next.round || !isValidDeath(next, payload)) {
        fail("INVALID_EVENT", "PLAYER_DIED payload is invalid");
      }
      seat.alive = false;
      next.deaths.push(clone(payload));
      break;
    }
    case EVENTS.VOTE_RECORDED:
      if (next.phase !== PHASES.DAY_VOTE || !isLivingSeat(next, payload.voterSeatId) ||
          (payload.targetSeatId !== null && (!isLivingSeat(next, payload.targetSeatId) || payload.targetSeatId === payload.voterSeatId))) {
        fail("INVALID_EVENT", "VOTE_RECORDED payload is invalid");
      }
      next.votes[payload.voterSeatId] = payload.targetSeatId;
      break;
    case EVENTS.VOTE_RESULT_REVEALED:
      if (next.phase !== PHASES.DAY_VOTE || !isDeepEqual(payload, buildVoteResult(next))) {
        fail("INVALID_EVENT", "VOTE_RESULT_REVEALED payload is invalid");
      }
      next.voteHistory.push(clone(payload));
      break;
    case EVENTS.GAME_FINISHED:
      const outcome = determineWinner(next);
      if (!outcome || payload.winner !== outcome.winner || payload.reason !== outcome.reason ||
          ![PHASES.DAWN_RESOLUTION, PHASES.DAY_VOTE, PHASES.LAST_WORD, PHASES.HUNTER_SHOT].includes(next.phase) ||
          (next.phase === PHASES.HUNTER_SHOT && !next.hunterResolved) ||
          (next.phase === PHASES.DAWN_RESOLUTION && hasShootableHunterDeath(next)) ||
          (next.phase === PHASES.DAY_VOTE && Boolean(next.voteHistory.at(-1)?.exiledSeatId)) ||
          (next.phase === PHASES.LAST_WORD && next.pendingLastWord?.hunterEligible)) {
        fail("INVALID_EVENT", "GAME_FINISHED payload is invalid");
      }
      consumeDawnPotion(next);
      next.winner = payload.winner;
      next.finishReason = payload.reason;
      next.phase = PHASES.GAME_OVER;
      next.deadlineAt = null;
      next.pendingLastWord = null;
      next.pendingHunter = null;
      next.hunterShotTarget = null;
      next.hunterResolved = false;
      break;
    case EVENTS.ROLES_REVEALED:
      if (next.phase !== PHASES.GAME_OVER || !sameRoleMap(payload.roles, next.roles)) {
        fail("INVALID_EVENT", "ROLES_REVEALED must match completed game roles");
      }
      break;
  }
  assertInvariant(next);
  return next;
}

function isLivingSeat(state, seatId) {
  return state.seats.some((seat) => seat.seatId === seatId && seat.alive);
}

function sameRoleMap(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  const seatIds = Object.keys(right);
  return Object.keys(left).length === seatIds.length && seatIds.every((seatId) => left[seatId] === right[seatId]);
}

function evolvePrivateAction(state, payload) {
  validatePrivateActionEvent(state, payload);
  switch (payload.actionType) {
    case COMMANDS.ROOM_READY_SET:
      state.seats.find((seat) => seat.seatId === payload.actorSeatId).ready = payload.ready;
      return;
    case COMMANDS.WOLF_TARGET_SET:
      state.night.wolfTargets[payload.actorSeatId] = payload.targetSeatId;
      return;
    case COMMANDS.WITCH_ACTION_SET:
      state.night.witchAction = clone(payload.action);
      return;
    case COMMANDS.SEER_TARGET_SET:
      state.night.seerTarget = payload.targetSeatId;
      return;
    case COMMANDS.HUNTER_SHOT_SET:
      state.hunterShotTarget = payload.targetSeatId;
      state.hunterResolved = true;
      return;
  }
}

function validatePrivateActionEvent(state, payload) {
  const actor = state.seats.find((seat) => seat.seatId === payload.actorSeatId);
  switch (payload.actionType) {
    case COMMANDS.ROOM_READY_SET:
      if (state.phase !== PHASES.LOBBY || state.started || !actor || typeof payload.ready !== "boolean") {
        fail("INVALID_EVENT", "Ready action event is invalid");
      }
      return;
    case COMMANDS.WOLF_TARGET_SET:
      if (state.phase !== PHASES.NIGHT_WOLF || !actor?.alive || state.roles[payload.actorSeatId] !== ROLES.WEREWOLF ||
          !isValidOptionalTarget(state, payload.actorSeatId, payload.targetSeatId)) {
        fail("INVALID_EVENT", "Wolf action event is invalid");
      }
      return;
    case COMMANDS.WITCH_ACTION_SET:
      if (state.phase !== PHASES.NIGHT_WITCH || !actor?.alive || state.roles[payload.actorSeatId] !== ROLES.WITCH ||
          !isValidWitchEventAction(state, payload.actorSeatId, payload.action)) {
        fail("INVALID_EVENT", "Witch action event is invalid");
      }
      return;
    case COMMANDS.SEER_TARGET_SET:
      if (state.phase !== PHASES.NIGHT_SEER || !actor?.alive || state.roles[payload.actorSeatId] !== ROLES.SEER ||
          !isValidRequiredTarget(state, payload.actorSeatId, payload.targetSeatId)) {
        fail("INVALID_EVENT", "Seer action event is invalid");
      }
      return;
    case COMMANDS.HUNTER_SHOT_SET:
      if (state.phase !== PHASES.HUNTER_SHOT || state.pendingHunter?.seatId !== payload.actorSeatId ||
          !isValidOptionalTarget(state, payload.actorSeatId, payload.targetSeatId)) {
        fail("INVALID_EVENT", "Hunter action event is invalid");
      }
      return;
    default:
      fail("INVALID_EVENT", "Unknown private action type");
  }
}

function isValidRequiredTarget(state, actorSeatId, targetSeatId) {
  return isSafeId(targetSeatId) && targetSeatId !== actorSeatId && isLivingSeat(state, targetSeatId);
}

function isValidOptionalTarget(state, actorSeatId, targetSeatId) {
  return targetSeatId === null || isValidRequiredTarget(state, actorSeatId, targetSeatId);
}

function isValidWitchEventAction(state, witchSeatId, action) {
  if (!isRecord(action) || !["SAVE", "POISON", "SKIP"].includes(action.kind)) return false;
  if (action.kind === "SKIP") return Object.keys(action).length === 1;
  if (action.kind === "SAVE") {
    return state.witchInventory.antidote === 1 && Boolean(state.night.wolfAttackTarget) &&
      action.targetSeatId === state.night.wolfAttackTarget &&
      (action.targetSeatId !== witchSeatId || state.round === 1);
  }
  return state.witchInventory.poison === 1 && isValidRequiredTarget(state, witchSeatId, action.targetSeatId);
}

function isValidDeath(state, payload) {
  if (!Array.isArray(payload.reasons) || payload.reasons.length === 0 ||
      new Set(payload.reasons).size !== payload.reasons.length) return false;
  if (state.phase === PHASES.DAWN_RESOLUTION) {
    return isDeepEqual(payload.reasons, expectedNightDeathReasons(state, payload.seatId));
  }
  if (state.phase === PHASES.DAY_VOTE) {
    return isDeepEqual(payload.reasons, ["EXILED"]) && state.voteHistory.at(-1)?.exiledSeatId === payload.seatId;
  }
  if (state.phase === PHASES.HUNTER_SHOT) {
    return isDeepEqual(payload.reasons, ["HUNTER_SHOT"]) && state.hunterShotTarget === payload.seatId;
  }
  return false;
}

function expectedNightDeathReasons(state, seatId) {
  const reasons = [];
  const savedSeatId = state.night.witchAction?.kind === "SAVE" ? state.night.witchAction.targetSeatId : null;
  if (state.night.wolfAttackTarget === seatId && savedSeatId !== seatId) reasons.push("WOLF_ATTACK");
  if (state.night.witchAction?.kind === "POISON" && state.night.witchAction.targetSeatId === seatId) reasons.push("WITCH_POISON");
  return reasons;
}

function hasShootableHunterDeath(state) {
  const hunterSeatId = roleSeatId(state, ROLES.HUNTER);
  const death = state.deaths.find((candidate) => candidate.seatId === hunterSeatId && candidate.round === state.round);
  return Boolean(death?.reasons.includes("WOLF_ATTACK") && !death.reasons.includes("WITCH_POISON"));
}

function evolvePhaseChanged(state, payload) {
  if (!Object.values(PHASES).includes(payload.phase) || !Number.isInteger(payload.round) || payload.round < 0) {
    fail("INVALID_EVENT", "PHASE_CHANGED payload is invalid");
  }
  const previousPhase = state.phase;
  if (!PHASE_TRANSITIONS[previousPhase].has(payload.phase)) fail("INVALID_EVENT", "Phase transition is not allowed");
  validatePhasePayload(state, payload);
  if (payload.phase === PHASES.ROLE_REVEAL) {
    const roles = Object.values(state.roles).sort();
    const expected = [...ROLE_DECK].sort();
    if (roles.length !== 9 || roles.some((role, index) => role !== expected[index])) fail("INVALID_EVENT", "Role reveal requires a complete deck");
  }
  if (previousPhase === PHASES.NIGHT_WOLF && payload.phase === PHASES.NIGHT_WITCH) {
    state.night.wolfAttackTarget = resolveWolfTarget(state);
  }
  if (payload.phase === PHASES.NIGHT_WOLF) {
    state.night = { wolfTargets: {}, wolfAttackTarget: null, witchAction: null, seerTarget: null };
    state.votes = {};
    state.speechOrder = [];
    state.speechIndex = null;
  }
  if (previousPhase === PHASES.DAWN_RESOLUTION) consumeDawnPotion(state);
  if (payload.phase === PHASES.DAY_SPEECH) {
    state.speechOrder = clone(payload.speechOrder || state.speechOrder);
    state.speechIndex = payload.speechIndex ?? 0;
  }
  if (payload.phase === PHASES.DAY_VOTE) state.votes = {};
  if (payload.phase === PHASES.LAST_WORD) state.pendingLastWord = clone(payload.pendingLastWord);
  if (payload.phase === PHASES.HUNTER_SHOT) state.pendingHunter = clone(payload.pendingHunter);
  if (previousPhase === PHASES.LAST_WORD && payload.phase !== PHASES.LAST_WORD) state.pendingLastWord = null;
  if (previousPhase === PHASES.HUNTER_SHOT && payload.phase !== PHASES.HUNTER_SHOT) state.pendingHunter = null;
  if (previousPhase === PHASES.HUNTER_SHOT && payload.phase !== PHASES.HUNTER_SHOT) state.hunterShotTarget = null;
  if (previousPhase === PHASES.HUNTER_SHOT && payload.phase !== PHASES.HUNTER_SHOT) state.hunterResolved = false;
  state.phase = payload.phase;
  state.round = payload.round;
  state.deadlineAt = payload.deadlineAt ?? null;
}

function validatePhasePayload(state, payload) {
  if (payload.deadlineAt !== null && (typeof payload.deadlineAt !== "string" || !payload.deadlineAt)) {
    fail("INVALID_EVENT", "Phase deadline must be a non-empty string or null");
  }
  const previousPhase = state.phase;
  let expectedRound = state.round;
  if (previousPhase === PHASES.ROLE_REVEAL && payload.phase === PHASES.NIGHT_WOLF) expectedRound = 1;
  if (payload.phase === PHASES.NIGHT_WOLF && previousPhase !== PHASES.ROLE_REVEAL) expectedRound = state.round + 1;
  if (payload.round !== expectedRound) fail("INVALID_EVENT", "Phase round is inconsistent");
  if (payload.phase === PHASES.DAY_SPEECH) {
    const expectedOrder = sortedSeatIds(state.seats).filter((seatId) => isLivingSeat(state, seatId));
    const expectedIndex = previousPhase === PHASES.DAY_SPEECH ? state.speechIndex + 1 : 0;
    if (expectedIndex >= expectedOrder.length || !Array.isArray(payload.speechOrder) || !isDeepEqual(payload.speechOrder, expectedOrder) ||
        payload.speechIndex !== expectedIndex || payload.currentSpeakerSeatId !== expectedOrder[expectedIndex]) {
      fail("INVALID_EVENT", "Speech phase payload is inconsistent");
    }
    if (previousPhase === PHASES.HUNTER_SHOT && state.pendingHunter?.resumePhase !== PHASES.DAY_SPEECH) {
      fail("INVALID_EVENT", "Hunter resolution cannot resume at daytime speech");
    }
    if (previousPhase === PHASES.HUNTER_SHOT && !state.hunterResolved) {
      fail("INVALID_EVENT", "Hunter must resolve before daytime resumes");
    }
    if (previousPhase === PHASES.DAWN_RESOLUTION && hasShootableHunterDeath(state)) {
      fail("INVALID_EVENT", "A shootable hunter must act before daytime speech");
    }
  }
  if (payload.phase === PHASES.DAY_VOTE && state.speechIndex !== state.speechOrder.length - 1) {
    fail("INVALID_EVENT", "Voting can start only after the final speech");
  }
  if (payload.phase === PHASES.LAST_WORD) {
    const exiledSeatId = state.voteHistory.at(-1)?.exiledSeatId;
    const expected = { seatId: exiledSeatId, hunterEligible: state.roles[exiledSeatId] === ROLES.HUNTER };
    if (!exiledSeatId || !isDeepEqual(payload.pendingLastWord, expected)) fail("INVALID_EVENT", "Last-word payload is inconsistent");
  }
  if (payload.phase === PHASES.HUNTER_SHOT) {
    const expectedSeatId = previousPhase === PHASES.DAWN_RESOLUTION
      ? roleSeatId(state, ROLES.HUNTER)
      : state.pendingLastWord?.seatId;
    const expectedResume = previousPhase === PHASES.DAWN_RESOLUTION ? PHASES.DAY_SPEECH : PHASES.NIGHT_WOLF;
    if (!isDeepEqual(payload.pendingHunter, { seatId: expectedSeatId, resumePhase: expectedResume })) {
      fail("INVALID_EVENT", "Hunter phase payload is inconsistent");
    }
    if (previousPhase === PHASES.DAWN_RESOLUTION) {
      const death = state.deaths.find((candidate) => candidate.seatId === expectedSeatId);
      if (!death?.reasons.includes("WOLF_ATTACK") || death.reasons.includes("WITCH_POISON")) {
        fail("INVALID_EVENT", "Hunter was not killed by a shootable cause");
      }
    } else if (!state.pendingLastWord?.hunterEligible) {
      fail("INVALID_EVENT", "The exiled player is not an eligible hunter");
    }
  }
  if (payload.phase === PHASES.NIGHT_WOLF) {
    if (previousPhase === PHASES.DAY_VOTE && state.voteHistory.at(-1)?.exiledSeatId) {
      fail("INVALID_EVENT", "An exiled player must receive a last word");
    }
    if (previousPhase === PHASES.LAST_WORD && state.pendingLastWord?.hunterEligible) {
      fail("INVALID_EVENT", "An eligible hunter must act after the last word");
    }
    if (previousPhase === PHASES.HUNTER_SHOT && state.pendingHunter?.resumePhase !== PHASES.NIGHT_WOLF) {
      fail("INVALID_EVENT", "Hunter resolution cannot resume at night");
    }
    if (previousPhase === PHASES.HUNTER_SHOT && !state.hunterResolved) {
      fail("INVALID_EVENT", "Hunter must resolve before night resumes");
    }
  }
}

function isDeepEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function consumeDawnPotion(state) {
  if (state.phase !== PHASES.DAWN_RESOLUTION) return;
  if (state.night.witchAction?.kind === "SAVE") state.witchInventory.antidote = 0;
  if (state.night.witchAction?.kind === "POISON") state.witchInventory.poison = 0;
}

function replay(initialState, events) {
  if (!Array.isArray(events)) fail("INVALID_REQUEST", "events must be an array");
  return events.reduce((state, event) => evolve(state, event), clone(initialState));
}

module.exports = {
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
};

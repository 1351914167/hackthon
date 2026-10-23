"use strict";

const { createHash, randomBytes, randomInt, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  COMMANDS,
  PHASES,
  ROLE_DECK,
  SCHEMA_VERSION,
  createInitialState,
  decide,
  replay,
} = require("../game");
const { VIEWER_TYPES, projectForViewer } = require("../projection");
const { createMemoryEventStore } = require("../store");

const DEFAULT_DURATIONS = Object.freeze({
  [PHASES.ROLE_REVEAL]: 8_000,
  [PHASES.NIGHT_WOLF]: 30_000,
  [PHASES.NIGHT_WITCH]: 20_000,
  [PHASES.NIGHT_SEER]: 20_000,
  [PHASES.DAWN_RESOLUTION]: 0,
  [PHASES.DAY_SPEECH]: 60_000,
  [PHASES.DAY_VOTE]: 30_000,
  [PHASES.LAST_WORD]: 30_000,
  [PHASES.HUNTER_SHOT]: 20_000,
});

class RoomServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoomServiceError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new RoomServiceError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function createRoomService(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("INVALID_REQUEST", "Service options must be an object");
  const clock = options.clock || (() => Date.now());
  const chooseInt = options.randomInt || ((maximum) => randomInt(maximum));
  const createId = options.createId || ((kind) => `${kind}-${randomUUID()}`);
  const createToken = options.createToken || (() => randomBytes(32).toString("base64url"));
  const durations = validateDurations({ ...DEFAULT_DURATIONS, ...(options.durations || {}) });
  const hostDisconnectGraceMs = options.hostDisconnectGraceMs ?? 30_000;
  if (!Number.isSafeInteger(hostDisconnectGraceMs) || hostDisconnectGraceMs < 0) {
    fail("INVALID_REQUEST", "hostDisconnectGraceMs must be a non-negative safe integer");
  }
  const store = options.store || createMemoryEventStore();
  validateDependencies({ clock, chooseInt, createId, createToken, store });

  const rooms = new Map();
  const tokens = new Map();
  const idempotency = new Map();

  function createRoom(input) {
    const command = validateRoomCommand(input, true);
    return runIdempotent(`create:${command.sessionId}:${command.idempotencyKey}`, command, () => {
      const roomId = safeGeneratedId(createId("room"), "room ID");
      if (rooms.has(roomId)) fail("ID_COLLISION", "Generated room ID already exists");
      const seatToken = uniqueToken(createToken, tokens);
      const seat = createSeat("seat-1", command.nickname, command.sessionId, seatToken);
      const room = {
        roomId,
        code: roomId,
        status: "LOBBY",
        hostSeatId: seat.seatId,
        seats: [seat],
        game: null,
      };
      rooms.set(roomId, room);
      tokens.set(seatToken, { roomId, seatId: seat.seatId });
      return { roomId, seatToken, snapshot: snapshotFor(room, seat) };
    });
  }

  function joinRoom(input) {
    const command = validateRoomCommand(input, false);
    return runIdempotent(`join:${command.roomId}:${command.sessionId}:${command.idempotencyKey}`, command, () => {
      const room = requireRoom(command.roomId);
      if (room.status !== "LOBBY") fail("ACTION_NOT_ALLOWED", "Cannot join a room after the game starts");
      if (room.seats.some((seat) => seat.sessionId === command.sessionId && !seat.exited)) {
        fail("ACTION_NOT_ALLOWED", "This session already occupies a seat");
      }
      if (room.seats.filter((seat) => !seat.exited).length >= 9) fail("ROOM_FULL", "The room already has nine seats");
      const seatId = firstAvailableSeatId(room.seats);
      const seatToken = uniqueToken(createToken, tokens);
      const seat = createSeat(seatId, command.nickname, command.sessionId, seatToken);
      const reusableIndex = room.seats.findIndex((candidate) => candidate.exited && candidate.seatId === seatId);
      if (reusableIndex === -1) room.seats.push(seat);
      else room.seats[reusableIndex] = seat;
      sortSeats(room.seats);
      tokens.set(seatToken, { roomId: room.roomId, seatId });
      return { roomId: room.roomId, seatToken, snapshot: snapshotFor(room, seat) };
    });
  }

  function setReady(input) {
    const command = validateSeatWrite(input);
    return runIdempotent(`ready:${command.roomId}:${command.seatToken}:${command.idempotencyKey}`, command, () => {
      const { room, seat } = authenticate(command.roomId, command.seatToken);
      if (room.status !== "LOBBY") fail("ACTION_NOT_ALLOWED", "Ready state is locked after game start");
      if (typeof command.ready !== "boolean") fail("INVALID_REQUEST", "ready must be boolean");
      seat.ready = command.ready;
      return { snapshot: snapshotFor(room, seat) };
    });
  }

  function startGame(input) {
    const command = validateSeatWrite(input);
    return runIdempotent(`start:${command.roomId}:${command.seatToken}:${command.idempotencyKey}`, command, () => {
      const { room, seat } = authenticate(command.roomId, command.seatToken);
      if (room.status !== "LOBBY" || room.game) fail("ACTION_NOT_ALLOWED", "The game has already started");
      if (room.hostSeatId !== seat.seatId) fail("ACTION_NOT_ALLOWED", "Only the current host can start the game");
      const activeSeats = room.seats.filter((candidate) => !candidate.exited);
      if (activeSeats.length !== 9 || activeSeats.some((candidate) => !candidate.ready || !candidate.connected)) {
        fail("ACTION_NOT_ALLOWED", "Nine connected and ready players are required");
      }

      const gameId = safeGeneratedId(createId("game"), "game ID");
      if ([...rooms.values()].some((candidate) => candidate.game?.state.gameId === gameId) || store.load(gameId).latestSeq !== 0) {
        fail("ID_COLLISION", "Generated game ID already exists");
      }
      const initialState = createInitialState({
        roomId: room.roomId,
        gameId,
        hostSeatId: seat.seatId,
        seats: activeSeats.map((candidate) => ({ seatId: candidate.seatId, ready: true })),
      });
      const now = readNow(clock);
      const expectedVersion = snapshotFor(room, seat).version;
      const clientAction = {
        schemaVersion: SCHEMA_VERSION,
        actionId: `start-${command.idempotencyKey}`,
        gameId,
        expectedVersion,
        type: COMMANDS.GAME_START,
        payload: {},
        actorSeatId: seat.seatId,
      };
      const engineCommand = { ...clientAction, expectedSeq: 0 };
      delete engineCommand.expectedVersion;
      const events = decideWithDeadline(initialState, engineCommand, {
        now,
        durations,
        roleAssignments: shuffledAssignments(activeSeats, chooseInt),
      });
      const nextState = replay(initialState, events);
      store.append(gameId, 0, events, clientAction);
      room.status = "ACTIVE";
      room.game = createGameAggregate(initialState, nextState, events, clientAction);
      refreshDeadline(room.game, events);
      return { gameId, snapshot: snapshotFor(room, seat) };
    });
  }

  function dispatchAction(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REQUEST", "Action request must be an object");
    const { room, seat } = authenticate(input.roomId, input.seatToken);
    if (!room.game) fail("ACTION_NOT_ALLOWED", "No game exists");
    const action = validateClientAction(input.action, room.game.state.gameId, seat.seatId);
    if ([COMMANDS.PHASE_TIMEOUT, COMMANDS.GAME_START, COMMANDS.ROOM_READY_SET].includes(action.type)) {
      fail("ACTION_NOT_ALLOWED", "This command is not accepted from a game client");
    }

    const previous = store.findAction(room.game.state.gameId, action);
    if (previous) return { acknowledged: true, idempotent: true, snapshot: snapshotFor(room, seat) };

    if (room.status !== "ACTIVE") fail("ACTION_NOT_ALLOWED", "No active game exists");
    if (!seat.connected) fail("ACTION_NOT_ALLOWED", "Disconnected seats cannot act");
    const visible = snapshotFor(room, seat);
    if (action.expectedVersion !== visible.version) {
      fail("VIEW_CONFLICT", "The visible room state changed before this action was applied", { latestVersion: visible.version });
    }
    const now = readNow(clock);
    const engineCommand = { ...action, expectedSeq: room.game.state.seq };
    delete engineCommand.expectedVersion;
    const events = decideWithDeadline(room.game.state, engineCommand, { now, durations });
    const nextState = replay(room.game.state, events);
    const expectedSeq = room.game.state.seq;
    store.append(room.game.state.gameId, expectedSeq, events, action);
    room.game.state = nextState;
    room.game.history.push({ expectedSeq, events: clone(events), action: clone(action) });
    refreshDeadline(room.game, events);
    if (nextState.phase === PHASES.GAME_OVER) room.status = "FINISHED";
    return { acknowledged: true, idempotent: false, snapshot: snapshotFor(room, seat) };
  }

  function getSnapshot(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REQUEST", "Snapshot request must be an object");
    const room = requireRoom(input.roomId);
    if (input.seatToken === undefined || input.seatToken === null) return snapshotFor(room, null);
    return snapshotFor(room, authenticate(input.roomId, input.seatToken).seat);
  }

  function disconnect(input) {
    const { room, seat } = authenticateInput(input);
    seat.connected = false;
    seat.disconnectedAt = readNow(clock);
    return { snapshot: snapshotFor(room, seat) };
  }

  function reconnect(input) {
    const { room, seat } = authenticateInput(input);
    seat.connected = true;
    seat.disconnectedAt = null;
    if (!room.hostSeatId) room.hostSeatId = seat.seatId;
    return { roomId: room.roomId, seatToken: input.seatToken, snapshot: snapshotFor(room, seat) };
  }

  function leaveRoom(input) {
    const command = validateSeatWrite(input);
    return runIdempotent(`leave:${command.roomId}:${command.seatToken}:${command.idempotencyKey}`, command, () => {
      const { room, seat } = authenticate(command.roomId, command.seatToken);
      seat.connected = false;
      seat.disconnectedAt = readNow(clock);
      seat.exited = true;
      tokens.delete(command.seatToken);
      migrateHost(room);
      if (room.seats.every((candidate) => candidate.exited)) {
        rooms.delete(room.roomId);
        return { roomId: room.roomId, destroyed: true };
      }
      return { roomId: room.roomId, destroyed: false, snapshot: snapshotFor(room, null) };
    });
  }

  function restartGame(input) {
    const command = validateSeatWrite(input);
    return runIdempotent(`restart:${command.roomId}:${command.seatToken}:${command.idempotencyKey}`, command, () => {
      const { room, seat } = authenticate(command.roomId, command.seatToken);
      if (room.status !== "FINISHED" || !room.game) fail("ACTION_NOT_ALLOWED", "Only a finished game can restart");
      if (room.hostSeatId !== seat.seatId) fail("ACTION_NOT_ALLOWED", "Only the current host can restart the room");
      room.status = "LOBBY";
      room.game = null;
      for (const candidate of room.seats) {
        if (!candidate.exited) candidate.ready = false;
      }
      return { snapshot: snapshotFor(room, seat) };
    });
  }

  function tick(nowInput) {
    const now = nowInput === undefined ? readNow(clock) : normalizeTime(nowInput);
    const results = [];
    for (const room of rooms.values()) {
      migrateExpiredHost(room, now, hostDisconnectGraceMs);
      const game = room.game;
      if (!game || room.status !== "ACTIVE" || !game.deadline || now < game.deadline.at) continue;
      const deadline = clone(game.deadline);
      if (deadline.gameId !== game.state.gameId || deadline.phase !== game.state.phase ||
          deadline.round !== game.state.round || deadline.phaseSeq !== latestPhaseSeq(game)) continue;

      const action = {
        schemaVersion: SCHEMA_VERSION,
        actionId: `timeout-${game.state.gameId}-${deadline.phaseSeq}`,
        gameId: game.state.gameId,
        expectedVersion: "trusted-scheduler",
        type: COMMANDS.PHASE_TIMEOUT,
        payload: {},
        actorSeatId: "scheduler",
      };
      const previous = store.findAction(game.state.gameId, action);
      if (previous) {
        game.deadline = null;
        continue;
      }
      const engineCommand = { ...action, expectedSeq: game.state.seq };
      delete engineCommand.expectedVersion;
      const events = decideWithDeadline(game.state, engineCommand, {
        now,
        durations,
        trusted: true,
      });
      const nextState = replay(game.state, events);
      const expectedSeq = game.state.seq;
      store.append(game.state.gameId, expectedSeq, events, action);
      game.state = nextState;
      game.history.push({ expectedSeq, events: clone(events), action: clone(action) });
      refreshDeadline(game, events);
      if (nextState.phase === PHASES.GAME_OVER) room.status = "FINISHED";
      results.push({ roomId: room.roomId, gameId: nextState.gameId, phase: nextState.phase });
    }
    return results;
  }

  function serialize() {
    return clone({
      schemaVersion: 1,
      rooms: [...rooms.values()],
      idempotency: [...idempotency.entries()],
    });
  }

  if (options.restoredState !== undefined) restore(options.restoredState);

  function restore(serialized) {
    if (!serialized || serialized.schemaVersion !== 1 || !Array.isArray(serialized.rooms) || !Array.isArray(serialized.idempotency)) {
      fail("INVALID_REQUEST", "Restored room state is invalid");
    }
    for (const rawRoom of serialized.rooms) {
      const room = clone(rawRoom);
      validateRestoredRoom(room);
      rooms.set(room.roomId, room);
      for (const seat of room.seats) {
        if (!seat.exited) {
          if (tokens.has(seat.seatToken)) fail("INVALID_REQUEST", "Restored seat tokens must be unique");
          tokens.set(seat.seatToken, { roomId: room.roomId, seatId: seat.seatId });
        }
      }
      if (room.game) {
        for (const batch of room.game.history) store.append(room.game.state.gameId, batch.expectedSeq, batch.events, batch.action);
      }
    }
    for (const [key, value] of serialized.idempotency) idempotency.set(key, clone(value));
  }

  return Object.freeze({
    createRoom,
    disconnect,
    dispatchAction,
    getSnapshot,
    joinRoom,
    leaveRoom,
    reconnect,
    restartGame,
    serialize,
    setReady,
    startGame,
    tick,
  });

  function requireRoom(roomId) {
    if (typeof roomId !== "string" || !roomId) fail("INVALID_REQUEST", "roomId is required");
    const room = rooms.get(roomId);
    if (!room) fail("ROOM_NOT_FOUND", "Room does not exist");
    return room;
  }

  function authenticate(roomId, seatToken) {
    const room = requireRoom(roomId);
    if (typeof seatToken !== "string" || !seatToken) fail("INVALID_SEAT_TOKEN", "A seat token is required");
    const binding = tokens.get(seatToken);
    if (!binding || binding.roomId !== roomId) fail("INVALID_SEAT_TOKEN", "Seat token is invalid for this room");
    const seat = room.seats.find((candidate) => candidate.seatId === binding.seatId);
    if (!seat || seat.exited || seat.seatToken !== seatToken) fail("INVALID_SEAT_TOKEN", "Seat token is no longer active");
    return { room, seat };
  }

  function authenticateInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REQUEST", "Seat request must be an object");
    return authenticate(input.roomId, input.seatToken);
  }

  function snapshotFor(room, seat) {
    const gameProjection = room.game
      ? projectForViewer(room.game.state, seat
        ? { type: VIEWER_TYPES.PLAYER, seatId: seat.seatId }
        : { type: VIEWER_TYPES.SPECTATOR })
      : null;
    if (gameProjection) delete gameProjection.version;
    const snapshot = {
      roomId: room.roomId,
      code: room.code,
      status: room.status,
      hostSeatId: room.hostSeatId,
      seats: room.seats.filter((candidate) => !candidate.exited).map((candidate) => ({
        seatId: candidate.seatId,
        nickname: candidate.nickname,
        ready: candidate.ready,
        connected: candidate.connected,
      })),
      selfSeatId: seat?.seatId || null,
      game: gameProjection,
    };
    snapshot.version = visibleVersion(snapshot);
    return snapshot;
  }

  function runIdempotent(key, input, operation) {
    const previous = idempotency.get(key);
    if (previous) {
      if (!isDeepStrictEqual(previous.input, input)) fail("ACTION_ID_CONFLICT", "Idempotency key was reused with different content");
      return clone(previous.result);
    }
    const result = operation();
    idempotency.set(key, { input: clone(input), result: clone(result) });
    return clone(result);
  }
}

function validateDependencies({ clock, chooseInt, createId, createToken, store }) {
  if (![clock, chooseInt, createId, createToken].every((value) => typeof value === "function") ||
      !store || !["append", "findAction", "load"].every((name) => typeof store[name] === "function")) {
    fail("INVALID_REQUEST", "Room service dependencies are invalid");
  }
}

function validateDurations(durations) {
  for (const phase of Object.keys(DEFAULT_DURATIONS)) {
    if (!Number.isSafeInteger(durations[phase]) || durations[phase] < 0) fail("INVALID_REQUEST", `Invalid duration for ${phase}`);
  }
  return Object.freeze(durations);
}

function validateRoomCommand(input, creating) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REQUEST", "Room command must be an object");
  const command = clone(input);
  if (!creating && (typeof command.roomId !== "string" || !command.roomId)) fail("INVALID_REQUEST", "roomId is required");
  if (typeof command.sessionId !== "string" || !command.sessionId || typeof command.idempotencyKey !== "string" || !command.idempotencyKey) {
    fail("INVALID_REQUEST", "sessionId and idempotencyKey are required");
  }
  if (typeof command.nickname !== "string" || !command.nickname.trim() || command.nickname.trim().length > 24) {
    fail("INVALID_REQUEST", "nickname must contain 1 to 24 characters");
  }
  command.nickname = command.nickname.trim();
  return command;
}

function validateSeatWrite(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.roomId !== "string" || !input.roomId ||
      typeof input.seatToken !== "string" || !input.seatToken || typeof input.idempotencyKey !== "string" || !input.idempotencyKey) {
    fail("INVALID_REQUEST", "Authenticated room write fields are required");
  }
  return clone(input);
}

function validateClientAction(input, gameId, actorSeatId) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== SCHEMA_VERSION ||
      input.gameId !== gameId || typeof input.actionId !== "string" || !input.actionId ||
      typeof input.expectedVersion !== "string" || !input.expectedVersion || typeof input.type !== "string" ||
      !input.type || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload) ||
      Object.hasOwn(input, "actorSeatId") || Object.hasOwn(input, "expectedSeq")) {
    fail("INVALID_REQUEST", "Client action envelope is invalid");
  }
  return { ...clone(input), actorSeatId };
}

function createSeat(seatId, nickname, sessionId, seatToken) {
  return { seatId, nickname, sessionId, seatToken, ready: false, connected: true, disconnectedAt: null, exited: false };
}

function firstAvailableSeatId(seats) {
  const occupied = new Set(seats.filter((seat) => !seat.exited).map((seat) => seat.seatId));
  for (let number = 1; number <= 9; number += 1) {
    if (!occupied.has(`seat-${number}`)) return `seat-${number}`;
  }
  fail("ROOM_FULL", "The room already has nine seats");
}

function sortSeats(seats) {
  seats.sort((left, right) => Number(left.seatId.slice(5)) - Number(right.seatId.slice(5)));
}

function migrateHost(room) {
  const candidates = room.seats.filter((seat) => !seat.exited && seat.connected);
  sortSeats(candidates);
  room.hostSeatId = candidates[0]?.seatId || null;
}

function migrateExpiredHost(room, now, graceMs) {
  const host = room.seats.find((seat) => seat.seatId === room.hostSeatId && !seat.exited);
  if (!host || host.connected || host.disconnectedAt === null || now < host.disconnectedAt + graceMs) return false;
  migrateHost(room);
  return true;
}

function uniqueToken(factory, tokens) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = factory();
    if (typeof token === "string" && token.length >= 16 && !tokens.has(token)) return token;
  }
  fail("TOKEN_GENERATION_FAILED", "Could not generate a unique seat token");
}

function safeGeneratedId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value)) {
    fail("INVALID_REQUEST", `Generated ${label} is unsafe`);
  }
  return value;
}

function shuffledAssignments(seats, chooseInt) {
  const deck = [...ROLE_DECK];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const selected = chooseInt(index + 1);
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > index) fail("INVALID_REQUEST", "randomInt returned an invalid value");
    [deck[index], deck[selected]] = [deck[selected], deck[index]];
  }
  return Object.fromEntries(seats.map((seat, index) => [seat.seatId, deck[index]]));
}

function readNow(clock) {
  return normalizeTime(clock());
}

function normalizeTime(value) {
  const milliseconds = value instanceof Date ? value.getTime() : (typeof value === "string" ? Date.parse(value) : value);
  if (!Number.isFinite(milliseconds)) fail("INVALID_REQUEST", "Clock returned an invalid time");
  return milliseconds;
}

function decideWithDeadline(state, command, { now, durations, ...context }) {
  const baseContext = { ...context, at: new Date(now).toISOString(), deadlineAt: null };
  const previewEvents = decide(state, command, baseContext);
  const finalPhase = replay(state, previewEvents).phase;
  const deadline = finalPhase === PHASES.GAME_OVER ? null : new Date(now + durations[finalPhase]).toISOString();
  return decide(state, command, { ...baseContext, deadlineAt: deadline });
}

function createGameAggregate(initialState, state, events, action) {
  return {
    initialState: clone(initialState),
    state,
    history: [{ expectedSeq: 0, events: clone(events), action: clone(action) }],
    deadline: null,
  };
}

function latestPhaseSeq(game) {
  for (let batchIndex = game.history.length - 1; batchIndex >= 0; batchIndex -= 1) {
    const events = game.history[batchIndex].events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === "PHASE_CHANGED") return events[index].seq;
    }
  }
  return null;
}

function refreshDeadline(game, events) {
  const phaseEvent = [...events].reverse().find((event) => event.type === "PHASE_CHANGED");
  if (!phaseEvent || game.state.phase === PHASES.GAME_OVER || !game.state.deadlineAt) {
    if (game.state.phase === PHASES.GAME_OVER) game.deadline = null;
    return;
  }
  game.deadline = {
    gameId: game.state.gameId,
    phase: game.state.phase,
    round: game.state.round,
    phaseSeq: phaseEvent.seq,
    at: Date.parse(game.state.deadlineAt),
  };
}

function visibleVersion(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function validateRestoredRoom(room) {
  if (!room || typeof room.roomId !== "string" || !Array.isArray(room.seats) ||
      !["LOBBY", "ACTIVE", "FINISHED"].includes(room.status) ||
      room.seats.some((seat) => !seat || typeof seat.seatToken !== "string")) {
    fail("INVALID_REQUEST", "Restored room entry is invalid");
  }
  if (room.game) {
    const restored = replay(room.game.initialState, room.game.history.flatMap((batch) => batch.events));
    if (!isDeepStrictEqual(restored, room.game.state)) fail("INVALID_REQUEST", "Restored game state does not match its event history");
  }
}

module.exports = { DEFAULT_DURATIONS, RoomServiceError, createRoomService };

"use strict";

const { randomUUID } = require("node:crypto");

class MediaBrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MediaBrokerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MediaBrokerError(code, message);
}

function createMediaBroker(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("INVALID_REQUEST", "Media broker options must be an object");
  const clock = options.clock || (() => Date.now());
  const getSnapshot = options.getSnapshot;
  const createOpaqueId = options.createOpaqueId || (() => `media-${randomUUID()}`);
  const ttlMs = options.ttlMs ?? 45_000;
  const signalTtlMs = options.signalTtlMs ?? 30_000;
  const maxInbox = options.maxInbox ?? 64;
  const maxSignalBytes = options.maxSignalBytes ?? 65_536;
  const iceServers = normalizeIceServers(options.iceServers || []);
  if (typeof clock !== "function" || typeof getSnapshot !== "function" || typeof createOpaqueId !== "function") {
    fail("INVALID_REQUEST", "clock, getSnapshot, and createOpaqueId dependencies are required");
  }
  for (const [name, value] of Object.entries({ ttlMs, signalTtlMs, maxInbox, maxSignalBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_REQUEST", `${name} must be a positive safe integer`);
  }

  const participants = new Map();
  const inboxes = new Map();

  function join(input) {
    const context = authenticate(input);
    const now = readNow(clock);
    prune(now);
    removeOtherGames(context.roomId, context.selfSeatId, context.gameId);
    participants.set(participantKey(context), { ...identity(context), lastSeenAt: now });
    if (!inboxes.has(participantKey(context))) inboxes.set(participantKey(context), []);
    return topology(context, now, true);
  }

  function leave(input) {
    const context = authenticate(input);
    const key = participantKey(context);
    participants.delete(key);
    inboxes.delete(key);
    return { left: true, roomId: context.roomId, gameId: context.gameId, selfSeatId: context.selfSeatId };
  }

  function peers(input) {
    const context = authenticate(input);
    const now = readNow(clock);
    prune(now);
    touch(context, now);
    return topology(context, now, false);
  }

  function publishSignal(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_REQUEST", "Signal request must be an object");
    const context = authenticate(input);
    const now = readNow(clock);
    prune(now);
    touch(context, now);
    const recipientSeatId = input.recipientSeatId;
    if (!isSeatId(recipientSeatId) || recipientSeatId === context.selfSeatId || !isCurrentSeat(context.snapshot, recipientSeatId)) {
      fail("INVALID_RECIPIENT", "Signal recipient must be another current room seat");
    }
    const recipientKey = participantKey({ ...context, selfSeatId: recipientSeatId });
    if (!participants.has(recipientKey)) fail("PEER_NOT_JOINED", "Signal recipient has not joined media");
    const signal = normalizeSignal(input.signal, maxSignalBytes);
    enforceSpeakerEdge(context, recipientSeatId, signal.type);

    const id = createOpaqueId();
    if (typeof id !== "string" || !id || id.length > 128) fail("INVALID_REQUEST", "Opaque signal ID generator returned an invalid value");
    const message = {
      id,
      fromSeatId: context.selfSeatId,
      type: signal.type,
      payload: signal.payload,
      createdAt: new Date(now).toISOString(),
    };
    const inbox = inboxes.get(recipientKey) || [];
    inbox.push(message);
    while (inbox.length > maxInbox) inbox.shift();
    inboxes.set(recipientKey, inbox);
    return { accepted: true, signalId: id };
  }

  function drain(input) {
    const context = authenticate(input);
    const now = readNow(clock);
    prune(now);
    touch(context, now);
    const key = participantKey(context);
    const inbox = inboxes.get(key) || [];
    inboxes.set(key, []);
    return {
      signals: inbox.map((signal) => structuredClone(signal)),
      currentSpeakerSeatId: context.currentSpeakerSeatId,
    };
  }

  function authenticate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.roomId !== "string" || !input.roomId ||
        typeof input.seatToken !== "string" || !input.seatToken) {
      fail("INVALID_REQUEST", "roomId and seatToken are required");
    }
    const snapshot = getSnapshot({ roomId: input.roomId, seatToken: input.seatToken });
    if (!snapshot || snapshot.roomId !== input.roomId || snapshot.status !== "ACTIVE" || !snapshot.game ||
        !isSeatId(snapshot.selfSeatId) ||
        !snapshot.seats?.some((seat) => seat.seatId === snapshot.selfSeatId && seat.connected === true) ||
        !snapshot.game.seats?.some((seat) => seat.seatId === snapshot.selfSeatId)) {
      fail("MEDIA_NOT_AVAILABLE", "An authenticated active game seat is required");
    }
    return {
      roomId: snapshot.roomId,
      gameId: snapshot.game.gameId,
      selfSeatId: snapshot.selfSeatId,
      currentSpeakerSeatId: snapshot.game.currentSpeakerSeatId,
      snapshot,
    };
  }

  function touch(context, now) {
    const participant = participants.get(participantKey(context));
    if (!participant) fail("MEDIA_NOT_JOINED", "Join media before using this operation");
    participant.lastSeenAt = now;
  }

  function topology(context, now, includeIceServers) {
    const connectedSeats = new Set(context.snapshot.seats.filter((seat) => seat.connected).map((seat) => seat.seatId));
    const mediaPeers = [...participants.values()]
      .filter((participant) => participant.roomId === context.roomId && participant.gameId === context.gameId &&
        participant.seatId !== context.selfSeatId && participant.lastSeenAt + ttlMs > now && connectedSeats.has(participant.seatId))
      .map((participant) => ({ seatId: participant.seatId }))
      .sort((left, right) => left.seatId.localeCompare(right.seatId, "en", { numeric: true }));
    const result = {
      roomId: context.roomId,
      gameId: context.gameId,
      selfSeatId: context.selfSeatId,
      currentSpeakerSeatId: context.currentSpeakerSeatId,
      peers: mediaPeers,
    };
    if (includeIceServers) result.iceServers = structuredClone(iceServers);
    return result;
  }

  function enforceSpeakerEdge(context, recipientSeatId, type) {
    const speaker = context.currentSpeakerSeatId;
    if (!speaker) fail("NO_ACTIVE_SPEAKER", "The current game phase has no audio speaker");
    if (type === "offer" && context.selfSeatId !== speaker) fail("ACTION_NOT_ALLOWED", "Only the current speaker can publish an offer");
    if (type === "answer" && recipientSeatId !== speaker) fail("ACTION_NOT_ALLOWED", "Answers must be sent to the current speaker");
    if (type === "ice" && context.selfSeatId !== speaker && recipientSeatId !== speaker) {
      fail("ACTION_NOT_ALLOWED", "ICE is allowed only on a speaker-receiver edge");
    }
  }

  function prune(now) {
    for (const [key, participant] of participants) {
      if (participant.lastSeenAt + ttlMs <= now) {
        participants.delete(key);
        inboxes.delete(key);
      }
    }
    for (const [key, inbox] of inboxes) {
      inboxes.set(key, inbox.filter((signal) => Date.parse(signal.createdAt) + signalTtlMs > now));
    }
  }

  function removeOtherGames(roomId, seatId, gameId) {
    for (const [key, participant] of participants) {
      if (participant.roomId === roomId && participant.seatId === seatId && participant.gameId !== gameId) {
        participants.delete(key);
        inboxes.delete(key);
      }
    }
  }

  return Object.freeze({ drain, join, leave, peers, publishSignal });
}

function identity(context) {
  return { roomId: context.roomId, gameId: context.gameId, seatId: context.selfSeatId };
}

function participantKey(context) {
  return `${context.roomId}\u0000${context.gameId}\u0000${context.selfSeatId}`;
}

function isSeatId(value) {
  return typeof value === "string" && /^seat-[1-9]$/.test(value);
}

function isCurrentSeat(snapshot, seatId) {
  return snapshot.game.seats.some((seat) => seat.seatId === seatId) &&
    snapshot.seats.some((seat) => seat.seatId === seatId && seat.connected);
}

function normalizeSignal(signal, maxBytes) {
  if (!signal || typeof signal !== "object" || Array.isArray(signal) || !["offer", "answer", "ice"].includes(signal.type)) {
    fail("INVALID_SIGNAL", "Signal type must be offer, answer, or ice");
  }
  let payload;
  if (signal.type === "offer" || signal.type === "answer") {
    if (typeof signal.sdp !== "string" || !signal.sdp || signal.sdp.length > maxBytes) fail("INVALID_SIGNAL", "SDP is invalid or too large");
    payload = { sdp: signal.sdp };
  } else {
    payload = normalizeCandidate(signal.candidate);
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes) fail("INVALID_SIGNAL", "Signal payload is too large");
  return { type: signal.type, payload };
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      typeof candidate.candidate !== "string" || candidate.candidate.length > 4096 ||
      (candidate.sdpMid !== null && candidate.sdpMid !== undefined && (typeof candidate.sdpMid !== "string" || candidate.sdpMid.length > 256)) ||
      (candidate.sdpMLineIndex !== null && candidate.sdpMLineIndex !== undefined &&
        (!Number.isSafeInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)) ||
      (candidate.usernameFragment !== undefined && (typeof candidate.usernameFragment !== "string" || candidate.usernameFragment.length > 256))) {
    fail("INVALID_SIGNAL", "ICE candidate is invalid");
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(candidate.usernameFragment === undefined ? {} : { usernameFragment: candidate.usernameFragment }),
  };
}

function parseIceServersFromEnv(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || value.length > 16_384) fail("INVALID_ICE_CONFIG", "ICE server config must be bounded JSON text");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("INVALID_ICE_CONFIG", "ICE server config is not valid JSON");
  }
  return normalizeIceServers(parsed);
}

function normalizeIceServers(value) {
  if (!Array.isArray(value) || value.length > 8) fail("INVALID_ICE_CONFIG", "ICE server config must be an array of at most eight entries");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("INVALID_ICE_CONFIG", "ICE server entries must be objects");
    const urls = typeof entry.urls === "string" ? [entry.urls] : entry.urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8 ||
        urls.some((url) => typeof url !== "string" || url.length > 2048 || !/^(stun|turn|turns):/i.test(url))) {
      fail("INVALID_ICE_CONFIG", "ICE server URLs must use stun, turn, or turns");
    }
    const hasTurn = urls.some((url) => /^turns?:/i.test(url));
    if (hasTurn && (typeof entry.username !== "string" || !entry.username || entry.username.length > 512 ||
        typeof entry.credential !== "string" || !entry.credential || entry.credential.length > 2048)) {
      fail("INVALID_ICE_CONFIG", "TURN entries require bounded username and credential strings");
    }
    return {
      urls: typeof entry.urls === "string" ? urls[0] : [...urls],
      ...(hasTurn ? { username: entry.username, credential: entry.credential } : {}),
    };
  });
}

function readNow(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : (typeof value === "string" ? Date.parse(value) : value);
  if (!Number.isFinite(milliseconds)) fail("INVALID_REQUEST", "Media clock returned an invalid time");
  return milliseconds;
}

module.exports = { MediaBrokerError, createMediaBroker, parseIceServersFromEnv };

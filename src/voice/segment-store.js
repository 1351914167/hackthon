"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { voiceError } = require("./errors");
const { AUDIO_TYPES } = require("./lingxi-gateway");

function createVoiceSegmentStore(options = {}) {
  const ttlMs = positiveInteger(options.ttlMs, 2 * 60 * 60_000, "ttlMs");
  const maxSegmentBytes = positiveInteger(options.maxSegmentBytes, 16 * 1024 * 1024, "maxSegmentBytes");
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, 64 * 1024 * 1024, "maxTotalBytes");
  if (maxSegmentBytes > maxTotalBytes) voiceError("VOICE_INVALID_CONFIG", "maxSegmentBytes cannot exceed maxTotalBytes", 500);
  const now = options.now || Date.now;
  const idGenerator = options.idGenerator || randomUUID;
  if (typeof now !== "function" || typeof idGenerator !== "function") voiceError("VOICE_INVALID_CONFIG", "Clock and ID generator are required", 500);

  const segments = new Map();
  let totalBytes = 0;

  function sweep() {
    const timestamp = currentTime(now);
    let removed = 0;
    for (const [segmentId, segment] of segments) {
      if (segment.expiresAt <= timestamp) {
        removeStored(segmentId, segment);
        removed += 1;
      }
    }
    return removed;
  }

  function put(input = {}) {
    sweep();
    const roomId = validateId(input.roomId, "roomId");
    const gameId = validateId(input.gameId, "gameId");
    const phaseKey = validateId(input.phaseKey, "phaseKey");
    const speakerSeatId = validateId(input.speakerSeatId, "speakerSeatId");
    const allowedSeatIds = validateAllowedSeats(input.allowedSeatIds);
    const contentType = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
    if (!AUDIO_TYPES.has(contentType) || !contentType.startsWith("audio/")) {
      voiceError("VOICE_UNSUPPORTED_AUDIO", "segment content type is not supported", 415);
    }
    const audio = copyAudio(input.audio);
    if (audio.length === 0) voiceError("VOICE_INVALID_REQUEST", "segment audio must not be empty", 400);
    if (audio.length > maxSegmentBytes) voiceError("VOICE_PAYLOAD_TOO_LARGE", "segment exceeds the size limit", 413);
    if (totalBytes + audio.length > maxTotalBytes) voiceError("VOICE_STORAGE_LIMIT", "temporary voice storage is full", 507);

    const segmentId = idGenerator();
    if (typeof segmentId !== "string" || !segmentId || segments.has(segmentId)) {
      voiceError("VOICE_ID_GENERATION_FAILED", "Could not allocate a voice segment identifier", 500);
    }
    const createdAt = currentTime(now);
    const segment = {
      segmentId,
      roomId,
      gameId,
      phaseKey,
      speakerSeatId,
      contentType,
      audio,
      sha256: createHash("sha256").update(audio).digest("hex"),
      allowedSeatIds,
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    if (!Number.isSafeInteger(segment.expiresAt)) voiceError("VOICE_INVALID_CONFIG", "Segment expiry is outside the safe time range", 500);
    segments.set(segmentId, segment);
    totalBytes += audio.length;
    return metadata(segment);
  }

  function get(input = {}) {
    sweep();
    const segmentId = validateId(input.segmentId, "segmentId");
    const segment = segments.get(segmentId);
    if (!segment || segment.roomId !== input.roomId || segment.gameId !== input.gameId || segment.phaseKey !== input.phaseKey) {
      voiceError("VOICE_SEGMENT_NOT_FOUND", "Voice segment was not found", 404);
    }
    const requesterSeatId = validateId(input.requesterSeatId, "requesterSeatId");
    if (!segment.allowedSeatIds.has(requesterSeatId)) voiceError("VOICE_SEGMENT_FORBIDDEN", "Seat cannot access this voice segment", 403);
    return { ...metadata(segment), audio: Buffer.from(segment.audio) };
  }

  function remove(segmentId) {
    validateId(segmentId, "segmentId");
    const segment = segments.get(segmentId);
    if (!segment) return false;
    removeStored(segmentId, segment);
    return true;
  }

  function clearGame(roomId, gameId) {
    validateId(roomId, "roomId");
    validateId(gameId, "gameId");
    let removed = 0;
    for (const [segmentId, segment] of segments) {
      if (segment.roomId === roomId && segment.gameId === gameId) {
        removeStored(segmentId, segment);
        removed += 1;
      }
    }
    return removed;
  }

  function stats() {
    sweep();
    return { segments: segments.size, totalBytes, maxTotalBytes };
  }

  function removeStored(segmentId, segment) {
    segments.delete(segmentId);
    totalBytes -= segment.audio.length;
  }

  return Object.freeze({ clearGame, get, put, remove, stats, sweep });
}

function metadata(segment) {
  return {
    segmentId: segment.segmentId,
    roomId: segment.roomId,
    gameId: segment.gameId,
    phaseKey: segment.phaseKey,
    speakerSeatId: segment.speakerSeatId,
    contentType: segment.contentType,
    size: segment.audio.length,
    sha256: segment.sha256,
    createdAt: segment.createdAt,
    expiresAt: segment.expiresAt,
  };
}

function validateAllowedSeats(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 9) {
    voiceError("VOICE_INVALID_REQUEST", "allowedSeatIds must contain 1 to 9 seats", 400);
  }
  const seats = new Set(value.map((seatId) => validateId(seatId, "allowedSeatId")));
  if (seats.size !== value.length) voiceError("VOICE_INVALID_REQUEST", "allowedSeatIds must be unique", 400);
  return seats;
}

function copyAudio(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  voiceError("VOICE_INVALID_REQUEST", "segment audio bytes are required", 400);
}

function validateId(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) voiceError("VOICE_INVALID_REQUEST", `${name} is required`, 400);
  return value;
}

function currentTime(now) {
  const timestamp = Number(now());
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) voiceError("VOICE_INVALID_CONFIG", "Clock returned an invalid time", 500);
  return timestamp;
}

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) voiceError("VOICE_INVALID_CONFIG", `${name} must be a positive integer`, 500);
  return resolved;
}

module.exports = { createVoiceSegmentStore };

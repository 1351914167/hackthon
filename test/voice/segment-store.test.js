"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");

const { VoiceError, createVoiceSegmentStore } = require("../../src/voice");

function input(overrides = {}) {
  return {
    roomId: "room-1",
    gameId: "game-1",
    phaseKey: "round-1:speech-3",
    speakerSeatId: "seat-3",
    allowedSeatIds: ["seat-1", "seat-2", "seat-3"],
    audio: Buffer.from("original voice"),
    contentType: "audio/webm",
    ...overrides,
  };
}

function access(segmentId, overrides = {}) {
  return {
    segmentId,
    roomId: "room-1",
    gameId: "game-1",
    phaseKey: "round-1:speech-3",
    requesterSeatId: "seat-1",
    ...overrides,
  };
}

function expectError(code, callback, statusCode) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof VoiceError, true);
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

describe("temporary voice segment authorization", () => {
  it("stores copied audio and exposes only whitelisted metadata", () => {
    let timestamp = 1_000;
    const store = createVoiceSegmentStore({ now: () => timestamp, ttlMs: 5_000, idGenerator: () => "segment-1" });
    const source = Buffer.from("original voice");
    const created = store.put(input({ audio: source }));
    source.fill(0);
    assert.deepEqual(created, {
      segmentId: "segment-1",
      roomId: "room-1",
      gameId: "game-1",
      phaseKey: "round-1:speech-3",
      speakerSeatId: "seat-3",
      contentType: "audio/webm",
      size: 14,
      sha256: createHash("sha256").update("original voice").digest("hex"),
      createdAt: 1_000,
      expiresAt: 6_000,
    });
    assert.equal(JSON.stringify(created).includes("token"), false);
    assert.equal("allowedSeatIds" in created, false);

    const first = store.get(access(created.segmentId));
    assert.equal(first.audio.toString(), "original voice");
    first.audio.fill(0);
    assert.equal(store.get(access(created.segmentId)).audio.toString(), "original voice");
    assert.deepEqual(store.stats(), { segments: 1, totalBytes: 14, maxTotalBytes: 64 * 1024 * 1024 });
    timestamp += 1;
  });

  it("hides cross-room, cross-game, and cross-phase segments and rejects unauthorized seats", () => {
    const store = createVoiceSegmentStore({ idGenerator: () => "segment-1" });
    const segment = store.put(input());
    for (const overrides of [
      { roomId: "room-2" },
      { gameId: "game-2" },
      { phaseKey: "round-2:speech-3" },
      { segmentId: "missing" },
    ]) expectError("VOICE_SEGMENT_NOT_FOUND", () => store.get(access(segment.segmentId, overrides)), 404);
    expectError("VOICE_SEGMENT_FORBIDDEN", () => store.get(access(segment.segmentId, { requesterSeatId: "seat-9" })), 403);
  });

  it("expires segments without persistence and reclaims capacity", () => {
    let timestamp = 10;
    let sequence = 0;
    const store = createVoiceSegmentStore({
      ttlMs: 10,
      maxTotalBytes: 6,
      maxSegmentBytes: 6,
      now: () => timestamp,
      idGenerator: () => `segment-${++sequence}`,
    });
    const first = store.put(input({ audio: Buffer.from("123456") }));
    expectError("VOICE_STORAGE_LIMIT", () => store.put(input({ audio: Buffer.from("1") })), 507);
    timestamp = 20;
    assert.equal(store.sweep(), 1);
    expectError("VOICE_SEGMENT_NOT_FOUND", () => store.get(access(first.segmentId)), 404);
    const replacement = store.put(input({ audio: Buffer.from("new") }));
    assert.equal(replacement.size, 3);
    assert.deepEqual(store.stats(), { segments: 1, totalBytes: 3, maxTotalBytes: 6 });
  });

  it("supports explicit removal and game-scoped cleanup", () => {
    let id = 0;
    const store = createVoiceSegmentStore({ idGenerator: () => `segment-${++id}` });
    const first = store.put(input());
    store.put(input({ phaseKey: "round-1:speech-4" }));
    store.put(input({ roomId: "room-2", gameId: "game-2" }));
    assert.equal(store.remove(first.segmentId), true);
    assert.equal(store.remove(first.segmentId), false);
    assert.equal(store.clearGame("room-1", "game-1"), 1);
    assert.equal(store.clearGame("room-1", "game-1"), 0);
    assert.equal(store.stats().segments, 1);
  });
});

describe("temporary voice segment validation", () => {
  it("accepts Buffer, Uint8Array, and ArrayBuffer without retaining caller memory", () => {
    let id = 0;
    const store = createVoiceSegmentStore({ idGenerator: () => `segment-${++id}` });
    const values = [Buffer.from("a"), Uint8Array.from([98]), Uint8Array.from([99]).buffer];
    for (const value of values) store.put(input({ audio: value }));
    assert.equal(store.stats().segments, 3);
  });

  it("rejects invalid identity, authorization, media, and size fields", () => {
    const store = createVoiceSegmentStore({ maxSegmentBytes: 4, maxTotalBytes: 8 });
    const invalids = [
      [input({ roomId: "" }), "VOICE_INVALID_REQUEST"],
      [input({ gameId: 4 }), "VOICE_INVALID_REQUEST"],
      [input({ phaseKey: "" }), "VOICE_INVALID_REQUEST"],
      [input({ speakerSeatId: "" }), "VOICE_INVALID_REQUEST"],
      [input({ allowedSeatIds: [] }), "VOICE_INVALID_REQUEST"],
      [input({ allowedSeatIds: ["seat-1", "seat-1"] }), "VOICE_INVALID_REQUEST"],
      [input({ allowedSeatIds: Array.from({ length: 10 }, (_, index) => `seat-${index}`) }), "VOICE_INVALID_REQUEST"],
      [input({ contentType: "video/mp4" }), "VOICE_UNSUPPORTED_AUDIO"],
      [input({ contentType: "text/plain" }), "VOICE_UNSUPPORTED_AUDIO"],
      [input({ audio: "not bytes" }), "VOICE_INVALID_REQUEST"],
      [input({ audio: Buffer.alloc(0) }), "VOICE_INVALID_REQUEST"],
      [input({ audio: Buffer.alloc(5) }), "VOICE_PAYLOAD_TOO_LARGE"],
    ];
    for (const [value, code] of invalids) expectError(code, () => store.put(value));
    const segment = store.put(input({ audio: Buffer.from("ok") }));
    expectError("VOICE_INVALID_REQUEST", () => store.get(access(segment.segmentId, { requesterSeatId: "" })));
    expectError("VOICE_INVALID_REQUEST", () => store.remove(""));
    expectError("VOICE_INVALID_REQUEST", () => store.clearGame("", "game-1"));
  });

  it("rejects invalid configuration, clocks, and segment IDs", () => {
    for (const options of [
      { ttlMs: 0 },
      { maxSegmentBytes: 0 },
      { maxTotalBytes: 0 },
      { maxSegmentBytes: 2, maxTotalBytes: 1 },
      { now: 4 },
      { idGenerator: 4 },
    ]) expectError("VOICE_INVALID_CONFIG", () => createVoiceSegmentStore(options), 500);

    const badClock = createVoiceSegmentStore({ now: () => -1 });
    expectError("VOICE_INVALID_CONFIG", () => badClock.stats(), 500);
    const badId = createVoiceSegmentStore({ idGenerator: () => "" });
    expectError("VOICE_ID_GENERATION_FAILED", () => badId.put(input()), 500);
    const duplicateId = createVoiceSegmentStore({ idGenerator: () => "same" });
    duplicateId.put(input());
    expectError("VOICE_ID_GENERATION_FAILED", () => duplicateId.put(input()), 500);
  });
});

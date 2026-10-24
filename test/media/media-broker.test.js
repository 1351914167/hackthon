"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { MediaBrokerError, createMediaBroker, parseIceServersFromEnv } = require("../../src/media");

function fixture(overrides = {}) {
  let now = 1_700_000_000_000;
  let signalNumber = 0;
  const state = {
    roomId: "room-1",
    status: "ACTIVE",
    gameId: "game-1",
    speaker: "seat-1",
    connected: new Set(["seat-1", "seat-2", "seat-3"]),
  };
  const tokens = new Map([
    ["token-1", "seat-1"],
    ["token-2", "seat-2"],
    ["token-3", "seat-3"],
  ]);
  const getSnapshot = ({ roomId, seatToken }) => {
    const seatId = tokens.get(seatToken);
    if (roomId !== state.roomId || !seatId) throw Object.assign(new Error("bad token"), { code: "INVALID_SEAT_TOKEN" });
    return {
      roomId: state.roomId,
      status: state.status,
      selfSeatId: seatId,
      seats: [...tokens.values()].map((id) => ({ seatId: id, connected: state.connected.has(id) })),
      game: state.gameId ? {
        gameId: state.gameId,
        currentSpeakerSeatId: state.speaker,
        seats: [...tokens.values()].map((id) => ({ seatId: id, alive: true })),
      } : null,
    };
  };
  const broker = createMediaBroker({
    clock: () => now,
    getSnapshot,
    createOpaqueId: () => `signal-${++signalNumber}`,
    ttlMs: 1_000,
    signalTtlMs: 500,
    maxInbox: 2,
    iceServers: [{ urls: "stun:stun.example.test" }],
    ...overrides,
  });
  return { broker, state, tokens, now: () => now, advance: (ms) => { now += ms; } };
}

function auth(number) {
  return { roomId: "room-1", seatToken: `token-${number}` };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error instanceof MediaBrokerError && error.code === code);
}

describe("media signaling broker", () => {
  it("joins authenticated seats and exposes only public topology", () => {
    const { broker } = fixture();
    const first = broker.join(auth(1));
    assert.deepEqual(first.peers, []);
    assert.deepEqual(first.iceServers, [{ urls: "stun:stun.example.test" }]);
    broker.join(auth(2));
    broker.join(auth(3));
    const topology = broker.peers(auth(1));
    assert.deepEqual(topology.peers, [{ seatId: "seat-2" }, { seatId: "seat-3" }]);
    assert.equal(topology.currentSpeakerSeatId, "seat-1");
    const serialized = JSON.stringify(topology);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("role"), false);
    assert.equal(serialized.includes("seq"), false);
    assert.equal("iceServers" in topology, false);
  });

  it("relays offer, answer, and ICE only on the current speaker edge", () => {
    const { broker } = fixture();
    broker.join(auth(1));
    broker.join(auth(2));
    broker.join(auth(3));

    const offer = broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "offer-sdp" } });
    assert.deepEqual(offer, { accepted: true, signalId: "signal-1" });
    const receiverInbox = broker.drain(auth(2));
    assert.deepEqual(receiverInbox.signals[0], {
      id: "signal-1",
      fromSeatId: "seat-1",
      type: "offer",
      payload: { sdp: "offer-sdp" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    assert.deepEqual(broker.drain(auth(2)).signals, []);

    broker.publishSignal({ ...auth(2), recipientSeatId: "seat-1", signal: { type: "answer", sdp: "answer-sdp" } });
    broker.publishSignal({
      ...auth(2),
      recipientSeatId: "seat-1",
      signal: { type: "ice", candidate: { candidate: "candidate:1", sdpMid: "audio", sdpMLineIndex: 0, usernameFragment: "ufrag" } },
    });
    const speakerInbox = broker.drain(auth(1));
    assert.deepEqual(speakerInbox.signals.map((signal) => signal.type), ["answer", "ice"]);
    assert.deepEqual(speakerInbox.signals[1].payload, {
      candidate: "candidate:1",
      sdpMid: "audio",
      sdpMLineIndex: 0,
      usernameFragment: "ufrag",
    });

    expectCode("ACTION_NOT_ALLOWED", () => broker.publishSignal({ ...auth(2), recipientSeatId: "seat-3", signal: { type: "offer", sdp: "bad" } }));
    expectCode("ACTION_NOT_ALLOWED", () => broker.publishSignal({ ...auth(2), recipientSeatId: "seat-3", signal: { type: "answer", sdp: "bad" } }));
    expectCode("ACTION_NOT_ALLOWED", () => broker.publishSignal({ ...auth(2), recipientSeatId: "seat-3", signal: { type: "ice", candidate: { candidate: "x" } } }));
  });

  it("requires current joined and connected recipients", () => {
    const { broker, state } = fixture();
    broker.join(auth(1));
    expectCode("PEER_NOT_JOINED", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } }));
    broker.join(auth(2));
    state.connected.delete("seat-2");
    expectCode("INVALID_RECIPIENT", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } }));
    expectCode("INVALID_RECIPIENT", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-1", signal: { type: "offer", sdp: "x" } }));
    expectCode("INVALID_RECIPIENT", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-9", signal: { type: "offer", sdp: "x" } }));
    expectCode("MEDIA_NOT_JOINED", () => broker.drain(auth(3)));
  });

  it("rejects every media operation after the authenticated seat disconnects", () => {
    const { broker, state } = fixture();
    broker.join(auth(1));
    broker.join(auth(2));
    state.connected.delete("seat-1");
    for (const operation of [
      () => broker.join(auth(1)),
      () => broker.peers(auth(1)),
      () => broker.drain(auth(1)),
      () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } }),
    ]) expectCode("MEDIA_NOT_AVAILABLE", operation);
  });

  it("rejects signaling when no public speaker exists", () => {
    const { broker, state } = fixture();
    broker.join(auth(1));
    broker.join(auth(2));
    state.speaker = null;
    expectCode("NO_ACTIVE_SPEAKER", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } }));
  });

  it("bounds and expires inboxes and participants", () => {
    const { broker, advance } = fixture();
    broker.join(auth(1));
    broker.join(auth(2));
    for (const sdp of ["one", "two", "three"]) {
      broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp } });
    }
    assert.deepEqual(broker.drain(auth(2)).signals.map((signal) => signal.payload.sdp), ["two", "three"]);
    broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "expires" } });
    advance(500);
    assert.deepEqual(broker.drain(auth(2)).signals, []);
    advance(1_001);
    broker.join(auth(1));
    assert.deepEqual(broker.peers(auth(1)).peers, []);
  });

  it("removes a leaving participant and old-game registrations", () => {
    const { broker, state } = fixture();
    broker.join(auth(1));
    broker.join(auth(2));
    assert.equal(broker.leave(auth(2)).left, true);
    assert.deepEqual(broker.peers(auth(1)).peers, []);
    state.gameId = "game-2";
    assert.equal(broker.join(auth(1)).gameId, "game-2");
  });

  it("validates authentication, signal schemas, sizes, and dependencies", () => {
    const { broker, state } = fixture({ maxSignalBytes: 16 });
    expectCode("INVALID_REQUEST", () => broker.join(null));
    state.status = "FINISHED";
    expectCode("MEDIA_NOT_AVAILABLE", () => broker.join(auth(1)));
    state.status = "ACTIVE";
    broker.join(auth(1));
    broker.join(auth(2));
    for (const signal of [
      null,
      { type: "other" },
      { type: "offer", sdp: "" },
      { type: "offer", sdp: "x".repeat(17) },
      { type: "ice", candidate: null },
      { type: "ice", candidate: { candidate: "x", sdpMLineIndex: -1 } },
      { type: "ice", candidate: { candidate: "x", sdpMid: 4 } },
    ]) expectCode("INVALID_SIGNAL", () => broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal }));

    for (const options of [null, [], {}, { getSnapshot: () => ({}), ttlMs: 0 }, { getSnapshot: () => ({}), maxInbox: 0 }]) {
      expectCode("INVALID_REQUEST", () => createMediaBroker(options));
    }
    const invalidId = fixture({ createOpaqueId: () => "" });
    invalidId.broker.join(auth(1));
    invalidId.broker.join(auth(2));
    expectCode("INVALID_REQUEST", () => invalidId.broker.publishSignal({ ...auth(1), recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } }));
  });

  it("uses default clock and opaque ID generators without exposing authority data", () => {
    const snapshot = {
      roomId: "room-1",
      status: "ACTIVE",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-1", seats: [{ seatId: "seat-1" }, { seatId: "seat-2" }] },
    };
    const broker = createMediaBroker({ getSnapshot: ({ seatToken }) => ({ ...snapshot, selfSeatId: seatToken === "two" ? "seat-2" : "seat-1" }) });
    broker.join({ roomId: "room-1", seatToken: "one" });
    broker.join({ roomId: "room-1", seatToken: "two" });
    const published = broker.publishSignal({ roomId: "room-1", seatToken: "one", recipientSeatId: "seat-2", signal: { type: "offer", sdp: "x" } });
    assert.match(published.signalId, /^media-/);
  });

  it("accepts Date and ISO string clocks", () => {
    const base = fixture({ clock: () => new Date(1_700_000_000_000) });
    assert.equal(base.broker.join(auth(1)).selfSeatId, "seat-1");
    const iso = fixture({ clock: () => new Date(1_700_000_000_000).toISOString() });
    assert.equal(iso.broker.join(auth(1)).selfSeatId, "seat-1");
  });
});

describe("ICE environment parsing", () => {
  it("parses bounded STUN and TURN entries", () => {
    assert.deepEqual(parseIceServersFromEnv(), []);
    assert.deepEqual(parseIceServersFromEnv(""), []);
    assert.deepEqual(parseIceServersFromEnv(JSON.stringify([
      { urls: "stun:stun.example.test" },
      { urls: ["turn:turn.example.test?transport=udp", "turns:turn.example.test"], username: "user", credential: "secret", ignored: "no" },
    ])), [
      { urls: "stun:stun.example.test" },
      { urls: ["turn:turn.example.test?transport=udp", "turns:turn.example.test"], username: "user", credential: "secret" },
    ]);
  });

  it("rejects malformed or unsafe ICE config", () => {
    for (const value of [
      4,
      "{",
      "x".repeat(16_385),
      "{}",
      JSON.stringify([null]),
      JSON.stringify([{ urls: "https://example.test" }]),
      JSON.stringify([{ urls: [] }]),
      JSON.stringify([{ urls: "turn:turn.example.test" }]),
      JSON.stringify(Array.from({ length: 9 }, () => ({ urls: "stun:x" }))),
    ]) expectCode("INVALID_ICE_CONFIG", () => parseIceServersFromEnv(value));
  });
});

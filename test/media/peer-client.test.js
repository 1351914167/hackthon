"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const { createPeerClient } = require("../../src/media/peer-client");

class FakeTrack {
  constructor() {
    this.enabled = false;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor() {
    this.track = new FakeTrack();
  }

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class FakePeerConnection {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = "new";
    this.addedTracks = [];
    this.remoteDescriptions = [];
    this.remoteDescription = null;
    this.iceCandidates = [];
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track, stream) {
    this.addedTracks.push({ track, stream });
  }

  async createOffer() {
    return { type: "offer", sdp: "created-offer" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "created-answer" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.remoteDescriptions.push(description);
  }

  async addIceCandidate(candidate) {
    this.iceCandidates.push(candidate);
  }

  close() {
    this.connectionState = "closed";
    this.closed = true;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

function response(payload, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => structuredClone(payload) };
}

function transportFixture(joinTopology) {
  const calls = [];
  let topology = structuredClone(joinTopology);
  const drains = [];
  const fetchImpl = async (url, options) => {
    const operation = url.split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ operation, body, options });
    if (operation === "join") return response({ ...topology, iceServers: [{ urls: "stun:test" }] });
    if (operation === "peers") return response(topology);
    if (operation === "drain") return response(drains.shift() || { signals: [], currentSpeakerSeatId: topology.currentSpeakerSeatId });
    if (operation === "signal") return response({ accepted: true, signalId: `id-${calls.length}` });
    if (operation === "leave") return response({ left: true });
    throw new Error(`unexpected ${operation}`);
  };
  return {
    calls,
    drains,
    fetchImpl,
    setTopology: (next) => { topology = structuredClone(next); },
  };
}

function clientOptions(transport, overrides = {}) {
  const stream = new FakeStream();
  const intervals = [];
  const cleared = [];
  const tracks = [];
  const states = [];
  const errors = [];
  return {
    stream,
    intervals,
    cleared,
    tracks,
    states,
    errors,
    options: {
      roomId: "room-1",
      seatToken: "secret-seat-token",
      baseUrl: "https://game.example/",
      fetchImpl: transport.fetchImpl,
      RTCPeerConnection: FakePeerConnection,
      getUserMedia: async () => stream,
      setIntervalFn: (callback, delay) => {
        intervals.push({ callback, delay });
        return intervals.length;
      },
      clearIntervalFn: (id) => cleared.push(id),
      onTrack: (event, metadata) => tracks.push({ event, metadata }),
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
      pollIntervalMs: 250,
      ...overrides,
    },
  };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
});

describe("speaker peer client", () => {
  it("captures one audio stream and offers it to every receiver", async () => {
    const transport = transportFixture({
      gameId: "game-1",
      selfSeatId: "seat-1",
      currentSpeakerSeatId: "seat-1",
      peers: [{ seatId: "seat-2" }, { seatId: "seat-3" }],
    });
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    const state = await client.start();
    assert.equal(state.isSpeaker, true);
    assert.equal(state.hasLocalStream, true);
    assert.equal(state.connectionCount, 2);
    assert.equal(fixture.stream.track.enabled, true);
    assert.equal(FakePeerConnection.instances.length, 2);
    assert.equal(FakePeerConnection.instances.every((connection) => connection.addedTracks.length === 1), true);
    assert.deepEqual(transport.calls.filter((call) => call.operation === "signal").map((call) => call.body.signal.type), ["offer", "offer"]);
    assert.equal(transport.calls[0].options.headers.Authorization, "Bearer secret-seat-token");
    assert.equal(fixture.intervals[0].delay, 250);

    const candidate = { candidate: "candidate:1", toJSON: () => ({ candidate: "candidate:1" }) };
    FakePeerConnection.instances[0].onicecandidate({ candidate });
    await Promise.resolve();
    assert.equal(transport.calls.at(-1).body.signal.type, "ice");
    FakePeerConnection.instances[0].onicecandidate({ candidate: null });
    FakePeerConnection.instances[0].onconnectionstatechange();
    fixture.intervals[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("applies answers and ICE, deduplicates polls, then closes on speaker change", async () => {
    const topology = {
      gameId: "game-1",
      selfSeatId: "seat-1",
      currentSpeakerSeatId: "seat-1",
      peers: [{ seatId: "seat-2" }],
    };
    const transport = transportFixture(topology);
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    await client.start();
    transport.drains.push({
      currentSpeakerSeatId: "seat-1",
      signals: [
        { fromSeatId: "seat-2", type: "ice", payload: { candidate: "remote-candidate" } },
        { fromSeatId: "seat-2", type: "answer", payload: { sdp: "remote-answer" } },
      ],
    });
    const firstPoll = client.poll();
    const secondPoll = client.poll();
    assert.equal(firstPoll, secondPoll);
    await firstPoll;
    const connection = FakePeerConnection.instances[0];
    assert.deepEqual(connection.remoteDescriptions, [{ type: "answer", sdp: "remote-answer" }]);
    assert.deepEqual(connection.iceCandidates, [{ candidate: "remote-candidate" }]);
    transport.drains.push({
      currentSpeakerSeatId: "seat-1",
      signals: [{ fromSeatId: "seat-2", type: "ice", payload: { candidate: "late-candidate" } }],
    });
    await client.poll();
    assert.deepEqual(connection.iceCandidates, [{ candidate: "remote-candidate" }, { candidate: "late-candidate" }]);

    const iceHandler = connection.onicecandidate;
    iceHandler({ candidate: { candidate: "raw-candidate" } });
    await Promise.resolve();
    assert.equal(transport.calls.at(-1).body.signal.candidate.candidate, "raw-candidate");

    transport.setTopology({ ...topology, peers: [{ seatId: "seat-2" }, { seatId: "seat-3" }] });
    await client.poll();
    assert.equal(client.getState().connectionCount, 2);
    const removedConnection = FakePeerConnection.instances[1];
    transport.setTopology(topology);
    await client.poll();
    assert.equal(removedConnection.closed, true);
    assert.equal(client.getState().connectionCount, 1);

    await client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-2" },
    });
    assert.equal(connection.closed, true);
    assert.equal(fixture.stream.track.stopped, true);
    assert.equal(client.getState().isSpeaker, false);
    iceHandler({ candidate: { candidate: "after-stop" } });
  });

  it("stops tracks/connections and leaves exactly once", async () => {
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    await client.start();
    await client.start();
    await client.stop();
    await client.stop();
    assert.equal(fixture.cleared.length, 1);
    assert.equal(fixture.stream.track.stopped, true);
    assert.equal(FakePeerConnection.instances[0].closed, true);
    assert.equal(transport.calls.filter((call) => call.operation === "leave").length, 1);
    assert.equal(client.getState().started, false);
  });

  it("single-flights concurrent starts", async () => {
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [] });
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    const first = client.start();
    const second = client.start();
    assert.equal(first, second);
    await first;
    assert.equal(transport.calls.filter((call) => call.operation === "join").length, 1);
    assert.equal(fixture.intervals.length, 1);
  });

  it("discards a late media stream after stop", async () => {
    const media = deferred();
    const stream = new FakeStream();
    let mediaRequested = false;
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport, { getUserMedia: () => { mediaRequested = true; return media.promise; } });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => mediaRequested);
    const stopping = client.stop();
    media.resolve(stream);
    await Promise.all([starting, stopping]);
    assert.equal(stream.track.stopped, true);
    assert.equal(client.getState().started, false);
    assert.equal(client.getState().hasLocalStream, false);
    assert.equal(client.getState().connectionCount, 0);
    assert.equal(fixture.intervals.length, 0);
  });

  it("invalidates pending capture as soon as a newer speaker topology is queued", async () => {
    const media = deferred();
    const stream = new FakeStream();
    let mediaRequested = false;
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport, { getUserMedia: () => { mediaRequested = true; return media.promise; } });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => mediaRequested);
    const switching = client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-2" },
    });
    media.resolve(stream);
    await Promise.all([starting, switching]);
    assert.equal(stream.track.stopped, true);
    assert.equal(client.getState().currentSpeakerSeatId, "seat-2");
    assert.equal(client.getState().hasLocalStream, false);
    assert.equal(client.getState().connectionCount, 0);
  });

  it("does not starve a slow offer when an identical topology arrives", async () => {
    const pendingOffer = deferred();
    class SlowOfferPeerConnection extends FakePeerConnection {
      async createOffer() {
        return pendingOffer.promise;
      }
    }
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport, { RTCPeerConnection: SlowOfferPeerConnection });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => FakePeerConnection.instances.length === 1);
    const repeated = client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-1" },
    });
    pendingOffer.resolve({ type: "offer", sdp: "slow-offer" });
    await Promise.all([starting, repeated]);
    assert.equal(FakePeerConnection.instances[0].closed, false);
    assert.equal(client.getState().connectionCount, 1);
    assert.equal(transport.calls.filter((call) => call.operation === "signal" && call.body.signal.type === "offer").length, 1);
  });

  it("closes a slow offer when a substantive speaker change arrives", async () => {
    const pendingOffer = deferred();
    class SlowOfferPeerConnection extends FakePeerConnection {
      async createOffer() { return pendingOffer.promise; }
    }
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport, { RTCPeerConnection: SlowOfferPeerConnection });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => FakePeerConnection.instances.length === 1);
    const switching = client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-2" },
    });
    pendingOffer.resolve({ type: "offer", sdp: "obsolete-offer" });
    await Promise.all([starting, switching]);
    assert.equal(FakePeerConnection.instances[0].closed, true);
    assert.equal(client.getState().connectionCount, 0);
    assert.equal(transport.calls.some((call) => call.operation === "signal"), false);
  });

  it("closes an offer invalidated while setting its local description", async () => {
    const localDescription = deferred();
    let settingDescription = false;
    class SlowLocalDescriptionPeerConnection extends FakePeerConnection {
      async setLocalDescription(description) {
        settingDescription = true;
        await localDescription.promise;
        return super.setLocalDescription(description);
      }
    }
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] });
    const fixture = clientOptions(transport, { RTCPeerConnection: SlowLocalDescriptionPeerConnection });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => settingDescription);
    const switching = client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-1",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-2" },
    });
    localDescription.resolve();
    await Promise.all([starting, switching]);
    assert.equal(FakePeerConnection.instances[0].closed, true);
    assert.equal(transport.calls.some((call) => call.operation === "signal"), false);
  });
});

describe("receiver peer client", () => {
  it("bounds ICE received before an offer and preserves the first candidates in order", async () => {
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    const transport = transportFixture(topology);
    const client = createPeerClient(clientOptions(transport).options);
    await client.start();
    transport.drains.push({ currentSpeakerSeatId: "seat-1", signals: Array.from({ length: 70 }, (_, index) =>
      ({ fromSeatId: "seat-1", type: "ice", payload: { candidate: `candidate:${index}` } })) });
    await client.poll();
    assert.equal(FakePeerConnection.instances.length, 0);
    transport.drains.push({ currentSpeakerSeatId: "seat-1", signals: [
      { fromSeatId: "seat-1", type: "offer", payload: { sdp: "delayed-offer" } },
    ] });
    await client.poll();
    assert.equal(FakePeerConnection.instances[0].iceCandidates.length, 64);
    assert.deepEqual(FakePeerConnection.instances[0].iceCandidates.at(-1), { candidate: "candidate:63" });
    await client.stop();
  });
  it("answers current-speaker offers and delivers only trusted tracks", async () => {
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    const transport = transportFixture(topology);
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    await client.start();
    assert.equal(client.getState().hasLocalStream, false);
    assert.equal(FakePeerConnection.instances.length, 0);

    transport.drains.push({
      currentSpeakerSeatId: "seat-1",
      signals: [{ fromSeatId: "seat-1", type: "offer", payload: { sdp: "speaker-offer" } }],
    });
    await client.poll();
    const connection = FakePeerConnection.instances[0];
    assert.deepEqual(connection.remoteDescriptions, [{ type: "offer", sdp: "speaker-offer" }]);
    assert.equal(transport.calls.at(-1).body.signal.type, "answer");
    const trustedEvent = { track: new FakeTrack(), streams: [] };
    connection.ontrack(trustedEvent);
    assert.equal(fixture.tracks[0].metadata.fromSeatId, "seat-1");

    const oldTrackHandler = connection.ontrack;
    const oldStateHandler = connection.onconnectionstatechange;
    const oldIceHandler = connection.onicecandidate;
    await client.updateRoomSnapshot({
      roomId: "room-1",
      selfSeatId: "seat-2",
      seats: [{ seatId: "seat-1", connected: true }, { seatId: "seat-2", connected: true }, { seatId: "seat-3", connected: true }],
      game: { gameId: "game-1", currentSpeakerSeatId: "seat-3" },
    });
    const untrustedTrack = new FakeTrack();
    oldTrackHandler({ track: untrustedTrack, streams: [] });
    assert.equal(untrustedTrack.stopped, true);
    const untrustedTrackWithoutStreams = new FakeTrack();
    oldTrackHandler({ track: untrustedTrackWithoutStreams });
    assert.equal(untrustedTrackWithoutStreams.stopped, true);
    const rejectedStream = new FakeStream();
    oldTrackHandler({ streams: [rejectedStream] });
    assert.equal(rejectedStream.track.stopped, true);
    assert.equal(fixture.tracks.length, 1);
    oldStateHandler();
    const signalsBefore = transport.calls.filter((call) => call.operation === "signal").length;
    oldIceHandler({ candidate: { candidate: "stale-candidate" } });
    await Promise.resolve();
    assert.equal(transport.calls.filter((call) => call.operation === "signal").length, signalsBefore);
  });

  it("ignores stale/unrelated signals and reacts to speaker updates from drain", async () => {
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }, { seatId: "seat-3" }] };
    const transport = transportFixture(topology);
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    await client.start();
    transport.drains.push({
      currentSpeakerSeatId: "seat-3",
      signals: [
        null,
        { fromSeatId: "seat-9", type: "offer", payload: { sdp: "not-a-peer" } },
        { fromSeatId: "seat-1", type: "offer", payload: { sdp: "old-speaker" } },
        { fromSeatId: "seat-3", type: "answer", payload: { sdp: "answer-without-connection" } },
        { fromSeatId: "seat-3", type: "ice", payload: { candidate: "ice-without-connection" } },
        { fromSeatId: "seat-3", type: "offer", payload: { sdp: "new-speaker" } },
      ],
    });
    await client.poll();
    assert.equal(client.getState().currentSpeakerSeatId, "seat-3");
    assert.equal(FakePeerConnection.instances.length, 1);
    assert.equal(FakePeerConnection.instances[0].remoteDescriptions[0].sdp, "new-speaker");
    assert.deepEqual(FakePeerConnection.instances[0].iceCandidates, [{ candidate: "ice-without-connection" }]);
  });

  it("returns state without mutation for irrelevant room snapshots", async () => {
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: null, peers: [] });
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    const before = client.getState();
    assert.deepEqual(await client.updateRoomSnapshot(null), before);
    assert.deepEqual(await client.updateRoomSnapshot({ roomId: "other", game: {} }), before);
    assert.deepEqual(await client.updateRoomSnapshot({ roomId: "room-1", game: null }), before);
    assert.deepEqual(await client.poll(), before);
    assert.deepEqual((await client.updateRoomSnapshot({ roomId: "room-1", selfSeatId: "seat-2", game: { gameId: "game-1", currentSpeakerSeatId: null } })).peerSeatIds, []);
  });
});

describe("peer client errors", () => {
  it("limits a still-expired broker to one rejoin per poll and surfaces the final error", async () => {
    let joins = 0;
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: null, peers: [] };
    const fetchImpl = async (url) => {
      if (url.endsWith("/join")) { joins += 1; return response(topology); }
      if (url.endsWith("/leave")) return response({ left: true });
      return response({ error: { code: "MEDIA_NOT_JOINED", message: "still expired" } }, false, 409);
    };
    const client = createPeerClient(clientOptions({ fetchImpl }).options);
    await client.start();
    await assert.rejects(client.poll(), (error) => error.code === "MEDIA_NOT_JOINED");
    assert.equal(joins, 2);
    await client.stop();
  });
  it("validates constructor dependencies", () => {
    for (const options of [
      null,
      {},
      { roomId: "room", seatToken: "token" },
      { roomId: "room", seatToken: "token", fetchImpl: async () => {}, RTCPeerConnection: FakePeerConnection, getUserMedia: async () => {}, pollIntervalMs: 10 },
      { ...clientOptions({ fetchImpl: async () => response({}) }).options, now: 4 },
      { ...clientOptions({ fetchImpl: async () => response({}) }).options, connectionRecoveryMs: -1 },
      { ...clientOptions({ fetchImpl: async () => response({}) }).options, retryCooldownMs: -1 },
    ]) assert.throws(() => createPeerClient(options), TypeError);
  });

  it("surfaces HTTP errors and reports leave failures", async () => {
    const failingFetch = async (url) => {
      if (url.endsWith("/leave")) return response({ error: { code: "LEAVE_FAILED", message: "leave failed" } }, false, 500);
      return response({ error: { code: "JOIN_FAILED", message: "join failed" } }, false, 401);
    };
    const fixture = clientOptions({ fetchImpl: failingFetch });
    const client = createPeerClient(fixture.options);
    await assert.rejects(client.start(), (error) => error.code === "JOIN_FAILED");

    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: null, peers: [] });
    const leaveFixture = clientOptions(transport, {
      fetchImpl: async (url, options) => url.endsWith("/leave")
        ? response({ error: { code: "LEAVE_FAILED", message: "leave failed" } }, false, 500)
        : transport.fetchImpl(url, options),
    });
    const leaveClient = createPeerClient(leaveFixture.options);
    await leaveClient.start();
    await leaveClient.stop();
    assert.equal(leaveFixture.errors[0].code, "LEAVE_FAILED");

    const fallbackFixture = clientOptions({ fetchImpl: async () => response({}, false, 503) });
    await assert.rejects(createPeerClient(fallbackFixture.options).start(), (error) => error.code === "MEDIA_REQUEST_FAILED" && error.message.includes("503"));
  });

  it("cleans up when stop wins before the initial join response", async () => {
    const pendingJoin = deferred();
    let joinStarted = false;
    let leaveCalls = 0;
    const topology = { gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [] };
    const fetchImpl = async (url) => {
      const operation = url.split("/").at(-1);
      if (operation === "join") { joinStarted = true; return pendingJoin.promise; }
      if (operation === "leave") { leaveCalls += 1; return response({ left: true }); }
      return response(topology);
    };
    const fixture = clientOptions({ fetchImpl });
    const client = createPeerClient(fixture.options);
    const starting = client.start();
    await waitFor(() => joinStarted);
    const stopping = client.stop();
    pendingJoin.resolve(response(topology));
    await Promise.all([starting, stopping]);
    assert.equal(client.getState().started, false);
    assert.equal(leaveCalls, 2);
  });

  it("rejects a speaker capture that has no audio stream", async () => {
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [] });
    const fixture = clientOptions(transport, { getUserMedia: async () => ({}) });
    await assert.rejects(createPeerClient(fixture.options).start(), /no audio stream/);
  });

  it("accepts minimal topology and drain responses without optional arrays", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const operation = url.split("/").at(-1);
      calls.push(operation);
      if (operation === "join" || operation === "peers") {
        return response({ gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: null });
      }
      if (operation === "drain") return response({ currentSpeakerSeatId: null });
      return response({ left: true });
    };
    const fixture = clientOptions({ fetchImpl });
    const client = createPeerClient(fixture.options);
    await client.start();
    await client.poll();
    assert.deepEqual(client.getState().peerSeatIds, []);
    await client.stop();
    assert.deepEqual(calls, ["join", "peers", "drain", "leave"]);
  });

  it("rejoins once when the broker participant TTL has expired", async () => {
    const calls = [];
    let peersCalls = 0;
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    const fetchImpl = async (url) => {
      const operation = url.split("/").at(-1);
      calls.push(operation);
      if (operation === "join") return response({ ...topology, iceServers: [] });
      if (operation === "peers" && peersCalls++ === 0) {
        return response({ error: { code: "MEDIA_NOT_JOINED", message: "expired" } }, false, 409);
      }
      if (operation === "peers") return response(topology);
      if (operation === "drain") return response({ currentSpeakerSeatId: "seat-1", signals: [] });
      return response({ left: true });
    };
    const fixture = clientOptions({ fetchImpl });
    const client = createPeerClient(fixture.options);
    await client.start();
    await client.poll();
    assert.equal(calls.filter((operation) => operation === "join").length, 2);
    assert.deepEqual(calls.slice(1, 6), ["peers", "join", "peers", "drain"]);
    assert.equal(client.getState().started, true);
  });

  it("abandons a pending TTL rejoin after stop", async () => {
    const pendingRejoin = deferred();
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    let joinCalls = 0;
    let rejoinStarted = false;
    const fetchImpl = async (url) => {
      const operation = url.split("/").at(-1);
      if (operation === "join" && joinCalls++ === 0) return response(topology);
      if (operation === "join") { rejoinStarted = true; return pendingRejoin.promise; }
      if (operation === "peers") return response({ error: { code: "MEDIA_NOT_JOINED", message: "expired" } }, false, 409);
      return response({ left: true });
    };
    const fixture = clientOptions({ fetchImpl });
    const client = createPeerClient(fixture.options);
    await client.start();
    const polling = client.poll();
    await waitFor(() => rejoinStarted);
    await client.stop();
    pendingRejoin.resolve(response(topology));
    await polling;
    assert.equal(client.getState().started, false);
    assert.equal(client.getState().connectionCount, 0);
  });

  it("discards an in-flight poll immediately after stop", async () => {
    const pendingPeers = deferred();
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    let peersStarted = false;
    let drainCalls = 0;
    const fetchImpl = async (url) => {
      const operation = url.split("/").at(-1);
      if (operation === "join") return response(topology);
      if (operation === "peers") { peersStarted = true; return pendingPeers.promise; }
      if (operation === "drain") { drainCalls += 1; return response({ signals: [] }); }
      return response({ left: true });
    };
    const fixture = clientOptions({ fetchImpl });
    const client = createPeerClient(fixture.options);
    await client.start();
    const polling = client.poll();
    await waitFor(() => peersStarted);
    await client.stop();
    pendingPeers.resolve(response(topology));
    await polling;
    assert.equal(drainCalls, 0);
    assert.equal(client.getState().connectionCount, 0);
  });

  it("rebuilds failed and long-connecting speaker edges with cooldown", async () => {
    let currentTime = 0;
    const topology = { gameId: "game-1", selfSeatId: "seat-1", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-2" }] };
    const transport = transportFixture(topology);
    const fixture = clientOptions(transport, {
      now: () => currentTime,
      connectionRecoveryMs: 100,
      retryCooldownMs: 100,
    });
    const client = createPeerClient(fixture.options);
    await client.start();
    const first = FakePeerConnection.instances[0];
    first.connectionState = "failed";
    first.onconnectionstatechange();
    assert.equal(fixture.states.some((state) => state.failedPeerCount === 1), true);
    await waitFor(() => FakePeerConnection.instances.length === 2);
    assert.equal(first.closed, true);
    assert.equal(client.getState().connectingPeerCount, 1);

    const second = FakePeerConnection.instances[1];
    second.connectionState = "connecting";
    second.onconnectionstatechange();
    currentTime = 99;
    await client.poll();
    assert.equal(FakePeerConnection.instances.length, 2);
    currentTime = 100;
    await client.poll();
    assert.equal(FakePeerConnection.instances.length, 3);

    const third = FakePeerConnection.instances[2];
    third.connectionState = "failed";
    third.onconnectionstatechange();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakePeerConnection.instances.length, 3);
    third.connectionState = "connected";
    third.onconnectionstatechange();
    await client.poll();
    assert.deepEqual(client.getState(), {
      started: true,
      roomId: "room-1",
      gameId: "game-1",
      selfSeatId: "seat-1",
      currentSpeakerSeatId: "seat-1",
      peerSeatIds: ["seat-2"],
      isSpeaker: true,
      hasLocalStream: true,
      connectionCount: 1,
      connectedPeerCount: 1,
      connectingPeerCount: 0,
      failedPeerCount: 0,
    });
  });

  it("closes a failed receiver edge without attempting an offer", async () => {
    const topology = { gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] };
    const transport = transportFixture(topology);
    const fixture = clientOptions(transport);
    const client = createPeerClient(fixture.options);
    await client.start();
    transport.drains.push({ currentSpeakerSeatId: "seat-1", signals: [{ fromSeatId: "seat-1", type: "offer", payload: { sdp: "offer" } }] });
    await client.poll();
    const receiverConnection = FakePeerConnection.instances[0];
    receiverConnection.connectionState = "failed";
    receiverConnection.onconnectionstatechange();
    await waitFor(() => receiverConnection.closed);
    assert.equal(client.getState().connectionCount, 0);
    assert.equal(transport.calls.filter((call) => call.operation === "signal" && call.body.signal.type === "offer").length, 0);
  });

  it("supports default callbacks and browser globals", async () => {
    const originalFetch = global.fetch;
    const originalPeer = global.RTCPeerConnection;
    const originalNavigator = global.navigator;
    const stream = new FakeStream();
    const transport = transportFixture({ gameId: "game-1", selfSeatId: "seat-2", currentSpeakerSeatId: "seat-1", peers: [{ seatId: "seat-1" }] });
    try {
      global.fetch = transport.fetchImpl;
      global.RTCPeerConnection = FakePeerConnection;
      Object.defineProperty(global, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
      const intervals = [];
      const client = createPeerClient({
        roomId: "room-1",
        seatToken: "token",
        setIntervalFn: (callback) => { intervals.push(callback); return 1; },
        clearIntervalFn: () => {},
      });
      await client.start();
      transport.drains.push({ currentSpeakerSeatId: "seat-1", signals: [{ fromSeatId: "seat-1", type: "offer", payload: { sdp: "offer" } }] });
      await client.poll();
      FakePeerConnection.instances[0].ontrack({ track: new FakeTrack(), streams: [] });
      FakePeerConnection.instances[0].onconnectionstatechange();
      await client.stop();
      assert.equal(intervals.length, 1);
    } finally {
      global.fetch = originalFetch;
      global.RTCPeerConnection = originalPeer;
      Object.defineProperty(global, "navigator", { configurable: true, value: originalNavigator });
    }
  });
});

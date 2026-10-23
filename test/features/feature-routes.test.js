"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");

const { createFeatureRoutes, FeatureError } = require("../../src/features");
const { readBody, readJson } = require("../../src/http/application");
const { createSqliteRepository } = require("../../src/persistence/sqlite-repository");
const { createVoiceSegmentStore, VoiceError } = require("../../src/voice");

function baseGame(overrides = {}) {
  return {
    gameId: "game-1",
    phase: "DAY_SPEECH",
    round: 1,
    deadlineAt: "2099-10-23T10:01:00.000Z",
    currentSpeakerSeatId: "seat-1",
    voteHistory: [],
    deaths: [],
    result: null,
    revealedRoles: [],
    ...overrides,
  };
}

function roomHarness() {
  const seats = ["seat-1", "seat-2", "seat-3"];
  const tokens = new Map(seats.map((seatId, index) => [`token-${index + 1}`, seatId]));
  const disconnected = new Set();
  let roomId = "ROOM1";
  let game = baseGame();
  let rejectToken = null;
  return {
    rooms: {
      getSnapshot({ roomId: requested, seatToken }) {
        if (requested !== roomId) throw Object.assign(new Error("missing"), { code: "ROOM_NOT_FOUND", statusCode: 404 });
        if (!tokens.has(seatToken) || seatToken === rejectToken) {
          throw Object.assign(new Error("invalid"), { code: "INVALID_SEAT_TOKEN", statusCode: 401 });
        }
        return {
          roomId,
          status: game?.phase === "GAME_OVER" ? "FINISHED" : "ACTIVE",
          selfSeatId: tokens.get(seatToken),
          seats: seats.map((seatId) => ({ seatId, nickname: seatId, connected: !disconnected.has(seatId) })),
          game: game ? structuredClone(game) : null,
          version: "visible-version",
        };
      },
    },
    setGame(value) { game = value; },
    getGame() { return game; },
    reject(value) { rejectToken = value; },
    disconnect(seatId) { disconnected.add(seatId); },
    reconnect(seatId) { disconnected.delete(seatId); },
    setRoom(value) { roomId = value; },
  };
}

function gatewayHarness(overrides = {}) {
  const calls = { transcribe: [], synthesize: [] };
  const gateway = {
    status: () => ({
      provider: "Lingxi API",
      configured: true,
      implemented: { transcription: true, speech: true, realtime: false },
      checked: { transcription: true, speech: true, realtime: false },
      healthy: { transcription: true, speech: true, realtime: null },
    }),
    async transcribe(input) {
      calls.transcribe.push(input);
      if (overrides.transcribe) return overrides.transcribe(input);
      return { text: "真实转写" };
    },
    async synthesize(input) {
      calls.synthesize.push(input);
      if (overrides.synthesize) return overrides.synthesize(input);
      return { audio: Buffer.from("narration"), contentType: "audio/mpeg" };
    },
  };
  return { calls, gateway };
}

function retentionHarness(clock = Date.now) {
  const archives = [];
  const files = new Map();
  const repository = {
    archive(record) {
      const previous = archives.find((item) => item.recordId === record.recordId);
      if (previous) {
        assert.deepEqual(record, previous);
        return structuredClone(previous);
      }
      archives.push(structuredClone(record));
      return structuredClone(record);
    },
    listArchives(filter = {}) {
      return archives.filter((item) => !filter.kind || item.kind === filter.kind).map((item) => structuredClone(item));
    },
  };
  const mediaFiles = {
    put({ sha256, audio }) {
      files.set(sha256, Buffer.from(audio));
      return { sha256, size: audio.length, createdAt: clock(), expiresAt: clock() + 7_200_000 };
    },
    get({ sha256 }) {
      if (!files.has(sha256)) throw Object.assign(new Error("missing"), { code: "MEDIA_NOT_FOUND", statusCode: 404 });
      const audio = Buffer.from(files.get(sha256));
      return { audio, metadata: { sha256, size: audio.length, createdAt: clock(), expiresAt: clock() + 7_200_000 } };
    },
    remove(sha256) { return files.delete(sha256); },
    sweep() { return 0; },
  };
  return { archives, files, mediaFiles, repository };
}

function request(method, body = Buffer.alloc(0), headers = {}) {
  const value = Readable.from(body.length ? [body] : []);
  value.method = method;
  value.headers = headers;
  return value;
}

function response() {
  return {
    headersSent: false,
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

async function multipartRequest(fields = {}) {
  const form = new FormData();
  if (fields.file !== false) {
    form.append("file", new Blob([fields.audio ?? "original voice"], { type: fields.type || "audio/webm;codecs=opus" }), fields.name || "voice.webm");
  }
  if (fields.duplicate) form.append("file", new Blob(["two"], { type: "audio/webm" }), "two.webm");
  if (fields.durationMs !== false) form.append("durationMs", String(fields.durationMs ?? 12_000));
  if (fields.retain) form.append("retain", "true");
  const webRequest = new Request("http://localhost/upload", { method: "POST", body: form });
  const body = Buffer.from(await webRequest.arrayBuffer());
  return request("POST", body, {
    "content-type": webRequest.headers.get("content-type"),
    "content-length": String(body.length),
    authorization: `Bearer ${fields.token || "token-1"}`,
  });
}

function jsonRequest(value, tokenValue = "token-1") {
  const body = Buffer.from(JSON.stringify(value));
  return request("POST", body, {
    "content-type": "application/json",
    "content-length": String(body.length),
    authorization: `Bearer ${tokenValue}`,
  });
}

function token(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!match) throw Object.assign(new Error("token"), { code: "INVALID_SEAT_TOKEN", statusCode: 401 });
  return match[1];
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function invoke(extension, path, req, overrides = {}) {
  const res = response();
  const handled = await extension({
    request: req,
    response: res,
    url: new URL(path, "http://localhost"),
    token,
    json,
    readBody: overrides.readBody || readBody,
    readJson: overrides.readJson || readJson,
  });
  return { handled, response: res, json: () => JSON.parse(res.body.toString("utf8")) };
}

async function upload(extension, options = {}) {
  const result = await invoke(extension, "/api/rooms/ROOM1/voice", await multipartRequest(options));
  assert.equal(result.response.status, 201);
  return result.json();
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

async function expectCode(code, operation, statusCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

describe("feature route contracts", () => {
  it("returns false for unrelated routes and exposes honest Lingxi status", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, ...retention });
    assert.equal((await invoke(extension, "/api/other", request("GET"))).handled, false);
    const status = await invoke(extension, "/api/lingxi/status", request("GET"));
    assert.equal(status.response.status, 200);
    assert.equal(status.json().healthy.transcription, true);
    await expectCode("METHOD_NOT_ALLOWED", () => invoke(extension, "/api/lingxi/status", request("POST")), 405);

    const defaults = createFeatureRoutes({ rooms: room.rooms });
    const unconfigured = await invoke(defaults, "/api/lingxi/status", request("GET"));
    assert.equal(unconfigured.json().configured, false);
  });

  it("validates required dependencies", () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    for (const options of [
      {},
      { rooms: {} },
      { rooms: room.rooms, clock: 4 },
      { rooms: room.rooms, gateway: {} },
      { rooms: room.rooms, gateway: lingxi.gateway, segments: {} },
      { rooms: room.rooms, gateway: lingxi.gateway, repository: {} },
      { rooms: room.rooms, gateway: lingxi.gateway, mediaFiles: {} },
      { rooms: room.rooms, gateway: lingxi.gateway, maxMarksPerPlayer: 0 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxMarksPerPlayer: 201 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxRoomVoiceBytes: 0 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxSeatVoiceBytes: 0 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxSeatVoiceClips: 0 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxRoomVoiceInflight: 0 },
      { rooms: room.rooms, gateway: lingxi.gateway, maxSeatVoiceInflight: 0 },
    ]) assert.throws(() => createFeatureRoutes(options), FeatureError);
  });
});

describe("original voice upload and playback", () => {
  it("freezes the original phase while transcription completes and lets another seat play verified bytes", async () => {
    const room = roomHarness();
    let resolveTranscription;
    const pending = new Promise((resolve) => { resolveTranscription = resolve; });
    const lingxi = gatewayHarness({ transcribe: () => pending });
    const retention = retentionHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, ...retention });
    const uploadPromise = upload(extension, { retain: true });
    await waitFor(() => lingxi.calls.transcribe.length === 1);
    room.setGame({ ...room.getGame(), phase: "DAY_VOTE", currentSpeakerSeatId: null });
    resolveTranscription({ text: "  冻结阶段的发言  " });
    const segment = await uploadPromise;
    assert.equal(segment.phaseKey.startsWith("1:DAY_SPEECH:seat-1:"), true);
    assert.equal(segment.transcript, "冻结阶段的发言");
    assert.equal(segment.transcriptStatus, "ready");
    assert.equal(segment.retain, true);
    assert.match(segment.sha256, /^[a-f0-9]{64}$/);
    assert.match(lingxi.calls.transcribe[0].seatId, /^voice:[a-f0-9]{64}$/);
    assert.equal(lingxi.calls.transcribe[0].formData.get("file").type, "audio/webm");

    const list = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-2" }));
    assert.equal(list.json().segments[0].segmentId, segment.segmentId);
    assert.equal("allowedSeatIds" in list.json().segments[0], false);

    const audio = await invoke(extension, `/api/rooms/ROOM1/voice/${segment.segmentId}`, request("GET", Buffer.alloc(0), { authorization: "Bearer token-2" }));
    assert.equal(audio.response.status, 200);
    assert.equal(audio.response.body.toString(), "original voice");
    assert.equal(audio.response.headers["Content-Type"], "audio/webm");
    assert.equal(audio.response.headers["X-Voice-SHA256"], segment.sha256);
    assert.equal(audio.response.headers["Cache-Control"], "private, no-store");
  });

  it("keeps raw audio when Lingxi transcription fails", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness({ transcribe: async () => { throw new VoiceError("LINGXI_TIMEOUT", "timeout", 504); } });
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const segment = await upload(extension);
    assert.equal(segment.transcriptStatus, "failed");
    assert.equal(segment.transcript, null);
    const audio = await invoke(extension, `/api/rooms/ROOM1/voice/${segment.segmentId}`, request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    assert.equal(audio.response.body.toString(), "original voice");
  });

  it("requires a configured persistence target only when retention is requested", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    await expectCode("MEDIA_RETENTION_UNAVAILABLE", () => upload(extension, { retain: true }), 503);
    assert.equal((await upload(extension)).retain, false);
  });

  it("treats an empty successful transcription as failed without losing audio", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness({ transcribe: async () => ({ text: "   " }) });
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const segment = await upload(extension);
    assert.equal(segment.transcriptStatus, "failed");
    assert.equal(segment.transcript, null);
    await expectCode("METHOD_NOT_ALLOWED", () => invoke(extension, `/api/rooms/ROOM1/voice/${segment.segmentId}`, jsonRequest({})), 405);
  });

  it("discards an in-flight upload when its seat leaves or the room starts another game", async () => {
    for (const mode of ["leave", "restart"]) {
      const room = roomHarness();
      let release;
      const lingxi = gatewayHarness({ transcribe: () => new Promise((resolve) => { release = resolve; }) });
      const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
      const pending = upload(extension);
      await waitFor(() => typeof release === "function");
      if (mode === "leave") room.reject("token-1");
      else room.setGame(baseGame({ gameId: "game-2" }));
      release({ text: "late" });
      await expectCode(mode === "leave" ? "INVALID_SEAT_TOKEN" : "VOICE_CONTEXT_EXPIRED", () => pending);
      const list = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-2" }));
      assert.deepEqual(list.json().segments, []);
    }
  });

  it("rejects recording outside the current speaker phase", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, ...retention });
    await expectCode("ACTION_NOT_ALLOWED", () => upload(extension, { token: "token-2" }), 403);
    room.setGame(baseGame({ phase: "DAY_VOTE", currentSpeakerSeatId: null }));
    await expectCode("ACTION_NOT_ALLOWED", () => upload(extension), 403);
    room.setGame(baseGame());
    room.disconnect("seat-1");
    await expectCode("ACTION_NOT_ALLOWED", () => upload(extension), 403);
    room.reconnect("seat-1");
    room.setGame(baseGame({ deadlineAt: "1970-01-01T00:00:00.001Z" }));
    await expectCode("ACTION_NOT_ALLOWED", () => upload(extension), 403);
  });

  it("rechecks speaker, phase, deadline, and connectivity after the full multipart body arrives", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const source = await multipartRequest();
    const bytes = await readBody(source, 20 * 1024 * 1024);
    const delayedRequest = request("POST", Buffer.alloc(0), source.headers);
    let releaseBody;
    let bodyStarted;
    const started = new Promise((resolve) => { bodyStarted = resolve; });
    const pending = invoke(extension, "/api/rooms/ROOM1/voice", delayedRequest, {
      readBody: async () => {
        bodyStarted();
        await new Promise((resolve) => { releaseBody = resolve; });
        return bytes;
      },
    });
    await started;
    room.setGame(baseGame({ phase: "DAY_SPEECH", currentSpeakerSeatId: "seat-2", deadlineAt: "2026-10-23T10:02:00.000Z" }));
    releaseBody();
    await expectCode("ACTION_NOT_ALLOWED", () => pending, 403);
    assert.equal(lingxi.calls.transcribe.length, 0);
  });

  it("bounds inflight uploads and per-room/per-seat clip bytes", async () => {
    const room = roomHarness();
    let release;
    const heldLingxi = gatewayHarness({ transcribe: () => new Promise((resolve) => { release = resolve; }) });
    const inflight = createFeatureRoutes({ rooms: room.rooms, gateway: heldLingxi.gateway });
    const firstPending = upload(inflight, { audio: "first" });
    await waitFor(() => heldLingxi.calls.transcribe.length === 1);
    await expectCode("VOICE_INFLIGHT_LIMIT", () => upload(inflight, { audio: "second" }), 429);
    release({ text: "done" });
    await firstPending;

    let releaseRoom;
    const heldRoom = gatewayHarness({ transcribe: () => new Promise((resolve) => { releaseRoom = resolve; }) });
    const roomLimited = createFeatureRoutes({
      rooms: room.rooms,
      gateway: heldRoom.gateway,
      maxSeatVoiceInflight: 2,
      maxRoomVoiceInflight: 1,
    });
    const roomPending = upload(roomLimited);
    await waitFor(() => heldRoom.calls.transcribe.length === 1);
    await expectCode("VOICE_ROOM_INFLIGHT_LIMIT", () => upload(roomLimited), 429);
    releaseRoom({ text: "done" });
    await roomPending;

    const clips = createFeatureRoutes({ rooms: room.rooms, gateway: gatewayHarness().gateway, maxSeatVoiceClips: 1 });
    await upload(clips, { audio: "one" });
    await expectCode("VOICE_CLIP_QUOTA", () => upload(clips, { audio: "two" }), 429);

    const seatBytes = createFeatureRoutes({
      rooms: room.rooms,
      gateway: gatewayHarness().gateway,
      maxSeatVoiceBytes: 6,
      maxRoomVoiceBytes: 100,
    });
    await upload(seatBytes, { audio: "1234" });
    await expectCode("VOICE_SEAT_QUOTA", () => upload(seatBytes, { audio: "5678" }), 429);

    const roomBytes = createFeatureRoutes({
      rooms: room.rooms,
      gateway: gatewayHarness().gateway,
      maxSeatVoiceBytes: 100,
      maxRoomVoiceBytes: 6,
    });
    await upload(roomBytes, { audio: "1234" });
    room.setGame(baseGame({ currentSpeakerSeatId: "seat-2" }));
    await expectCode("VOICE_ROOM_QUOTA", () => upload(roomBytes, { audio: "5678", token: "token-2" }), 429);
  });

  it("validates multipart type, one file, duration, size declaration, and methods", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    await expectCode("UNSUPPORTED_MEDIA_TYPE", () => invoke(extension, "/api/rooms/ROOM1/voice", request("POST", Buffer.from("x"), {
      "content-type": "text/plain", authorization: "Bearer token-1",
    })), 415);
    await expectCode("UNSUPPORTED_MEDIA_TYPE", () => invoke(extension, "/api/rooms/ROOM1/voice", request("POST", Buffer.from("x"), {
      authorization: "Bearer token-1",
    })), 415);
    const noFile = await multipartRequest({ file: false });
    const duplicate = await multipartRequest({ duplicate: true });
    await expectCode("INVALID_REQUEST", () => invoke(extension, "/api/rooms/ROOM1/voice", noFile), 400);
    await expectCode("INVALID_REQUEST", () => invoke(extension, "/api/rooms/ROOM1/voice", duplicate), 400);
    for (const durationMs of [false, "bad", 0, 90_001]) {
      const invalidDuration = await multipartRequest({ durationMs });
      const outsideRange = durationMs === 0 || durationMs === 90_001;
      await expectCode(outsideRange ? "VOICE_DURATION_LIMIT" : "INVALID_REQUEST",
        () => invoke(extension, "/api/rooms/ROOM1/voice", invalidDuration), outsideRange ? 413 : 400);
    }
    await expectCode("PAYLOAD_TOO_LARGE", () => invoke(extension, "/api/rooms/ROOM1/voice", request("POST", Buffer.alloc(0), {
      authorization: "Bearer token-1", "content-type": "multipart/form-data; boundary=x", "content-length": String(17 * 1024 * 1024),
    })), 413);
    await expectCode("INVALID_REQUEST", () => invoke(extension, "/api/rooms/ROOM1/voice", request("POST", Buffer.from("bad"), {
      authorization: "Bearer token-1", "content-type": "multipart/form-data; boundary=x",
    })), 400);
    await expectCode("METHOD_NOT_ALLOWED", () => invoke(extension, "/api/rooms/ROOM1/voice", request("HEAD", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 405);
  });
});

describe("consent, private marks, and factual recap", () => {
  it("keeps only consented clips available after game over and supports speaker removal", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, ...retention });
    const temporary = await upload(extension);
    const retained = await upload(extension, { retain: true, audio: "retained voice" });
    room.setGame(baseGame({
      phase: "GAME_OVER",
      currentSpeakerSeatId: null,
      result: { winner: "GOOD", reason: "ALL_WEREWOLVES_DEAD" },
      revealedRoles: [{ seatId: "seat-1", role: "SEER", team: "GOOD" }],
    }));
    const list = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    assert.deepEqual(list.json().segments.map((item) => item.segmentId), [retained.segmentId]);
    await expectCode("VOICE_SEGMENT_NOT_FOUND", () => invoke(extension, `/api/rooms/ROOM1/voice/${temporary.segmentId}`, request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 404);
    await expectCode("ACTION_NOT_ALLOWED", () => invoke(extension, `/api/rooms/ROOM1/voice/${retained.segmentId}/remove`, jsonRequest({}, "token-2")), 403);
    const removed = await invoke(extension, `/api/rooms/ROOM1/voice/${retained.segmentId}/remove`, jsonRequest({}));
    assert.deepEqual(removed.json(), { segmentId: retained.segmentId, removed: true });
    await expectCode("VOICE_SEGMENT_NOT_FOUND", () => invoke(extension, `/api/rooms/ROOM1/voice/${retained.segmentId}`, request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 404);
  });

  it("keeps bookmarks private, immutable, and tied to real segments", async () => {
    let now = 1_000;
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness(() => now);
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, clock: () => now, ...retention });
    const segment = await upload(extension, { retain: true });
    const route = `/api/rooms/ROOM1/voice/${segment.segmentId}/mark`;
    const first = await invoke(extension, route, jsonRequest({ label: "关键发言" }));
    assert.equal(first.json().label, "关键发言");
    now += 1;
    assert.deepEqual((await invoke(extension, route, jsonRequest({ label: "关键发言" }))).json(), first.json());
    await expectCode("VOICE_MARK_CONFLICT", () => invoke(extension, route, jsonRequest({ label: "改写" })), 409);
    await expectCode("INVALID_REQUEST", () => invoke(extension, route, jsonRequest({ label: "" })), 400);
    await expectCode("INVALID_REQUEST", () => invoke(extension, route, jsonRequest({ label: "x".repeat(201) })), 400);
    await expectCode("VOICE_SEGMENT_NOT_FOUND", () => invoke(extension, "/api/rooms/ROOM1/voice/missing/mark", jsonRequest({ label: "关键" })), 404);

    const own = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    const other = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-2" }));
    assert.equal(own.json().segments[0].mark.label, "关键发言");
    assert.equal("mark" in other.json().segments[0], false);
  });

  it("enforces the per-viewer bookmark count without exposing another viewer's count", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, maxMarksPerPlayer: 1 });
    const first = await upload(extension);
    const second = await upload(extension, { audio: "second" });
    await invoke(extension, `/api/rooms/ROOM1/voice/${first.segmentId}/mark`, jsonRequest({ label: "一" }));
    await expectCode("INVALID_REQUEST", () => invoke(extension, `/api/rooms/ROOM1/voice/${second.segmentId}/mark`, jsonRequest({ label: 4 })), 400);
    await expectCode("VOICE_MARK_LIMIT", () => invoke(extension, `/api/rooms/ROOM1/voice/${second.segmentId}/mark`, jsonRequest({ label: "二" })), 429);
    const other = await invoke(extension, `/api/rooms/ROOM1/voice/${second.segmentId}/mark`, jsonRequest({ label: "其他玩家" }, "token-2"));
    assert.equal(other.json().label, "其他玩家");
  });

  it("builds a deterministic game-over recap whose references all resolve", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, ...retention });
    const segment = await upload(extension, { retain: true });
    await invoke(extension, `/api/rooms/ROOM1/voice/${segment.segmentId}/mark`, jsonRequest({ label: "预言家发言改变票型" }));
    await expectCode("ACTION_NOT_ALLOWED", () => invoke(extension, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 403);

    room.setGame(baseGame({
      phase: "GAME_OVER",
      currentSpeakerSeatId: null,
      result: { winner: "GOOD", reason: "ALL_WEREWOLVES_DEAD" },
      revealedRoles: [{ seatId: "seat-1", role: "SEER", team: "GOOD" }],
      voteHistory: [
        { round: 1, exiledSeatId: "seat-3", ballots: [{ voterSeatId: "seat-1", targetSeatId: "seat-3" }] },
        { round: 2, exiledSeatId: null, ballots: [] },
      ],
      deaths: [{ round: 1, seatId: "seat-3", reasons: ["EXILED"] }],
    }));
    const result = await invoke(extension, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    const recap = result.json();
    assert.equal(recap.gameId, "game-1");
    assert.equal(recap.winner, "GOOD");
    assert.equal(recap.roles[0].role, "SEER");
    assert.equal(recap.segments[0].segmentId, segment.segmentId);
    assert.deepEqual(recap.marks.map((mark) => mark.segmentId), [segment.segmentId]);
    const ids = new Set([
      ...recap.votes.map((item) => `vote:${item.id}`),
      ...recap.deaths.map((item) => `death:${item.id}`),
      ...recap.segments.map((item) => `voice:${item.segmentId}`),
    ]);
    for (const point of recap.turningPoints) {
      for (const reference of point.references) assert.equal(ids.has(`${reference.type}:${reference.id}`), true);
    }
    assert.match(recap.turningPoints[0].text, /放逐 seat-3/);
    assert.match(recap.turningPoints[1].text, /平票/);

    const other = await invoke(extension, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), { authorization: "Bearer token-2" }));
    assert.deepEqual(other.json().marks, []);
    assert.deepEqual((await invoke(extension, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json(), recap);
  });

  it("restores retained media and private marks after restart, then honors deletion tombstones", async () => {
    let now = 2_000;
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness(() => now);
    const first = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, clock: () => now, ...retention });
    const segment = await upload(first, { retain: true, audio: "restart voice" });
    await invoke(first, `/api/rooms/ROOM1/voice/${segment.segmentId}/mark`, jsonRequest({ label: "重启后仍私密" }));

    const restarted = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, clock: () => now, ...retention });
    const own = (await invoke(restarted, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json();
    const other = (await invoke(restarted, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-2",
    }))).json();
    assert.equal(own.segments[0].mark.label, "重启后仍私密");
    assert.equal("mark" in other.segments[0], false);
    const audio = await invoke(restarted, `/api/rooms/ROOM1/voice/${segment.segmentId}`, request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-2",
    }));
    assert.equal(audio.response.body.toString(), "restart voice");

    room.setRoom("ROOM2");
    assert.deepEqual((await invoke(restarted, "/api/rooms/ROOM2/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json().segments, []);
    room.setRoom("ROOM1");

    now += 1;
    await invoke(restarted, `/api/rooms/ROOM1/voice/${segment.segmentId}/remove`, jsonRequest({}));
    assert.equal(retention.files.has(segment.sha256), false);
    const afterDeletion = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, clock: () => now, ...retention });
    assert.deepEqual((await invoke(afterDeletion, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json().segments, []);
  });

  it("keeps a deduplicated media file until every active segment reference is deleted", async () => {
    let now = 3_000;
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const retention = retentionHarness(() => now);
    const options = { rooms: room.rooms, gateway: lingxi.gateway, clock: () => now, ...retention };
    const extension = createFeatureRoutes(options);
    const first = await upload(extension, { retain: true, audio: "same tone" });
    const second = await upload(extension, { retain: true, audio: "same tone" });
    assert.notEqual(first.segmentId, second.segmentId);
    assert.equal(first.sha256, second.sha256);
    assert.equal(retention.files.size, 1);

    await invoke(extension, `/api/rooms/ROOM1/voice/${first.segmentId}/remove`, jsonRequest({}));
    assert.equal(retention.files.has(first.sha256), true);
    const restarted = createFeatureRoutes(options);
    const listed = (await invoke(restarted, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json().segments;
    assert.deepEqual(listed.map((item) => item.segmentId), [second.segmentId]);
    const audio = await invoke(restarted, `/api/rooms/ROOM1/voice/${second.segmentId}`, request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-2",
    }));
    assert.equal(audio.response.body.toString(), "same tone");

    now += 1;
    await invoke(restarted, `/api/rooms/ROOM1/voice/${second.segmentId}/remove`, jsonRequest({}));
    assert.equal(retention.files.has(second.sha256), false);
    assert.deepEqual((await invoke(createFeatureRoutes(options), "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json().segments, []);
  });

  it("integrates real SQLite archives with content-addressed media across restart", async (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-feature-persistence-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const repository = createSqliteRepository({ filename: path.join(folder, "features.sqlite") });
    t.after(() => repository.close());
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const options = { rooms: room.rooms, gateway: lingxi.gateway, repository, mediaDirectory: path.join(folder, "media") };
    const first = createFeatureRoutes(options);
    const segment = await upload(first, { retain: true, audio: "sqlite media" });
    await invoke(first, `/api/rooms/ROOM1/voice/${segment.segmentId}/mark`, jsonRequest({ label: "SQLite 私密标记" }));
    assert.equal(repository.listArchives({ kind: "VOICE_REF" }).length, 1);
    assert.equal(repository.listArchives({ kind: "NOTE" }).length, 1);

    const restarted = createFeatureRoutes(options);
    const audio = await invoke(restarted, `/api/rooms/ROOM1/voice/${segment.segmentId}`, request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-2",
    }));
    assert.equal(audio.response.body.toString(), "sqlite media");
    room.setGame(baseGame({
      phase: "GAME_OVER",
      currentSpeakerSeatId: null,
      result: { winner: "GOOD" },
      revealedRoles: [],
    }));
    await invoke(restarted, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    await invoke(restarted, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    assert.equal(repository.listArchives({ kind: "RECAP" }).length, 1);
    repository.archive({
      schemaVersion: 1,
      recordId: "deleted.crash-recovery",
      roomId: "ROOM1",
      gameId: "game-1",
      kind: "NOTE",
      createdAt: new Date(segment.createdAt + 1).toISOString(),
      data: { type: "VOICE_DELETED", segmentId: segment.segmentId, speakerSeatId: "seat-1", sha256: segment.sha256 },
    });
    assert.equal(fs.existsSync(path.join(folder, "media", `${segment.sha256}.audio`)), true);
    const afterDeletion = createFeatureRoutes(options);
    assert.equal(fs.existsSync(path.join(folder, "media", `${segment.sha256}.audio`)), false);
    assert.deepEqual((await invoke(afterDeletion, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json().segments, []);
  });

  it("omits marks for clips without post-game consent and handles empty public facts", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const segment = await upload(extension);
    await invoke(extension, `/api/rooms/ROOM1/voice/${segment.segmentId}/mark`, jsonRequest({ label: "仅局内" }));
    room.setGame(baseGame({
      phase: "GAME_OVER",
      currentSpeakerSeatId: null,
      deadlineAt: null,
      result: null,
      revealedRoles: undefined,
      voteHistory: undefined,
      deaths: undefined,
    }));
    const recap = (await invoke(extension, "/api/rooms/ROOM1/recap", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    }))).json();
    assert.equal(recap.winner, null);
    assert.deepEqual(recap.roles, []);
    assert.deepEqual(recap.votes, []);
    assert.deepEqual(recap.deaths, []);
    assert.deepEqual(recap.segments, []);
    assert.deepEqual(recap.marks, []);
    assert.deepEqual(recap.turningPoints, []);
  });

  it("expires stale record indexes along with temporary audio", async () => {
    let now = 0;
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const segmentStore = createVoiceSegmentStore({ now: () => now, ttlMs: 10 });
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, segments: segmentStore, clock: () => now });
    await upload(extension);
    now = 10;
    const list = await invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), { authorization: "Bearer token-1" }));
    assert.deepEqual(list.json().segments, []);
  });

  it("rejects feature access without a current game and rejects invalid clocks", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    room.setGame(null);
    await expectCode("VOICE_CONTEXT_EXPIRED", () => invoke(extension, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 409);

    room.setGame(baseGame());
    const badClock = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway, clock: () => -1 });
    await expectCode("FEATURE_INVALID_CONFIG", () => invoke(badClock, "/api/rooms/ROOM1/voice", request("GET", Buffer.alloc(0), {
      authorization: "Bearer token-1",
    })), 500);
  });
});

describe("server-owned narration", () => {
  it("deduplicates concurrent synthesis by phase key and serves audio", async () => {
    const room = roomHarness();
    let release;
    const lingxi = gatewayHarness({ synthesize: () => new Promise((resolve) => { release = resolve; }) });
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const call = (tokenValue) => invoke(extension, "/api/rooms/ROOM1/narration", request("POST", Buffer.from("{}"), {
      authorization: `Bearer ${tokenValue}`, "content-type": "application/json",
    }));
    const first = call("token-1");
    const second = call("token-2");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lingxi.calls.synthesize.length, 1);
    assert.equal(lingxi.calls.synthesize[0].text, "现在请 seat-1 发言。");
    release({ audio: Buffer.from("shared narration"), contentType: "audio/mpeg" });
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.response.body.toString(), "shared narration");
      assert.equal(result.response.headers["Cache-Control"], "private, no-store");
    }
    await call("token-3");
    assert.equal(lingxi.calls.synthesize.length, 1);
    room.setGame(baseGame({ phase: "DAY_VOTE", currentSpeakerSeatId: null }));
    const third = call("token-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lingxi.calls.synthesize.length, 2);
    release({ audio: Buffer.from("vote"), contentType: "audio/mpeg" });
    await third;
  });

  it("returns the same fixed text when narration synthesis is unavailable", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness({ synthesize: async () => { throw new Error("provider secret"); } });
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    await assert.rejects(() => invoke(extension, "/api/rooms/ROOM1/narration", request("POST", Buffer.from("{}"), {
      authorization: "Bearer token-1", "content-type": "application/json",
    })), (error) => {
      assert.equal(error.code, "NARRATION_UNAVAILABLE");
      assert.equal(error.message, "现在请 seat-1 发言。");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.equal(lingxi.calls.synthesize.length, 1);
  });

  it("uses fixed last-word and unknown-phase narration text", async () => {
    const room = roomHarness();
    const lingxi = gatewayHarness();
    const extension = createFeatureRoutes({ rooms: room.rooms, gateway: lingxi.gateway });
    const call = () => invoke(extension, "/api/rooms/ROOM1/narration", request("POST", Buffer.from("{}"), {
      authorization: "Bearer token-1", "content-type": "application/json",
    }));
    room.setGame(baseGame({ phase: "LAST_WORD", currentSpeakerSeatId: "seat-1" }));
    await call();
    assert.equal(lingxi.calls.synthesize.at(-1).text, "现在请 seat-1 发表遗言。");
    room.setGame(baseGame({ phase: "UNKNOWN", currentSpeakerSeatId: null, deadlineAt: null }));
    await call();
    assert.equal(lingxi.calls.synthesize.at(-1).text, "牌局阶段已经更新，请查看文字提示。");
  });
});

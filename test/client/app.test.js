"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createApp, segmentsFrom, statusFromLingxi, unwrapSnapshot } = require("../../src/client/app");
const core = require("../../src/client/core");

function room(game = null, version = "v1") {
  const seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `s${index + 1}`, nickname: `玩家${index + 1}`, ready: true, connected: true }));
  return { roomId: "r1", code: "FOG", status: game ? "ACTIVE" : "LOBBY", hostSeatId: "s1", selfSeatId: "s1", seats, game, version };
}

function game(phase = "DAY_VOTE", actions = ["VOTE_CAST"]) {
  return {
    gameId: "g1", phase, round: 1, deadlineAt: null, hostSeatId: "s1",
    seats: Array.from({ length: 9 }, (_, index) => ({ seatId: `s${index + 1}`, ready: true, alive: true })),
    currentSpeakerSeatId: ["DAY_SPEECH", "LAST_WORD"].includes(phase) ? "s1" : null,
    deaths: [], voteHistory: [], result: phase === "GAME_OVER" ? { winner: "GOOD", reason: "done" } : null,
    self: { seatId: "s1", ready: true, alive: true, role: "VILLAGER", team: "GOOD", abilities: {}, seerResults: [], currentAction: null, availableActions: actions },
  };
}

function fakeSession(initial = null) {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; return next; }, update: (next) => { value = value ? { ...value, ...next } : null; return value; }, clear: () => { value = null; } };
}

function setup(config = {}) {
  const calls = [];
  const renders = [];
  let streamCallbacks;
  let voiceListener;
  const initialRoom = config.room || room();
  const api = {
    initSession: async () => { if (config.sessionError) throw config.sessionError; calls.push("session"); },
    getLingxiStatus: async () => { if (config.statusError) throw config.statusError; return { configured: config.lingxi !== false, implemented: { transcription: true, speech: true, realtime: false }, checked: { transcription: true, speech: true, realtime: false }, healthy: { transcription: true, speech: true, realtime: null } }; },
    createRoom: config.createRoom || (async (nickname, key) => ({ roomId: "r1", seatToken: "token", snapshot: initialRoom, nickname, key })),
    joinRoom: async () => ({ roomId: "r1", seatToken: "token", snapshot: initialRoom }),
    getSnapshot: config.getSnapshot || (async () => config.latestRoom || initialRoom),
    roomCommand: config.roomCommand || (async (roomId, token, command, body, key) => {
      calls.push({ command, body, key });
      if (command === "reconnect") return { snapshot: initialRoom };
      if (command === "leave") return {};
      return { snapshot: config.commandRoom || initialRoom };
    }),
    gameAction: config.gameAction || (async (roomId, token, action) => { calls.push({ action }); return { snapshot: room(game(action.type === "SPEECH_FINISH" ? "DAY_SPEECH" : "DAY_VOTE", []), "v2") }; }),
    streamRoom: (roomId, token, callbacks) => { streamCallbacks = callbacks; return { close: () => calls.push("close") }; },
    listVoice: async () => { if (config.listError) throw config.listError; return config.segments || []; },
    uploadVoice: async (...args) => { calls.push({ upload: args }); return config.uploadSegment === undefined ? ({ segmentId: "clip", transcript: "发言" }) : config.uploadSegment; },
    getVoice: async () => new Blob(["audio"]),
    markVoice: async () => ({}),
    getRecap: async () => { if (config.recapError) throw config.recapError; return { gameId: "g1", winner: "GOOD", roles: [], votes: [], deaths: [], turningPoints: [], segments: [], marks: [] }; },
    narration: async () => { calls.push("narration"); if (config.narrationError) throw config.narrationError; return new Blob(["host"]); },
    createReport: async (roomId, token, targetSeatId, reason) => {
      const report = { reportId: `report-${calls.length}`, reporterSeatId: initialRoom.selfSeatId, targetSeatId, reason, createdAt: 1000 };
      calls.push({ report });
      return report;
    },
    listReports: async () => { calls.push("list-reports"); return config.reportPayload === undefined ? { reports: config.reports || [] } : config.reportPayload; },
  };
  const view = {
    bind(handler) { this.handler = handler; },
    render(model) { renders.push(model); },
    showAlert(message) { calls.push({ alert: message }); },
    showToast(message) { calls.push({ toast: message }); },
  };
  const voice = {
    subscribe(listener) { voiceListener = listener; listener("idle"); return () => {}; },
    start: async () => voiceListener("recording"),
    stop: async () => { voiceListener("idle"); return { blob: new Blob(["audio"]), durationMs: 1200 }; },
    hash: async () => config.hash || "hash",
    play: async () => calls.push("play"),
    cancel: () => calls.push("cancel"),
  };
  const sessionStore = config.sessionStore || fakeSession();
  let id = 0;
  const app = createApp({ api, view, voice, sessionStore, now: () => 1000, randomUUID: () => `id-${++id}`, setInterval: (callback) => { if (config.captureTick) config.captureTick(callback); return 9; }, clearInterval: (value) => calls.push({ cleared: value }), clipboard: config.clipboard === false ? null : { writeText: async (text) => calls.push({ copied: text }) }, createPeer: config.createPeer });
  return { api, app, calls, renders, sessionStore, stream: () => streamCallbacks, voice: () => voiceListener, view };
}

describe("client app", () => {
  it("normalizes public response shapes and honest Lingxi availability", () => {
    assert.deepEqual(segmentsFrom([1]), [1]);
    assert.deepEqual(segmentsFrom({ segments: [2] }), [2]);
    assert.deepEqual(segmentsFrom(null), []);
    assert.deepEqual(unwrapSnapshot({ snapshot: { roomId: "r", version: "v" } }), { roomId: "r", version: "v" });
    assert.equal(unwrapSnapshot({ roomId: "r" }), null);
    assert.equal(statusFromLingxi({ configured: true, implemented: { transcription: true }, checked: { transcription: true }, healthy: { transcription: true } }).available, true);
    assert.equal(statusFromLingxi({ configured: true, implemented: { transcription: true, speech: true }, checked: { transcription: false, speech: false }, healthy: { transcription: null, speech: null } }).label, "灵汐字幕待检");
    assert.equal(statusFromLingxi({ configured: true, implemented: { transcription: true, speech: true }, checked: { transcription: true, speech: true }, healthy: { transcription: true, speech: true } }).narrationAvailable, true);
    assert.equal(statusFromLingxi({ configured: false }).label, "原声可用 · 无字幕");
    assert.equal(statusFromLingxi({ configured: true, implemented: { transcription: true }, checked: { transcription: true }, healthy: { transcription: false } }).label, "灵汐字幕异常");
    assert.equal(statusFromLingxi({ configured: true, implemented: {}, checked: {}, healthy: {} }).available, false);
    assert.equal(statusFromLingxi({ configured: true, implemented: { speech: true }, checked: { speech: true }, healthy: { speech: false } }).narrationAvailable, false);
    assert.equal(statusFromLingxi(null).available, false);
  });

  it("creates a real room, updates from SSE, executes room commands, and leaves", async () => {
    const h = setup();
    await h.app.start();
    assert.equal(h.renders.at(-1).screen, "entry");
    await h.app.handle("create-room", { nickname: "青岚" });
    assert.equal(h.sessionStore.read().seatToken, "token");
    assert.equal(h.renders.at(-1).screen, "lobby");
    await h.app.handle("copy-room");
    assert.deepEqual(h.calls.find((call) => call.copied), { copied: "FOG" });
    await h.app.handle("toggle-ready", { ready: "false" });
    await h.app.handle("start-game");
    await h.app.handle("restart-room");
    assert.deepEqual(h.calls.filter((call) => call.command).map((call) => call.command), ["ready", "start", "restart"]);
    h.stream().onCursor("cursor-1");
    assert.equal(h.sessionStore.read().cursor, "cursor-1");
    h.stream().onSnapshot(room(game(), "stream-v"));
    assert.equal(h.app.getState().snapshot.version, "stream-v");
    h.stream().onError(new Error("offline"));
    assert.match(h.app.getState().error, /重连/);
    await h.app.handle("leave-room");
    assert.equal(h.sessionStore.read(), null);
    assert.equal(h.app.getState().snapshot, null);
    h.app.dispose();
    assert.equal(h.calls.includes("cancel"), true);
  });

  it("submits server-owned game actions, reuses failed action IDs, and resolves visible conflicts", async () => {
    const actions = [];
    let attempt = 0;
    const error = Object.assign(new Error("temporary"), { code: "UPSTREAM" });
    const h = setup({
      room: room(game(), "v1"),
      latestRoom: room(game(), "v2"),
      gameAction: async (roomId, token, action) => {
        actions.push(action);
        if (attempt++ === 0) throw error;
        return { snapshot: room(game(), "v2") };
      },
    });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "青岚" });
    await h.app.handle("select-seat", { seatId: "s2" });
    await h.app.handle("submit-action", { type: "VOTE_CAST" });
    await h.app.handle("submit-action", { type: "VOTE_CAST" });
    assert.equal(actions.length, 2);
    assert.equal(actions[0].actionId, actions[1].actionId);
    assert.deepEqual(actions[1].payload, { targetSeatId: "s2" });
    assert.equal(actions[1].expectedVersion, "v1");
    assert.equal(h.app.getState().snapshot.version, "v2");

    const conflict = Object.assign(new Error("changed"), { code: "VIEW_CONFLICT" });
    h.api.gameAction = async () => { throw conflict; };
    await h.app.handle("submit-action", { type: "VOTE_CAST", null: "true" });
    assert.equal(h.app.getState().snapshot.version, "v2");
  });

  it("records only with permission, uploads real blobs, verifies, plays, and marks voice", async () => {
    const segment = { segmentId: "clip", speakerSeatId: "s1", hash: "hash" };
    const h = setup({ room: room(game("DAY_SPEECH", ["SPEECH_FINISH"]), "v1"), segments: [segment], uploadSegment: segment });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "青岚" });
    await h.app.handle("start-recording");
    assert.equal(h.app.getState().recording, true);
    await h.app.handle("toggle-retain");
    assert.equal(h.app.getState().retainVoice, true);
    await h.app.handle("stop-recording");
    assert.equal(h.app.getState().segments[0].segmentId, "clip");
    assert.equal(h.calls.find((call) => call.upload).upload[3], 1200);
    assert.equal(h.calls.find((call) => call.upload).upload[4], true);
    await h.app.handle("play-voice", { segmentId: "clip" });
    assert.equal(h.calls.includes("play"), true);
    assert.equal(h.app.getState().verifications.clip, "哈希一致");
    await h.app.handle("mark-voice", { segmentId: "clip", label: "关键" });
    assert.equal(h.calls.some((call) => call.toast === "声证标记已保存"), true);
  });

  it("restores a tab-scoped seat and keeps raw recording available without Lingxi subtitles", async () => {
    const sessionStore = fakeSession({ roomId: "r1", seatToken: "t", cursor: "" });
    const h = setup({ sessionStore, room: room(game("DAY_SPEECH", ["SPEECH_FINISH"])), lingxi: false });
    await h.app.start();
    assert.equal(h.app.getState().snapshot.roomId, "r1");
    await h.app.handle("start-recording");
    assert.equal(h.app.getState().recording, true);
    assert.equal(h.app.getState().voiceStatus.label, "原声可用 · 无字幕");
  });

  it("requests narration once per visible phase and keeps text when narration fails", async () => {
    const active = room(game("DAY_SPEECH", ["SPEECH_FINISH"]), "v1");
    const h = setup({ room: active });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "青岚" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((item) => item === "narration").length, 1);
    h.stream().onSnapshot({ ...active, version: "v2" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((item) => item === "narration").length, 1);
    const night = room(game("NIGHT_WOLF", []), "v3");
    h.stream().onSnapshot(night);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((item) => item === "narration").length, 2);

    const failed = setup({ room: active, narrationError: new Error("tts down") });
    await failed.app.start();
    await failed.app.handle("create-room", { nickname: "白鹿" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failed.app.getState().snapshot.version, "v1");
  });

  it("handles unavailable optional endpoints and malformed room responses without invented data", async () => {
    const malformed = setup({ createRoom: async () => ({ roomId: "r1" }), listError: new Error("not implemented"), statusError: new Error("offline") });
    await malformed.app.start();
    await malformed.app.handle("create-room", { nickname: "青岚" });
    assert.match(malformed.app.getState().error, /缺少座位凭证/);
    assert.equal(malformed.app.getState().voiceStatus.label, "灵汐不可用");

    const noSession = setup({ clipboard: false });
    await noSession.app.start();
    await noSession.app.handle("copy-room");
    await noSession.app.handle("toggle-ready", { ready: "true" });
    assert.equal(noSession.calls.some((call) => call.toast === "请手动记录房间码"), true);
    assert.match(noSession.app.getState().error, /没有座位凭证/);
  });

  it("uses snapshot fallbacks, empty uploads, recap failure, timers, and strict hash verification", async () => {
    let tick;
    const active = room(game("DAY_SPEECH", ["SPEECH_FINISH"]), "v1");
    active.game.deadlineAt = "2030-01-01T00:00:00.000Z";
    const h = setup({
      room: active,
      commandRoom: active,
      uploadSegment: null,
      listError: new Error("missing"),
      recapError: new Error("missing"),
      captureTick: (callback) => { tick = callback; },
    });
    await h.app.start();
    await h.app.handle("join-room", { roomId: "r1", nickname: "青岚" });
    tick();
    await h.app.handle("start-recording");
    await h.app.handle("stop-recording");
    assert.equal(h.app.getState().segments.length, 0);

    h.app.getState().segments.push({ segmentId: "none", speakerSeatId: "s1" });
    await h.app.handle("play-voice", { segmentId: "none" });
    assert.equal(h.app.getState().verifications.none, "未验证（无摘要）");
    h.app.getState().segments.push({ segmentId: "bad", speakerSeatId: "s1", sha256: "different" });
    await h.app.handle("play-voice", { segmentId: "bad" });
    assert.equal(h.app.getState().verifications.bad, "哈希不匹配");
    assert.match(h.app.getState().error, /哈希校验失败/);
    await h.app.handle("play-voice", { segmentId: "missing" });
    assert.match(h.app.getState().error, /不存在/);
  });

  it("clears an unrecoverable restored seat and loads finished recap only from the server", async () => {
    const restored = fakeSession({ roomId: "r1", seatToken: "t", cursor: "" });
    const failed = setup({ sessionStore: restored, roomCommand: async () => { throw new Error("expired"); } });
    await failed.app.start();
    assert.equal(restored.read(), null);
    assert.match(failed.app.getState().error, /未能恢复/);

    const finishedGame = game("GAME_OVER", []);
    const finishedRoom = { ...room(finishedGame, "done"), status: "FINISHED" };
    const done = setup({ room: finishedRoom });
    await done.app.start();
    await done.app.handle("create-room", { nickname: "青岚" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done.app.getState().recap.winner, "GOOD");
  });

  it("starts native WebRTC only after explicit consent and keeps clips as fallback", async () => {
    const peerCalls = [];
    let handlers;
    const peer = {
      start: async () => peerCalls.push("start"),
      stop: async () => peerCalls.push("stop"),
      updateRoomSnapshot: async (snapshot) => peerCalls.push(snapshot.version),
    };
    const h = setup({
      room: room(game("DAY_SPEECH", ["SPEECH_FINISH"]), "v1"),
      createPeer(session, callbacks) { peerCalls.push(session.roomId); handlers = callbacks; return peer; },
    });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "青岚" });
    assert.equal(peerCalls.length, 0);
    await h.app.handle("toggle-live-voice");
    assert.deepEqual(peerCalls.slice(0, 3), ["r1", "start", "v1"]);
    handlers.onStateChange({ started: true, connectionCount: 2 });
    assert.equal(h.app.getState().liveVoice.connected, true);
    handlers.onStateChange({ started: false, connectionCount: 0 });
    assert.equal(h.app.getState().liveVoice.connected, false);
    handlers.onError(new Error("nat"));
    assert.equal(h.app.getState().liveVoice.connected, false);
    await h.app.handle("toggle-live-voice");
    assert.equal(peerCalls.includes("stop"), true);

    const lobby = setup({ createPeer: () => peer });
    await lobby.app.start();
    await lobby.app.handle("create-room", { nickname: "白鹿" });
    await lobby.app.handle("toggle-live-voice");
    assert.equal(lobby.calls.some((call) => call.toast === "牌局开始后可开启实时原声"), true);
  });

  it("rejects unauthorized local actions and survives startup, stream, and optional storage failures", async () => {
    let tick;
    const unavailable = setup({ sessionError: new Error("server down"), captureTick: (callback) => { tick = callback; } });
    await unavailable.app.start();
    tick();
    assert.match(unavailable.app.getState().error, /服务暂不可用/);
    await unavailable.app.handle("submit-action", { type: "SPEECH_FINISH" });
    assert.match(unavailable.app.getState().error, /尚未开始/);
    await unavailable.app.handle("stop-recording");
    assert.match(unavailable.app.getState().error, /没有座位凭证/);
    await unavailable.app.handle("play-voice", { segmentId: "none" });
    assert.match(unavailable.app.getState().error, /不存在/);

    const restored = fakeSession({ roomId: "r1", seatToken: "t", cursor: "" });
    const fallback = setup({ sessionStore: restored, roomCommand: async () => ({}), latestRoom: room() });
    await fallback.app.start();
    assert.equal(fallback.app.getState().snapshot.roomId, "r1");
  });

  it("serializes concurrent clicks, refreshes missing response snapshots, and cleans stale selections", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const initial = room(game("DAY_VOTE", ["VOTE_CAST"]), "v1");
    const h = setup({
      room: initial,
      createRoom: async () => pending,
      roomCommand: async () => ({}),
      latestRoom: initial,
      gameAction: async () => ({}),
    });
    await h.app.start();
    const first = h.app.handle("create-room", { nickname: "青岚" });
    await h.app.handle("join-room", { roomId: "r1", nickname: "重复点击" });
    release({ seatToken: "token", snapshot: initial });
    await first;
    assert.equal(h.app.getState().snapshot.roomId, "r1");
    await h.app.handle("start-game");
    await h.app.handle("select-seat", { seatId: "s2" });
    await h.app.handle("submit-action", { type: "VOTE_CAST", null: "true" });
    assert.equal(h.app.getState().snapshot.version, "v1");

    const reduced = { ...initial, version: "v2", seats: initial.seats.filter((seat) => seat.seatId !== "s2") };
    h.stream().onCursor("");
    h.stream().onSnapshot(reduced);
    assert.equal(h.app.getState().selectedSeatId, null);
    h.stream().onSnapshot(null);
    await h.app.handle("join-room", { roomId: "r1", nickname: "新标签" });
    assert.equal(h.calls.filter((item) => item === "close").length > 0, true);
  });

  it("submits witch choices and verifies legacy certificate hashes without trusting missing metadata", async () => {
    const submitted = [];
    const witchGame = game("NIGHT_WITCH", ["WITCH_ACTION_SET"]);
    witchGame.self.role = "WITCH";
    witchGame.self.abilities = { antidote: 1, poison: 1 };
    const h = setup({
      room: room(witchGame, "v1"),
      gameAction: async (roomId, token, action) => { submitted.push(action); return { snapshot: room(witchGame, `v${submitted.length + 1}`) }; },
      segments: [{ id: "legacy", speakerSeatId: "s1", certificate: { sha256: "hash" } }],
    });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "女巫" });
    await h.app.handle("select-seat", { seatId: "s2" });
    await h.app.handle("witch-action", { kind: "POISON" });
    await h.app.handle("witch-action", { kind: "SKIP" });
    assert.deepEqual(submitted.map((item) => item.payload), [{ kind: "POISON", targetSeatId: "s2" }, { kind: "SKIP" }]);
    await h.app.handle("play-voice", { segmentId: "legacy" });
    assert.equal(h.app.getState().verifications.legacy, "哈希一致");
  });

  it("degrades realtime failures and completes cleanup even when peer leave fails", async () => {
    const peer = { start: async () => { throw new Error("permission denied"); }, updateRoomSnapshot: async () => {}, stop: async () => { throw new Error("leave failed"); } };
    const h = setup({ room: room(game("DAY_SPEECH", [])), createPeer: () => peer });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "青岚" });
    await h.app.handle("toggle-live-voice");
    assert.match(h.app.getState().liveVoice.error, /permission denied/);
    await h.app.handle("toggle-live-voice");
    assert.equal(h.app.getState().liveVoice.enabled, false);
    h.app.dispose();
  });

  it("submits a controlled report and exposes report records only to the host drawer", async () => {
    const existing = { reportId: "report-old", reporterSeatId: "s3", targetSeatId: "s2", reason: "旧举报", createdAt: 900 };
    const h = setup({ room: room(game("DAY_SPEECH", [])), reports: [existing] });
    await h.app.start();
    await h.app.handle("create-room", { nickname: "房主" });
    await h.app.handle("select-seat", { seatId: "s2" });
    await h.app.handle("report-reason", { value: "A".repeat(250) });
    assert.equal(h.app.getState().reportReason.length, 200);
    await h.app.handle("submit-report", { reason: "  不当发言，请房主核查  " });
    const submitted = h.calls.find((item) => item.report)?.report;
    assert.equal(submitted.targetSeatId, "s2");
    assert.equal(submitted.reason, "不当发言，请房主核查");
    assert.equal(h.app.getState().reportReason, "不当发言，请房主核查");
    assert.equal(h.calls.some((item) => item.toast === "举报已提交给当前房主核查"), true);

    await h.app.handle("load-reports");
    assert.equal(h.app.getState().reportsOpen, true);
    assert.deepEqual(h.app.getState().reports, [existing]);
    await h.app.handle("select-seat", { seatId: "s3" });
    await h.app.handle("submit-report", { reason: "第二条" });
    assert.equal(h.app.getState().reports.length, 2);
    await h.app.handle("load-reports");
    assert.equal(h.app.getState().reportsOpen, false);

    const nextGame = { ...room(game("NIGHT_WOLF", []), "next"), game: { ...game("NIGHT_WOLF", []), gameId: "g2" } };
    h.stream().onSnapshot(nextGame);
    assert.deepEqual(h.app.getState().reports, []);
    assert.equal(h.app.getState().reportsOpen, false);
  });

  it("rejects report submission without a target and hides host report loading from non-hosts", async () => {
    const noTarget = setup({ room: room(game("DAY_SPEECH", [])) });
    await noTarget.app.start();
    await noTarget.app.handle("create-room", { nickname: "玩家" });
    await noTarget.app.handle("submit-report", { reason: "原因" });
    assert.match(noTarget.app.getState().error, /先选择/);
    await noTarget.app.handle("select-seat", { seatId: "s2" });
    await noTarget.app.handle("submit-report", { reason: " ".repeat(3) });
    assert.match(noTarget.app.getState().error, /1 到 200/);

    const otherRoom = room(game("DAY_SPEECH", []));
    otherRoom.selfSeatId = "s2";
    const nonHost = setup({ room: otherRoom });
    await nonHost.app.start();
    await nonHost.app.handle("create-room", { nickname: "非房主" });
    await nonHost.app.handle("load-reports");
    assert.match(nonHost.app.getState().error, /只有当前房主/);
    assert.equal(nonHost.calls.includes("list-reports"), false);

    const malformed = setup({ room: room(game("DAY_SPEECH", [])), reportPayload: {} });
    await malformed.app.start();
    await malformed.app.handle("create-room", { nickname: "房主" });
    await malformed.app.handle("load-reports");
    assert.deepEqual(malformed.app.getState().reports, []);
  });
});

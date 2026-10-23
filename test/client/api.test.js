"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ApiError, consumeSseStream, createApi, parseSseBlock } = require("../../src/client/api");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    blob: async () => ({ blob: payload }),
    body: null,
  };
}

class FakeFormData {
  constructor() { this.values = []; }
  append(...args) { this.values.push(args); }
}

function harness(responder = () => response({ ok: true })) {
  const calls = [];
  const api = createApi({
    fetch: async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); },
    FormData: FakeFormData,
    AbortController,
    TextDecoder,
    setTimeout: (callback) => { callback(); return 1; },
  });
  return { api, calls };
}

describe("client api", () => {
  it("parses SSE fields, comments, multiline data, and opaque IDs", () => {
    assert.deepEqual(parseSseBlock(": heartbeat\nid: c-1\nevent: snapshot\ndata: {\"a\":\ndata: 1}"), {
      event: "snapshot", id: "c-1", data: "{\"a\":\n1}",
    });
    assert.deepEqual(parseSseBlock("data: ok"), { event: "message", id: "", data: "ok" });
    assert.deepEqual(parseSseBlock("retry\nevent:\nid:\ndata:"), { event: "", id: "", data: "" });
  });

  it("consumes fragmented snapshot streams without exposing authority events", async () => {
    const bytes = new TextEncoder().encode("id: opaque-1\nevent: snapshot\ndata: {\"snapshot\":{\"roomId\":\"r\"},\"cursor\":\"opaque-2\"}\n\n");
    const parts = [bytes.slice(0, 18), bytes.slice(18)];
    const body = { getReader: () => ({ read: async () => parts.length ? { done: false, value: parts.shift() } : { done: true } }) };
    const cursors = [];
    const snapshots = [];
    await consumeSseStream(body, { onCursor: (value) => cursors.push(value), onSnapshot: (value) => snapshots.push(value) }, TextDecoder);
    assert.deepEqual(cursors, ["opaque-1", "opaque-2"]);
    assert.deepEqual(snapshots, [{ roomId: "r" }]);
    await assert.rejects(() => consumeSseStream(null, {}, TextDecoder), /unavailable/);
  });

  it("builds room, action, voice, recap, and status requests", async () => {
    const { api, calls } = harness((url) => url.endsWith("/voice/s1") || url.endsWith("/narration") ? response("audio") : response({ roomId: "r" }));
    await api.initSession();
    await api.createRoom("青岚", "idem-1");
    await api.joinRoom("雾 镇", "白鹿", "idem-2");
    await api.getSnapshot("r", "token");
    await api.roomCommand("r", "token", "ready", { ready: true }, "idem-3");
    await api.roomCommand("r", "token", "start", undefined, "idem-4");
    await api.gameAction("r", "token", { actionId: "a" });
    await api.uploadVoice("r", "token", { size: 3 }, 1200, true);
    await api.listVoice("r", "token");
    await api.getVoice("r", "token", "s1");
    await api.markVoice("r", "token", "s1", "关键");
    await api.getRecap("r", "token");
    await api.getLingxiStatus();
    await api.narration("r", "token");

    assert.equal(calls[0].url, "/api/session");
    assert.equal(calls[1].init.headers["Idempotency-Key"], "idem-1");
    assert.equal(calls[2].url, "/api/rooms/%E9%9B%BE%20%E9%95%87/join");
    assert.equal(calls[3].init.headers.Authorization, "Bearer token");
    assert.equal(calls[6].url, "/api/rooms/r/actions");
    assert.equal(calls[7].init.body.values[0][0], "file");
    assert.deepEqual(calls[7].init.body.values.slice(1), [["durationMs", "1200"], ["retain", "true"]]);
    assert.equal(calls[9].url, "/api/rooms/r/voice/s1");
    assert.equal(calls[11].url, "/api/rooms/r/recap");
    assert.equal(calls[12].url, "/api/lingxi/status");
    assert.equal(calls[13].init.method, "POST");
  });

  it("submits and lists room-scoped reports with bearer authentication", async () => {
    const { api, calls } = harness(() => response({ reports: [] }));
    await api.createReport("room 1", "seat-token", "seat-2", "不当发言，请房主核查");
    await api.listReports("room 1", "seat-token");
    assert.equal(calls[0].url, "/api/rooms/room%201/reports");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer seat-token");
    assert.deepEqual(JSON.parse(calls[0].init.body), { targetSeatId: "seat-2", reason: "不当发言，请房主核查" });
    assert.equal(calls[1].init.method, undefined);
    assert.equal(calls[1].init.headers.Authorization, "Bearer seat-token");
  });

  it("normalizes JSON and non-JSON request errors", async () => {
    const first = harness(() => response({ error: { code: "ROOM_FULL", message: "满员" } }, 409)).api;
    await assert.rejects(() => first.createRoom("x", "i"), (error) => error instanceof ApiError && error.code === "ROOM_FULL" && error.status === 409);
    const second = createApi({
      fetch: async () => ({ ok: false, status: 500, json: async () => { throw new Error("bad json"); } }),
      FormData: FakeFormData, AbortController, TextDecoder,
    });
    await assert.rejects(() => second.getLingxiStatus(), (error) => error instanceof ApiError && error.code === "REQUEST_FAILED");
    const noContent = createApi({ fetch: async () => ({ ok: true, status: 204 }), FormData: FakeFormData, AbortController, TextDecoder });
    assert.equal(await noContent.initSession(), null);

    const plain = harness(() => response({ error: "plain failure" }, 502)).api;
    await assert.rejects(() => plain.getVoice("r", "t", "x"), (error) => error.message === "plain failure");
    await assert.rejects(() => plain.narration("r", "t"), (error) => error.status === 502);
    const empty = harness(() => response({}, 400)).api;
    await assert.rejects(() => empty.getSnapshot("r", "t"), /请求失败/);
  });

  it("opens an authenticated SSE stream and can close it", async () => {
    const bytes = new TextEncoder().encode("event: snapshot\nid: c1\ndata: {\"roomId\":\"r\"}\n\n");
    let reads = 0;
    const body = { getReader: () => ({ read: async () => reads++ ? { done: true } : { done: false, value: bytes } }) };
    const calls = [];
    const api = createApi({
      fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, body }; },
      FormData: FakeFormData, AbortController, TextDecoder,
      setTimeout: () => new Promise(() => {}),
    });
    const snapshots = [];
    const stream = api.streamRoom("r", "t", { cursor: "old", onSnapshot: (value) => snapshots.push(value) });
    await new Promise((resolve) => setImmediate(resolve));
    stream.close();
    assert.equal(calls[0].url, "/api/rooms/r/events?cursor=old");
    assert.equal(calls[0].init.headers.Authorization, "Bearer t");
    assert.deepEqual(snapshots, [{ roomId: "r" }]);
  });

  it("reports SSE connection errors and stops retrying after close", async () => {
    let stream;
    const errors = [];
    const api = createApi({
      fetch: async () => { throw new Error("network"); },
      FormData: FakeFormData, AbortController, TextDecoder,
      setTimeout: (callback) => { callback(); },
    });
    stream = api.streamRoom("r", "t", {
      onError(error) { errors.push(error.message); stream.close(); },
      onCursor() {},
    });
    await stream.done;
    assert.deepEqual(errors, ["network"]);

    const aborted = createApi({
      fetch: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
      FormData: FakeFormData, AbortController, TextDecoder,
    }).streamRoom("r", "t");
    await aborted.done;

    let rejected;
    const deniedApi = createApi({
      fetch: async () => response({ error: { code: "INVALID_SEAT_TOKEN", message: "denied" } }, 401),
      FormData: FakeFormData, AbortController, TextDecoder,
      setTimeout: () => new Promise(() => {}),
    });
    const denied = deniedApi.streamRoom("r", "t", { onError(error) { rejected = error; denied.close(); } });
    await denied.done;
    assert.equal(rejected.code, "INVALID_SEAT_TOKEN");
  });
});

"use strict";
const assert = require("node:assert/strict");
const { it } = require("node:test");
const { Readable } = require("node:stream");
const { createApplication, start, readBody, readJson, httpError } = require("../../src/http/application");

async function fixture(t, options = {}) {
  const calls = [];
  let version = "one";
  let failure;
  const rooms = Object.fromEntries(["createRoom", "joinRoom", "setReady", "startGame", "dispatchAction", "reconnect", "disconnect", "leaveRoom", "restartGame"].map((method) => [method, (args) => {
    calls.push({ method, args });
    if (failure) throw failure;
    return { roomId: "ABCDE", seatToken: "token", snapshot: { version } };
  }]));
  rooms.getSnapshot = (args) => {
    calls.push({ method: "getSnapshot", args });
    if (failure) throw failure;
    return { version, game: null };
  };
  rooms.tick = () => {};
  const app = createApplication({ rooms, pollInterval: 100000, ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionResponse = await fetch(`${base}/api/session`, { method: "POST" });
  const cookie = sessionResponse.headers.get("set-cookie").split(";")[0];
  async function request(url, body, headers = {}, method = "POST") {
    return fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie,
      Authorization: "Bearer token", "Idempotency-Key": "id-1", ...headers }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  }
  return { app, rooms, base, calls, request, cookie, setVersion: (next) => { version = next; }, fail: (error) => { failure = error; } };
}

it("serves only public assets with CSP and never source secrets", async (t) => {
  const f = await fixture(t);
  for (const route of ["/", "/index.html", "/styles.css", "/app.js", "/product.html", "/product.css"]) {
    const response = await fetch(f.base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length);
  }
  const head = await fetch(f.base + "/", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal((await fetch(f.base + "/src/game/engine.js")).status, 404);
  assert.equal((await fetch(f.base + "/src/client/missing.js")).status, 404);
  assert.equal((await fetch(f.base + "/api/health")).status, 200);
  assert.equal((await fetch(f.base + "/api/rooms/ABCDE/ready")).status, 404);
  assert.equal((await fetch(f.base + "/api/health")).status, 200);
});

it("routes authenticated room intents and same-origin anonymous creation", async (t) => {
  const f = await fixture(t, { secureCookies: true });
  for (const [route, body, method] of [
    ["/api/rooms", { nickname: "玩家" }, "createRoom"],
    ["/api/rooms/ABCDE/join", { nickname: "第二位" }, "joinRoom"],
    ["/api/rooms/ABCDE/ready", { ready: true }, "setReady"],
    ["/api/rooms/ABCDE/start", {}, "startGame"],
    ["/api/rooms/ABCDE/actions", { type: "VOTE_CAST" }, "dispatchAction"],
    ["/api/rooms/ABCDE/reconnect", {}, "reconnect"],
    ["/api/rooms/ABCDE/leave", {}, "leaveRoom"],
    ["/api/rooms/ABCDE/restart", {}, "restartGame"],
  ]) {
    assert.equal((await f.request(route, body)).status, route === "/api/rooms" ? 201 : 200);
    assert.ok(f.calls.some((call) => call.method === method));
  }
  assert.equal((await f.request("/api/rooms/ABCDE/snapshot", null, {}, "GET")).status, 200);
  const own = f.calls.find((call) => call.method === "setReady");
  assert.equal(own.args.seatToken, "token");
  assert.equal(own.args.ready, true);
  assert.equal((await f.request("/api/rooms/ABCDE", {})).status, 404);
});

it("rejects missing sessions, forged tokens, Origin and malformed bodies", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["/api/rooms", {}, { Cookie: "" }, 401],
    ["/api/rooms", {}, { Cookie: "wuyin_session=missing" }, 401],
    ["/api/rooms/ABCDE/start", {}, { Authorization: "invalid" }, 401],
    ["/api/rooms", {}, { Origin: "https://other.example" }, 403],
    ["/api/rooms", {}, { "Sec-Fetch-Site": "cross-site" }, 403],
    ["/api/rooms", {}, { "Content-Type": "text/plain" }, 415],
    ["/api/rooms", [], {}, 400],
    ["/api/rooms", null, {}, 400],
  ];
  for (const [route, body, headers, status] of cases) assert.equal((await f.request(route, body, headers)).status, status);
  assert.equal((await fetch(f.base + "/api/rooms", { method: "POST", body: "{", headers: { Cookie: f.cookie, "Content-Type": "application/json" } })).status, 400);
  assert.equal((await fetch(f.base + "/api/rooms", { method: "DELETE" })).status, 405);
});

it("normalizes domain errors without leaking global authority sequence", async (t) => {
  const f = await fixture(t);
  for (const [code, status] of [["ROOM_FULL", 409], ["ROOM_NOT_FOUND", 404], ["SEQUENCE_CONFLICT", 409]]) {
    f.fail(Object.assign(new Error("domain"), { code, latestSeq: 123 }));
    const response = await f.request("/api/rooms/ABCDE/start", {});
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(JSON.stringify(result).includes("123"), false);
    assert.equal(result.error.code, code === "SEQUENCE_CONFLICT" ? "VIEW_CONFLICT" : code);
  }
  f.fail(Object.assign(new Error("private details"), { code: "VIEW_CONFLICT", latestVersion: "new" }));
  assert.equal((await (await f.request("/api/rooms/ABCDE/start", {})).json()).error.latestVersion, "new");
  f.fail(new Error("secret"));
  const failure = await f.request("/api/rooms/ABCDE/start", {});
  assert.equal(failure.status, 500);
  assert.equal((await failure.text()).includes("secret"), false);
});

it("sends per-viewer SSE snapshots and supports opaque cursor recovery", async (t) => {
  let now = 0;
  const f = await fixture(t, { clock: () => now });
  const response = await fetch(f.base + "/api/rooms/ABCDE/events", { headers: { Authorization: "Bearer token" } });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: snapshot/);
  const cursor = /id: ([^\n]+)/.exec(initial)[1];
  f.app.poll();
  now = 16000;
  f.app.poll();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": heartbeat\n\n");
  f.setVersion("two");
  f.app.poll();
  assert.match(new TextDecoder().decode((await reader.read()).value), /two/);
  const retry = await fetch(f.base + `/api/rooms/ABCDE/events?cursor=${cursor}`, { headers: { Authorization: "Bearer token" } });
  const retryReader = retry.body.getReader();
  const retryData = new TextDecoder().decode((await retryReader.read()).value);
  assert.match(retryData, /two/);
  const latestCursor = /id: ([^\n]+)/.exec(retryData)[1];
  await retryReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const unchanged = await fetch(f.base + `/api/rooms/ABCDE/events?cursor=${latestCursor}`, { headers: { Authorization: "Bearer token" } });
  const unchangedReader = unchanged.body.getReader();
  assert.equal(new TextDecoder().decode((await unchangedReader.read()).value), ": connected\n\n");
  await unchangedReader.cancel();
  f.fail(Object.assign(new Error("gone"), { code: "ROOM_NOT_FOUND" }));
  f.app.poll();
  await reader.cancel();
});

it("limits authenticated SSE fan-out instead of allocating unbounded streams", async (t) => {
  const f = await fixture(t, { maxStreams: 2 });
  const url = f.base + "/api/rooms/ABCDE/events";
  const headers = { Authorization: "Bearer token" };
  const first = await fetch(url, { headers });
  const second = await fetch(url, { headers });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await fetch(url, { headers })).status, 429);
  await first.body.cancel();
  await second.body.cancel();
});

it("expires sessions and launches with explicit local configuration", async (t) => {
  let now = 0;
  const f = await fixture(t, { clock: () => now });
  now = 25 * 60 * 60 * 1000;
  assert.equal((await f.request("/api/rooms", { nickname: "过期" })).status, 401);
  f.app.poll();
  assert.equal((await f.request("/api/rooms", { nickname: "已清理" })).status, 401);
  const app = start({ rooms: f.rooms, port: 0, host: "127.0.0.1", pollInterval: 100000 });
  await new Promise((resolve) => app.server.once("listening", resolve));
  assert.ok(app.server.address().port);
  await app.stop();
});

it("runs explicitly installed extension routes and returns their errors safely", async (t) => {
  const f = await fixture(t, { extension: async ({ url, json, response }) => {
    if (url.pathname !== "/api/extension") return false;
    json(response, 200, { custom: true });
    if (url.searchParams.has("fail")) throw new Error("already sent");
    return true;
  } });
  assert.deepEqual(await (await fetch(f.base + "/api/extension")).json(), { custom: true });
  assert.equal((await fetch(f.base + "/api/extension?fail=1")).status, 200);
});

it("bounds visitor sessions and recovers expired SSE cursors", async (t) => {
  const f = await fixture(t, { maxSessions: 1 });
  assert.equal((await fetch(f.base + "/api/session", { method: "POST" })).status, 429);
  const url = f.base + "/api/rooms/ABCDE/events";
  const response = await fetch(url, { headers: { Authorization: "Bearer token" } });
  const reader = response.body.getReader();
  const original = new TextDecoder().decode((await reader.read()).value);
  const cursor = /id: ([^\n]+)/.exec(original)[1];
  for (let i = 0; i < 66; i += 1) { f.setVersion(`version-${i}`); f.app.poll(); }
  const retry = await fetch(`${url}?cursor=${cursor}`, { headers: { Authorization: "Bearer token" } });
  const retryReader = retry.body.getReader();
  assert.match(new TextDecoder().decode((await retryReader.read()).value), /version-65/);
  await retryReader.cancel();
  await reader.cancel();
});

it("starts the public launcher with a real room service and environment configuration", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "wuyin-launcher-"));
  const previousPort = process.env.PORT;
  const previousHost = process.env.HOST;
  const previousData = process.env.DATA_FILE;
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  process.env.DATA_FILE = path.join(directory, "state.sqlite");
  const launcher = require("../../server");
  const app = launcher.start();
  await new Promise((resolve) => app.server.once("listening", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const initialized = await fetch(base + "/api/session", { method: "POST" });
  const response = await fetch(base + "/api/rooms", { method: "POST", headers: {
    Cookie: initialized.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json", "Idempotency-Key": "real-create",
  }, body: JSON.stringify({ nickname: "真实房主" }) });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(typeof result.seatToken, "string");
  assert.equal(JSON.stringify(result.snapshot).includes(result.seatToken), false);
  await app.stop();
  if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
  if (previousHost === undefined) delete process.env.HOST; else process.env.HOST = previousHost;
  if (previousData === undefined) delete process.env.DATA_FILE; else process.env.DATA_FILE = previousData;
  fs.rmSync(directory, { recursive: true });
});

it("closes slow SSE consumers and reports unexpected disconnect errors", async (t) => {
  const faults = [];
  const f = await fixture(t, { onError: (fault) => faults.push(fault) });
  const response = await fetch(f.base + "/api/rooms/ABCDE/events", { headers: { Authorization: "Bearer token" } });
  const reader = response.body.getReader();
  await reader.read();
  f.setVersion("x".repeat(300000));
  f.app.poll();
  f.setVersion("y".repeat(300000));
  f.app.poll();
  f.fail(Object.assign(new Error("unexpected"), { code: "BROKEN" }));
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(faults.every((fault) => fault.code === "DISCONNECT_FAILED"));
});

it("limits both declared and streamed bodies and accepts only JSON objects", async () => {
  function input(chunks, headers = {}) {
    const request = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
    request.headers = headers;
    return request;
  }
  await assert.rejects(readBody(input(["123"], { "content-length": "3" }), 2), { code: "PAYLOAD_TOO_LARGE" });
  await assert.rejects(readBody(input(["12", "34"]), 3), { code: "PAYLOAD_TOO_LARGE" });
  assert.equal((await readBody(input(["12", "3"]), 4)).toString(), "123");
  await assert.rejects(readJson(input(["null"], { "content-type": "application/json" })), { code: "INVALID_REQUEST" });
  await assert.rejects(readJson(input(["{}"])), { code: "UNSUPPORTED_MEDIA_TYPE" });
  assert.deepEqual(await readJson(input(["{}"], { "content-type": "application/json;charset=utf8" })), {});
  assert.equal(httpError("X", 418, "message").statusCode, 418);
});

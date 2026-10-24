"use strict";
const assert = require("node:assert/strict");
const { it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntime, start } = require("../../src/runtime");

it("restarts the real runtime and restores an authenticated room from SQLite", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-runtime-"));
  const filename = path.join(directory, "state.sqlite");
  const runtime = createRuntime({ filename, clock: () => 10000 });
  const created = runtime.rooms.createRoom({ sessionId: "test-session", nickname: "恢复测试", idempotencyKey: "create" });
  runtime.rooms.setReady({ roomId: created.roomId, seatToken: created.seatToken, ready: true, idempotencyKey: "ready" });
  runtime.close();
  const app = start({ filename, port: 0, host: "127.0.0.1", clock: () => 20000 });
  await new Promise((resolve) => app.server.once("listening", resolve));
  t.after(() => app.stop());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/rooms/${created.roomId}/snapshot`, {
    headers: { Authorization: `Bearer ${created.seatToken}` },
  });
  const snapshot = await response.json();
  assert.equal(snapshot.selfSeatId, "seat-1");
  assert.equal(snapshot.seats[0].ready, true);
  assert.equal(snapshot.seats[0].connected, false);
  const status = await fetch(`http://127.0.0.1:${app.server.address().port}/api/lingxi/status`);
  assert.equal((await status.json()).configured, false);
  await app.stop();
  await app.stop();
  fs.rmSync(directory, { recursive: true });
});

it("closes the repository when runtime configuration is invalid", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-invalid-"));
  let closed = false;
  const repository = { load: () => null, close: () => { closed = true; } };
  assert.throws(() => createRuntime({ filename: path.join(directory, "state.sqlite"), repository, gateway: {} }));
  assert.equal(closed, true);
  fs.rmSync(directory, { recursive: true });
});

it("uses environment defaults and authenticates voice and realtime media routes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wuyin-default-"));
  const priorFile = process.env.DATA_FILE;
  const priorIce = process.env.ICE_SERVERS;
  process.env.DATA_FILE = path.join(directory, "state.sqlite");
  process.env.ICE_SERVERS = "[]";
  const runtime = createRuntime();
  let reply;
  const unrelated = await runtime.extension({ url: new URL("http://localhost/unknown"), request: { method: "GET" } });
  assert.equal(unrelated, false);
  const handled = await runtime.extension({ url: new URL("http://localhost/api/lingxi/status"), request: { method: "GET" },
    response: {}, json: (_, status, value) => { reply = { status, value }; } });
  assert.equal(handled, true);
  assert.equal(reply.status, 200);
  await assert.rejects(runtime.extension({ url: new URL("http://localhost/api/rooms/ROOM1/voice"), request: { method: "POST" },
    token: () => { throw Object.assign(new Error("no token"), { code: "INVALID_SEAT_TOKEN" }); } }), { code: "INVALID_SEAT_TOKEN" });
  await assert.rejects(runtime.extension({ url: new URL("http://localhost/api/media/join"), request: { method: "POST" },
    token: () => { throw Object.assign(new Error("no token"), { code: "INVALID_SEAT_TOKEN" }); } }), { code: "INVALID_SEAT_TOKEN" });
  runtime.close();
  if (priorFile === undefined) delete process.env.DATA_FILE; else process.env.DATA_FILE = priorFile;
  if (priorIce === undefined) delete process.env.ICE_SERVERS; else process.env.ICE_SERVERS = priorIce;
  fs.rmSync(directory, { recursive: true });
});

it("supports injected rooms for isolated tests and an explicitly configured public Origin", async (t) => {
  const { createRoomService } = require("../../src/room");
  const priorOrigin = process.env.PUBLIC_ORIGIN;
  const priorCookie = process.env.COOKIE_SECURE;
  process.env.PUBLIC_ORIGIN = "https://game.example";
  process.env.COOKIE_SECURE = "true";
  const { EventEmitter } = require("node:events");
  const processImpl = new EventEmitter();
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const app = start({ rooms: createRoomService(), port: 0, host: "127.0.0.1", processImpl,
    extension: () => { throw new Error("must-not-log-this-sensitive-text"); } });
  await new Promise((resolve) => app.server.once("listening", resolve));
  t.after(() => app.stop());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/session`, { method: "POST", headers: { Origin: "https://game.example" } });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /Secure/);
  const failure = await fetch(`http://127.0.0.1:${app.server.address().port}/api/unknown`);
  assert.equal(failure.status, 500);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes("sensitive-text"), false);
  processImpl.emit("SIGTERM");
  await app.stop();
  assert.equal(processImpl.listenerCount("SIGINT"), 0);
  if (priorOrigin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = priorOrigin;
  if (priorCookie === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = priorCookie;
});

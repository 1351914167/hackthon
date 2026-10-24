"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");

const { readJson } = require("../../src/http/application");
const { MediaRouteError, createMediaRoutes } = require("../../src/media/routes");

function brokerFixture(overrides = {}) {
  const calls = [];
  const broker = {};
  for (const operation of ["join", "leave", "peers", "drain"]) {
    broker[operation] = (input) => {
      calls.push({ operation, input });
      return overrides[operation] ? overrides[operation](input) : { operation, ok: true };
    };
  }
  broker.publishSignal = (input) => {
    calls.push({ operation: "signal", input });
    return overrides.signal ? overrides.signal(input) : { accepted: true, signalId: "opaque-1" };
  };
  return { broker, calls };
}

function request(method, body = {}, token = "seat-token") {
  const bytes = Buffer.from(JSON.stringify(body));
  const stream = Readable.from([bytes]);
  stream.method = method;
  stream.headers = {
    authorization: token ? `Bearer ${token}` : "",
    "content-type": "application/json",
    "content-length": String(bytes.length),
  };
  return stream;
}

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}

function token(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!match) throw Object.assign(new Error("token required"), { code: "INVALID_SEAT_TOKEN", statusCode: 401 });
  return match[1];
}

function json(res, status, value) {
  res.writeHead(status);
  res.end(JSON.stringify(value));
}

async function invoke(routes, path, req) {
  const res = response();
  const handled = await routes({
    request: req,
    response: res,
    url: new URL(path, "http://localhost"),
    token,
    json,
    readJson,
  });
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

describe("media HTTP routes", () => {
  it("returns false for unrelated paths and rejects all non-POST methods", async () => {
    const { broker } = brokerFixture();
    const routes = createMediaRoutes({ broker });
    assert.equal((await invoke(routes, "/api/other", request("GET"))).handled, false);
    for (const operation of ["join", "leave", "peers", "signal", "drain"]) {
      await assert.rejects(invoke(routes, `/api/media/${operation}`, request("GET")), (error) => {
        assert.equal(error instanceof MediaRouteError, true);
        assert.equal(error.code, "METHOD_NOT_ALLOWED");
        assert.equal(error.statusCode, 405);
        return true;
      });
    }
    assert.equal((await invoke(routes, "/api/media/config", request("GET"))).handled, false);
  });

  it("extracts the server-side token and dispatches every broker operation", async () => {
    const { broker, calls } = brokerFixture();
    const routes = createMediaRoutes({ broker });
    for (const operation of ["join", "leave", "peers", "drain"]) {
      const result = await invoke(routes, `/api/media/${operation}`, request("POST", { roomId: "room-1", seatToken: "forged" }, `token-${operation}`));
      assert.equal(result.handled, true);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { operation, ok: true });
      assert.deepEqual(calls.at(-1), { operation, input: { roomId: "room-1", seatToken: `token-${operation}` } });
    }

    const signal = { type: "offer", sdp: "v=0" };
    const sent = await invoke(routes, "/api/media/signal", request("POST", {
      roomId: "room-1",
      seatToken: "forged",
      recipientSeatId: "seat-2",
      signal,
    }, "real-token"));
    assert.deepEqual(sent.body, { accepted: true, signalId: "opaque-1" });
    assert.deepEqual(calls.at(-1), {
      operation: "signal",
      input: { roomId: "room-1", seatToken: "real-token", recipientSeatId: "seat-2", signal },
    });
  });

  it("awaits asynchronous brokers", async () => {
    const { broker } = brokerFixture({ join: async () => ({ joined: true }) });
    const result = await invoke(createMediaRoutes({ broker }), "/api/media/join", request("POST", { roomId: "room-1" }));
    assert.deepEqual(result.body, { joined: true });
  });

  it("normalizes known broker errors without replacing their identity", async () => {
    const known = Object.assign(new Error("join first"), { code: "MEDIA_NOT_JOINED" });
    const { broker } = brokerFixture({ drain: () => { throw known; } });
    await assert.rejects(invoke(createMediaRoutes({ broker }), "/api/media/drain", request("POST", { roomId: "room-1" })), (error) => {
      assert.equal(error, known);
      assert.equal(error.statusCode, 409);
      return true;
    });

    const explicit = Object.assign(new Error("explicit"), { code: "INVALID_SIGNAL", statusCode: 422 });
    broker.publishSignal = () => { throw explicit; };
    await assert.rejects(invoke(createMediaRoutes({ broker }), "/api/media/signal", request("POST", { roomId: "room-1" })), (error) => {
      assert.equal(error.statusCode, 422);
      return true;
    });

    const unknown = Object.assign(new Error("unknown"), { code: "UNKNOWN" });
    broker.peers = () => { throw unknown; };
    await assert.rejects(invoke(createMediaRoutes({ broker }), "/api/media/peers", request("POST", { roomId: "room-1" })), (error) => {
      assert.equal(error.statusCode, undefined);
      return true;
    });
  });

  it("authenticates before parsing JSON and preserves parser errors", async () => {
    const { broker, calls } = brokerFixture();
    const routes = createMediaRoutes({ broker });
    await assert.rejects(invoke(routes, "/api/media/join", request("POST", { roomId: "room-1" }, null)), { code: "INVALID_SEAT_TOKEN" });
    assert.equal(calls.length, 0);

    const malformed = Readable.from([Buffer.from("not-json")]);
    malformed.method = "POST";
    malformed.headers = { authorization: "Bearer valid", "content-type": "application/json" };
    await assert.rejects(invoke(routes, "/api/media/join", malformed), { code: "INVALID_REQUEST" });
    assert.equal(calls.length, 0);
  });

  it("validates broker configuration", () => {
    for (const options of [undefined, null, [], {}, { broker: {} }, { broker: { join() {}, leave() {}, peers() {}, drain() {} } }]) {
      assert.throws(() => createMediaRoutes(options), (error) => error instanceof MediaRouteError && error.code === "MEDIA_INVALID_CONFIG" && error.statusCode === 500);
    }
  });
});

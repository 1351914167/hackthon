"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");

const { MAX_REPORTS_PER_SEAT, ReportError, createReportRoutes } = require("../../src/features/reports");
const { readJson } = require("../../src/http/application");

function harness() {
  let gameId = "game-1";
  let sequence = 0;
  const archives = [];
  const repository = {
    archive(record) {
      archives.push(structuredClone(record));
      return record;
    },
    listArchives({ kind } = {}) {
      return archives.filter((item) => !kind || item.kind === kind).map((item) => structuredClone(item));
    },
  };
  const rooms = {
    getSnapshot({ roomId, seatToken }) {
      if (!["ROOM1", "ROOM2"].includes(roomId)) throw Object.assign(new Error("missing"), { code: "ROOM_NOT_FOUND" });
      const selfSeatId = { host: "seat-1", guest: "seat-2", third: "seat-3" }[seatToken];
      if (!selfSeatId) throw Object.assign(new Error("token"), { code: "INVALID_SEAT_TOKEN" });
      return {
        roomId,
        hostSeatId: "seat-1",
        selfSeatId,
        seats: ["seat-1", "seat-2", "seat-3"].map((seatId) => ({ seatId })),
        game: gameId ? { gameId } : null,
      };
    },
  };
  return {
    archives,
    repository,
    rooms,
    id: () => `report-${String(++sequence).padStart(8, "0")}`,
    setGame(value) { gameId = value; },
  };
}

function request(method, value, seatToken = "guest") {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const result = Readable.from(body.length ? [body] : []);
  result.method = method;
  result.headers = {
    authorization: `Bearer ${seatToken}`,
    ...(value === undefined ? {} : { "content-type": "application/json", "content-length": String(body.length) }),
  };
  return result;
}

function response() {
  return {
    status: null,
    value: null,
    writeHead(status) { this.status = status; },
    end(body) { this.value = JSON.parse(Buffer.from(body).toString("utf8")); },
  };
}

function token(req) {
  return req.headers.authorization.slice(7);
}

function json(res, status, value) {
  res.writeHead(status);
  res.end(JSON.stringify(value));
}

async function invoke(extension, roomId, req) {
  const res = response();
  const handled = await extension({
    request: req,
    response: res,
    url: new URL(`/api/rooms/${roomId}/reports`, "http://localhost"),
    token,
    json,
    readJson,
  });
  return { handled, response: res };
}

async function expectCode(code, operation, statusCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

describe("local room reports", () => {
  it("archives reports without credentials and exposes them only to the current host", async () => {
    const h = harness();
    const extension = createReportRoutes({ rooms: h.rooms, repository: h.repository, randomUUID: h.id, clock: () => 1_000 });
    const created = await invoke(extension, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "持续辱骂其他玩家" }));
    assert.equal(created.response.status, 201);
    assert.equal(created.response.value.reporterSeatId, "seat-2");
    assert.equal(created.response.value.targetSeatId, "seat-3");
    assert.match(created.response.value.reportId, /^report-/);
    assert.equal(JSON.stringify(h.archives).toLowerCase().includes("token"), false);
    assert.equal(h.archives[0].kind, "NOTE");
    assert.equal(h.archives[0].data.type, "REPORT");

    await expectCode("ACTION_NOT_ALLOWED", () => invoke(extension, "ROOM1", request("GET", undefined, "guest")), 403);
    const host = await invoke(extension, "ROOM1", request("GET", undefined, "host"));
    assert.equal(host.response.value.reports.length, 1);
    assert.equal(host.response.value.reports[0].reason, "持续辱骂其他玩家");
  });

  it("validates targets, reasons, game state, and methods", async () => {
    const h = harness();
    const extension = createReportRoutes({ rooms: h.rooms, randomUUID: h.id });
    for (const input of [
      { targetSeatId: "missing", reason: "原因" },
      { targetSeatId: "seat-3", reason: "" },
      { targetSeatId: "seat-3", reason: 4 },
      { targetSeatId: "seat-3", reason: "x".repeat(201) },
    ]) await expectCode("INVALID_REQUEST", () => invoke(extension, "ROOM1", request("POST", input)), 400);
    await expectCode("METHOD_NOT_ALLOWED", () => invoke(extension, "ROOM1", request("HEAD")), 405);
    h.setGame(null);
    await expectCode("ACTION_NOT_ALLOWED", () => invoke(extension, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "原因" })), 403);
    const unrelated = await extension({ url: new URL("http://localhost/api/other") });
    assert.equal(unrelated, false);
  });

  it("limits each reporter to ten reports per game and resets for another game", async () => {
    const h = harness();
    const extension = createReportRoutes({ rooms: h.rooms, repository: h.repository, randomUUID: h.id });
    assert.equal(MAX_REPORTS_PER_SEAT, 10);
    for (let index = 0; index < 10; index += 1) {
      await invoke(extension, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: `原因 ${index}` }));
    }
    await expectCode("REPORT_LIMIT", () => invoke(extension, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "超限" })), 429);
    h.setGame("game-2");
    assert.equal((await invoke(extension, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "新一局" }))).response.status, 201);
  });

  it("restores persisted reports while preserving room and game isolation", async () => {
    const h = harness();
    const first = createReportRoutes({ rooms: h.rooms, repository: h.repository, randomUUID: h.id, clock: () => 2_000 });
    await invoke(first, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "恢复测试" }));
    const restarted = createReportRoutes({ rooms: h.rooms, repository: h.repository, randomUUID: h.id });
    assert.equal((await invoke(restarted, "ROOM1", request("GET", undefined, "host"))).response.value.reports.length, 1);
    assert.equal((await invoke(restarted, "ROOM2", request("GET", undefined, "host"))).response.value.reports.length, 0);
    h.setGame("game-2");
    assert.equal((await invoke(restarted, "ROOM1", request("GET", undefined, "host"))).response.value.reports.length, 0);
  });

  it("rejects invalid dependencies, clocks, and generated IDs", async () => {
    const h = harness();
    for (const options of [{}, { rooms: {} }, { rooms: h.rooms, clock: 4 }, { rooms: h.rooms, randomUUID: 4 }, { rooms: h.rooms, repository: {} }]) {
      assert.throws(() => createReportRoutes(options), ReportError);
    }
    const badClock = createReportRoutes({ rooms: h.rooms, clock: () => -1, randomUUID: h.id });
    await expectCode("REPORT_INVALID_CONFIG", () => invoke(badClock, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "原因" })), 500);
    const badId = createReportRoutes({ rooms: h.rooms, randomUUID: () => "bad" });
    await expectCode("REPORT_ID_INVALID", () => invoke(badId, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "原因" })), 500);
    const collision = createReportRoutes({ rooms: h.rooms, randomUUID: () => "report-collision" });
    await invoke(collision, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "首次" }));
    await expectCode("REPORT_ID_INVALID", () => invoke(collision, "ROOM1", request("POST", { targetSeatId: "seat-3", reason: "重复" })), 500);
  });
});

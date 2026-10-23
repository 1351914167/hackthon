"use strict";
const assert = require("node:assert/strict");
const { it } = require("node:test");
const { createApplication } = require("../../server");
const { createRoomService } = require("../../src/room");

it("runs nine authenticated HTTP clients through a complete game without leaking roles", async (t) => {
  let now = Date.parse("2026-10-23T12:00:00Z");
  const rooms = createRoomService({ clock: () => now });
  const app = createApplication({ rooms, clock: () => now, pollInterval: 100000 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const clients = [];
  let roomId;
  async function post(route, body, client, key = crypto.randomUUID()) {
    const response = await fetch(base + route, { method: "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": key, Cookie: client.cookie,
      ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function snapshot(client) {
    const response = await fetch(`${base}/api/rooms/${roomId}/snapshot`, { headers: { Authorization: `Bearer ${client.token}` } });
    assert.equal(response.status, 200);
    return response.json();
  }
  for (let i = 0; i < 10; i += 1) {
    const session = await fetch(base + "/api/session", { method: "POST" });
    const client = { cookie: session.headers.get("set-cookie").split(";")[0] };
    const result = await post(i === 0 ? "/api/rooms" : `/api/rooms/${roomId}/join`, { nickname: `玩家${i + 1}` }, client);
    if (i === 9) { assert.equal(result.status, 409); break; }
    assert.equal(result.status, i === 0 ? 201 : 200);
    roomId = result.body.roomId;
    client.token = result.body.seatToken;
    clients.push(client);
  }
  assert.equal((await post(`/api/rooms/${roomId}/start`, {}, clients[1])).status, 403);
  for (const client of clients) assert.equal((await post(`/api/rooms/${roomId}/ready`, { ready: true }, client)).status, 200);
  assert.equal((await post(`/api/rooms/${roomId}/start`, {}, clients[0])).status, 200);
  const personalViews = await Promise.all(clients.map(snapshot));
  const wolves = personalViews.filter((view) => view.game.self.role === "WEREWOLF").map((view) => view.selfSeatId);
  const voter = personalViews.findIndex((view) => view.game.self.role !== "WEREWOLF");
  for (const view of personalViews) {
    assert.equal("seq" in view.game, false);
    assert.equal("roles" in view.game, false);
    assert.equal("night" in view.game, false);
    assert.equal("seatToken" in view, false);
  }
  for (const targetSeatId of wolves) {
    let view = await snapshot(clients[voter]);
    while (view.game.phase !== "DAY_VOTE") {
      now = Date.parse(view.game.deadlineAt);
      app.poll();
      view = await snapshot(clients[voter]);
    }
    const action = { schemaVersion: 1, actionId: crypto.randomUUID(), gameId: view.game.gameId,
      expectedVersion: view.version, type: "VOTE_CAST", payload: { targetSeatId } };
    const first = await post(`/api/rooms/${roomId}/actions`, action, clients[voter]);
    assert.equal(first.status, 200);
    assert.equal((await post(`/api/rooms/${roomId}/actions`, action, clients[voter])).status, 200);
    view = await snapshot(clients[voter]);
    now = Date.parse(view.game.deadlineAt);
    app.poll();
    view = await snapshot(clients[voter]);
    assert.equal(view.game.phase, "LAST_WORD");
    now = Date.parse(view.game.deadlineAt);
    app.poll();
  }
  const finished = await snapshot(clients[0]);
  assert.equal(finished.game.phase, "GAME_OVER");
  assert.equal(finished.game.result.winner, "GOOD");
  assert.equal(finished.game.revealedRoles.length, 9);
  assert.equal((await post(`/api/rooms/${roomId}/restart`, {}, clients[0])).status, 200);
  assert.equal((await snapshot(clients[0])).game, null);
});

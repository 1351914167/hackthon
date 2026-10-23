"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const core = require("../../src/client/core");

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), values };
}

function snapshot(phase = null, role = "VILLAGER") {
  const seats = Array.from({ length: 3 }, (_, index) => ({ seatId: `s${index + 1}`, nickname: `玩家${index + 1}`, ready: index !== 2, connected: index !== 1 }));
  return {
    roomId: "r1", code: "FOG123", status: phase === "GAME_OVER" ? "FINISHED" : phase ? "ACTIVE" : "LOBBY",
    hostSeatId: "s1", selfSeatId: "s1", version: "v1", seats,
    game: phase ? {
      gameId: "g1", phase, round: 1, deadlineAt: "2026-10-23T10:01:00.000Z",
      seats: seats.map((seat, index) => ({ seatId: seat.seatId, alive: index !== 2, ready: true })),
      currentSpeakerSeatId: ["DAY_SPEECH", "LAST_WORD"].includes(phase) ? "s1" : null,
      deaths: [], voteHistory: [], result: phase === "GAME_OVER" ? { winner: "GOOD", reason: "ALL_WEREWOLVES_DEAD" } : null,
      self: { seatId: "s1", alive: true, role, abilities: {}, seerResults: [], currentAction: null, availableActions: [] },
    } : null,
  };
}

describe("client core", () => {
  it("stores only tab-scoped room session data and tolerates corrupt storage", () => {
    const backing = storage();
    const store = core.createSessionStore(backing);
    assert.equal(store.read(), null);
    assert.equal(store.update({ cursor: "x" }), null);
    assert.deepEqual(store.write({ roomId: "minimal", seatToken: "token" }), { roomId: "minimal", seatToken: "token", nickname: "", cursor: "" });
    assert.deepEqual(store.write({ roomId: "r", seatToken: "t", nickname: "雾", cursor: "c", secret: "drop" }), { roomId: "r", seatToken: "t", nickname: "雾", cursor: "c" });
    assert.deepEqual(store.update({ cursor: "d" }), { roomId: "r", seatToken: "t", nickname: "雾", cursor: "d" });
    assert.equal(backing.values.get(core.STORAGE_KEY).includes("secret"), false);
    store.clear();
    assert.equal(store.read(), null);
    backing.setItem(core.STORAGE_KEY, "{");
    assert.equal(store.read(), null);
    backing.setItem(core.STORAGE_KEY, JSON.stringify({ roomId: 1, seatToken: "t" }));
    assert.equal(store.read(), null);
  });

  it("formats deadlines and action identifiers", () => {
    assert.equal(core.remainingSeconds("2026-10-23T10:01:00.000Z", Date.parse("2026-10-23T10:00:01.000Z")), 59);
    assert.equal(core.remainingSeconds("2020-01-01T00:00:00Z", Date.now()), 0);
    assert.equal(core.remainingSeconds("bad", 0), null);
    assert.equal(core.formatTimer(61), "01:01");
    assert.equal(core.formatTimer(null), "--:--");
    assert.equal(core.makeId(() => "uuid", Date.now), "uuid");
    assert.match(core.makeId(null, () => 123), /^action-123-/);
  });

  it("builds entry and lobby view models from real room state", () => {
    assert.equal(core.createViewModel({ booting: true }, 0).screen, "loading");
    const entry = core.createViewModel({ booting: false, busy: false, error: "", roomHint: "ABC", voiceStatus: { available: false } }, 0);
    assert.equal(entry.screen, "entry");
    assert.equal(entry.roomHint, "ABC");

    const room = snapshot();
    const lobby = core.createViewModel({ booting: false, snapshot: room, voiceStatus: {} }, 0);
    assert.equal(lobby.screen, "lobby");
    assert.equal(lobby.isHost, true);
    assert.equal(lobby.seats[0].status, "自己 · 房主 · 已准备");
    assert.equal(lobby.seats[1].status, "离线");
    assert.equal(lobby.seats[2].status, "未准备");
  });

  it("derives every phase prompt and server-owned target state", () => {
    const cases = [
      ["ROLE_REVEAL", "VILLAGER", "可见的身份"], ["NIGHT_WOLF", "WEREWOLF", "袭击目标"],
      ["NIGHT_WOLF", "VILLAGER", "等待狼人"], ["NIGHT_WITCH", "WITCH", "救人"],
      ["NIGHT_WITCH", "VILLAGER", "女巫"], ["NIGHT_SEER", "SEER", "查验"],
      ["NIGHT_SEER", "VILLAGER", "预言家"], ["DAWN_RESOLUTION", "VILLAGER", "结算"],
      ["DAY_SPEECH", "VILLAGER", "轮到你"], ["DAY_VOTE", "VILLAGER", "弃票"],
      ["LAST_WORD", "VILLAGER", "遗言"], ["HUNTER_SHOT", "HUNTER", "开枪"],
      ["GAME_OVER", "VILLAGER", "回听"], ["UNKNOWN", "VILLAGER", "等待服务端"],
    ];
    for (const [phase, role, phrase] of cases) {
      const room = snapshot(phase, role);
      if (phase === "HUNTER_SHOT") room.game.self.availableActions = role === "HUNTER" ? ["HUNTER_SHOT_SET"] : [];
      const state = { booting: false, snapshot: room, selectedSeatId: "s2", voiceStatus: { available: true }, segments: [], verifications: {} };
      const model = core.createViewModel(state, Date.parse("2026-10-23T10:00:30.000Z"));
      assert.equal(model.screen, "game");
      assert.match(model.instruction, new RegExp(phrase));
      assert.equal(model.selectedSeat.seatId, "s2");
      assert.equal(model.timer, "00:30");
      if (["DAY_SPEECH", "LAST_WORD"].includes(phase)) assert.equal(model.canRecord, true);
    }
  });

  it("keeps raw recording independent from Lingxi subtitles and ignores dead targets", () => {
    const room = snapshot("DAY_SPEECH");
    const model = core.createViewModel({ booting: false, snapshot: room, selectedSeatId: "s3", voiceStatus: { available: false } }, 0);
    assert.equal(model.canRecord, true);
    assert.equal(model.selectedSeat, null);
    assert.deepEqual(model.targets.map((seat) => seat.seatId), ["s2"]);

    for (const phase of ["DAY_SPEECH", "LAST_WORD"]) {
      const waiting = snapshot(phase);
      waiting.game.currentSpeakerSeatId = "s2";
      assert.match(core.createViewModel({ booting: false, snapshot: waiting, voiceStatus: null }, 0).instruction, /聆听|正在发表/);
    }
    const hunter = snapshot("HUNTER_SHOT", "HUNTER");
    assert.match(core.createViewModel({ booting: false, snapshot: hunter, voiceStatus: {} }, 0).instruction, /正在决定/);

    const anonymous = snapshot("ROLE_REVEAL");
    anonymous.seats = undefined;
    anonymous.game.seats = undefined;
    anonymous.game.self = null;
    const fallback = core.createViewModel({ booting: false, snapshot: anonymous, voiceStatus: null, segments: {}, verifications: null }, 0);
    assert.equal(fallback.seats.length, 0);
    assert.equal(fallback.roleLabel, "等待发牌");
    assert.deepEqual(fallback.segments, []);
  });
});

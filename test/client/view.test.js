"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createView, escapeHtml, renderEntry, renderGame, renderLobby } = require("../../src/client/view");

class Classes {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, enabled) { if (enabled) this.add(value); else this.remove(value); }
  contains(value) { return this.values.has(value); }
}

class Element {
  constructor() { this.innerHTML = ""; this.textContent = ""; this.listeners = {}; this.classList = new Classes(); this.dataset = {}; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelector(selector) { return selector === "span:last-child" ? this.lastSpan : null; }
}

function baseModel() {
  const seats = [
    { seatId: "s1", nickname: "<青岚>", number: 1, ready: true, connected: true, alive: true, isSelf: true, isHost: true, isSpeaker: true, status: "自己 · 房主" },
    { seatId: "s2", nickname: "白鹿", number: 2, ready: true, connected: true, alive: true, status: "存活" },
    { seatId: "s3", nickname: "临川", number: 3, ready: true, connected: false, alive: false, status: "出局" },
  ];
  return {
    screen: "game", roomCode: "FOG", seats, selectedSeat: seats[1], busy: false, error: "", isHost: true,
    voiceStatus: { available: true, label: "灵汐在线" }, recording: false, voiceBusy: false, canRecord: true,
    roleLabel: "女巫", roleDescription: "用药", instruction: "轮到你", timer: "00:22", seconds: 22,
    self: { role: "WITCH", abilities: { antidote: 1, poison: 1 }, seerResults: [], currentAction: null, availableActions: ["WITCH_ACTION_SET"], wolfAttackTarget: "s2" },
    game: { phase: "NIGHT_WITCH", round: 1, currentSpeakerSeatId: "s1", deaths: [{ seatId: "s3", reasons: ["EXILED"], round: 1 }], voteHistory: [], wolfTeammates: [] },
    segments: [{ segmentId: "clip-1234567890", speakerSeatId: "s2", transcript: "真实发言", size: 12 }], verifications: {}, selectedLabel: "关键发言", recap: null,
  };
}

describe("client view", () => {
  it("escapes untrusted names and renders actual entry/lobby states", () => {
    assert.equal(escapeHtml("<a 'x'>&\""), "&lt;a &#39;x&#39;&gt;&amp;&quot;");
    const entry = renderEntry({ roomHint: "<ROOM>", busy: false, error: "失败 <x>" });
    assert.match(entry, /&lt;ROOM&gt;/);
    assert.match(entry, /失败 &lt;x&gt;/);
    const lobbyModel = { ...baseModel(), screen: "lobby", snapshot: { hostSeatId: "s1" }, selfSeat: baseModel().seats[0], filledSeats: 3 };
    const lobby = renderLobby(lobbyModel);
    assert.match(lobby, /&lt;青岚&gt;/);
    assert.match(lobby, /等待加入/);
    assert.match(lobby, /取消准备/);
    assert.match(lobby, /等待 6 人准备/);
  });

  it("renders role-specific actions, voice evidence, and finished recap", () => {
    const witch = renderGame(baseModel());
    assert.match(witch, /使用解药/);
    assert.match(witch, /使用毒药/);
    assert.match(witch, /真实发言/);
    assert.doesNotMatch(witch, /<青岚>/);

    for (const [type, text] of [["WOLF_TARGET_SET", "确认狼刀"], ["SEER_TARGET_SET", "确认查验"], ["VOTE_CAST", "确认投票"], ["HUNTER_SHOT_SET", "确认开枪"]]) {
      const model = baseModel();
      model.self.role = type === "HUNTER_SHOT_SET" ? "HUNTER" : "VILLAGER";
      model.self.availableActions = [type];
      model.self.currentAction = { submitted: true, targetSeatId: "s2" };
      assert.match(renderGame(model), new RegExp(text));
    }
    for (const [type, text] of [["SPEECH_FINISH", "结束发言"], ["LAST_WORD_FINISH", "结束遗言"]]) {
      const model = baseModel();
      model.self.availableActions = [type];
      assert.match(renderGame(model), new RegExp(text));
    }
    const idle = baseModel();
    idle.self.availableActions = [];
    assert.match(renderGame(idle), /等待其他玩家/);

    const over = baseModel();
    over.game.phase = "GAME_OVER";
    over.game.result = { winner: "GOOD", reason: "ALL_WEREWOLVES_DEAD" };
    over.game.revealedRoles = [{ seatId: "s1", role: "WITCH" }];
    assert.match(renderGame(over), /好人阵营获胜/);
    assert.match(renderGame(over), /再来一局/);
  });

  it("renders empty, busy, offline, alternate role, and verification branches", () => {
    assert.match(renderEntry({ roomHint: "", busy: true, error: "" }), /disabled/);
    const lobby = baseModel();
    lobby.screen = "lobby";
    lobby.snapshot = { hostSeatId: "missing" };
    lobby.selfSeat = { nickname: "", ready: false };
    lobby.filledSeats = 9;
    lobby.seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `x${index}`, nickname: index ? `人${index}` : "", number: index + 1, ready: true, connected: index !== 1, alive: true, status: "已准备", isSelf: false }));
    lobby.isHost = false;
    lobby.busy = true;
    lobby.error = "房间变化";
    const lobbyHtml = renderLobby(lobby);
    assert.match(lobbyHtml, /准备/);
    assert.match(lobbyHtml, /未知席位/);
    assert.match(lobbyHtml, /房间变化/);
    assert.doesNotMatch(lobbyHtml, /开始牌局/);

    const model = baseModel();
    model.selectedSeat = null;
    model.busy = true;
    model.error = "动作失败";
    model.game.phase = "NIGHT_WOLF";
    model.game.currentSpeakerSeatId = "missing";
    model.game.voteHistory = [
      { round: 1, exiledSeatId: null, ballots: [] },
      { round: 2, exiledSeatId: "s2", ballots: [{ voterSeatId: "s1", targetSeatId: "s2" }] },
    ];
    model.self.role = "SEER";
    model.self.availableActions = ["SEER_TARGET_SET"];
    model.self.currentAction = { submitted: false, targetSeatId: null };
    model.self.seerResults = [{ round: 1, targetSeatId: "s2", team: "WEREWOLF" }, { round: 2, targetSeatId: "s3", team: "GOOD" }];
    model.game.wolfTeammates = [{ seatId: "s2" }];
    model.recording = true;
    model.retainVoice = true;
    model.canRecord = false;
    model.seconds = null;
    model.segments = [
      { id: "alt-id", seatId: "s2", phase: "DAY_SPEECH", size: 0 },
      { segmentId: "verified", speakerSeatId: "missing", phaseKey: "LAST_WORD", size: 2048 },
    ];
    model.verifications = { verified: "哈希一致" };
    const html = renderGame(model);
    assert.match(html, /先从席位中选择目标/);
    assert.match(html, /狼人/);
    assert.match(html, /哈希一致/);
    assert.match(html, /平票/);
    assert.match(html, /动作失败/);
    assert.match(html, /stop-recording/);
    assert.match(html, /赛后保留 开/);

    model.recording = false;
    model.voiceBusy = true;
    assert.match(renderGame(model), /上传与灵汐转写中/);
    model.voiceBusy = false;
    model.canRecord = false;
    model.voiceStatus = null;
    model.segments = [];
    model.game.deaths = [];
    model.game.voteHistory = [];
    model.self.seerResults = [];
    model.game.wolfTeammates = [];
    assert.match(renderGame(model), /暂无可回听/);
    assert.match(renderGame(model), /等待首个公开事件/);

    const recap = baseModel();
    recap.isHost = false;
    recap.busy = true;
    recap.game.phase = "GAME_OVER";
    recap.game.result = null;
    recap.game.revealedRoles = null;
    recap.recap = { winner: "WEREWOLF", roles: [{ seatId: "s2", role: "CUSTOM" }] };
    const recapHtml = renderGame(recap);
    assert.match(recapHtml, /狼人阵营获胜/);
    assert.match(recapHtml, /CUSTOM/);
    assert.doesNotMatch(recapHtml, /再来一局/);

    const readyLobby = baseModel();
    readyLobby.snapshot = { hostSeatId: "s1" };
    readyLobby.selfSeat = readyLobby.seats[0];
    readyLobby.seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `z${index}`, nickname: `玩家${index}`, number: index + 1, ready: index !== 8, connected: true, alive: true, status: "等待", isSelf: index === 0 }));
    readyLobby.filledSeats = 9;
    readyLobby.isHost = true;
    assert.match(renderLobby(readyLobby), /等待 1 人准备/);
    readyLobby.seats[8].ready = true;
    assert.match(renderLobby(readyLobby), /开始牌局/);

    const fallbacks = baseModel();
    fallbacks.self.wolfAttackTarget = null;
    assert.match(renderGame(fallbacks), /今夜无人被袭击/);
    delete fallbacks.self.availableActions;
    delete fallbacks.self.seerResults;
    delete fallbacks.game.wolfTeammates;
    delete fallbacks.game.deaths;
    delete fallbacks.game.voteHistory;
    fallbacks.segments = [{}];
    fallbacks.game.phase = "DAY_VOTE";
    fallbacks.seconds = 10;
    fallbacks.selectedSeat = null;
    assert.match(renderGame(fallbacks), /今夜无人被袭击|等待其他玩家/);
    assert.match(renderGame(fallbacks), /is-low/);

    const abstained = baseModel();
    abstained.self.availableActions = ["VOTE_CAST"];
    abstained.self.currentAction = { submitted: true, targetSeatId: null };
    assert.match(renderGame(abstained), /主动跳过/);

    const emptyRecap = baseModel();
    emptyRecap.game.phase = "GAME_OVER";
    emptyRecap.game.result = null;
    emptyRecap.game.revealedRoles = null;
    emptyRecap.recap = null;
    assert.match(renderGame(emptyRecap), /牌局已经完成/);
  });

  it("binds delegated forms, controls, rules, alerts, and status updates on a fake document", () => {
    const root = new Element();
    const roomMeta = new Element();
    const status = new Element();
    status.lastSpan = new Element();
    const toast = new Element();
    const alert = new Element();
    const rules = new Element();
    rules.showModal = () => { rules.open = true; };
    rules.close = () => { rules.open = false; };
    const ruleButton = new Element();
    const closeButton = new Element();
    const document = { querySelector: (selector) => ({ "#rulesButton": ruleButton, "#closeRules": closeButton })[selector] || null };
    const scheduled = [];
    const view = createView({ document, root, roomMeta, voiceStatus: status, toast, alertRegion: alert, rulesDialog: rules, setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; }, clearTimeout() {} });
    const actions = [];
    view.bind((name, payload) => actions.push({ name, payload }));

    const control = { dataset: { command: "select-seat", seatId: "s2" } };
    root.listeners.click({ target: { closest: () => control } });
    const fields = { nickname: { value: " 青岚 " }, roomId: { value: " FOG " } };
    root.listeners.submit({ preventDefault() {}, target: { dataset: { form: "join-room" }, elements: { namedItem: (name) => fields[name] } } });
    root.listeners.submit({ preventDefault() {}, target: { dataset: { form: "create-room" }, elements: fields } });
    root.listeners.submit({ preventDefault() { throw new Error("should not prevent"); }, target: { dataset: {}, elements: {} } });
    root.listeners.click({ target: { closest: () => null } });
    assert.deepEqual(actions, [
      { name: "select-seat", payload: control.dataset },
      { name: "join-room", payload: { roomId: "FOG", nickname: "青岚" } },
      { name: "create-room", payload: { nickname: "青岚" } },
    ]);

    ruleButton.listeners.click();
    assert.equal(rules.open, true);
    closeButton.listeners.click();
    assert.equal(rules.open, false);
    rules.listeners.click({ target: rules });
    assert.equal(rules.open, false);

    view.render({ screen: "entry", busy: false, error: "", roomHint: "", voiceStatus: { available: true, label: "灵汐在线" } });
    assert.match(root.innerHTML, /创建新房/);
    assert.equal(status.classList.contains("is-live"), true);
    assert.equal(status.lastSpan.textContent, "灵汐在线");
    view.showToast("完成");
    assert.equal(toast.textContent, "完成");
    assert.equal(toast.classList.contains("is-visible"), true);
    view.showAlert("错误");
    scheduled.at(-1)();
    assert.equal(alert.textContent, "错误");
    view.render({ screen: "loading", voiceStatus: null });
    assert.match(root.innerHTML, /正在连接/);
    view.render({ ...baseModel(), screen: "game", roomCode: "FOG", voiceStatus: { available: false } });
    assert.match(roomMeta.innerHTML, /FOG/);
    view.render({ ...baseModel(), screen: "lobby", snapshot: { hostSeatId: "s1" }, selfSeat: baseModel().seats[0], filledSeats: 3, roomCode: "" });
    assert.match(root.innerHTML, /等待区/);

    const defaults = createView({ document, root, roomMeta, voiceStatus: status, toast, alertRegion: alert, rulesDialog: rules });
    defaults.bind(() => {});
    root.listeners.submit({ preventDefault() {}, target: { dataset: { form: "create-room" }, elements: {} } });
  });
});

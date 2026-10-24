"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const vm = require("node:vm");
const { bootstrap, requireElement } = require("../../app");

describe("browser bootstrap", () => {
  it("fails clearly when the application mount is absent", () => {
    assert.throws(() => requireElement({ querySelector: () => null }, "#app"), /#app/);
  });

  it("injects prebuilt boundaries and starts the thin application shell", async () => {
    const mount = {};
    const document = { querySelector: (selector) => selector === "#app" ? mount : null };
    const rendered = [];
    const api = {
      initSession: async () => ({}), getLingxiStatus: async () => ({ configured: false }),
    };
    const view = { bind(handler) { this.handler = handler; }, render(model) { rendered.push(model); }, showAlert() {}, showToast() {} };
    const voice = { subscribe(listener) { listener("idle"); }, cancel() {} };
    const sessionStore = { read: () => null };
    const window = {
      document, location: { search: "?room=FOG" }, URLSearchParams,
      setInterval: () => 1, clearInterval() {}, crypto: { randomUUID: () => "uuid" }, navigator: {},
    };
    const app = await bootstrap({ window, document, api, view, voice, sessionStore });
    assert.equal(app.getState().roomHint, "FOG");
    assert.equal(rendered.at(-1).screen, "entry");
    app.dispose();
  });

  it("constructs browser adapters from native dependencies", async () => {
    class Element {
      constructor() { this.innerHTML = ""; this.textContent = ""; this.listeners = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      querySelector(selector) { return selector === "span:last-child" ? this.label : null; }
    }
    const elements = Object.fromEntries(["#app", "#roomMeta", "#voiceStatus", "#toast", "#alertRegion", "#rulesDialog", "#rulesButton", "#closeRules"].map((key) => [key, new Element()]));
    elements["#voiceStatus"].label = new Element();
    elements["#rulesDialog"].showModal = () => {};
    elements["#rulesDialog"].close = () => {};
    const document = { querySelector: (selector) => elements[selector] || null };
    const values = new Map();
    const window = {
      document,
      location: { search: "" },
      URLSearchParams,
      sessionStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
      fetch: async (url) => ({ ok: true, status: 200, json: async () => url === "/api/lingxi/status" ? { configured: false, implemented: {}, checked: {}, healthy: {} } : {} }),
      FormData, AbortController, TextDecoder, Blob,
      setTimeout, clearTimeout,
      setInterval: () => 8,
      clearInterval() {},
      MediaRecorder: null,
      Audio: class {},
      URL: { createObjectURL() {}, revokeObjectURL() {} },
      crypto: { randomUUID: () => "uuid" },
      navigator: { mediaDevices: null, clipboard: null },
    };
    const app = await bootstrap({ window });
    assert.match(elements["#app"].innerHTML, /创建新房/);
    app.dispose();
  });

  it("loads every UMD module through its browser path and boots a real room view", async () => {
    class Element {
      constructor() {
        this.innerHTML = ""; this.textContent = ""; this.listeners = {};
        const classes = new Set();
        this.classList = { toggle() {}, add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) };
      }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      querySelector(selector) { return selector === "span:last-child" ? this.label : null; }
      closest() { return null; }
    }
    const selectors = ["#app", "#roomMeta", "#voiceStatus", "#toast", "#alertRegion", "#rulesDialog", "#rulesButton", "#closeRules", "#remoteVoice"];
    const elements = Object.fromEntries(selectors.map((selector) => [selector, new Element()]));
    elements["#voiceStatus"].label = new Element();
    elements["#rulesDialog"].showModal = () => {};
    elements["#rulesDialog"].close = () => {};
    elements["#remoteVoice"].play = async () => { elements["#remoteVoice"].played = true; };
    let domReady;
    const document = {
      readyState: "loading",
      querySelector: (selector) => elements[selector] || null,
      addEventListener(name, callback) { if (name === "DOMContentLoaded") domReady = callback; },
    };
    const seats = Array.from({ length: 9 }, (_, index) => ({ seatId: `s${index + 1}`, nickname: `玩家${index + 1}`, ready: true, connected: true }));
    const game = { gameId: "g1", phase: "DAY_SPEECH", round: 1, deadlineAt: null, seats: seats.map((seat) => ({ seatId: seat.seatId, ready: true, alive: true })), currentSpeakerSeatId: "s1", deaths: [], voteHistory: [], result: null, self: { seatId: "s1", ready: true, alive: true, role: "VILLAGER", team: "GOOD", abilities: {}, seerResults: [], currentAction: null, availableActions: ["SPEECH_FINISH"] } };
    const snapshot = { roomId: "r1", code: "FOG", status: "ACTIVE", hostSeatId: "s1", selfSeatId: "s1", seats, game, version: "v1" };
    const emptyBody = { getReader: () => ({ read: async () => ({ done: true }) }) };
    const peerCalls = [];
    let peerOptions;
    const stored = new Map();
    const context = {
      document,
      location: { search: "" },
      URLSearchParams,
      sessionStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
      fetch: async (url, init = {}) => {
        if (url === "/api/lingxi/status") return { ok: true, status: 200, json: async () => ({ configured: false, implemented: {}, checked: {}, healthy: {} }) };
        if (url === "/api/rooms" && init.method === "POST") return { ok: true, status: 200, json: async () => ({ roomId: "r1", seatToken: "token", snapshot }) };
        if (url === "/api/rooms/r/voice") return { ok: true, status: 200, json: async () => ({ segments: [] }) };
        if (url.startsWith("/api/rooms/r/events")) return { ok: true, status: 200, body: emptyBody };
        return { ok: true, status: 200, json: async () => ({}) };
      },
      FormData, AbortController, TextDecoder, Blob,
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
      MediaRecorder: null,
      Audio: class {},
      URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
      crypto: { randomUUID: () => "uuid" },
      navigator: { mediaDevices: { getUserMedia: async () => ({}) }, clipboard: null },
      RTCPeerConnection: class {},
      WerewolfPeerClient: {
        createPeerClient(options) {
          peerOptions = options;
          return { start: async () => peerCalls.push("start"), stop: async () => peerCalls.push("stop"), updateRoomSnapshot: async () => peerCalls.push("update") };
        },
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const relative of ["src/client/core.js", "src/client/api.js", "src/client/voice.js", "src/client/view.js", "src/client/app.js", "app.js"]) {
      const filename = path.resolve(__dirname, "../..", relative);
      vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    }
    assert.equal(typeof context.WuyinBootstrap.bootstrap, "function");
    await domReady();
    const app = await context.WuyinBootstrap.bootstrap();
    await app.handle("create-room", { nickname: "青岚" });
    await app.handle("toggle-live-voice");
    assert.deepEqual(peerCalls.slice(0, 2), ["start", "update"]);
    peerOptions.onTrack({ streams: [{ id: "remote" }] });
    assert.equal(elements["#remoteVoice"].played, true);
    peerOptions.onTrack({ streams: [] });
    elements["#remoteVoice"].play = async () => { throw new Error("autoplay blocked"); };
    peerOptions.onTrack({ streams: [{ id: "blocked" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements["#remoteVoice"].controls, true);
    assert.equal(elements["#remoteVoice"].classList.contains("needs-playback"), true);
    elements["#remoteVoice"].play = async () => {};
    peerOptions.onTrack({ streams: [{ id: "resumed" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements["#remoteVoice"].controls, false);
    assert.equal(elements["#remoteVoice"].classList.contains("needs-playback"), false);
    app.dispose();

    const failedAlert = new Element();
    const failedContext = {
      document: { readyState: "complete", querySelector: (selector) => selector === "#alertRegion" ? failedAlert : null },
      WuyinCore: context.WuyinCore,
      WuyinApi: context.WuyinApi,
      WuyinVoice: context.WuyinVoice,
      WuyinView: context.WuyinView,
      WuyinApp: context.WuyinApp,
    };
    failedContext.window = failedContext;
    vm.createContext(failedContext);
    const rootBootstrap = path.resolve(__dirname, "../../app.js");
    vm.runInContext(fs.readFileSync(rootBootstrap, "utf8"), failedContext, { filename: rootBootstrap });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(failedAlert.textContent, /应用启动失败/);
  });
});

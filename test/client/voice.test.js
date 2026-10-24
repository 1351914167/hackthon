"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { describe, it } = require("node:test");
const { createVoiceController, toHex } = require("../../src/client/voice");

class Recorder {
  static isTypeSupported(value) { return value.includes("opus"); }
  constructor(stream, config) { this.stream = stream; this.config = config; this.mimeType = config?.mimeType || "audio/webm"; this.state = "inactive"; this.listeners = {}; Recorder.last = this; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.listeners.dataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
    this.listeners.stop?.();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function mediaStream(name) {
  const track = { name, stopped: false, stop() { this.stopped = true; } };
  return { stream: { name, getTracks: () => [track] }, track };
}

function controllerFor(mediaDevices, MediaRecorderCtor) {
  return createVoiceController({
    mediaDevices,
    MediaRecorder: MediaRecorderCtor,
    Blob,
    Audio: class {},
    URL: {},
    crypto: webcrypto,
    now: () => 100,
  });
}

function setup(overrides = {}) {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const urls = [];
  class Audio {
    constructor(url) { this.url = url; this.listeners = {}; Audio.last = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    async play() { if (overrides.playError) throw new Error("blocked"); }
  }
  let currentTime = 100;
  const controller = createVoiceController({
    mediaDevices: overrides.mediaDevices || { getUserMedia: async () => stream },
    MediaRecorder: overrides.MediaRecorder === undefined ? Recorder : overrides.MediaRecorder,
    Blob,
    Audio,
    URL: { createObjectURL: () => "blob:voice", revokeObjectURL: (url) => urls.push(url) },
    crypto: webcrypto,
    now: () => currentTime += 25,
  });
  return { controller, track, urls, Audio };
}

describe("voice controller", () => {
  it("records only after explicit start and releases microphone tracks", async () => {
    const { controller, track } = setup();
    const states = [];
    const unsubscribe = controller.subscribe((state) => states.push(state));
    assert.equal(controller.getStatus(), "idle");
    await controller.start();
    assert.equal(controller.getStatus(), "recording");
    const recording = await controller.stop();
    assert.equal(await recording.blob.text(), "voice");
    assert.equal(recording.durationMs, 25);
    assert.equal(track.stopped, true);
    assert.deepEqual(states, ["idle", "requesting", "recording", "processing", "idle"]);
    unsubscribe();
    await assert.rejects(() => controller.stop(), /没有/);
  });

  it("rejects unsupported, denied, and concurrent recording attempts", async () => {
    const unsupported = setup({ MediaRecorder: null }).controller;
    await assert.rejects(() => unsupported.start(), /不支持/);
    const denied = setup({ mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } } }).controller;
    await assert.rejects(() => denied.start(), /denied/);
    assert.equal(denied.getStatus(), "idle");
    const active = setup().controller;
    await active.start();
    await assert.rejects(() => active.start(), /正忙/);
    active.cancel();
    assert.equal(active.getStatus(), "idle");
  });

  it("hashes and plays authenticated blobs while always releasing object URLs", async () => {
    const blob = new Blob(["abc"]);
    const { controller, urls, Audio } = setup();
    assert.equal(await controller.hash(blob), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const audio = await controller.play(blob);
    assert.equal(audio.url, "blob:voice");
    Audio.last.listeners.ended();
    assert.deepEqual(urls, ["blob:voice"]);
    await assert.rejects(() => controller.play(null), /不可用/);
    const failed = setup({ playError: true });
    await assert.rejects(() => failed.controller.play(blob), /blocked/);
    assert.deepEqual(failed.urls, ["blob:voice"]);
  });

  it("supports environments without WebCrypto hashing and recorder error cleanup", async () => {
    const noCrypto = createVoiceController({ mediaDevices: {}, MediaRecorder: null, Blob, Audio: class {}, URL: {}, crypto: null });
    assert.equal(await noCrypto.hash(new Blob(["x"])), null);
    assert.equal(await setup().controller.hash({}), null);
    assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), "000fff");

    const { controller, track } = setup();
    await controller.start();
    const stopped = controller.stop();
    // The standard fake stops synchronously; error handling is covered with a manual recorder below.
    await stopped;
    assert.equal(track.stopped, true);
    controller.cancel();

    class BasicRecorder extends Recorder {
      static isTypeSupported() { return false; }
      constructor(stream, config) { super(stream, config); this.mimeType = ""; }
    }
    const basic = setup({ MediaRecorder: BasicRecorder }).controller;
    await basic.start();
    assert.equal((await basic.stop()).blob.type, "audio/webm");

    class ErrorRecorder extends Recorder {
      stop() { this.state = "inactive"; this.listeners.error({ error: new Error("device lost") }); }
    }
    const failed = setup({ MediaRecorder: ErrorRecorder }).controller;
    await failed.start();
    await assert.rejects(() => failed.stop(), /device lost/);
  });

  it("cancels a pending permission request and stops a late stream without recording", async () => {
    const permission = deferred();
    const late = mediaStream("late");
    let recorderCount = 0;
    class CountingRecorder extends Recorder {
      constructor(...args) { super(...args); recorderCount += 1; }
    }
    const controller = controllerFor({ getUserMedia: () => permission.promise }, CountingRecorder);
    const states = [];
    controller.subscribe((state) => states.push(state));
    const starting = controller.start();
    assert.equal(controller.getStatus(), "requesting");
    const cancelled = assert.rejects(() => starting, /已取消/);
    controller.cancel();
    assert.equal(controller.getStatus(), "idle");
    await cancelled;
    assert.equal(recorderCount, 0);
    permission.resolve(late.stream);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(late.track.stopped, true);
    assert.deepEqual(states, ["idle", "requesting", "idle"]);
  });

  it("does not let a cancelled permission request overwrite a newer recording", async () => {
    const firstPermission = deferred();
    const secondPermission = deferred();
    const oldMedia = mediaStream("old");
    const currentMedia = mediaStream("current");
    let calls = 0;
    const controller = controllerFor({ getUserMedia: () => (++calls === 1 ? firstPermission.promise : secondPermission.promise) }, Recorder);

    const firstStart = controller.start();
    controller.cancel();
    await assert.rejects(() => firstStart, /已取消/);
    const secondStart = controller.start();
    secondPermission.resolve(currentMedia.stream);
    await secondStart;
    assert.equal(controller.getStatus(), "recording");

    firstPermission.resolve(oldMedia.stream);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldMedia.track.stopped, true);
    assert.equal(currentMedia.track.stopped, false);
    assert.equal(controller.getStatus(), "recording");
    controller.cancel();
    assert.equal(currentMedia.track.stopped, true);
  });

  it("ignores late events from an old recorder after a new session starts", async () => {
    class DelayedRecorder {
      static instances = [];
      static isTypeSupported() { return true; }
      constructor(stream, config) {
        this.stream = stream;
        this.mimeType = config.mimeType;
        this.listeners = {};
        this.state = "inactive";
        DelayedRecorder.instances.push(this);
      }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; }
      data(text) { this.listeners.dataavailable({ data: new Blob([text], { type: this.mimeType }) }); }
      finish() { this.listeners.stop(); }
      fail(error) { this.listeners.error({ error }); }
    }
    const firstMedia = mediaStream("first");
    const secondMedia = mediaStream("second");
    let calls = 0;
    const controller = controllerFor({ getUserMedia: async () => (++calls === 1 ? firstMedia.stream : secondMedia.stream) }, DelayedRecorder);

    await controller.start();
    const firstRecorder = DelayedRecorder.instances[0];
    const firstStop = controller.stop();
    const cancelledStop = assert.rejects(() => firstStop, /已取消/);
    controller.cancel();
    await cancelledStop;
    assert.equal(firstMedia.track.stopped, true);

    await controller.start();
    const secondRecorder = DelayedRecorder.instances[1];
    firstRecorder.data("old");
    firstRecorder.finish();
    firstRecorder.fail(new Error("old recorder error"));
    assert.equal(controller.getStatus(), "recording");
    assert.equal(secondMedia.track.stopped, false);

    const secondStop = controller.stop();
    secondRecorder.data("new");
    secondRecorder.finish();
    const recording = await secondStop;
    assert.equal(await recording.blob.text(), "new");
    assert.equal(secondMedia.track.stopped, true);
    assert.equal(controller.getStatus(), "idle");
  });

  it("handles reentrant cancellation, recorder stop failures, and errors without details", async () => {
    const reentrantMedia = mediaStream("reentrant");
    let reentrantController;
    class ReentrantRecorder extends Recorder {
      start() {
        super.start();
        reentrantController.cancel();
      }
    }
    reentrantController = controllerFor({ getUserMedia: async () => reentrantMedia.stream }, ReentrantRecorder);
    await reentrantController.start();
    assert.equal(reentrantController.getStatus(), "idle");
    assert.equal(reentrantMedia.track.stopped, true);

    const throwingMedia = mediaStream("throwing");
    class ThrowingStopRecorder extends Recorder {
      stop() { throw new Error("already stopping"); }
    }
    const throwingController = controllerFor({ getUserMedia: async () => throwingMedia.stream }, ThrowingStopRecorder);
    await throwingController.start();
    assert.doesNotThrow(() => throwingController.cancel());
    assert.equal(throwingController.getStatus(), "idle");
    assert.equal(throwingMedia.track.stopped, true);

    class EmptyErrorRecorder extends Recorder {
      stop() { this.state = "inactive"; this.listeners.error({}); }
    }
    const emptyError = controllerFor({ getUserMedia: async () => mediaStream("error").stream }, EmptyErrorRecorder);
    await emptyError.start();
    await assert.rejects(() => emptyError.stop(), /录音失败/);
  });
});

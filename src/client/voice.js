(function initVoice(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WuyinVoice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function voiceFactory() {
  "use strict";

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function createVoiceController(options) {
    const mediaDevices = options.mediaDevices;
    const MediaRecorderCtor = options.MediaRecorder;
    const BlobCtor = options.Blob;
    const AudioCtor = options.Audio;
    const URLApi = options.URL;
    const subtle = options.crypto?.subtle;
    const now = options.now || Date.now;
    let recorder = null;
    let stream = null;
    let chunks = [];
    let status = "idle";
    let stopPromise = null;
    let resolveStop = null;
    let rejectStop = null;
    let startedAt = 0;
    const listeners = new Set();

    function notify(next) {
      status = next;
      for (const listener of listeners) listener(status);
    }

    function releaseStream() {
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
    }

    function subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    }

    async function start() {
      if (status !== "idle") throw new Error("录音设备正忙");
      if (!mediaDevices?.getUserMedia || !MediaRecorderCtor) throw new Error("当前浏览器不支持录音");
      notify("requesting");
      try {
        stream = await mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        const preferred = "audio/webm;codecs=opus";
        const config = MediaRecorderCtor.isTypeSupported?.(preferred) ? { mimeType: preferred } : undefined;
        recorder = new MediaRecorderCtor(stream, config);
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => {
          const type = recorder.mimeType || "audio/webm";
          const blob = new BlobCtor(chunks, { type });
          const durationMs = Math.max(1, Math.round(now() - startedAt));
          releaseStream();
          recorder = null;
          chunks = [];
          notify("idle");
          resolveStop?.({ blob, durationMs });
          resolveStop = null;
          rejectStop = null;
          stopPromise = null;
        });
        recorder.addEventListener("error", (event) => {
          releaseStream();
          recorder = null;
          notify("idle");
          rejectStop?.(event.error || new Error("录音失败"));
          resolveStop = null;
          rejectStop = null;
          stopPromise = null;
        });
        recorder.start();
        startedAt = now();
        notify("recording");
      } catch (error) {
        releaseStream();
        recorder = null;
        notify("idle");
        throw error;
      }
    }

    function stop() {
      if (!recorder || status !== "recording") return Promise.reject(new Error("当前没有正在进行的录音"));
      notify("processing");
      stopPromise = new Promise((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      const pending = stopPromise;
      recorder.stop();
      return pending;
    }

    function cancel() {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      else releaseStream();
    }

    async function hash(blob) {
      if (!subtle || !blob?.arrayBuffer) return null;
      return toHex(await subtle.digest("SHA-256", await blob.arrayBuffer()));
    }

    async function play(blob) {
      if (!blob) throw new Error("语音片段不可用");
      const objectUrl = URLApi.createObjectURL(blob);
      const audio = new AudioCtor(objectUrl);
      const release = () => URLApi.revokeObjectURL(objectUrl);
      audio.addEventListener?.("ended", release, { once: true });
      audio.addEventListener?.("error", release, { once: true });
      try {
        await audio.play();
      } catch (error) {
        release();
        throw error;
      }
      return audio;
    }

    return Object.freeze({ cancel, getStatus: () => status, hash, play, start, stop, subscribe });
  }

  return { createVoiceController, toHex };
});

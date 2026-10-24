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
    let activeSession = null;
    let status = "idle";
    const listeners = new Set();

    function notify(next) {
      status = next;
      for (const listener of listeners) listener(status);
    }

    function releaseStream(session) {
      stopStream(session.stream);
      session.stream = null;
    }

    function stopStream(value) {
      value?.getTracks?.().forEach((track) => track.stop());
    }

    function cancellationError() {
      return new Error("录音已取消");
    }

    function settleCancelled(session) {
      session.rejectStop?.(cancellationError());
      session.resolveStop = null;
      session.rejectStop = null;
      session.stopPromise = null;
    }

    function subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    }

    async function start() {
      if (status !== "idle") throw new Error("录音设备正忙");
      if (!mediaDevices?.getUserMedia || !MediaRecorderCtor) throw new Error("当前浏览器不支持录音");
      const session = {
        cancelled: false,
        stream: null,
        recorder: null,
        chunks: [],
        startedAt: 0,
        stopPromise: null,
        resolveStop: null,
        rejectStop: null,
        cancelStart: null,
      };
      activeSession = session;
      notify("requesting");
      try {
        const pendingMedia = Promise.resolve().then(() => mediaDevices.getUserMedia({ audio: true }));
        const result = await Promise.race([
          pendingMedia.then((value) => ({ stream: value })),
          new Promise((resolve) => { session.cancelStart = () => resolve({ cancelled: true }); }),
        ]);
        session.cancelStart = null;
        if (result.cancelled) {
          pendingMedia.then(stopStream, () => {});
          throw cancellationError();
        }
        session.stream = result.stream;
        if (session.cancelled || activeSession !== session) {
          releaseStream(session);
          throw cancellationError();
        }
        const preferred = "audio/webm;codecs=opus";
        const config = MediaRecorderCtor.isTypeSupported?.(preferred) ? { mimeType: preferred } : undefined;
        session.recorder = new MediaRecorderCtor(session.stream, config);
        const currentRecorder = session.recorder;
        currentRecorder.addEventListener("dataavailable", (event) => {
          if (!session.cancelled && activeSession === session && event.data?.size) session.chunks.push(event.data);
        });
        currentRecorder.addEventListener("stop", () => {
          if (session.cancelled || activeSession !== session) {
            releaseStream(session);
            return;
          }
          const type = currentRecorder.mimeType || "audio/webm";
          const blob = new BlobCtor(session.chunks, { type });
          const durationMs = Math.max(1, Math.round(now() - session.startedAt));
          activeSession = null;
          releaseStream(session);
          notify("idle");
          session.resolveStop?.({ blob, durationMs });
          session.resolveStop = null;
          session.rejectStop = null;
          session.stopPromise = null;
        });
        currentRecorder.addEventListener("error", (event) => {
          if (session.cancelled || activeSession !== session) {
            releaseStream(session);
            return;
          }
          activeSession = null;
          releaseStream(session);
          notify("idle");
          session.rejectStop?.(event.error || new Error("录音失败"));
          session.resolveStop = null;
          session.rejectStop = null;
          session.stopPromise = null;
        });
        currentRecorder.start();
        if (session.cancelled || activeSession !== session) return;
        session.startedAt = now();
        notify("recording");
      } catch (error) {
        releaseStream(session);
        if (activeSession === session) {
          activeSession = null;
          notify("idle");
        }
        throw error;
      }
    }

    function stop() {
      const session = activeSession;
      if (!session?.recorder || status !== "recording") return Promise.reject(new Error("当前没有正在进行的录音"));
      notify("processing");
      session.stopPromise = new Promise((resolve, reject) => {
        session.resolveStop = resolve;
        session.rejectStop = reject;
      });
      const pending = session.stopPromise;
      session.recorder.stop();
      return pending;
    }

    function cancel() {
      const session = activeSession;
      if (!session) return;
      session.cancelled = true;
      activeSession = null;
      session.cancelStart?.();
      session.cancelStart = null;
      releaseStream(session);
      settleCancelled(session);
      try {
        if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
      } catch {
        // The recorder may already be transitioning to inactive.
      } finally {
        notify("idle");
      }
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

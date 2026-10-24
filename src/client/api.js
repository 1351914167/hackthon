(function initApi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WuyinApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function apiFactory() {
  "use strict";

  class ApiError extends Error {
    constructor(status, code, message, payload) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }

  function parseSseBlock(block) {
    let event = "message";
    let id = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const split = line.indexOf(":");
      const field = split < 0 ? line : line.slice(0, split);
      const value = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    return { event, id, data: data.join("\n") };
  }

  async function consumeSseStream(body, callbacks, TextDecoderCtor) {
    if (!body?.getReader) throw new Error("SSE response body is unavailable");
    const decoder = new TextDecoderCtor();
    const reader = body.getReader();
    let buffer = "";
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (const block of blocks) {
        const message = parseSseBlock(block);
        if (message.id) callbacks.onCursor?.(message.id);
        if (message.event === "snapshot" && message.data) {
          const payload = JSON.parse(message.data);
          callbacks.onCursor?.(payload.cursor || message.id);
          callbacks.onSnapshot?.(payload.snapshot || payload);
        }
      }
      if (part.done) break;
    }
  }

  function createApi(options) {
    const fetchFn = options.fetch;
    const FormDataCtor = options.FormData;
    const AbortControllerCtor = options.AbortController;
    const TextDecoderCtor = options.TextDecoder;
    const schedule = options.setTimeout || setTimeout;
    const baseUrl = (options.baseUrl || "").replace(/\/$/, "");

    function url(path) {
      return `${baseUrl}${path}`;
    }

    async function decodeError(response) {
      let payload = {};
      try { payload = await response.json(); } catch { payload = {}; }
      const detail = payload.error || payload;
      const code = typeof detail === "object" ? detail.code : "REQUEST_FAILED";
      const message = typeof detail === "object" ? detail.message : detail;
      throw new ApiError(response.status, code || "REQUEST_FAILED", message || `请求失败（${response.status}）`, payload);
    }

    async function json(path, init = {}) {
      const response = await fetchFn(url(path), { credentials: "same-origin", ...init });
      if (!response.ok) return decodeError(response);
      if (response.status === 204) return null;
      return response.json();
    }

    function authHeaders(token, extra = {}) {
      return { Authorization: `Bearer ${token}`, ...extra };
    }

    function postJson(path, body, headers = {}) {
      return json(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    }

    function initSession() {
      return postJson("/api/session", {});
    }

    function createRoom(nickname, idempotencyKey) {
      return postJson("/api/rooms", { nickname }, { "Idempotency-Key": idempotencyKey });
    }

    function joinRoom(roomId, nickname, idempotencyKey) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/join`, { nickname }, { "Idempotency-Key": idempotencyKey });
    }

    function getSnapshot(roomId, token) {
      return json(`/api/rooms/${encodeURIComponent(roomId)}/snapshot`, { headers: authHeaders(token) });
    }

    function roomCommand(roomId, token, command, body, idempotencyKey) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/${command}`, body || {}, authHeaders(token, { "Idempotency-Key": idempotencyKey }));
    }

    function gameAction(roomId, token, action) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/actions`, action, authHeaders(token));
    }

    function createReport(roomId, token, targetSeatId, reason) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/reports`, { targetSeatId, reason }, authHeaders(token));
    }

    function listReports(roomId, token) {
      return json(`/api/rooms/${encodeURIComponent(roomId)}/reports`, { headers: authHeaders(token) });
    }

    async function uploadVoice(roomId, token, blob, durationMs, retain = false) {
      const form = new FormDataCtor();
      form.append("file", blob, "voice.webm");
      form.append("durationMs", String(durationMs));
      if (retain) form.append("retain", "true");
      return json(`/api/rooms/${encodeURIComponent(roomId)}/voice`, {
        method: "POST",
        headers: authHeaders(token),
        body: form,
      });
    }

    function listVoice(roomId, token) {
      return json(`/api/rooms/${encodeURIComponent(roomId)}/voice`, { headers: authHeaders(token) });
    }

    async function getVoice(roomId, token, segmentId) {
      const response = await fetchFn(url(`/api/rooms/${encodeURIComponent(roomId)}/voice/${encodeURIComponent(segmentId)}`), {
        credentials: "same-origin",
        headers: authHeaders(token),
      });
      if (!response.ok) return decodeError(response);
      return response.blob();
    }

    function markVoice(roomId, token, segmentId, label) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/voice/${encodeURIComponent(segmentId)}/mark`, { label }, authHeaders(token));
    }

    function removeVoice(roomId, token, segmentId) {
      return postJson(`/api/rooms/${encodeURIComponent(roomId)}/voice/${encodeURIComponent(segmentId)}/remove`, {}, authHeaders(token));
    }

    function getRecap(roomId, token) {
      return json(`/api/rooms/${encodeURIComponent(roomId)}/recap`, { headers: authHeaders(token) });
    }

    function getLingxiStatus() {
      return json("/api/lingxi/status", { headers: { Accept: "application/json" } });
    }

    function narration(roomId, token) {
      return fetchFn(url(`/api/rooms/${encodeURIComponent(roomId)}/narration`), {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        body: "{}",
      }).then((response) => response.ok ? response.blob() : decodeError(response));
    }

    function streamRoom(roomId, token, callbacks = {}) {
      const controller = new AbortControllerCtor();
      let closed = false;
      let cursor = callbacks.cursor || "";
      const done = (async function run() {
        while (!closed) {
          try {
            const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
            const response = await fetchFn(url(`/api/rooms/${encodeURIComponent(roomId)}/events${suffix}`), {
              credentials: "same-origin",
              headers: authHeaders(token, { Accept: "text/event-stream" }),
              signal: controller.signal,
            });
            if (!response.ok) await decodeError(response);
            await consumeSseStream(response.body, {
              onSnapshot: callbacks.onSnapshot,
              onCursor(next) {
                if (next) cursor = next;
                callbacks.onCursor?.(next);
              },
            }, TextDecoderCtor);
          } catch (error) {
            if (closed || error?.name === "AbortError") break;
            callbacks.onError?.(error);
          }
          if (!closed) await new Promise((resolve) => schedule(resolve, 1000));
        }
      })();
      return Object.freeze({ close() { closed = true; controller.abort(); }, done });
    }

    return Object.freeze({
      createRoom,
      createReport,
      gameAction,
      getLingxiStatus,
      getRecap,
      getSnapshot,
      getVoice,
      initSession,
      joinRoom,
      listVoice,
      listReports,
      markVoice,
      narration,
      removeVoice,
      roomCommand,
      streamRoom,
      uploadVoice,
    });
  }

  return { ApiError, consumeSseStream, createApi, parseSseBlock };
});

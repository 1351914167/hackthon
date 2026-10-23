"use strict";

const { VoiceError, voiceError } = require("./errors");

const LINGXI_BASE_URL = "https://api.aicso.top";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const SPEECH_MODEL = "gpt-4o-mini-tts";
const ALLOWED_VOICES = Object.freeze(["alloy", "echo", "fable", "nova", "onyx", "shimmer"]);
const AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/mp4",
]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".mp4", ".mpeg", ".mpga", ".ogg", ".wav", ".webm"]);

function createLingxiGateway(options = {}) {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") voiceError("VOICE_INVALID_CONFIG", "A fetch implementation is required", 500);

  const timeoutMs = positiveInteger(options.timeoutMs, 20_000, "timeoutMs");
  const maxAudioBytes = positiveInteger(options.maxAudioBytes, 16 * 1024 * 1024, "maxAudioBytes");
  const maxTranscriptBytes = positiveInteger(options.maxTranscriptBytes, 256 * 1024, "maxTranscriptBytes");
  const maxSpeechBytes = positiveInteger(options.maxSpeechBytes, 8 * 1024 * 1024, "maxSpeechBytes");
  const maxConcurrent = positiveInteger(options.maxConcurrent, 4, "maxConcurrent");
  const requestsPerWindow = positiveInteger(options.requestsPerWindow, 12, "requestsPerWindow");
  const rateWindowMs = positiveInteger(options.rateWindowMs, 60_000, "rateWindowMs");
  const now = options.now || Date.now;
  const timers = options.timers || { setTimeout, clearTimeout };
  if (typeof now !== "function" || typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    voiceError("VOICE_INVALID_CONFIG", "Clock and timer functions are required", 500);
  }

  const admission = createAdmissionController({ maxConcurrent, requestsPerWindow, rateWindowMs, now });
  const checks = {
    transcription: { checked: false, healthy: null },
    speech: { checked: false, healthy: null },
  };

  function status() {
    return {
      provider: "Lingxi API",
      configured: Boolean(apiKey),
      implemented: { transcription: true, speech: true, realtime: false },
      checked: { transcription: checks.transcription.checked, speech: checks.speech.checked, realtime: false },
      healthy: { transcription: checks.transcription.healthy, speech: checks.speech.healthy, realtime: null },
    };
  }

  async function transcribe(input = {}) {
    requireConfigured(apiKey);
    const seatId = validateSeatId(input.seatId);
    const file = validateIncomingAudio(input.formData, maxAudioBytes);
    return runLingxiRequest({
      seatId,
      signal: input.signal,
      capability: "transcription",
      admission,
      checks,
      timeoutMs,
      timers,
      request: (signal) => {
        const outbound = new FormData();
        outbound.append("file", file.blob, file.name);
        outbound.append("model", TRANSCRIPTION_MODEL);
        outbound.append("response_format", "json");
        return fetchImpl(`${LINGXI_BASE_URL}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: outbound,
          signal,
        });
      },
      consume: async (response) => {
        requireResponseType(response, (type) => type === "application/json");
        const bytes = await readLimitedBody(response, maxTranscriptBytes);
        let payload;
        try {
          payload = JSON.parse(bytes.toString("utf8"));
        } catch {
          voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an invalid transcription response", 502);
        }
        if (!payload || typeof payload.text !== "string") {
          voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an invalid transcription response", 502);
        }
        return { text: payload.text };
      },
    });
  }

  async function synthesize(input = {}) {
    requireConfigured(apiKey);
    const seatId = validateSeatId(input.seatId);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 600) voiceError("VOICE_INVALID_REQUEST", "text must contain 1 to 600 characters", 400);
    const voice = input.voice === undefined ? "alloy" : input.voice;
    if (!ALLOWED_VOICES.includes(voice)) voiceError("VOICE_INVALID_REQUEST", "voice is not allowed", 400);

    return runLingxiRequest({
      seatId,
      signal: input.signal,
      capability: "speech",
      admission,
      checks,
      timeoutMs,
      timers,
      request: (signal) => fetchImpl(`${LINGXI_BASE_URL}/v1/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: SPEECH_MODEL, input: text, voice, response_format: "mp3" }),
        signal,
      }),
      consume: async (response) => {
        const contentType = requireResponseType(response, (type) => type.startsWith("audio/"));
        return { audio: await readLimitedBody(response, maxSpeechBytes), contentType };
      },
    });
  }

  return Object.freeze({ status, synthesize, transcribe });
}

async function runLingxiRequest({ seatId, signal, capability, admission, checks, timeoutMs, timers, request, consume }) {
  const release = admission.acquire(seatId);
  const timeout = createTimeoutSignal(signal, timeoutMs, timers);
  try {
    let response;
    try {
      response = await request(timeout.signal);
      checks[capability].checked = true;
    } catch (error) {
      checks[capability].checked = true;
      checks[capability].healthy = false;
      if (timeout.didTimeOut()) voiceError("LINGXI_TIMEOUT", "Lingxi request timed out", 504);
      if (signal?.aborted) voiceError("VOICE_REQUEST_ABORTED", "Voice request was aborted", 499);
      if (error instanceof VoiceError) throw error;
      voiceError("LINGXI_UPSTREAM_ERROR", "Lingxi request failed", 502);
    }
    if (!response || typeof response.ok !== "boolean" || !response.headers) {
      checks[capability].healthy = false;
      voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an invalid response", 502);
    }
    if (!response.ok) {
      checks[capability].healthy = false;
      voiceError("LINGXI_UPSTREAM_ERROR", "Lingxi request failed", 502);
    }
    try {
      const value = await consume(response);
      checks[capability].healthy = true;
      return value;
    } catch (error) {
      checks[capability].healthy = false;
      if (timeout.didTimeOut()) voiceError("LINGXI_TIMEOUT", "Lingxi request timed out", 504);
      if (signal?.aborted) voiceError("VOICE_REQUEST_ABORTED", "Voice request was aborted", 499);
      if (error instanceof VoiceError) throw error;
      voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an invalid response", 502);
    }
  } finally {
    timeout.dispose();
    release();
  }
}

function createAdmissionController({ maxConcurrent, requestsPerWindow, rateWindowMs, now }) {
  let active = 0;
  const rates = new Map();
  return {
    acquire(seatId) {
      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) voiceError("VOICE_INVALID_CONFIG", "Clock returned an invalid time", 500);
      let rate = rates.get(seatId);
      if (!rate || timestamp - rate.windowStartedAt >= rateWindowMs || timestamp < rate.windowStartedAt) {
        rate = { windowStartedAt: timestamp, count: 0 };
        rates.set(seatId, rate);
      }
      if (rate.count >= requestsPerWindow) {
        const retryAfterSeconds = Math.max(1, Math.ceil((rate.windowStartedAt + rateWindowMs - timestamp) / 1000));
        voiceError("VOICE_RATE_LIMITED", "Voice request rate limit exceeded", 429, { retryAfterSeconds });
      }
      if (active >= maxConcurrent) voiceError("VOICE_CONCURRENCY_LIMITED", "Voice request concurrency limit exceeded", 429);
      rate.count += 1;
      active += 1;
      let released = false;
      return () => {
        if (!released) active -= 1;
        released = true;
      };
    },
  };
}

function createTimeoutSignal(externalSignal, timeoutMs, timers) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose() {
      timers.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function validateIncomingAudio(formData, maxAudioBytes) {
  if (!formData || typeof formData.getAll !== "function") {
    voiceError("VOICE_INVALID_REQUEST", "multipart form data is required", 400);
  }
  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    voiceError("VOICE_INVALID_REQUEST", "exactly one audio file is required", 400);
  }
  const blob = files[0];
  const name = typeof blob.name === "string" ? blob.name : "";
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!name || name.length > 128 || /[/\\]/.test(name) || !AUDIO_EXTENSIONS.has(extension)) {
    voiceError("VOICE_UNSUPPORTED_AUDIO", "audio filename is not supported", 415);
  }
  const contentType = blob.type.toLowerCase();
  if (!AUDIO_TYPES.has(contentType)) voiceError("VOICE_UNSUPPORTED_AUDIO", "audio content type is not supported", 415);
  if (!Number.isSafeInteger(blob.size) || blob.size <= 0) voiceError("VOICE_INVALID_REQUEST", "audio file must not be empty", 400);
  if (blob.size > maxAudioBytes) voiceError("VOICE_PAYLOAD_TOO_LARGE", "audio file exceeds the size limit", 413);
  return { blob, name };
}

function requireResponseType(response, accepts) {
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !accepts(contentType)) voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an unexpected content type", 502);
  return contentType;
}

async function readLimitedBody(response, maxBytes) {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) voiceError("LINGXI_INVALID_RESPONSE", "Lingxi returned an invalid content length", 502);
    if (length > maxBytes) voiceError("LINGXI_RESPONSE_TOO_LARGE", "Lingxi response exceeds the size limit", 502);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) voiceError("LINGXI_RESPONSE_TOO_LARGE", "Lingxi response exceeds the size limit", 502);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        voiceError("LINGXI_RESPONSE_TOO_LARGE", "Lingxi response exceeds the size limit", 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function requireConfigured(apiKey) {
  if (!apiKey) voiceError("LINGXI_NOT_CONFIGURED", "LINGXI_API_KEY is not configured", 503);
}

function validateSeatId(seatId) {
  if (typeof seatId !== "string" || !seatId.trim() || seatId.length > 128) {
    voiceError("VOICE_INVALID_REQUEST", "An authenticated seatId is required", 400);
  }
  return seatId;
}

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) voiceError("VOICE_INVALID_CONFIG", `${name} must be a positive integer`, 500);
  return resolved;
}

module.exports = {
  ALLOWED_VOICES,
  AUDIO_TYPES,
  LINGXI_BASE_URL,
  SPEECH_MODEL,
  TRANSCRIPTION_MODEL,
  createLingxiGateway,
};

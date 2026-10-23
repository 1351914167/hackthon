"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  ALLOWED_VOICES,
  LINGXI_BASE_URL,
  SPEECH_MODEL,
  TRANSCRIPTION_MODEL,
  VoiceError,
  createLingxiGateway,
} = require("../../src/voice");

function audioForm({ bytes = "voice", type = "audio/webm", name = "speech.webm" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return form;
}

async function expectVoiceError(promise, code, statusCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof VoiceError, true);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal("detail" in error, false);
    return true;
  });
}

function gateway(fetchImpl, options = {}) {
  return createLingxiGateway({ apiKey: "test-key", fetchImpl, timeoutMs: 1_000, ...options });
}

describe("Lingxi gateway contracts", () => {
  it("reports configuration, implemented capabilities, and actual checks separately", async () => {
    const missing = createLingxiGateway({ apiKey: "" });
    assert.deepEqual(missing.status(), {
      provider: "Lingxi API",
      configured: false,
      implemented: { transcription: true, speech: true, realtime: false },
      checked: { transcription: false, speech: false, realtime: false },
      healthy: { transcription: null, speech: null, realtime: null },
    });
    await expectVoiceError(missing.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_NOT_CONFIGURED", 503);
    await expectVoiceError(missing.transcribe({ seatId: "seat-1", formData: audioForm() }), "LINGXI_NOT_CONFIGURED", 503);
    assert.equal(missing.status().checked.speech, false);
  });

  it("rebuilds transcription multipart data with a fixed model", async () => {
    let captured;
    const client = gateway(async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ text: "  我是预言家  " }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    });
    const incoming = audioForm();
    incoming.append("model", "attacker-model");
    incoming.append("response_format", "verbose_json");

    assert.deepEqual(await client.transcribe({ seatId: "seat-1", formData: incoming }), { text: "  我是预言家  " });
    assert.equal(captured.url, `${LINGXI_BASE_URL}/v1/audio/transcriptions`);
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Authorization, "Bearer test-key");
    assert.equal(captured.options.signal instanceof AbortSignal, true);
    assert.deepEqual(captured.options.body.getAll("model"), [TRANSCRIPTION_MODEL]);
    assert.deepEqual(captured.options.body.getAll("response_format"), ["json"]);
    assert.equal(captured.options.body.getAll("file").length, 1);
    assert.equal(client.status().checked.transcription, true);
    assert.equal(client.status().healthy.transcription, true);
  });

  it("rejects malformed or unsafe transcription uploads before fetch", async () => {
    let calls = 0;
    const client = gateway(async () => {
      calls += 1;
      return new Response("{}");
    }, { maxAudioBytes: 5 });
    const duplicate = audioForm();
    duplicate.append("file", new Blob(["more"], { type: "audio/webm" }), "more.webm");
    const empty = audioForm({ bytes: "" });
    const noFile = new FormData();
    const invalids = [
      [{ seatId: "", formData: audioForm() }, "VOICE_INVALID_REQUEST", 400],
      [{ seatId: "seat-1", formData: {} }, "VOICE_INVALID_REQUEST", 400],
      [{ seatId: "seat-1", formData: noFile }, "VOICE_INVALID_REQUEST", 400],
      [{ seatId: "seat-1", formData: duplicate }, "VOICE_INVALID_REQUEST", 400],
      [{ seatId: "seat-1", formData: audioForm({ name: "../voice.webm" }) }, "VOICE_UNSUPPORTED_AUDIO", 415],
      [{ seatId: "seat-1", formData: audioForm({ name: "voice.txt" }) }, "VOICE_UNSUPPORTED_AUDIO", 415],
      [{ seatId: "seat-1", formData: audioForm({ type: "text/plain" }) }, "VOICE_UNSUPPORTED_AUDIO", 415],
      [{ seatId: "seat-1", formData: empty }, "VOICE_INVALID_REQUEST", 400],
      [{ seatId: "seat-1", formData: audioForm({ bytes: "123456" }) }, "VOICE_PAYLOAD_TOO_LARGE", 413],
    ];
    for (const [input, code, status] of invalids) await expectVoiceError(client.transcribe(input), code, status);
    assert.equal(calls, 0);
  });

  it("fixes the TTS model, format, and allowed voice", async () => {
    const requests = [];
    const client = gateway(async (url, options) => {
      requests.push({ url, options, payload: JSON.parse(options.body) });
      return new Response(Buffer.from([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
    });
    assert.deepEqual(await client.synthesize({ seatId: "seat-2", text: " 天黑请闭眼 " }), {
      audio: Buffer.from([1, 2, 3]),
      contentType: "audio/mpeg",
    });
    await client.synthesize({ seatId: "seat-2", text: "请投票", voice: "nova" });
    assert.equal(requests[0].url, `${LINGXI_BASE_URL}/v1/audio/speech`);
    assert.deepEqual(requests[0].payload, {
      model: SPEECH_MODEL,
      input: "天黑请闭眼",
      voice: "alloy",
      response_format: "mp3",
    });
    assert.equal(requests[1].payload.voice, "nova");
    assert.equal(requests[0].options.headers.Authorization, "Bearer test-key");
    assert.equal(ALLOWED_VOICES.includes("nova"), true);
    assert.equal(client.status().healthy.speech, true);
  });

  it("rejects invalid TTS input without spending an upstream request", async () => {
    let calls = 0;
    const client = gateway(async () => {
      calls += 1;
      return new Response("audio", { headers: { "Content-Type": "audio/mpeg" } });
    });
    for (const input of [
      { seatId: 4, text: "hello" },
      { seatId: "seat-1", text: 4 },
      { seatId: "seat-1", text: "   " },
      { seatId: "seat-1", text: "x".repeat(601) },
      { seatId: "seat-1", text: "hello", voice: "custom" },
    ]) {
      await expectVoiceError(client.synthesize(input), "VOICE_INVALID_REQUEST", 400);
    }
    assert.equal(calls, 0);
  });
});

describe("Lingxi gateway failure and resource boundaries", () => {
  it("redacts upstream errors and records an unhealthy completed check", async () => {
    const client = gateway(async () => new Response("secret provider diagnostic", { status: 429 }));
    await assert.rejects(client.synthesize({ seatId: "seat-1", text: "test" }), (error) => {
      assert.equal(error.code, "LINGXI_UPSTREAM_ERROR");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.deepEqual(client.status().checked, { transcription: false, speech: true, realtime: false });
    assert.equal(client.status().healthy.speech, false);
  });

  it("normalizes network failures and invalid response envelopes", async () => {
    const network = gateway(async () => { throw new Error("dns includes secret"); });
    await expectVoiceError(network.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_UPSTREAM_ERROR", 502);

    const domainFailure = gateway(async () => { throw new VoiceError("CONTROLLED_FAILURE", "controlled", 418); });
    await expectVoiceError(domainFailure.synthesize({ seatId: "seat-1", text: "test" }), "CONTROLLED_FAILURE", 418);

    const invalid = gateway(async () => ({ nope: true }));
    await expectVoiceError(invalid.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_INVALID_RESPONSE", 502);
  });

  it("validates transcription JSON and response content types", async () => {
    const cases = [
      [new Response("{}", { headers: { "Content-Type": "text/plain" } }), "LINGXI_INVALID_RESPONSE"],
      [new Response("not-json", { headers: { "Content-Type": "application/json" } }), "LINGXI_INVALID_RESPONSE"],
      [new Response("{}", { headers: { "Content-Type": "application/json" } }), "LINGXI_INVALID_RESPONSE"],
    ];
    for (const [response, code] of cases) {
      const client = gateway(async () => response);
      await expectVoiceError(client.transcribe({ seatId: "seat-1", formData: audioForm() }), code, 502);
    }
    const speech = gateway(async () => new Response("json", { headers: { "Content-Type": "application/json" } }));
    await expectVoiceError(speech.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_INVALID_RESPONSE", 502);
    const missingType = gateway(async () => new Response("audio"));
    await expectVoiceError(missingType.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_INVALID_RESPONSE", 502);
  });

  it("enforces response limits from headers, streams, and array-buffer fallbacks", async () => {
    const byHeader = gateway(async () => new Response("x", {
      headers: { "Content-Type": "audio/mpeg", "Content-Length": "100" },
    }), { maxSpeechBytes: 3 });
    await expectVoiceError(byHeader.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_RESPONSE_TOO_LARGE", 502);

    const badLength = gateway(async () => new Response("x", {
      headers: { "Content-Type": "audio/mpeg", "Content-Length": "bad" },
    }));
    await expectVoiceError(badLength.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_INVALID_RESPONSE", 502);

    const streamed = gateway(async () => new Response("1234", { headers: { "Content-Type": "audio/mpeg" } }), { maxSpeechBytes: 3 });
    await expectVoiceError(streamed.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_RESPONSE_TOO_LARGE", 502);

    const fallback = gateway(async () => ({
      ok: true,
      headers: new Headers({ "Content-Type": "audio/mpeg" }),
      body: null,
      async arrayBuffer() { return Uint8Array.from([1, 2, 3, 4]).buffer; },
    }), { maxSpeechBytes: 3 });
    await expectVoiceError(fallback.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_RESPONSE_TOO_LARGE", 502);

    const validFallback = gateway(async () => ({
      ok: true,
      headers: new Headers({ "Content-Type": "audio/mpeg" }),
      body: null,
      async arrayBuffer() { return Uint8Array.from([1, 2]).buffer; },
    }), { maxSpeechBytes: 3 });
    assert.deepEqual((await validFallback.synthesize({ seatId: "seat-1", text: "test" })).audio, Buffer.from([1, 2]));

    const brokenFallback = gateway(async () => ({
      ok: true,
      headers: new Headers({ "Content-Type": "audio/mpeg" }),
      body: null,
      async arrayBuffer() { throw new Error("broken response body with secret"); },
    }));
    await expectVoiceError(brokenFallback.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_INVALID_RESPONSE", 502);
  });

  it("times out pending fetches and distinguishes caller cancellation", async () => {
    const timers = {
      setTimeout(callback) { queueMicrotask(callback); return 1; },
      clearTimeout() {},
    };
    const pendingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const timed = gateway(pendingFetch, { timers });
    await expectVoiceError(timed.synthesize({ seatId: "seat-1", text: "test" }), "LINGXI_TIMEOUT", 504);

    const controller = new AbortController();
    const cancelled = gateway(pendingFetch);
    const promise = cancelled.synthesize({ seatId: "seat-1", text: "test", signal: controller.signal });
    controller.abort();
    await expectVoiceError(promise, "VOICE_REQUEST_ABORTED", 499);

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAborted = gateway(async (_url, { signal }) => {
      assert.equal(signal.aborted, true);
      throw signal.reason;
    });
    await expectVoiceError(preAborted.synthesize({
      seatId: "seat-1",
      text: "test",
      signal: preAbortedController.signal,
    }), "VOICE_REQUEST_ABORTED", 499);
  });

  it("limits concurrent requests and releases capacity after completion", async () => {
    let releaseFetch;
    const held = new Promise((resolve) => { releaseFetch = resolve; });
    let calls = 0;
    const client = gateway(async () => {
      calls += 1;
      if (calls === 1) await held;
      return new Response("audio", { headers: { "Content-Type": "audio/mpeg" } });
    }, { maxConcurrent: 1, requestsPerWindow: 5 });
    const first = client.synthesize({ seatId: "seat-1", text: "first" });
    await Promise.resolve();
    await expectVoiceError(client.synthesize({ seatId: "seat-2", text: "second" }), "VOICE_CONCURRENCY_LIMITED", 429);
    releaseFetch();
    await first;
    assert.equal((await client.synthesize({ seatId: "seat-2", text: "third" })).audio.toString(), "audio");
  });

  it("rate limits each authenticated seat and resets the window", async () => {
    let timestamp = 1_000;
    const client = gateway(async () => new Response("audio", { headers: { "Content-Type": "audio/mpeg" } }), {
      now: () => timestamp,
      requestsPerWindow: 1,
      rateWindowMs: 1_000,
    });
    await client.synthesize({ seatId: "seat-1", text: "one" });
    await assert.rejects(client.synthesize({ seatId: "seat-1", text: "two" }), (error) => {
      assert.equal(error.code, "VOICE_RATE_LIMITED");
      assert.equal(error.retryAfterSeconds, 1);
      return true;
    });
    await client.synthesize({ seatId: "seat-2", text: "other seat" });
    timestamp = 2_000;
    await client.synthesize({ seatId: "seat-1", text: "new window" });
  });

  it("rejects invalid gateway limits and clock values", async () => {
    for (const options of [
      { timeoutMs: 0 },
      { maxAudioBytes: -1 },
      { maxTranscriptBytes: 0.5 },
      { maxSpeechBytes: 0 },
      { maxConcurrent: 0 },
      { requestsPerWindow: 0 },
      { rateWindowMs: 0 },
      { fetchImpl: 4 },
      { now: 4 },
      { timers: {} },
    ]) assert.throws(() => createLingxiGateway({ apiKey: "key", ...options }), { code: "VOICE_INVALID_CONFIG" });

    const client = gateway(async () => new Response("audio", { headers: { "Content-Type": "audio/mpeg" } }), { now: () => NaN });
    await expectVoiceError(client.synthesize({ seatId: "seat-1", text: "test" }), "VOICE_INVALID_CONFIG", 500);
  });
});

it("keeps gameplay fallback data independent when Lingxi is unavailable", async () => {
  const client = gateway(async () => new Response("provider failure", { status: 503 }));
  const gameplay = { phase: "DAY_SPEECH", currentSpeakerSeatId: "seat-3", deadlineAt: "2026-10-23T10:01:00.000Z" };
  const fallback = { kind: "TEXT", text: "3号发言暂时无法转写，可继续牌局。", gameplay: structuredClone(gameplay) };
  try {
    await client.transcribe({ seatId: "seat-3", formData: audioForm() });
    assert.fail("expected the fake Lingxi service to fail");
  } catch (error) {
    assert.equal(error.code, "LINGXI_UPSTREAM_ERROR");
  }
  assert.deepEqual(fallback.gameplay, gameplay);
  assert.equal(fallback.kind, "TEXT");
});

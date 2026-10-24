"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test, expect, chromium } = require("@playwright/test");

const { readJson } = require("../../src/http/application");
const { createMediaBroker } = require("../../src/media");
const { createMediaRoutes } = require("../../src/media/routes");

test.describe("real browser WebRTC media", () => {
  let browser;
  let server;
  let baseUrl;
  let speakerSeatId;

  test.beforeAll(async () => {
    speakerSeatId = "seat-1";
    const tokenSeats = new Map(Array.from({ length: 9 }, (_, index) => [
      `browser-token-${index + 1}`,
      `seat-${index + 1}`,
    ]));
    const getSnapshot = ({ roomId, seatToken }) => {
      const selfSeatId = tokenSeats.get(seatToken);
      if (roomId !== "browser-room" || !selfSeatId) throw Object.assign(new Error("invalid seat token"), { code: "INVALID_SEAT_TOKEN" });
      return {
        roomId,
        code: roomId,
        status: "ACTIVE",
        hostSeatId: "seat-1",
        selfSeatId,
        seats: [...tokenSeats.values()].map((seatId) => ({ seatId, nickname: seatId, ready: true, connected: true })),
        game: {
          gameId: "browser-game",
          phase: "DAY_SPEECH",
          round: 1,
          currentSpeakerSeatId: speakerSeatId,
          seats: [...tokenSeats.values()].map((seatId) => ({ seatId, ready: true, alive: true })),
        },
        version: "browser-visible-version",
      };
    };
    const broker = createMediaBroker({ getSnapshot, ttlMs: 15_000, signalTtlMs: 10_000 });
    const routes = createMediaRoutes({ broker });
    const peerClientPath = path.resolve(__dirname, "../../src/media/peer-client.js");

    server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, "http://localhost");
        if (request.method === "GET" && url.pathname === "/") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end("<!doctype html><meta charset=utf-8><title>media-test</title><script src=/peer-client.js></script>");
          return;
        }
        if (request.method === "GET" && url.pathname === "/peer-client.js") {
          response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
          response.end(await fs.readFile(peerClientPath));
          return;
        }
        if (request.method === "POST" && url.pathname === "/test/speaker") {
          const body = await readJson(request);
          if (!tokenSeats.has(`browser-token-${body.seatId.slice(-1)}`)) throw Object.assign(new Error("invalid speaker"), { code: "INVALID_REQUEST", statusCode: 400 });
          speakerSeatId = body.seatId;
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ speakerSeatId }));
          return;
        }
        const handled = await routes({
          request,
          response,
          url,
          token(req) {
            const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || "");
            if (!match) throw Object.assign(new Error("token required"), { code: "INVALID_SEAT_TOKEN", statusCode: 401 });
            return match[1];
          },
          json(res, status, value) {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(value));
          },
          readJson,
        });
        if (handled) return;
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      } catch (error) {
        response.writeHead(error.statusCode || 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: { code: error.code || "INTERNAL_ERROR", message: error.message } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      channel: process.env.PW_CHANNEL || "chrome",
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  });

  test.afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  test("sends fake-tone RTP, reports inbound packets, and replaces the old speaker track", async () => {
    test.setTimeout(60_000);
    const contexts = await Promise.all(Array.from({ length: 9 }, () => browser.newContext()));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [speakerPage, ...receiverPages] = pages;
    await Promise.all(pages.map((page) => page.goto(baseUrl)));

    const installClient = async (page, seatToken) => page.evaluate(async ({ roomId, seatToken, baseUrl }) => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.frequency.value = seatToken.endsWith("1") ? 440 : 660;
      gain.gain.value = 0.05;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      window.__tone = { audioContext, oscillator, stream: destination.stream };
      window.__receivedTracks = [];
      window.__mediaErrors = [];
      window.__media = window.WerewolfPeerClient.createPeerClient({
        roomId,
        seatToken,
        baseUrl,
        pollIntervalMs: 100,
        getUserMedia: async () => destination.stream,
        onTrack(event, metadata) {
          const stream = event.streams[0] || new MediaStream([event.track]);
          const audio = document.createElement("audio");
          audio.autoplay = true;
          audio.srcObject = stream;
          document.body.append(audio);
          audio.play().catch(() => {});
          window.__receivedTracks.push({
            track: event.track,
            receiver: event.receiver,
            fromSeatId: metadata.fromSeatId,
          });
        },
        onError(error) {
          window.__mediaErrors.push({ code: error.code, message: error.message });
        },
      });
      await window.__media.start();
      return window.__media.getState();
    }, { roomId: "browser-room", seatToken, baseUrl });

    await Promise.all(receiverPages.map((page, index) => installClient(page, `browser-token-${index + 2}`)));
    const initialSpeaker = await installClient(speakerPage, "browser-token-1");
    expect(initialSpeaker.isSpeaker).toBe(true);
    expect(initialSpeaker.connectionCount).toBe(8);

    await Promise.all(receiverPages.map((page) => page.waitForFunction(() => window.__receivedTracks.length > 0)));
    const firstTracks = await Promise.all(receiverPages.map((page) => page.evaluate(() => ({
      fromSeatId: window.__receivedTracks[0].fromSeatId,
      kind: window.__receivedTracks[0].track.kind,
      readyState: window.__receivedTracks[0].track.readyState,
    }))));
    for (const firstTrack of firstTracks) {
      expect(firstTrack).toMatchObject({ fromSeatId: "seat-1", kind: "audio", readyState: "live" });
    }

    const waitForPackets = async (page, fromSeatId) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const packets = await page.evaluate(async (seatId) => {
          const entry = window.__receivedTracks.find((value) => value.fromSeatId === seatId);
          if (!entry) return 0;
          const stats = await entry.receiver.getStats();
          return Math.max(0, ...[...stats.values()]
            .filter((report) => report.type === "inbound-rtp" && report.kind === "audio")
            .map((report) => report.packetsReceived || 0));
        }, fromSeatId);
        if (packets > 0) return packets;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return 0;
    };
    const packetsReceived = await Promise.all(receiverPages.map((page) => waitForPackets(page, "seat-1")));
    expect(packetsReceived).toHaveLength(8);
    for (const packets of packetsReceived) expect(packets).toBeGreaterThan(0);

    await fetch(`${baseUrl}/test/speaker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatId: "seat-2" }),
    });
    const nextSpeakerPage = receiverPages[0];
    await nextSpeakerPage.waitForFunction(() => window.__media.getState().isSpeaker === true);
    await nextSpeakerPage.waitForFunction(() => window.__receivedTracks[0].track.readyState === "ended");
    await speakerPage.waitForFunction(() => window.__receivedTracks.some((entry) => entry.fromSeatId === "seat-2"));
    expect(await waitForPackets(speakerPage, "seat-2")).toBeGreaterThan(0);

    const errors = await Promise.all(pages.map((page) => page.evaluate(() => window.__mediaErrors)));
    for (const pageErrors of errors) expect(pageErrors).toEqual([]);
    await Promise.all(pages.map((page) => page.evaluate(() => window.__media.stop())));
    await Promise.all(contexts.map((context) => context.close()));
  });
});

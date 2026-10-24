"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://images.unsplash.com data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
});
const STATUS = { INVALID_REQUEST: 400, INVALID_SEAT_TOKEN: 401, ACTION_NOT_ALLOWED: 403,
  ROOM_NOT_FOUND: 404, ROOM_FULL: 409, VIEW_CONFLICT: 409, ACTION_ID_CONFLICT: 409,
  SEQUENCE_CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429 };

function httpError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function readBody(request, limit) {
  if (Number(request.headers["content-length"]) > limit) throw httpError("PAYLOAD_TOO_LARGE", 413, "请求过大");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw httpError("PAYLOAD_TOO_LARGE", 413, "请求过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw httpError("UNSUPPORTED_MEDIA_TYPE", 415, "需要 JSON 请求");
  }
  const body = await readBody(request, 32 * 1024);
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value;
  } catch {
    throw httpError("INVALID_REQUEST", 400, "JSON 对象无效");
  }
}

function createApplication(options = {}) {
  const rooms = options.rooms || require("../room").createRoomService();
  const root = options.root || path.resolve(__dirname, "../..");
  const clock = options.clock || Date.now;
  const sessions = new Map();
  const viewers = new Map();
  const clients = new Set();
  const metrics = { requests: 0, errors: 0, startedAt: clock() };
  const sessionTTL = 24 * 60 * 60 * 1000;
  const extension = options.extension || require("../features").createFeatureRoutes({ rooms, clock });

  function json(response, status, value, extra = {}) {
    response.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra });
    response.end(JSON.stringify(value));
  }

  function token(request) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || "");
    if (!match) throw httpError("INVALID_SEAT_TOKEN", 401, "请重新加入房间");
    return match[1];
  }

  function session(request) {
    const id = /(?:^|;\s*)wuyin_session=([A-Za-z0-9-]+)/.exec(request.headers.cookie || "")?.[1];
    if (!id || !sessions.has(id) || sessions.get(id) <= clock()) {
      throw httpError("INVALID_SESSION", 401, "请刷新页面建立会话");
    }
    return id;
  }

  function visibleMessage(roomId, seatToken) {
    const snapshot = rooms.getSnapshot({ roomId, seatToken });
    const key = `${roomId}:${seatToken}`;
    let stream = viewers.get(key);
    if (!stream || stream.gameId !== snapshot.game?.gameId) {
      stream = { gameId: snapshot.game?.gameId, messages: [] };
      viewers.set(key, stream);
    }
    if (stream.messages.at(-1)?.snapshot.version !== snapshot.version) {
      stream.messages.push({ cursor: randomUUID(), snapshot });
      if (stream.messages.length > 64) stream.messages.shift();
    }
    return stream;
  }

  function sendEvent(client, message) {
    if (client.response.writableLength > 256 * 1024) {
      client.response.end();
      return;
    }
    client.response.write(`id: ${message.cursor}\nevent: snapshot\ndata: ${JSON.stringify(message)}\n\n`);
    client.cursor = message.cursor;
  }

  function poll() {
    rooms.tick(clock());
    for (const client of clients) {
      try {
        const message = visibleMessage(client.roomId, client.seatToken).messages.at(-1);
        if (message.cursor !== client.cursor) sendEvent(client, message);
        else if (clock() - client.heartbeat >= 15000) {
          client.response.write(": heartbeat\n\n");
          client.heartbeat = clock();
        }
      } catch {
        client.response.end();
      }
    }
    for (const [id, expires] of sessions) if (expires <= clock()) sessions.delete(id);
  }

  const server = http.createServer(async (request, response) => {
    metrics.requests += 1;
    const requestId = randomUUID();
    try {
      const url = new URL(request.url, "http://localhost");
      if (!["GET", "HEAD", "POST"].includes(request.method)) {
        throw httpError("METHOD_NOT_ALLOWED", 405, "方法不支持");
      }
      if (request.method === "POST") {
        const origin = request.headers.origin;
        const allowed = options.allowedOrigins || [`http://127.0.0.1:${server.address()?.port}`, `http://localhost:${server.address()?.port}`];
        if ((origin && !allowed.includes(origin)) || request.headers["sec-fetch-site"] === "cross-site") {
          throw httpError("ORIGIN_DENIED", 403, "来源不允许");
        }
      }
      if (url.pathname === "/api/health" && request.method === "GET") {
        json(response, 200, { status: "ok", version: "0.1.0", uptimeMs: Math.max(0, clock() - metrics.startedAt),
          requests: metrics.requests, errors: metrics.errors, streams: clients.size });
        return;
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        if (sessions.size >= (options.maxSessions || 10000)) throw httpError("RATE_LIMITED", 429, "会话数量已达上限");
        const id = randomUUID();
        sessions.set(id, clock() + sessionTTL);
        json(response, 201, { initialized: true }, {
          "Set-Cookie": `wuyin_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookies ? "; Secure" : ""}`,
        });
        return;
      }
      if (await extension({ request, response, url, rooms, token, json, readBody, readJson })) return;
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const sessionId = session(request);
        const input = await readJson(request);
        const result = rooms.createRoom({ sessionId, nickname: input.nickname, idempotencyKey: request.headers["idempotency-key"] });
        json(response, 201, result);
        return;
      }
      const route = /^\/api\/rooms\/([A-Za-z0-9_-]+)(?:\/(join|ready|start|snapshot|actions|events|reconnect|leave|restart))?$/.exec(url.pathname);
      if (route) {
        const [, roomId, operation] = route;
        if (request.method === "GET" && operation === "snapshot") {
          json(response, 200, rooms.getSnapshot({ roomId, seatToken: token(request) }));
          return;
        }
        if (request.method === "GET" && operation === "events") {
          const seatToken = token(request);
          const ownClients = [...clients].filter((client) => client.seatToken === seatToken);
          if (clients.size >= (options.maxStreams || 512) || ownClients.length >= 2) {
            throw httpError("RATE_LIMITED", 429, "实时连接数量已达上限");
          }
          rooms.reconnect({ roomId, seatToken });
          const stream = visibleMessage(roomId, seatToken);
          response.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", Connection: "keep-alive" });
          const cursor = url.searchParams.get("cursor");
          const index = stream.messages.findIndex((entry) => entry.cursor === cursor);
          const messages = index < 0 ? stream.messages.slice(-1) : stream.messages.slice(index + 1);
          const client = { roomId, seatToken, response, cursor, heartbeat: clock() };
          clients.add(client);
          if (messages.length) messages.forEach((message) => sendEvent(client, message));
          else response.write(": connected\n\n");
          response.on("close", () => {
            clients.delete(client);
            if (![...clients].some((other) => other.seatToken === seatToken)) {
              try {
                rooms.disconnect({ roomId, seatToken });
              } catch (error) {
                // The room may have expired while its stream was closing.
                if (error.code !== "ROOM_NOT_FOUND") options.onError?.({ code: "DISCONNECT_FAILED" });
              }
            }
          });
          return;
        }
        if (request.method === "POST") {
          const input = await readJson(request);
          const idempotencyKey = request.headers["idempotency-key"];
          let result;
          if (operation === "join") {
            result = rooms.joinRoom({ roomId, sessionId: session(request), nickname: input.nickname, idempotencyKey });
          } else {
            const seatToken = token(request);
            const args = { roomId, seatToken, idempotencyKey };
            if (operation === "ready") result = rooms.setReady({ ...args, ready: input.ready });
            else if (operation === "start") result = rooms.startGame(args);
            else if (operation === "actions") result = rooms.dispatchAction({ ...args, action: input });
            else if (operation === "reconnect") result = rooms.reconnect(args);
            else if (operation === "leave") result = rooms.leaveRoom(args);
            else if (operation === "restart") result = rooms.restartGame(args);
            else throw httpError("NOT_FOUND", 404, "接口不存在");
          }
          json(response, 200, result);
          poll();
          return;
        }
      }
      if (["GET", "HEAD"].includes(request.method)) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (["index.html", "styles.css", "app.js", "product.html", "product.css", "src/media/peer-client.js"].includes(file) || /^src\/client\/[a-z0-9-]+\.js$/.test(file)) {
          const data = await fs.readFile(path.join(root, file));
          const type = file.endsWith(".html") ? "text/html" : (file.endsWith(".css") ? "text/css" : "text/javascript");
          response.writeHead(200, { ...HEADERS, "Content-Type": `${type}; charset=utf-8` });
          response.end(request.method === "HEAD" ? undefined : data);
          return;
        }
      }
      throw httpError("NOT_FOUND", 404, "页面不存在");
    } catch (error) {
      metrics.errors += 1;
      const status = error.statusCode || STATUS[error.code] || (error.code === "ENOENT" ? 404 : 500);
      const code = error.code === "SEQUENCE_CONFLICT" ? "VIEW_CONFLICT" : (status === 500 ? "INTERNAL_ERROR" : error.code);
      if (status >= 500) options.onError?.({ code, status, requestId });
      if (!response.headersSent) json(response, status, { error: { code, message: status === 500 ? "服务暂不可用" : error.message,
        requestId, ...(error.latestVersion ? { latestVersion: error.latestVersion } : {}) } });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 1024;
  const timer = setInterval(poll, options.pollInterval || 500);
  timer.unref();
  function stop() {
    clearInterval(timer);
    for (const client of clients) client.response.end();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  }
  return { server, rooms, poll, stop };
}

function start(options = {}) {
  const application = createApplication(options);
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const host = options.host || process.env.HOST || "127.0.0.1";
  application.server.listen(port, host);
  return application;
}

module.exports = { createApplication, start, readBody, readJson, httpError };

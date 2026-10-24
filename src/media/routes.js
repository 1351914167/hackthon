"use strict";

const OPERATIONS = Object.freeze(["join", "leave", "peers", "signal", "drain"]);
const STATUS_BY_CODE = Object.freeze({
  INVALID_REQUEST: 400,
  INVALID_SIGNAL: 400,
  INVALID_RECIPIENT: 400,
  INVALID_SEAT_TOKEN: 401,
  ACTION_NOT_ALLOWED: 403,
  MEDIA_NOT_AVAILABLE: 403,
  NO_ACTIVE_SPEAKER: 403,
  MEDIA_NOT_JOINED: 409,
  PEER_NOT_JOINED: 409,
});

class MediaRouteError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "MediaRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new MediaRouteError(code, message, statusCode);
}

function createMediaRoutes(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("MEDIA_INVALID_CONFIG", "Media route options must be an object", 500);
  }
  const broker = options.broker;
  if (!broker || OPERATIONS.some((operation) => typeof broker[operation === "signal" ? "publishSignal" : operation] !== "function")) {
    fail("MEDIA_INVALID_CONFIG", "Media broker is required", 500);
  }

  return async function mediaRoutes(context) {
    const match = /^\/api\/media\/(join|leave|peers|signal|drain)$/.exec(context.url.pathname);
    if (!match) return false;
    if (context.request.method !== "POST") fail("METHOD_NOT_ALLOWED", "方法不支持", 405);
    const seatToken = context.token(context.request);
    const input = await context.readJson(context.request);
    const operation = match[1];
    const args = { roomId: input.roomId, seatToken };
    let result;
    try {
      if (operation === "signal") {
        result = broker.publishSignal({
          ...args,
          recipientSeatId: input.recipientSeatId,
          signal: input.signal,
        });
      } else {
        result = broker[operation](args);
      }
      result = await result;
    } catch (error) {
      if (error && !error.statusCode && STATUS_BY_CODE[error.code]) error.statusCode = STATUS_BY_CODE[error.code];
      throw error;
    }
    context.json(context.response, 200, result);
    return true;
  };
}

module.exports = { MediaRouteError, createMediaRoutes };

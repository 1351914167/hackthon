"use strict";

const { isDeepStrictEqual } = require("node:util");

class EventStoreError extends Error {
  constructor(code, message, latestSeq) {
    super(message);
    this.name = "EventStoreError";
    this.code = code;
    if (latestSeq !== undefined) this.latestSeq = latestSeq;
  }
}

function fail(code, message, latestSeq) {
  throw new EventStoreError(code, message, latestSeq);
}

function clone(value) {
  return structuredClone(value);
}

function createMemoryEventStore() {
  const streams = new Map();

  function streamFor(gameId) {
    return streams.get(gameId)?.events || [];
  }

  // The application calls this after authentication, before decide(), so a
  // successful retry is not rejected by the engine's newer sequence number.
  function findAction(gameId, action) {
    validateAction(gameId, action);
    const previous = streams.get(gameId)?.actions.get(action.actorSeatId)?.get(action.actionId);
    if (!previous) return null;
    if (!isDeepStrictEqual(previous.action, action)) {
      fail("ACTION_ID_CONFLICT", "The actionId was already used with different content", streamFor(gameId).length);
    }
    return clone(previous.result);
  }

  function append(gameId, expectedSeq, events, action) {
    validateAppendInput(gameId, expectedSeq, events, action);
    const previous = findAction(gameId, action);
    if (previous) return previous;

    const stream = streamFor(gameId);
    const latestSeq = stream.length;
    if (expectedSeq !== latestSeq) {
      fail("SEQUENCE_CONFLICT", "The event stream changed before this batch was appended", latestSeq);
    }
    validateBatch(gameId, expectedSeq, events, action.actionId, stream);

    // Prepare every fallible copy before committing either the event stream or
    // its idempotency record. A clone failure must not leave a partial write.
    let storedEvents;
    let storedAction;
    try {
      storedEvents = clone(events);
      storedAction = clone(action);
    } catch {
      fail("INVALID_REQUEST", "Actions and events must contain cloneable data");
    }
    const result = {
      gameId,
      previousSeq: expectedSeq,
      latestSeq: expectedSeq + storedEvents.length,
      events: clone(storedEvents),
    };
    const returnedResult = clone(result);
    const actions = new Map(streams.get(gameId)?.actions);
    const actorActions = new Map(actions.get(action.actorSeatId));
    actorActions.set(action.actionId, { action: storedAction, result });
    actions.set(action.actorSeatId, actorActions);
    streams.set(gameId, { events: stream.concat(storedEvents), actions });
    return returnedResult;
  }

  function load(gameId) {
    validateGameId(gameId);
    const events = streamFor(gameId);
    return { gameId, latestSeq: events.length, events: clone(events) };
  }

  function eventsAfter(gameId, afterSeq) {
    validateGameId(gameId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("INVALID_REQUEST", "afterSeq must be a non-negative safe integer");
    const stream = streamFor(gameId);
    if (afterSeq > stream.length) fail("SEQUENCE_CONFLICT", "afterSeq is ahead of the event stream", stream.length);
    return clone(stream.slice(afterSeq));
  }

  return Object.freeze({ append, eventsAfter, findAction, load });
}

function validateGameId(gameId) {
  if (typeof gameId !== "string" || !gameId.trim()) fail("INVALID_REQUEST", "gameId must be a non-empty string");
}

function validateAction(gameId, action) {
  validateGameId(gameId);
  if (!action || typeof action !== "object" || Array.isArray(action) ||
      action.schemaVersion !== 1 || action.gameId !== gameId ||
      typeof action.actionId !== "string" || !action.actionId.trim() ||
      typeof action.actorSeatId !== "string" || !action.actorSeatId.trim() ||
      typeof action.type !== "string" || !action.type.trim() ||
      typeof action.expectedVersion !== "string" || !action.expectedVersion) {
    fail("INVALID_REQUEST", "A versioned action bound to its stream and authenticated actor is required");
  }
}

function validateAppendInput(gameId, expectedSeq, events, action) {
  validateAction(gameId, action);
  if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
    fail("INVALID_REQUEST", "Internal expectedSeq must be a non-negative safe integer");
  }
  if (!Array.isArray(events) || events.length === 0) fail("INVALID_REQUEST", "events must be a non-empty array");
}

function validateBatch(gameId, expectedSeq, events, actionId, existingEvents) {
  const existingEventIds = new Set(existingEvents.map((event) => event.eventId));
  const batchEventIds = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedEventSeq = expectedSeq + index + 1;
    if (!event || typeof event !== "object" || Array.isArray(event) || event.gameId !== gameId ||
        event.schemaVersion !== 1 || typeof event.type !== "string" || !event.type.trim() ||
        typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) ||
        event.seq !== expectedEventSeq || typeof event.eventId !== "string" || !event.eventId ||
        event.causationId !== actionId) {
      fail("INVALID_EVENT_BATCH", "Every event must match the stream, sequence, and action");
    }
    if (existingEventIds.has(event.eventId) || batchEventIds.has(event.eventId)) {
      fail("INVALID_EVENT_BATCH", "Event identifiers must be unique");
    }
    batchEventIds.add(event.eventId);
  }
}

module.exports = { EventStoreError, createMemoryEventStore };

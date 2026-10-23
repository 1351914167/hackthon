"use strict";

const { isDeepStrictEqual } = require("node:util");
const { createRoomService } = require("../room");

function createPersistentRooms({ repository, clock = Date.now, serviceOptions = {} }) {
  const loaded = repository.load();
  const restored = loaded?.snapshot;
  if (restored) {
    for (const room of restored.rooms) {
      for (const seat of room.seats) {
        seat.connected = false;
        seat.disconnectedAt = clock();
      }
    }
  }
  let service = createRoomService({ ...serviceOptions, clock, ...(restored ? { restoredState: restored } : {}) });
  let revision = loaded?.revision || 0;
  const methods = {};
  for (const name of Object.keys(service)) {
    if (["getSnapshot", "serialize"].includes(name)) {
      methods[name] = (...args) => service[name](...args);
      continue;
    }
    methods[name] = (...args) => {
      const before = service.serialize();
      try {
        const result = service[name](...args);
        const after = service.serialize();
        if (!isDeepStrictEqual(before, after)) {
          const saved = repository.save(after, { expectedRevision: revision });
          revision = saved.revision;
        }
        return result;
      } catch (error) {
        service = createRoomService({ ...serviceOptions, clock, restoredState: before });
        throw error;
      }
    };
  }
  return Object.freeze(methods);
}

module.exports = { createPersistentRooms };

"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { createApplication, start: startHttp } = require("./http/application");
const { createSqliteRepository } = require("./persistence");
const { createPersistentRooms } = require("./persistence/room-repository");
const { createLingxiGateway } = require("./voice");
const { createFeatureRoutes } = require("./features");
const { createMediaBroker, parseIceServersFromEnv } = require("./media");
const { createMediaRoutes } = require("./media/routes");

function createRuntime(options = {}) {
  const clock = options.clock || Date.now;
  const filename = options.filename || process.env.DATA_FILE || path.resolve("data/wuyin.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const repository = options.repository || createSqliteRepository({ filename, now: clock });
  try {
    const rooms = createPersistentRooms({ repository, clock, serviceOptions: options.serviceOptions });
    const gateway = options.gateway || createLingxiGateway({ apiKey: process.env.LINGXI_API_KEY || "" });
    const features = createFeatureRoutes({ rooms, gateway, repository, clock,
      mediaDirectory: options.mediaDirectory || path.join(path.dirname(filename), "media") });
    const broker = createMediaBroker({ getSnapshot: rooms.getSnapshot, clock,
      iceServers: options.iceServers || parseIceServersFromEnv(process.env.ICE_SERVERS || "[]") });
    const media = createMediaRoutes({ broker });
    const extension = async (context) => await features(context) || await media(context);
    return { rooms, clock, extension, close: () => repository.close(), repository };
  } catch (error) {
    repository.close();
    throw error;
  }
}

function start(options = {}) {
  const runtime = options.rooms ? { rooms: options.rooms, extension: options.extension, close() {} } : createRuntime(options);
  const application = startHttp({ ...runtime, ...options,
    onError: options.onError || ((event) => console.error(JSON.stringify({ level: "error", ...event }))),
    allowedOrigins: options.allowedOrigins || (process.env.PUBLIC_ORIGIN ? [process.env.PUBLIC_ORIGIN] : undefined),
    secureCookies: process.env.COOKIE_SECURE === "true" });
  const stopHttp = application.stop;
  const processImpl = options.processImpl || process;
  const shutdown = () => application.stop();
  processImpl.once("SIGINT", shutdown);
  processImpl.once("SIGTERM", shutdown);
  let stopping;
  application.stop = () => {
    if (!stopping) {
      processImpl.off("SIGINT", shutdown);
      processImpl.off("SIGTERM", shutdown);
      stopping = stopHttp().finally(() => runtime.close());
    }
    return stopping;
  };
  return application;
}

module.exports = { createRuntime, start, createApplication };

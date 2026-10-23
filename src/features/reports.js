"use strict";

const { randomUUID } = require("node:crypto");

const MAX_REPORTS_PER_SEAT = 10;
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

class ReportError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ReportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new ReportError(code, message, statusCode);
}

function createReportRoutes(options = {}) {
  if (!options.rooms || typeof options.rooms.getSnapshot !== "function") fail("REPORT_INVALID_CONFIG", "Room service is required", 500);
  const rooms = options.rooms;
  const repository = options.repository;
  const clock = options.clock || Date.now;
  const createId = options.randomUUID || randomUUID;
  if (typeof clock !== "function" || typeof createId !== "function" ||
      (repository && (typeof repository.archive !== "function" || typeof repository.listArchives !== "function"))) {
    fail("REPORT_INVALID_CONFIG", "Report dependencies are invalid", 500);
  }

  const reports = new Map();
  restoreReports();

  async function extension(context) {
    const match = /^\/api\/rooms\/([A-Za-z0-9_-]+)\/reports$/.exec(context.url.pathname);
    if (!match) return false;
    const roomId = match[1];
    const snapshot = rooms.getSnapshot({ roomId, seatToken: context.token(context.request) });
    const gameId = snapshot.game?.gameId;
    if (!gameId) fail("ACTION_NOT_ALLOWED", "牌局开始后才能提交举报", 403);
    if (context.request.method === "POST") {
      const input = await context.readJson(context.request);
      context.json(context.response, 201, createReport(snapshot, input));
      return true;
    }
    if (context.request.method === "GET") {
      if (snapshot.selfSeatId !== snapshot.hostSeatId) fail("ACTION_NOT_ALLOWED", "只有当前房主可以查看本房间举报", 403);
      context.json(context.response, 200, { reports: list(roomId, gameId) });
      return true;
    }
    fail("METHOD_NOT_ALLOWED", "方法不支持", 405);
  }

  function createReport(snapshot, input) {
    const gameId = snapshot.game.gameId;
    const targetSeatId = typeof input.targetSeatId === "string" ? input.targetSeatId : "";
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!snapshot.seats.some((seat) => seat.seatId === targetSeatId)) fail("INVALID_REQUEST", "举报目标不在当前房间", 400);
    if (!reason || reason.length > 200) fail("INVALID_REQUEST", "举报原因需为 1 到 200 个字符", 400);
    const current = list(snapshot.roomId, gameId).filter((report) => report.reporterSeatId === snapshot.selfSeatId).length;
    if (current >= MAX_REPORTS_PER_SEAT) fail("REPORT_LIMIT", "每名玩家每局最多提交 10 条举报", 429);
    const reportId = createId();
    if (typeof reportId !== "string" || !REPORT_ID_PATTERN.test(reportId) || reports.has(reportId)) {
      fail("REPORT_ID_INVALID", "无法生成举报编号", 500);
    }
    const createdAt = readClock(clock);
    const report = {
      reportId,
      roomId: snapshot.roomId,
      gameId,
      reporterSeatId: snapshot.selfSeatId,
      targetSeatId,
      reason,
      createdAt,
    };
    if (repository) {
      repository.archive({
        schemaVersion: 1,
        recordId: reportId,
        roomId: report.roomId,
        gameId: report.gameId,
        kind: "NOTE",
        createdAt: new Date(createdAt).toISOString(),
        data: { type: "REPORT", reportId, reporterSeatId: report.reporterSeatId, targetSeatId, reason },
      });
    }
    reports.set(reportId, report);
    return structuredClone(report);
  }

  function list(roomId, gameId) {
    return [...reports.values()]
      .filter((report) => report.roomId === roomId && report.gameId === gameId)
      .sort((left, right) => left.createdAt - right.createdAt || left.reportId.localeCompare(right.reportId))
      .map((report) => structuredClone(report));
  }

  function restoreReports() {
    if (!repository) return;
    for (const item of repository.listArchives({ kind: "NOTE" })) {
      const data = item.data;
      if (data?.type !== "REPORT" || typeof data.reportId !== "string" || !REPORT_ID_PATTERN.test(data.reportId) ||
          typeof data.reporterSeatId !== "string" || typeof data.targetSeatId !== "string" ||
          typeof data.reason !== "string" || !data.reason || data.reason.length > 200 ||
          typeof item.roomId !== "string" || typeof item.gameId !== "string") continue;
      const createdAt = Date.parse(item.createdAt);
      if (!Number.isFinite(createdAt)) continue;
      reports.set(data.reportId, {
        reportId: data.reportId,
        roomId: item.roomId,
        gameId: item.gameId,
        reporterSeatId: data.reporterSeatId,
        targetSeatId: data.targetSeatId,
        reason: data.reason,
        createdAt,
      });
    }
  }

  return extension;
}

function readClock(clock) {
  const value = Number(clock());
  if (!Number.isSafeInteger(value) || value < 0) fail("REPORT_INVALID_CONFIG", "Clock returned an invalid time", 500);
  return value;
}

module.exports = { MAX_REPORTS_PER_SEAT, ReportError, createReportRoutes };

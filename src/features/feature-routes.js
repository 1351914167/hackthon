"use strict";

const { createHash } = require("node:crypto");
const { createLingxiGateway, createVoiceSegmentStore } = require("../voice");
const { createMediaFileStore } = require("../persistence/media-files");
const { createReportRoutes } = require("./reports");

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const MAX_DURATION_MS = 90_000;
const MAX_MARKS_PER_PLAYER = 200;
const MAX_LABEL_LENGTH = 200;
const DEFAULT_ROOM_VOICE_BYTES = 48 * 1024 * 1024;
const DEFAULT_SEAT_VOICE_BYTES = 24 * 1024 * 1024;
const DEFAULT_SEAT_CLIPS = 32;
const DEFAULT_ROOM_INFLIGHT = 3;
const DEFAULT_SEAT_INFLIGHT = 1;
const SPEECH_PHASES = new Set(["DAY_SPEECH", "LAST_WORD"]);

class FeatureError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "FeatureError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new FeatureError(code, message, statusCode);
}

function createFeatureRoutes(options = {}) {
  if (!options.rooms || typeof options.rooms.getSnapshot !== "function") {
    fail("FEATURE_INVALID_CONFIG", "Room service is required", 500);
  }
  const configuredRooms = options.rooms;
  const clock = options.clock || Date.now;
  if (typeof clock !== "function") fail("FEATURE_INVALID_CONFIG", "Feature clock is invalid", 500);
  const maxMarksPerPlayer = options.maxMarksPerPlayer ?? MAX_MARKS_PER_PLAYER;
  if (!Number.isSafeInteger(maxMarksPerPlayer) || maxMarksPerPlayer <= 0 || maxMarksPerPlayer > MAX_MARKS_PER_PLAYER) {
    fail("FEATURE_INVALID_CONFIG", "Bookmark limit must be between 1 and 200", 500);
  }
  const limits = {
    roomBytes: positiveOption(options.maxRoomVoiceBytes, DEFAULT_ROOM_VOICE_BYTES, "maxRoomVoiceBytes"),
    seatBytes: positiveOption(options.maxSeatVoiceBytes, DEFAULT_SEAT_VOICE_BYTES, "maxSeatVoiceBytes"),
    seatClips: positiveOption(options.maxSeatVoiceClips, DEFAULT_SEAT_CLIPS, "maxSeatVoiceClips"),
    roomInflight: positiveOption(options.maxRoomVoiceInflight, DEFAULT_ROOM_INFLIGHT, "maxRoomVoiceInflight"),
    seatInflight: positiveOption(options.maxSeatVoiceInflight, DEFAULT_SEAT_INFLIGHT, "maxSeatVoiceInflight"),
  };
  const gateway = options.gateway || createLingxiGateway({ apiKey: "" });
  const segments = options.segments || createVoiceSegmentStore({ now: clock });
  const repository = options.repository;
  const mediaFiles = options.mediaFiles || (options.mediaDirectory ? createMediaFileStore({
    directory: options.mediaDirectory,
    clock,
    ...(options.mediaTtlMs === undefined ? {} : { ttlMs: options.mediaTtlMs }),
    ...(options.maxMediaBytes === undefined ? {} : { maxTotalBytes: options.maxMediaBytes }),
  }) : null);
  if (!gateway || typeof gateway.status !== "function" ||
      typeof gateway.transcribe !== "function" || typeof gateway.synthesize !== "function" ||
      !segments || typeof segments.put !== "function" || typeof segments.get !== "function" ||
      typeof segments.remove !== "function" ||
      (repository && (typeof repository.archive !== "function" || typeof repository.listArchives !== "function")) ||
      (mediaFiles && (typeof mediaFiles.put !== "function" || typeof mediaFiles.get !== "function" ||
        typeof mediaFiles.remove !== "function" || typeof mediaFiles.sweep !== "function"))) {
    fail("FEATURE_INVALID_CONFIG", "Feature dependencies are invalid", 500);
  }

  const records = new Map();
  const marksByViewer = new Map();
  const narrationCache = new Map();
  const roomInflight = new Map();
  const seatInflight = new Map();
  const reportRoutes = createReportRoutes({ rooms: configuredRooms, repository, clock, randomUUID: options.randomUUID });
  restoreArchives();

  async function extension(context) {
    const { request, response, url, token, json, readBody, readJson } = context;
    if (await reportRoutes(context)) return true;
    if (url.pathname === "/api/lingxi/status") {
      requireMethod(request, "GET");
      json(response, 200, gateway.status());
      return true;
    }

    const recapRoute = /^\/api\/rooms\/([A-Za-z0-9_-]+)\/(recap|narration)$/.exec(url.pathname);
    if (recapRoute) {
      const [, roomId, operation] = recapRoute;
      if (operation === "recap") {
        requireMethod(request, "GET");
        json(response, 200, buildRecap(authenticate(configuredRooms, roomId, token(request))));
      } else {
        requireMethod(request, "POST");
        await sendNarration(authenticate(configuredRooms, roomId, token(request)), response);
      }
      return true;
    }

    const voiceRoute = /^\/api\/rooms\/([A-Za-z0-9_-]+)\/voice(?:\/([A-Za-z0-9._:-]+)(?:\/(mark|remove))?)?$/.exec(url.pathname);
    if (!voiceRoute) return false;
    const [, roomId, segmentId, operation] = voiceRoute;
    const seatToken = token(request);
    const snapshot = authenticate(configuredRooms, roomId, seatToken);

    if (!segmentId) {
      if (request.method === "POST") {
        requireConnected(snapshot);
        requireSpeakingContext(snapshot, readClock(clock));
        const release = acquireUpload(roomId, snapshot.selfSeatId);
        try {
          const formData = await parseMultipart(request, readBody);
          const acceptedSnapshot = authenticate(configuredRooms, roomId, seatToken);
          requireConnected(acceptedSnapshot);
          json(response, 201, await uploadVoice({ roomId, seatToken, snapshot: acceptedSnapshot, formData }));
        } finally {
          release();
        }
      } else if (request.method === "GET") {
        json(response, 200, { segments: visibleSegments(snapshot) });
      } else {
        fail("METHOD_NOT_ALLOWED", "方法不支持", 405);
      }
      return true;
    }

    if (!operation && request.method === "GET") {
      sendAudio(snapshot, segmentId, response);
      return true;
    }
    if (operation === "mark" && request.method === "POST") {
      json(response, 200, markSegment(snapshot, segmentId, await readJson(request)));
      return true;
    }
    if (operation === "remove" && request.method === "POST") {
      json(response, 200, removeSegment(snapshot, segmentId));
      return true;
    }
    fail("METHOD_NOT_ALLOWED", "方法不支持", 405);
  }

  async function uploadVoice({ roomId, seatToken, snapshot, formData }) {
    const context = requireSpeakingContext(snapshot, readClock(clock));
    pruneRoom(roomId, context.gameId);
    const file = requireFile(formData);
    const durationMs = requireDuration(formData);
    const retain = formData.get("retain") === "true";
    if (retain && (!repository || !mediaFiles)) {
      fail("MEDIA_RETENTION_UNAVAILABLE", "服务端尚未配置原声保留能力", 503);
    }
    const audio = Buffer.from(await file.arrayBuffer());
    enforceUploadQuota(roomId, context.gameId, context.speakerSeatId, audio.length);
    const contentType = file.type.split(";", 1)[0].toLowerCase();
    const transcriptionForm = new FormData();
    transcriptionForm.append("file", new Blob([audio], { type: contentType }), file.name);
    const allowedSeatIds = snapshot.seats.map((seat) => seat.seatId);
    const stored = segments.put({
      roomId,
      gameId: context.gameId,
      phaseKey: context.phaseKey,
      speakerSeatId: context.speakerSeatId,
      allowedSeatIds,
      audio,
      contentType,
    });
    const record = {
      ...stored,
      durationMs,
      retain,
      transcriptStatus: "pending",
      transcript: null,
      allowedSeatIds: new Set(allowedSeatIds),
    };
    records.set(stored.segmentId, record);

    try {
      const transcription = await gateway.transcribe({
        seatId: rateKey("voice", roomId, context.gameId, context.speakerSeatId),
        formData: transcriptionForm,
      });
      record.transcript = transcription.text.trim() || null;
      record.transcriptStatus = record.transcript ? "ready" : "failed";
    } catch {
      record.transcriptStatus = "failed";
    }

    let current;
    try {
      current = authenticate(configuredRooms, roomId, seatToken);
    } catch (error) {
      discardRecord(record.segmentId);
      throw error;
    }
    if (current.game?.gameId !== context.gameId) {
      discardRecord(record.segmentId);
      fail("VOICE_CONTEXT_EXPIRED", "语音所属牌局已经结束或重开", 409);
    }
    if (retain) persistVoice(record, audio);
    return publicRecord(record, current.selfSeatId);
  }

  function visibleSegments(snapshot) {
    const game = requireCurrentGame(snapshot);
    pruneRoom(snapshot.roomId, game.gameId);
    return [...records.values()]
      .filter((record) => record.roomId === snapshot.roomId && record.gameId === game.gameId &&
        recordVisibleTo(record, snapshot) && (game.phase !== "GAME_OVER" || record.retain))
      .sort((left, right) => right.createdAt - left.createdAt || left.segmentId.localeCompare(right.segmentId))
      .map((record) => publicRecord(record, snapshot.selfSeatId));
  }

  function sendAudio(snapshot, segmentId, response) {
    const record = requireVisibleRecord(snapshot, segmentId);
    let value;
    try {
      value = segments.get({
        segmentId,
        roomId: record.roomId,
        gameId: record.gameId,
        phaseKey: record.phaseKey,
        requesterSeatId: snapshot.selfSeatId,
      });
    } catch (error) {
      if (!record.retain || !mediaFiles || error?.code !== "VOICE_SEGMENT_NOT_FOUND") throw error;
      const restored = mediaFiles.get({ sha256: record.sha256 });
      value = { ...record, audio: restored.audio };
    }
    response.writeHead(200, {
      "Content-Type": value.contentType,
      "Content-Length": value.audio.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Voice-SHA256": value.sha256,
    });
    response.end(value.audio);
  }

  function markSegment(snapshot, segmentId, input) {
    const record = requireVisibleRecord(snapshot, segmentId);
    const label = typeof input.label === "string" ? input.label.trim() : "";
    if (!label || label.length > MAX_LABEL_LENGTH) fail("INVALID_REQUEST", "声证标签需为 1 到 200 个字符", 400);
    const key = viewerKey(snapshot.roomId, record.gameId, snapshot.selfSeatId);
    let marks = marksByViewer.get(key);
    if (!marks) {
      marks = new Map();
      marksByViewer.set(key, marks);
    }
    const existing = marks.get(segmentId);
    if (!existing && marks.size >= maxMarksPerPlayer) fail("VOICE_MARK_LIMIT", "每名玩家最多保存 200 个声证标记", 429);
    if (existing && existing.label !== label) fail("VOICE_MARK_CONFLICT", "同一声证标记不能静默改写", 409);
    if (existing) return structuredClone(existing);
    const mark = { segmentId, label, createdAt: readClock(clock) };
    if (repository) archiveMark(snapshot, record, mark);
    marks.set(segmentId, mark);
    return structuredClone(mark);
  }

  function removeSegment(snapshot, segmentId) {
    const record = requireVisibleRecord(snapshot, segmentId);
    if (record.speakerSeatId !== snapshot.selfSeatId) fail("ACTION_NOT_ALLOWED", "只能清理本人录制的原声", 403);
    if (repository) archiveDeletion(snapshot, record);
    if (record.retain && !hasActivePersistentReference(record.sha256, record.segmentId)) mediaFiles?.remove(record.sha256);
    discardRecord(segmentId);
    return { segmentId, removed: true };
  }

  function buildRecap(snapshot) {
    const game = requireCurrentGame(snapshot);
    if (game.phase !== "GAME_OVER") fail("ACTION_NOT_ALLOWED", "牌局结束后才能查看复盘", 403);
    const segmentValues = visibleSegments(snapshot);
    const visibleSegmentIds = new Set(segmentValues.map((segment) => segment.segmentId));
    const marks = viewerMarks(snapshot.roomId, game.gameId, snapshot.selfSeatId)
      .filter((mark) => visibleSegmentIds.has(mark.segmentId));
    const votes = (game.voteHistory || []).map((vote) => ({ id: `vote:${vote.round}`, ...structuredClone(vote) }));
    const deaths = (game.deaths || []).map((death, index) => ({ id: `death:${death.round}:${death.seatId}:${index}`, ...structuredClone(death) }));
    const turningPoints = [];
    for (const vote of votes) {
      turningPoints.push({
        text: vote.exiledSeatId ? `第 ${vote.round} 轮公投放逐 ${vote.exiledSeatId}` : `第 ${vote.round} 轮公投平票，无人放逐`,
        references: [{ type: "vote", id: vote.id }],
      });
    }
    for (const death of deaths) {
      turningPoints.push({ text: `${death.seatId} 在第 ${death.round} 轮出局`, references: [{ type: "death", id: death.id }] });
    }
    for (const mark of marks) {
      turningPoints.push({ text: mark.label, references: [{ type: "voice", id: mark.segmentId }] });
    }
    const recap = {
      gameId: game.gameId,
      winner: game.result?.winner || null,
      roles: structuredClone(game.revealedRoles || []),
      votes,
      deaths,
      turningPoints,
      segments: segmentValues,
      marks,
    };
    validateReferences(recap);
    if (repository) archiveRecap(snapshot, recap);
    return recap;
  }

  async function sendNarration(snapshot, response) {
    const game = requireCurrentGame(snapshot);
    const phaseKey = makePhaseKey(game);
    const key = `${snapshot.roomId}\u0000${game.gameId}\u0000${phaseKey}`;
    const text = narrationText(game);
    const roomPrefix = `${snapshot.roomId}\u0000`;
    for (const cachedKey of narrationCache.keys()) {
      if (cachedKey.startsWith(roomPrefix) && cachedKey !== key) narrationCache.delete(cachedKey);
    }
    let pending = narrationCache.get(key);
    if (!pending) {
      pending = gateway.synthesize({ seatId: rateKey("narration", snapshot.roomId, game.gameId), text })
        .catch((error) => {
          narrationCache.delete(key);
          throw error;
        });
      narrationCache.set(key, pending);
    }
    let value;
    try {
      value = await pending;
    } catch {
      fail("NARRATION_UNAVAILABLE", text, 503);
    }
    response.writeHead(200, {
      "Content-Type": value.contentType,
      "Content-Length": value.audio.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(value.audio);
  }

  function requireVisibleRecord(snapshot, segmentId) {
    const game = requireCurrentGame(snapshot);
    pruneRoom(snapshot.roomId, game.gameId);
    const record = records.get(segmentId);
    if (!record || record.roomId !== snapshot.roomId || record.gameId !== game.gameId ||
        !recordVisibleTo(record, snapshot) || (game.phase === "GAME_OVER" && !record.retain)) {
      fail("VOICE_SEGMENT_NOT_FOUND", "声证片段不存在", 404);
    }
    return record;
  }

  function pruneRoom(roomId, gameId) {
    const now = readClock(clock);
    mediaFiles?.sweep();
    for (const record of records.values()) {
      if (record.expiresAt <= now || (record.roomId === roomId && record.gameId !== gameId)) discardRecord(record.segmentId);
    }
  }

  function discardRecord(segmentId) {
    segments.remove(segmentId);
    records.delete(segmentId);
    for (const marks of marksByViewer.values()) marks.delete(segmentId);
  }

  function acquireUpload(roomId, seatId) {
    const seatKey = viewerKey(roomId, "upload", seatId);
    const roomCount = roomInflight.get(roomId) || 0;
    const seatCount = seatInflight.get(seatKey) || 0;
    if (seatCount >= limits.seatInflight) fail("VOICE_INFLIGHT_LIMIT", "当前席位已有语音正在处理", 429);
    if (roomCount >= limits.roomInflight) fail("VOICE_ROOM_INFLIGHT_LIMIT", "当前房间语音处理已达上限", 429);
    roomInflight.set(roomId, roomCount + 1);
    seatInflight.set(seatKey, seatCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      decrement(roomInflight, roomId);
      decrement(seatInflight, seatKey);
    };
  }

  function enforceUploadQuota(roomId, gameId, seatId, incomingBytes) {
    let roomBytes = 0;
    let seatBytes = 0;
    let seatClips = 0;
    for (const record of records.values()) {
      if (record.roomId !== roomId || record.gameId !== gameId) continue;
      roomBytes += record.size;
      if (record.speakerSeatId === seatId) {
        seatBytes += record.size;
        seatClips += 1;
      }
    }
    if (roomBytes + incomingBytes > limits.roomBytes) fail("VOICE_ROOM_QUOTA", "当前房间原声容量已达上限", 429);
    if (seatBytes + incomingBytes > limits.seatBytes) fail("VOICE_SEAT_QUOTA", "当前席位原声容量已达上限", 429);
    if (seatClips >= limits.seatClips) fail("VOICE_CLIP_QUOTA", "当前席位原声片段数已达上限", 429);
  }

  function persistVoice(record, audio) {
    let media;
    try {
      media = mediaFiles.put({ sha256: record.sha256, audio });
      record.expiresAt = media.expiresAt;
      repository.archive({
        schemaVersion: 1,
        recordId: archiveId("voice", record.gameId, record.segmentId),
        roomId: record.roomId,
        gameId: record.gameId,
        kind: "VOICE_REF",
        createdAt: new Date(record.createdAt).toISOString(),
        data: persistedRecord(record),
      });
    } catch (error) {
      if (media) mediaFiles.remove(record.sha256);
      discardRecord(record.segmentId);
      throw error;
    }
  }

  function archiveMark(snapshot, record, mark) {
    repository.archive({
      schemaVersion: 1,
      recordId: archiveId("mark", record.gameId, snapshot.selfSeatId, record.segmentId),
      roomId: snapshot.roomId,
      gameId: record.gameId,
      kind: "NOTE",
      createdAt: new Date(mark.createdAt).toISOString(),
      data: { type: "VOICE_MARK", segmentId: record.segmentId, viewerSeatId: snapshot.selfSeatId, label: mark.label },
    });
  }

  function archiveDeletion(snapshot, record) {
    const removedAt = readClock(clock);
    repository.archive({
      schemaVersion: 1,
      recordId: archiveId("deleted", record.gameId, record.segmentId),
      roomId: snapshot.roomId,
      gameId: record.gameId,
      kind: "NOTE",
      createdAt: new Date(removedAt).toISOString(),
      data: { type: "VOICE_DELETED", segmentId: record.segmentId, speakerSeatId: snapshot.selfSeatId, sha256: record.sha256 },
    });
  }

  function archiveRecap(snapshot, recap) {
    const contentId = createHash("sha256").update(JSON.stringify(recap)).digest("hex");
    const evidenceTime = Math.max(0, ...recap.segments.map((item) => item.createdAt), ...recap.marks.map((item) => item.createdAt));
    repository.archive({
      schemaVersion: 1,
      recordId: archiveId("recap", recap.gameId, snapshot.selfSeatId, contentId),
      roomId: snapshot.roomId,
      gameId: recap.gameId,
      kind: "RECAP",
      createdAt: new Date(evidenceTime).toISOString(),
      data: { viewerSeatId: snapshot.selfSeatId, recap },
    });
  }

  function restoreArchives() {
    if (!repository || !mediaFiles) return;
    const notes = repository.listArchives({ kind: "NOTE" });
    const tombstones = notes.filter((item) => item.data?.type === "VOICE_DELETED");
    const deleted = new Set(tombstones.map((item) => item.data.segmentId));
    const now = readClock(clock);
    const voiceReferences = repository.listArchives({ kind: "VOICE_REF" });
    const activeReferences = voiceReferences.filter((item) => validPersistedRecord(item.data) &&
      item.data.roomId === item.roomId && item.data.gameId === item.gameId && !deleted.has(item.data.segmentId) && item.data.expiresAt > now);
    const activeHashes = new Set(activeReferences.map((item) => item.data.sha256));
    for (const item of tombstones) {
      if (/^[a-f0-9]{64}$/.test(item.data.sha256 || "") && !activeHashes.has(item.data.sha256)) mediaFiles.remove(item.data.sha256);
    }
    for (const item of activeReferences) {
      const data = item.data;
      try {
        const media = mediaFiles.get({ sha256: data.sha256 });
        records.set(data.segmentId, {
          ...structuredClone(data),
          retain: true,
          expiresAt: media.metadata.expiresAt,
          allowedSeatIds: null,
        });
      } catch (error) {
        if (!["MEDIA_NOT_FOUND", "MEDIA_EXPIRED"].includes(error?.code)) throw error;
      }
    }
    for (const item of notes) {
      const data = item.data;
      if (data?.type !== "VOICE_MARK" || !records.has(data.segmentId) || typeof data.viewerSeatId !== "string" ||
          typeof data.label !== "string" || !data.label || data.label.length > MAX_LABEL_LENGTH) continue;
      const record = records.get(data.segmentId);
      if (record.roomId !== item.roomId || record.gameId !== item.gameId) continue;
      const key = viewerKey(item.roomId, item.gameId, data.viewerSeatId);
      let marks = marksByViewer.get(key);
      if (!marks) {
        marks = new Map();
        marksByViewer.set(key, marks);
      }
      marks.set(data.segmentId, { segmentId: data.segmentId, label: data.label, createdAt: Date.parse(item.createdAt) });
    }
  }

  function hasActivePersistentReference(sha256, excludedSegmentId) {
    if (!repository) return false;
    const deleted = new Set(repository.listArchives({ kind: "NOTE" })
      .filter((item) => item.data?.type === "VOICE_DELETED")
      .map((item) => item.data.segmentId));
    const now = readClock(clock);
    return repository.listArchives({ kind: "VOICE_REF" }).some((item) => item.data?.sha256 === sha256 &&
      item.data.segmentId !== excludedSegmentId && !deleted.has(item.data.segmentId) &&
      Number.isSafeInteger(item.data.expiresAt) && item.data.expiresAt > now);
  }

  function recordVisibleTo(record, snapshot) {
    return record.allowedSeatIds ? record.allowedSeatIds.has(snapshot.selfSeatId) : snapshot.seats.some((seat) => seat.seatId === snapshot.selfSeatId);
  }

  function publicRecord(record, viewerSeatId) {
    const mark = marksByViewer.get(viewerKey(record.roomId, record.gameId, viewerSeatId))?.get(record.segmentId);
    return {
      segmentId: record.segmentId,
      roomId: record.roomId,
      gameId: record.gameId,
      phaseKey: record.phaseKey,
      speakerSeatId: record.speakerSeatId,
      contentType: record.contentType,
      size: record.size,
      sha256: record.sha256,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      durationMs: record.durationMs,
      retain: record.retain,
      transcriptStatus: record.transcriptStatus,
      transcript: record.transcript,
      ...(mark ? { mark: structuredClone(mark) } : {}),
    };
  }

  function viewerMarks(roomId, gameId, seatId) {
    return [...(marksByViewer.get(viewerKey(roomId, gameId, seatId))?.values() || [])]
      .sort((left, right) => left.createdAt - right.createdAt || left.segmentId.localeCompare(right.segmentId))
      .map((mark) => structuredClone(mark));
  }

  return extension;
}

function persistedRecord(record) {
  return {
    type: "VOICE_REF",
    segmentId: record.segmentId,
    roomId: record.roomId,
    gameId: record.gameId,
    phaseKey: record.phaseKey,
    speakerSeatId: record.speakerSeatId,
    contentType: record.contentType,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    durationMs: record.durationMs,
    retain: true,
    transcriptStatus: record.transcriptStatus,
    transcript: record.transcript,
  };
}

function validPersistedRecord(value) {
  return value?.type === "VOICE_REF" && typeof value.segmentId === "string" && typeof value.roomId === "string" &&
    typeof value.gameId === "string" && typeof value.phaseKey === "string" && typeof value.speakerSeatId === "string" &&
    typeof value.contentType === "string" && Number.isSafeInteger(value.size) && value.size > 0 &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.expiresAt) && Number.isSafeInteger(value.durationMs) &&
    ["ready", "failed"].includes(value.transcriptStatus) && (value.transcript === null || typeof value.transcript === "string");
}

function archiveId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${prefix}.${digest}`;
}

function rateKey(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${prefix}:${digest}`;
}

async function parseMultipart(request, readBody) {
  const contentType = request.headers["content-type"] || "";
  if (!/^multipart\/form-data;/i.test(contentType)) fail("UNSUPPORTED_MEDIA_TYPE", "需要 multipart/form-data 请求", 415);
  let bytes;
  try {
    bytes = await readBody(request, MAX_MULTIPART_BYTES);
    return await new Request("http://localhost/upload", { method: "POST", headers: { "Content-Type": contentType }, body: bytes }).formData();
  } catch (error) {
    if (error instanceof FeatureError || error?.code === "PAYLOAD_TOO_LARGE") throw error;
    fail("INVALID_REQUEST", "语音 multipart 数据无效", 400);
  }
}

function requireFile(formData) {
  const files = formData.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof Blob)) fail("INVALID_REQUEST", "需要且只能上传一个语音文件", 400);
  if (files[0].size > MAX_AUDIO_BYTES) fail("PAYLOAD_TOO_LARGE", "语音文件不能超过 16MB", 413);
  return files[0];
}

function requireDuration(formData) {
  const values = formData.getAll("durationMs");
  if (values.length !== 1 || typeof values[0] !== "string" || !/^\d+$/.test(values[0])) {
    fail("INVALID_REQUEST", "durationMs 必须是毫秒整数", 400);
  }
  const duration = Number(values[0]);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_DURATION_MS) {
    fail("VOICE_DURATION_LIMIT", "单段语音不能超过 90 秒", 413);
  }
  return duration;
}

function authenticate(rooms, roomId, seatToken) {
  return rooms.getSnapshot({ roomId, seatToken });
}

function requireSpeakingContext(snapshot, now) {
  const game = requireCurrentGame(snapshot);
  const deadline = Date.parse(game.deadlineAt);
  if (!SPEECH_PHASES.has(game.phase) || snapshot.selfSeatId !== game.currentSpeakerSeatId ||
      !Number.isFinite(deadline) || deadline <= now) {
    fail("ACTION_NOT_ALLOWED", "当前席位没有发言权", 403);
  }
  return { gameId: game.gameId, speakerSeatId: snapshot.selfSeatId, phaseKey: makePhaseKey(game) };
}

function requireConnected(snapshot) {
  const seat = snapshot?.seats?.find((candidate) => candidate.seatId === snapshot.selfSeatId);
  if (!seat?.connected) fail("ACTION_NOT_ALLOWED", "离线席位不能上传语音", 403);
}

function requireCurrentGame(snapshot) {
  if (!snapshot?.selfSeatId || !snapshot.game?.gameId) fail("VOICE_CONTEXT_EXPIRED", "当前没有可用牌局", 409);
  return snapshot.game;
}

function makePhaseKey(game) {
  return `${game.round}:${game.phase}:${game.currentSpeakerSeatId || "none"}:${game.deadlineAt || "none"}`;
}

function narrationText(game) {
  const texts = {
    ROLE_REVEAL: "身份已经发放，请确认你的角色。",
    NIGHT_WOLF: "天黑请闭眼，狼人请选择袭击目标。",
    NIGHT_WITCH: "女巫请行动。",
    NIGHT_SEER: "预言家请选择查验目标。",
    DAWN_RESOLUTION: "天亮了，正在公布昨夜结果。",
    DAY_VOTE: "发言结束，请所有存活玩家投票。",
    HUNTER_SHOT: "猎人请选择开枪目标，或放弃开枪。",
    GAME_OVER: "牌局结束，请查看可验证复盘。",
  };
  if (game.phase === "DAY_SPEECH") return `现在请 ${game.currentSpeakerSeatId} 发言。`;
  if (game.phase === "LAST_WORD") return `现在请 ${game.currentSpeakerSeatId} 发表遗言。`;
  return texts[game.phase] || "牌局阶段已经更新，请查看文字提示。";
}

function validateReferences(recap) {
  const ids = {
    vote: new Set(recap.votes.map((item) => item.id)),
    death: new Set(recap.deaths.map((item) => item.id)),
    voice: new Set(recap.segments.map((item) => item.segmentId)),
  };
  for (const point of recap.turningPoints) {
    for (const reference of point.references) {
      if (!ids[reference.type]?.has(reference.id)) fail("RECAP_REFERENCE_INVALID", "复盘包含无效证据引用", 500);
    }
  }
}

function viewerKey(roomId, gameId, seatId) {
  return `${roomId}\u0000${gameId}\u0000${seatId}`;
}

function readClock(clock) {
  const value = Number(clock());
  if (!Number.isSafeInteger(value) || value < 0) fail("FEATURE_INVALID_CONFIG", "时钟返回值无效", 500);
  return value;
}

function positiveOption(value, fallback, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0) fail("FEATURE_INVALID_CONFIG", `${name} must be a positive integer`, 500);
  return result;
}

function decrement(map, key) {
  const value = (map.get(key) || 1) - 1;
  if (value <= 0) map.delete(key);
  else map.set(key, value);
}

function requireMethod(request, method) {
  if (request.method !== method) fail("METHOD_NOT_ALLOWED", "方法不支持", 405);
}

module.exports = { FeatureError, createFeatureRoutes };

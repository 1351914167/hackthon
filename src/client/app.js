(function initApp(root, factory) {
  const api = typeof module === "object" && module.exports ? factory(require("./core")) : factory(root.WuyinCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WuyinApp = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function appFactory(core) {
  "use strict";

  function unwrapSnapshot(payload) {
    return payload?.snapshot || (payload?.roomId && payload?.version ? payload : null);
  }

  function segmentsFrom(payload) {
    const values = Array.isArray(payload) ? payload : payload?.segments;
    return Array.isArray(values) ? values : [];
  }

  function statusFromLingxi(payload) {
    const implemented = payload?.implemented || {};
    const checked = payload?.checked || {};
    const healthy = payload?.healthy || {};
    const configured = payload?.configured === true;
    const checkedTranscription = checked.transcription === true;
    const available = configured && implemented.transcription === true && checkedTranscription && healthy.transcription === true;
    const narrationAvailable = configured && implemented.speech === true && (checked.speech !== true || healthy.speech === true);
    return {
      available,
      narrationAvailable,
      label: available ? "灵汐字幕在线" : configured ? (checkedTranscription ? "灵汐字幕异常" : "灵汐字幕待检") : "原声可用 · 无字幕",
    };
  }

  function createApp(options) {
    const api = options.api;
    const view = options.view;
    const voice = options.voice;
    const sessionStore = options.sessionStore;
    const now = options.now;
    const randomUUID = options.randomUUID;
    const interval = options.setInterval;
    const clearIntervalFn = options.clearInterval;
    const clipboard = options.clipboard;
    const createPeer = options.createPeer;
    let stream = null;
    let peer = null;
    let peerEpoch = 0;
    let peerSync = Promise.resolve();
    let startingPeer = null;
    let timer = null;
    let lastNarrationKey = "";
    let disposed = false;
    const state = {
      booting: true,
      busy: false,
      error: "",
      snapshot: null,
      roomHint: options.roomHint || "",
      selectedSeatId: null,
      segments: [],
      recap: null,
      recording: false,
      voiceBusy: false,
      voiceStatus: { available: false, narrationAvailable: false, label: "检查灵汐" },
      verifications: {},
      pendingIntent: null,
      retainVoice: false,
      liveVoice: { supported: Boolean(createPeer), enabled: false, connected: false, connecting: false, error: "" },
      reportReason: "不当发言，请房主核查",
      reports: [],
      reportsOpen: false,
      reportGameId: null,
    };

    function render() {
      if (!disposed) {
        const model = core.createViewModel(state, now());
        model.reportReason = state.reportReason;
        model.reports = state.reports;
        model.reportsOpen = state.reportsOpen;
        view.render(model);
      }
    }

    function setError(error) {
      state.error = error?.message || String(error || "请求失败");
      view.showAlert(state.error);
      render();
    }

    function updateSnapshot(snapshot) {
      if (!snapshot || !snapshot.roomId || !snapshot.version) return false;
      const previous = state.snapshot?.game;
      const next = snapshot.game;
      if (previous && (previous.gameId !== next?.gameId || previous.phase !== next.phase ||
          previous.round !== next.round || previous.currentSpeakerSeatId !== next.currentSpeakerSeatId)) voice.cancel();
      state.snapshot = snapshot;
      state.error = "";
      const nextGameId = snapshot.game?.gameId || null;
      if (state.reportGameId !== nextGameId) {
        state.reportGameId = nextGameId;
        state.reports = [];
        state.reportsOpen = false;
      }
      if (state.selectedSeatId && !snapshot.seats.some((seat) => seat.seatId === state.selectedSeatId)) state.selectedSeatId = null;
      render();
      requestNarration(snapshot);
      syncPeer(snapshot);
      if (snapshot.status === "FINISHED" || snapshot.game?.phase === "GAME_OVER") loadRecap();
      return true;
    }

    function syncPeer(snapshot) {
      if (!snapshot?.game || snapshot.game.phase === "GAME_OVER") return stopPeer();
      const epoch = peerEpoch;
      if (peer && peer === startingPeer) {
        const active = peer;
        return active.updateRoomSnapshot(snapshot).catch((error) => {
          if (epoch !== peerEpoch || peer !== active) return;
          state.liveVoice = { ...state.liveVoice, connected: false, connecting: false, error: error.message };
          render();
        });
      }
      peerSync = peerSync.then(() => performPeerSync(epoch));
      return peerSync;
    }

    async function performPeerSync(epoch) {
      const session = sessionStore.read();
      if (disposed || epoch !== peerEpoch || !state.liveVoice.enabled || !session || !createPeer) return;
      let active = peer;
      try {
        if (!active) {
          active = createPeer(session, {
            onStateChange(peerState) {
              if (peer !== active || epoch !== peerEpoch || disposed) return;
              const connected = peerState.started && peerState.connectedPeerCount > 0;
              state.liveVoice = { ...state.liveVoice, connected, connecting: peerState.started && peerState.connectingPeerCount > 0,
                peerState, error: connected ? "" : state.liveVoice.error };
              render();
            },
            onError(error) {
              if (peer !== active || epoch !== peerEpoch || disposed) return;
              state.liveVoice = { ...state.liveVoice, connected: false, connecting: false, error: error.message };
              render();
            },
          });
          peer = active;
          startingPeer = active;
          try { await active.start(); } finally { if (startingPeer === active) startingPeer = null; }
        }
        if (epoch !== peerEpoch || peer !== active || disposed) return;
        await active.updateRoomSnapshot(state.snapshot);
      } catch (error) {
        if (active && peer === active) {
          peer = null;
          try { await active.stop(); } catch { /* Keep the startup error visible. */ }
        }
        if (epoch !== peerEpoch || disposed) return;
        state.liveVoice = { ...state.liveVoice, connected: false, connecting: false, error: error.message };
        render();
      }
    }

    async function stopPeer() {
      peerEpoch += 1;
      peerSync = Promise.resolve();
      const active = peer;
      peer = null;
      startingPeer = null;
      state.liveVoice = { ...state.liveVoice, connected: false, connecting: false, enabled: false, error: "" };
      if (active) {
        try { await active.stop(); } catch { /* Clip recording remains available. */ }
      }
    }

    async function requestNarration(snapshot) {
      const phase = snapshot?.game?.phase;
      const session = sessionStore.read();
      if (!phase || phase === "GAME_OVER" || !session || !state.voiceStatus.narrationAvailable) return;
      const key = `${snapshot.game.gameId}:${snapshot.game.round}:${phase}:${snapshot.game.deadlineAt || ""}`;
      if (key === lastNarrationKey) return;
      lastNarrationKey = key;
      try {
        await voice.play(await api.narration(session.roomId, session.seatToken));
      } catch {
        // The same phase text remains visible; narration is an optional enhancement.
      } finally {
        refreshVoiceStatus();
      }
    }

    async function refreshVoiceStatus() {
      try {
        state.voiceStatus = statusFromLingxi(await api.getLingxiStatus());
      } catch {
        state.voiceStatus = { available: false, narrationAvailable: false, label: "灵汐不可用" };
      }
      render();
    }

    async function loadSegments() {
      const session = sessionStore.read();
      if (!session) return;
      try {
        state.segments = segmentsFrom(await api.listVoice(session.roomId, session.seatToken));
        render();
      } catch {
        state.segments = [];
        render();
      }
    }

    async function loadRecap() {
      const session = sessionStore.read();
      if (!session || state.recap) return;
      try {
        state.recap = await api.getRecap(session.roomId, session.seatToken);
        render();
      } catch {
        state.recap = null;
      }
    }

    function openStream() {
      stream?.close();
      const session = sessionStore.read();
      if (!session) return;
      stream = api.streamRoom(session.roomId, session.seatToken, {
        cursor: session.cursor,
        onCursor(cursor) { if (cursor) sessionStore.update({ cursor }); },
        onSnapshot(snapshot) {
          updateSnapshot(snapshot);
          loadSegments();
        },
        onError() {
          state.error = "实时同步暂时中断，正在重连";
          render();
        },
      });
    }

    async function attachRoom(payload, nickname) {
      const snapshot = unwrapSnapshot(payload);
      if (!payload?.seatToken || !snapshot) throw new Error("房间响应缺少座位凭证或快照");
      sessionStore.write({ roomId: payload.roomId || snapshot.roomId, seatToken: payload.seatToken, nickname, cursor: "" });
      updateSnapshot(snapshot);
      openStream();
      await loadSegments();
    }

    async function withBusy(operation) {
      if (state.busy) return;
      state.busy = true;
      state.error = "";
      render();
      try {
        return await operation();
      } catch (error) {
        setError(error);
      } finally {
        state.busy = false;
        render();
      }
    }

    async function restoreRoom(session) {
      try {
        const payload = await api.roomCommand(session.roomId, session.seatToken, "reconnect", {}, core.makeId(randomUUID, now));
        const snapshot = unwrapSnapshot(payload) || await api.getSnapshot(session.roomId, session.seatToken);
        updateSnapshot(snapshot);
        openStream();
        await loadSegments();
      } catch (error) {
        sessionStore.clear();
        state.snapshot = null;
        state.error = `未能恢复原席位：${error.message}`;
      }
    }

    async function start() {
      view.bind(handle);
      voice.subscribe((status) => {
        state.recording = status === "recording";
        render();
      });
      render();
      const statusPromise = refreshVoiceStatus();
      try {
        await api.initSession();
        const session = sessionStore.read();
        if (session) await restoreRoom(session);
      } catch (error) {
        state.error = `服务暂不可用：${error.message}`;
      }
      await statusPromise;
      requestNarration(state.snapshot);
      state.booting = false;
      render();
      timer = interval(() => {
        if (state.snapshot?.game?.deadlineAt) render();
      }, 1000);
    }

    async function roomCommand(command, body = {}) {
      const session = sessionStore.read();
      if (!session) throw new Error("当前标签页没有座位凭证");
      const payload = await api.roomCommand(session.roomId, session.seatToken, command, body, core.makeId(randomUUID, now));
      const snapshot = unwrapSnapshot(payload);
      if (snapshot) updateSnapshot(snapshot);
      else updateSnapshot(await api.getSnapshot(session.roomId, session.seatToken));
      return payload;
    }

    function actionPayload(type, data) {
      if (["WOLF_TARGET_SET", "SEER_TARGET_SET", "VOTE_CAST", "HUNTER_SHOT_SET"].includes(type)) {
        return { targetSeatId: data.null === "true" ? null : state.selectedSeatId };
      }
      return {};
    }

    async function submitAction(type, payload) {
      const session = sessionStore.read();
      const snapshot = state.snapshot;
      if (!session || !snapshot?.game) throw new Error("牌局尚未开始");
      const signature = JSON.stringify({ type, payload, version: snapshot.version });
      if (state.pendingIntent?.signature !== signature) {
        state.pendingIntent = { signature, actionId: core.makeId(randomUUID, now) };
      }
      const intent = {
        schemaVersion: 1,
        actionId: state.pendingIntent.actionId,
        gameId: snapshot.game.gameId,
        expectedVersion: snapshot.version,
        type,
        payload,
      };
      try {
        const response = await api.gameAction(session.roomId, session.seatToken, intent);
        state.pendingIntent = null;
        const next = unwrapSnapshot(response) || await api.getSnapshot(session.roomId, session.seatToken);
        updateSnapshot(next);
      } catch (error) {
        if (error.code === "VIEW_CONFLICT") {
          state.pendingIntent = null;
          updateSnapshot(await api.getSnapshot(session.roomId, session.seatToken));
        }
        throw error;
      }
    }

    async function startRecording() {
      const model = core.createViewModel(state, now());
      if (!model.canRecord) throw new Error("当前没有发言权");
      await voice.start();
    }

    async function stopRecording() {
      const session = sessionStore.read();
      if (!session) throw new Error("当前标签页没有座位凭证");
      state.voiceBusy = true;
      render();
      try {
        const recording = await voice.stop();
        const segment = await api.uploadVoice(session.roomId, session.seatToken, recording.blob, recording.durationMs, state.retainVoice);
        if (segment?.segmentId) state.segments = [segment, ...state.segments.filter((item) => item.segmentId !== segment.segmentId)];
        else await loadSegments();
        view.showToast(segment?.transcriptStatus === "ready" || segment?.transcript ? "原声已上传并完成灵汐转写" : "原声已上传，字幕暂不可用");
        await refreshVoiceStatus();
      } finally {
        state.voiceBusy = false;
        render();
      }
    }

    async function playVoice(id) {
      const session = sessionStore.read();
      const segment = state.segments.find((item) => (item.segmentId || item.id) === id);
      if (!session || !segment) throw new Error("声证片段不存在或无权查看");
      const blob = await api.getVoice(session.roomId, session.seatToken, id);
      const actualHash = await voice.hash(blob);
      const expectedHash = segment.sha256 || segment.hash || segment.certificate?.sha256;
      state.verifications[id] = expectedHash ? (actualHash === expectedHash ? "哈希一致" : "哈希不匹配") : "未验证（无摘要）";
      render();
      if (expectedHash && actualHash !== expectedHash) throw new Error("声证哈希校验失败，已阻止播放");
      await voice.play(blob);
    }

    async function handle(command, data = {}) {
      if (command === "select-seat") {
        state.selectedSeatId = data.seatId;
        render();
        return;
      }
      if (command === "toggle-retain") {
        state.retainVoice = !state.retainVoice;
        render();
        return;
      }
      if (command === "report-reason") {
        state.reportReason = String(data.value || "").slice(0, 200);
        return;
      }
      if (command === "toggle-live-voice") {
        if (!state.snapshot?.game || state.snapshot.game.phase === "GAME_OVER") {
          view.showToast("牌局开始后可开启实时原声");
          return;
        }
        if (state.liveVoice.enabled) await stopPeer();
        else {
          state.liveVoice = { ...state.liveVoice, enabled: true, error: "" };
          await syncPeer(state.snapshot);
        }
        render();
        return;
      }
      if (command === "copy-room") {
        if (!clipboard?.writeText) return view.showToast("请手动记录房间码");
        await clipboard.writeText(state.snapshot.code);
        view.showToast("房间码已复制");
        return;
      }
      return withBusy(async () => {
        if (command === "create-room") await attachRoom(await api.createRoom(data.nickname, core.makeId(randomUUID, now)), data.nickname);
        else if (command === "join-room") await attachRoom(await api.joinRoom(data.roomId, data.nickname, core.makeId(randomUUID, now)), data.nickname);
        else if (command === "toggle-ready") await roomCommand("ready", { ready: data.ready === "true" });
        else if (command === "start-game") await roomCommand("start");
        else if (command === "restart-room") { state.recap = null; await roomCommand("restart"); }
        else if (command === "leave-room") {
          await roomCommand("leave");
          stream?.close();
          await stopPeer();
          voice.cancel();
          sessionStore.clear();
          state.snapshot = null;
          state.segments = [];
          state.recap = null;
          view.showToast("已离开房间");
        } else if (command === "submit-action") await submitAction(data.type, actionPayload(data.type, data));
        else if (command === "witch-action") {
          const payload = { kind: data.kind };
          if (data.kind === "POISON") payload.targetSeatId = state.selectedSeatId;
          await submitAction("WITCH_ACTION_SET", payload);
        } else if (command === "start-recording") await startRecording();
        else if (command === "stop-recording") await stopRecording();
        else if (command === "play-voice") await playVoice(data.segmentId);
        else if (command === "mark-voice") {
          const session = sessionStore.read();
          await api.markVoice(session.roomId, session.seatToken, data.segmentId, data.label);
          view.showToast("声证标记已保存");
        } else if (command === "remove-voice") {
          const session = sessionStore.read();
          const segment = state.segments.find((item) => item.segmentId === data.segmentId);
          if (!session || !segment || segment.speakerSeatId !== state.snapshot.selfSeatId) throw new Error("只能清理本人原声片段");
          await api.removeVoice(session.roomId, session.seatToken, data.segmentId);
          state.segments = state.segments.filter((item) => item.segmentId !== data.segmentId);
          delete state.verifications[data.segmentId];
          state.recap = null;
          if (state.snapshot.game.phase === "GAME_OVER") await loadRecap();
          view.showToast("本人原声已清理");
        } else if (command === "submit-report") {
          const session = sessionStore.read();
          const reason = String(data.reason || state.reportReason).trim();
          if (!session || !state.selectedSeatId) throw new Error("请先选择需要举报的玩家");
          if (!reason || reason.length > 200) throw new Error("举报原因需为 1 到 200 个字符");
          const report = await api.createReport(session.roomId, session.seatToken, state.selectedSeatId, reason);
          if (state.reportsOpen && state.snapshot.selfSeatId === state.snapshot.hostSeatId) state.reports = [...state.reports, report];
          state.reportReason = "不当发言，请房主核查";
          view.showToast("举报已提交给当前房主核查");
        } else if (command === "load-reports") {
          if (state.reportsOpen) {
            state.reportsOpen = false;
          } else {
            const session = sessionStore.read();
            if (!session || state.snapshot.selfSeatId !== state.snapshot.hostSeatId) throw new Error("只有当前房主可以查看举报");
            const payload = await api.listReports(session.roomId, session.seatToken);
            state.reports = Array.isArray(payload?.reports) ? payload.reports : [];
            state.reportsOpen = true;
          }
        }
      });
    }

    function dispose() {
      disposed = true;
      stream?.close();
      stopPeer();
      voice.cancel();
      clearIntervalFn(timer);
    }

    return Object.freeze({ dispose, getState: () => ({ ...state }), handle, start });
  }

  return { createApp, segmentsFrom, statusFromLingxi, unwrapSnapshot };
});

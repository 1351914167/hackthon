(function initCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WuyinCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function coreFactory() {
  "use strict";

  const STORAGE_KEY = "wuyin.session.v1";
  const PHASE_LABELS = Object.freeze({
    ROLE_REVEAL: "确认身份",
    NIGHT_WOLF: "狼人行动",
    NIGHT_WITCH: "女巫行动",
    NIGHT_SEER: "预言家行动",
    DAWN_RESOLUTION: "天亮结算",
    DAY_SPEECH: "顺序发言",
    DAY_VOTE: "放逐公投",
    LAST_WORD: "放逐遗言",
    HUNTER_SHOT: "猎人开枪",
    GAME_OVER: "对局结束",
  });
  const ROLE_LABELS = Object.freeze({
    WEREWOLF: "狼人",
    SEER: "预言家",
    WITCH: "女巫",
    HUNTER: "猎人",
    VILLAGER: "平民",
  });
  const ROLE_DESCRIPTIONS = Object.freeze({
    WEREWOLF: "与狼队友协作，在夜晚形成严格多数袭击目标。",
    SEER: "每晚查验一名其他存活玩家的阵营。",
    WITCH: "解药与毒药各一瓶，同一夜只能使用一种。",
    HUNTER: "被狼袭或放逐时，可以带走一名存活玩家。",
    VILLAGER: "通过发言、声证与票型找出全部狼人。",
  });

  function createSessionStore(storage) {
    function read() {
      try {
        const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
        return value && typeof value.roomId === "string" && typeof value.seatToken === "string" ? value : null;
      } catch {
        return null;
      }
    }
    function write(session) {
      const safe = { roomId: session.roomId, seatToken: session.seatToken, nickname: session.nickname || "", cursor: session.cursor || "" };
      storage.setItem(STORAGE_KEY, JSON.stringify(safe));
      return safe;
    }
    function update(values) {
      const current = read();
      return current ? write({ ...current, ...values }) : null;
    }
    function clear() {
      storage.removeItem(STORAGE_KEY);
    }
    return Object.freeze({ clear, read, update, write });
  }

  function makeId(randomUUID, now) {
    if (typeof randomUUID === "function") return randomUUID();
    return `action-${now()}-${Math.random().toString(16).slice(2)}`;
  }

  function remainingSeconds(deadlineAt, nowMs) {
    const deadline = Date.parse(deadlineAt || "");
    if (!Number.isFinite(deadline)) return null;
    return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
  }

  function formatTimer(seconds) {
    if (seconds === null) return "--:--";
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
  }

  function phaseInstruction(game, self) {
    const phase = game.phase;
    if (phase === "ROLE_REVEAL") return "确认仅你可见的身份，等待所有玩家进入首夜。";
    if (phase === "NIGHT_WOLF") return self.role === "WEREWOLF" ? "选择袭击目标，可在截止前修改或撤回。" : "夜色笼罩村庄，请等待狼人完成行动。";
    if (phase === "NIGHT_WITCH") return self.role === "WITCH" ? "查看当夜袭击目标，选择救人、毒人或跳过。" : "女巫正在作出选择。";
    if (phase === "NIGHT_SEER") return self.role === "SEER" ? "选择一名其他存活玩家进行查验。" : "预言家正在查验身份。";
    if (phase === "DAWN_RESOLUTION") return "系统正在结算昨夜事件。";
    if (phase === "DAY_SPEECH") return game.currentSpeakerSeatId === self.seatId ? "轮到你发言，可录制真实语音片段。" : "聆听当前玩家发言并记录判断。";
    if (phase === "DAY_VOTE") return "选择一名其他存活玩家，或明确弃票。";
    if (phase === "LAST_WORD") return game.currentSpeakerSeatId === self.seatId ? "这是你的放逐遗言，完成后主动结束。" : "被放逐玩家正在发表遗言。";
    if (phase === "HUNTER_SHOT") return self.availableActions.includes("HUNTER_SHOT_SET") ? "选择开枪目标，也可以放弃。" : "猎人正在决定是否开枪。";
    if (phase === "GAME_OVER") return "身份与关键事件已经公开，可核验并回听声证。";
    return "等待服务端推进牌局。";
  }

  function makeSeats(snapshot, game) {
    const gameSeats = new Map((game?.seats || []).map((seat) => [seat.seatId, seat]));
    return (snapshot.seats || []).map((seat, index) => {
      const gameSeat = gameSeats.get(seat.seatId);
      const isSpeaker = game?.currentSpeakerSeatId === seat.seatId;
      const labels = [];
      if (seat.seatId === snapshot.selfSeatId) labels.push("自己");
      if (seat.seatId === snapshot.hostSeatId) labels.push("房主");
      if (gameSeat && !gameSeat.alive) labels.push("出局");
      else if (isSpeaker) labels.push("发言中");
      else if (!seat.connected) labels.push("离线");
      else if (!game && seat.ready) labels.push("已准备");
      else labels.push(game ? "存活" : "未准备");
      return {
        ...seat,
        number: index + 1,
        alive: gameSeat ? gameSeat.alive : true,
        isSelf: seat.seatId === snapshot.selfSeatId,
        isHost: seat.seatId === snapshot.hostSeatId,
        isSpeaker,
        status: labels.join(" · "),
      };
    });
  }

  function createViewModel(state, nowMs) {
    if (state.booting) return { screen: "loading" };
    if (!state.snapshot) return { screen: "entry", busy: state.busy, error: state.error, roomHint: state.roomHint || "", voiceStatus: state.voiceStatus };

    const snapshot = state.snapshot;
    const game = snapshot.game;
    const seats = makeSeats(snapshot, game);
    const base = {
      screen: game ? "game" : "lobby",
      snapshot,
      seats,
      busy: state.busy,
      error: state.error,
      voiceStatus: state.voiceStatus,
      roomCode: snapshot.code,
      isHost: snapshot.selfSeatId === snapshot.hostSeatId,
      selfSeat: seats.find((seat) => seat.isSelf),
      filledSeats: seats.length,
    };
    if (!game) return base;

    const self = game.self || { availableActions: [], abilities: {}, seerResults: [] };
    const seconds = remainingSeconds(game.deadlineAt, nowMs);
    const aliveTargets = seats.filter((seat) => seat.alive && !seat.isSelf);
    const selectedSeat = aliveTargets.find((seat) => seat.seatId === state.selectedSeatId) || null;
    return {
      ...base,
      game,
      self,
      phaseLabel: PHASE_LABELS[game.phase] || game.phase,
      roleLabel: ROLE_LABELS[self.role] || "等待发牌",
      roleDescription: ROLE_DESCRIPTIONS[self.role] || "身份由服务端安全发放。",
      instruction: phaseInstruction(game, self),
      seconds,
      timer: formatTimer(seconds),
      targets: aliveTargets,
      selectedSeat,
      canRecord: game.currentSpeakerSeatId === snapshot.selfSeatId && ["DAY_SPEECH", "LAST_WORD"].includes(game.phase),
      recording: state.recording,
      voiceBusy: state.voiceBusy,
      segments: Array.isArray(state.segments) ? state.segments : [],
      recap: state.recap,
      verifications: state.verifications || {},
      selectedLabel: state.selectedLabel || "关键发言",
      retainVoice: Boolean(state.retainVoice),
      liveVoice: state.liveVoice || { supported: false, enabled: false, connected: false },
    };
  }

  return {
    PHASE_LABELS,
    ROLE_DESCRIPTIONS,
    ROLE_LABELS,
    STORAGE_KEY,
    createSessionStore,
    createViewModel,
    formatTimer,
    makeId,
    remainingSeconds,
  };
});

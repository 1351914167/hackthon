(function initView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WuyinView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function viewFactory() {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
    })[character]);
  }

  function initials(name) {
    return Array.from(String(name || "?"))[0] || "?";
  }

  function seatName(seats, seatId) {
    const seat = seats.find((item) => item.seatId === seatId);
    return seat ? `${seat.number}号 · ${seat.nickname}` : "未知席位";
  }

  function button(label, command, options = {}) {
    const classes = ["button", options.primary ? "button-primary" : "button-secondary", options.danger ? "button-danger" : ""].filter(Boolean).join(" ");
    const attrs = Object.entries(options.data || {}).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join("");
    return `<button class="${classes}" type="button" data-command="${command}"${attrs}${options.disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
  }

  function renderEntry(model) {
    const roomHint = escapeHtml(model.roomHint);
    return `<section class="entry-screen">
      <div class="entry-copy">
        <span class="eyebrow">9 人标准局 · 灵汐语音</span>
        <h1>雾隐镇</h1>
        <p>所有身份与结算来自服务端。戴上耳机，邀请八位玩家入座。</p>
        <div class="trust-line"><span>确定性规则</span><span>私密视图</span><span>声证复盘</span></div>
      </div>
      <div class="entry-actions" aria-label="进入房间">
        <div class="entry-tabs">
          <strong>创建新房</strong>
          <span>或凭房间码加入</span>
        </div>
        <form class="entry-form" data-form="create-room">
          <label for="createNickname">你的称呼</label>
          <div class="field-row"><input id="createNickname" name="nickname" maxlength="16" autocomplete="nickname" required placeholder="例如：青岚" /><button class="button button-primary" type="submit"${model.busy ? " disabled" : ""}>创建</button></div>
        </form>
        <div class="entry-divider"><span>已有房间码</span></div>
        <form class="entry-form" data-form="join-room">
          <label for="roomCode">房间码</label>
          <input id="roomCode" name="roomId" maxlength="64" autocomplete="off" required value="${roomHint}" placeholder="输入房间码" />
          <label for="joinNickname">你的称呼</label>
          <div class="field-row"><input id="joinNickname" name="nickname" maxlength="16" autocomplete="nickname" required placeholder="例如：白鹿" /><button class="button button-secondary" type="submit"${model.busy ? " disabled" : ""}>加入</button></div>
        </form>
        ${model.error ? `<p class="inline-error" role="alert">${escapeHtml(model.error)}</p>` : ""}
      </div>
    </section>`;
  }

  function renderLobby(model) {
    const ready = Boolean(model.selfSeat?.ready);
    const allReady = model.filledSeats === 9 && model.seats.every((seat) => seat.ready);
    const seats = Array.from({ length: 9 }, (_, index) => {
      const seat = model.seats[index];
      if (!seat) return `<li class="lobby-seat empty"><span class="seat-index">${index + 1}</span><div><strong>等待加入</strong><small>空席</small></div></li>`;
      return `<li class="lobby-seat${seat.isSelf ? " self" : ""}${!seat.connected ? " offline" : ""}">
        <span class="avatar avatar-${(index % 9) + 1}">${escapeHtml(initials(seat.nickname))}</span>
        <div><strong>${index + 1}号 · ${escapeHtml(seat.nickname)}</strong><small>${escapeHtml(seat.status)}</small></div>
        <span class="ready-mark" aria-label="${seat.ready ? "已准备" : "未准备"}">${seat.ready ? "✓" : "·"}</span>
      </li>`;
    }).join("");
    return `<section class="lobby-screen">
      <header class="room-heading">
        <div><span class="eyebrow">等待区 · ${model.filledSeats}/9 人</span><h1>房间 <button class="code-copy" type="button" data-command="copy-room" aria-label="复制房间码">${escapeHtml(model.roomCode)}</button></h1></div>
        <div class="room-heading-actions">${button("离开", "leave-room", { danger: true, disabled: model.busy })}</div>
      </header>
      <div class="lobby-layout">
        <ol class="lobby-grid" aria-label="房间席位">${seats}</ol>
        <aside class="ready-panel">
          <span class="eyebrow">你的席位</span>
          <h2>${escapeHtml(model.selfSeat?.nickname || "玩家")}</h2>
          <p>${ready ? "你已准备，等待其他玩家。" : "确认设备后即可准备。"}</p>
          <div class="room-facts"><span>房主</span><strong>${escapeHtml(seatName(model.seats, model.snapshot.hostSeatId))}</strong><span>规则</span><strong>standard-9-v1</strong></div>
          ${button(ready ? "取消准备" : "准备", "toggle-ready", { primary: !ready, data: { ready: String(!ready) }, disabled: model.busy })}
          ${model.isHost ? button(allReady ? "开始牌局" : `等待 ${9 - model.seats.filter((seat) => seat.ready).length} 人准备`, "start-game", { primary: allReady, disabled: !allReady || model.busy }) : ""}
          <p class="privacy-note">座位凭证仅保存在当前标签页。</p>
        </aside>
      </div>
      ${model.error ? `<p class="inline-error" role="alert">${escapeHtml(model.error)}</p>` : ""}
    </section>`;
  }

  function renderSeatList(model) {
    return `<aside class="panel roster-panel" aria-labelledby="rosterTitle">
      <div class="panel-heading"><div><span class="eyebrow">存活 ${model.seats.filter((seat) => seat.alive).length} / ${model.seats.length}</span><h2 id="rosterTitle">圆桌席位</h2></div><span class="online-count">${model.seats.filter((seat) => seat.connected).length} 在线</span></div>
      <div class="player-list">${model.seats.map((seat) => `<button class="player${seat.isSelf ? " is-self" : ""}${seat.isSpeaker ? " active-speaker" : ""}${!seat.alive ? " eliminated" : ""}${model.selectedSeat?.seatId === seat.seatId ? " is-selected" : ""}" type="button" data-command="select-seat" data-seat-id="${escapeHtml(seat.seatId)}" aria-pressed="${model.selectedSeat?.seatId === seat.seatId}"${!seat.alive ? " disabled" : ""}>
        <span class="avatar avatar-${seat.number}">${escapeHtml(initials(seat.nickname))}</span><span class="player-copy"><strong>${seat.number}号 · ${escapeHtml(seat.nickname)}</strong><small>${escapeHtml(seat.status)}</small></span><span class="seat-number">${String(seat.number).padStart(2, "0")}</span>
      </button>`).join("")}</div>
    </aside>`;
  }

  function targetSummary(model) {
    return model.selectedSeat ? `已选择 ${escapeHtml(model.selectedSeat.number)}号 · ${escapeHtml(model.selectedSeat.nickname)}` : "先从席位中选择目标";
  }

  function renderActionPanel(model) {
    const actions = model.self.availableActions || [];
    const phase = model.game.phase;
    if (actions.includes("WITCH_ACTION_SET")) {
      const attacked = model.self.wolfAttackTarget ? seatName(model.seats, model.self.wolfAttackTarget) : "今夜无人被袭击";
      return `<div class="action-console"><span class="eyebrow">当夜袭击</span><strong>${escapeHtml(attacked)}</strong><p>${targetSummary(model)}</p><div class="action-row">
        ${button("使用解药", "witch-action", { primary: true, data: { kind: "SAVE" }, disabled: !model.self.wolfAttackTarget || !model.self.abilities.antidote || model.busy })}
        ${button("使用毒药", "witch-action", { data: { kind: "POISON" }, disabled: !model.selectedSeat || !model.self.abilities.poison || model.busy })}
        ${button("跳过", "witch-action", { data: { kind: "SKIP" }, disabled: model.busy })}
      </div></div>`;
    }
    const targetAction = ["WOLF_TARGET_SET", "SEER_TARGET_SET", "VOTE_CAST", "HUNTER_SHOT_SET"].find((type) => actions.includes(type));
    if (targetAction) {
      const labels = { WOLF_TARGET_SET: "确认狼刀", SEER_TARGET_SET: "确认查验", VOTE_CAST: "确认投票", HUNTER_SHOT_SET: "确认开枪" };
      const skipLabels = { WOLF_TARGET_SET: "撤回选择", VOTE_CAST: "弃票", HUNTER_SHOT_SET: "放弃开枪" };
      return `<div class="action-console"><span class="eyebrow">你的选择</span><strong>${targetSummary(model)}</strong>${model.self.currentAction?.submitted ? `<p>服务端已记录：${model.self.currentAction.targetSeatId ? escapeHtml(seatName(model.seats, model.self.currentAction.targetSeatId)) : "主动跳过"}</p>` : "<p>尚未提交</p>"}<div class="action-row">
        ${button(labels[targetAction], "submit-action", { primary: true, data: { type: targetAction }, disabled: !model.selectedSeat || model.busy })}
        ${skipLabels[targetAction] ? button(skipLabels[targetAction], "submit-action", { data: { type: targetAction, null: "true" }, disabled: model.busy }) : ""}
      </div></div>`;
    }
    if (actions.includes("SPEECH_FINISH")) return `<div class="action-console"><strong>你的发言时间</strong><p>语音片段上传完成后再结束发言。</p>${button("结束发言", "submit-action", { primary: true, data: { type: "SPEECH_FINISH" }, disabled: model.recording || model.voiceBusy || model.busy })}</div>`;
    if (actions.includes("LAST_WORD_FINISH")) return `<div class="action-console"><strong>你的放逐遗言</strong><p>上传遗言声证后结束本阶段。</p>${button("结束遗言", "submit-action", { primary: true, data: { type: "LAST_WORD_FINISH" }, disabled: model.recording || model.voiceBusy || model.busy })}</div>`;
    return `<div class="action-console waiting"><span class="waiting-ring" aria-hidden="true"></span><strong>等待其他玩家</strong><p>服务端会在阶段变化时同步你的可见快照。</p></div>`;
  }

  function renderVoiceDock(model) {
    const status = model.recording ? "正在录音" : model.voiceBusy ? "上传与灵汐转写中" : model.canRecord ? "可以开始录音" : "当前不可录音";
    const live = model.liveVoice || {};
    return `<div class="speak-dock">
      <div class="connection-copy"><span class="eyebrow">真实语音片段</span><strong>${status}</strong><button class="retention-toggle" type="button" data-command="toggle-retain" aria-pressed="${model.retainVoice}">赛后保留 ${model.retainVoice ? "开" : "关"}</button></div>
      <button class="mic-button${model.recording ? " is-recording" : ""}" type="button" data-command="${model.recording ? "stop-recording" : "start-recording"}" aria-pressed="${model.recording}"${(!model.canRecord && !model.recording) || model.voiceBusy ? " disabled" : ""}><span aria-hidden="true">●</span><span>${model.recording ? "停止" : "录音"}</span></button>
      <div class="latency"><span>${live.connected ? "实时原声已连接" : escapeHtml(model.voiceStatus?.label || "字幕不可用")}</span>${live.supported ? `<button class="retention-toggle" type="button" data-command="toggle-live-voice" aria-pressed="${Boolean(live.enabled)}">${live.enabled ? "关闭实时" : "开启实时"}</button>` : ""}</div>
    </div>`;
  }

  function renderRolePanel(model) {
    const results = (model.self.seerResults || []).map((result) => `<li><span>第 ${result.round} 夜 · ${escapeHtml(seatName(model.seats, result.targetSeatId))}</span><strong>${result.team === "WEREWOLF" ? "狼人" : "好人"}</strong></li>`).join("");
    const teammates = (model.game.wolfTeammates || []).map((wolf) => seatName(model.seats, wolf.seatId)).join("、");
    return `<section class="role-card"><div class="role-card-top"><span class="eyebrow">你的身份 · 仅自己可见</span><span class="role-symbol" aria-hidden="true">◉</span></div><h2>${escapeHtml(model.roleLabel)}</h2><p>${escapeHtml(model.roleDescription)}</p>
      ${teammates ? `<div class="role-result"><span>狼队友</span><strong>${escapeHtml(teammates)}</strong></div>` : ""}
      ${model.self.role === "WITCH" ? `<div class="inventory"><span>解药 ${model.self.abilities.antidote}</span><span>毒药 ${model.self.abilities.poison}</span></div>` : ""}
      ${results ? `<ul class="seer-results">${results}</ul>` : ""}</section>`;
  }

  function segmentId(segment) {
    return segment.segmentId || segment.id || "";
  }

  function renderSegments(model) {
    if (!model.segments.length) return `<div class="empty-state">暂无可回听的声证片段</div>`;
    return `<ul class="voice-list">${model.segments.map((segment) => {
      const id = segmentId(segment);
      const speaker = seatName(model.seats, segment.speakerSeatId || segment.seatId);
      const verification = model.verifications[id];
      const detail = segment.transcript || `${segment.phaseKey || segment.phase || "牌局"} · ${segment.size ? `${Math.ceil(segment.size / 1024)} KB` : "原声"}`;
      return `<li><div><strong>${escapeHtml(speaker)}</strong><p>${escapeHtml(detail)}</p><small>声证 ${escapeHtml(id.slice(0, 10))}${verification ? ` · ${escapeHtml(verification)}` : ""}</small></div><div class="clip-actions"><button class="icon-button" type="button" data-command="play-voice" data-segment-id="${escapeHtml(id)}" aria-label="播放 ${escapeHtml(speaker)} 的语音">▶</button><button class="clip-mark" type="button" data-command="mark-voice" data-segment-id="${escapeHtml(id)}" data-label="${escapeHtml(model.selectedLabel)}">标记</button></div></li>`;
    }).join("")}</ul>`;
  }

  function renderTimeline(model) {
    const items = [];
    for (const death of model.game.deaths || []) items.push(`<li><span>第 ${death.round} 轮</span><strong>${escapeHtml(seatName(model.seats, death.seatId))} 出局</strong><small>${escapeHtml((death.reasons || []).join(" / "))}</small></li>`);
    for (const vote of model.game.voteHistory || []) items.push(`<li><span>第 ${vote.round} 轮</span><strong>${vote.exiledSeatId ? `${escapeHtml(seatName(model.seats, vote.exiledSeatId))} 被放逐` : "平票，无人放逐"}</strong><small>${vote.ballots.length} 份票型已公开</small></li>`);
    return items.length ? `<ol class="timeline-list">${items.join("")}</ol>` : `<div class="empty-state">等待首个公开事件</div>`;
  }

  function renderReports(model) {
    const selected = model.selectedSeat;
    const reason = escapeHtml(model.reportReason || "不当发言，请房主核查");
    const reports = Array.isArray(model.reports) ? model.reports : [];
    const form = `<form class="entry-form" data-form="report-player"><input name="reason" data-field="report-reason" maxlength="200" value="${reason}" aria-label="举报原因" /><button class="button button-secondary" type="submit"${!selected || model.busy ? " disabled" : ""}>提交举报</button></form><p class="privacy-note">${selected ? `举报 ${escapeHtml(selected.number)}号 · ${escapeHtml(selected.nickname)}` : "先选择需要举报的玩家"}；仅交由当前房主核查，不自动处罚。</p>`;
    if (!model.isHost) return `<section class="intel-section"><div class="section-heading"><h2>房间举报</h2><span>仅房主核查</span></div>${form}</section>`;
    const drawer = model.reportsOpen ? `<ol class="timeline-list">${reports.length ? reports.map((report) => `<li><span>${escapeHtml(new Date(report.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }))}</span><strong>${escapeHtml(seatName(model.seats, report.reporterSeatId))} 举报 ${escapeHtml(seatName(model.seats, report.targetSeatId))}</strong><small>${escapeHtml(report.reason)}</small></li>`).join("") : "<li><strong>暂无举报</strong></li>"}</ol>` : "";
    return `<section class="intel-section"><div class="section-heading"><h2>房间举报</h2><button class="clip-mark" type="button" data-command="load-reports" aria-expanded="${Boolean(model.reportsOpen)}">${model.reportsOpen ? "收起" : "查看举报"}</button></div>${form}${drawer}</section>`;
  }

  function renderRecap(model) {
    const roles = model.game.revealedRoles || model.recap?.roles || [];
    const result = model.game.result || (model.recap?.winner ? { winner: model.recap.winner } : null);
    return `<section class="recap-panel"><span class="eyebrow">VERIFIABLE RECAP</span><h2>${result?.winner === "GOOD" ? "好人阵营获胜" : "狼人阵营获胜"}</h2><p>${escapeHtml(result?.reason || "牌局已经完成")}</p>
      <div class="revealed-grid">${roles.map((item) => `<div><span>${escapeHtml(seatName(model.seats, item.seatId))}</span><strong>${escapeHtml(({ WEREWOLF: "狼人", SEER: "预言家", WITCH: "女巫", HUNTER: "猎人", VILLAGER: "平民" })[item.role] || item.role)}</strong></div>`).join("")}</div>
      <div class="recap-actions">${model.isHost ? button("再来一局", "restart-room", { primary: true, disabled: model.busy }) : ""}${button("离开房间", "leave-room", { danger: true, disabled: model.busy })}</div></section>`;
  }

  function renderGame(model) {
    const speaker = model.seats.find((seat) => seat.seatId === model.game.currentSpeakerSeatId);
    return `<section class="game-shell">
      ${renderSeatList(model)}
      <section class="stage" aria-labelledby="phaseTitle">
        <div class="phase-strip"><span class="phase-icon" aria-hidden="true">${model.game.phase.startsWith("NIGHT") ? "◐" : "☼"}</span><div><span class="eyebrow">ROUND ${String(model.game.round).padStart(2, "0")}</span><h1 id="phaseTitle">${escapeHtml(model.phaseLabel)}</h1></div><div class="timer${model.seconds !== null && model.seconds <= 15 ? " is-low" : ""}" role="timer" aria-label="阶段剩余时间"><strong>${model.timer}</strong><span>服务端截止时间</span></div></div>
        ${model.game.phase === "GAME_OVER" ? renderRecap(model) : `<div class="speaker-stage"><div class="moon" aria-hidden="true"></div><div class="speaker-card"><span class="seat-label">${speaker ? `${speaker.number}号玩家` : "当前阶段"}</span><div class="speaker-avatar">${escapeHtml(initials(speaker?.nickname || model.roleLabel))}</div><h2>${escapeHtml(speaker?.nickname || model.phaseLabel)}</h2><p>${escapeHtml(model.instruction)}</p></div>${renderActionPanel(model)}</div>${renderVoiceDock(model)}`}
      </section>
      <aside class="panel intel-panel">
        ${renderRolePanel(model)}
        <section class="intel-section"><div class="section-heading"><h2>场上进程</h2><span>公开事件</span></div>${renderTimeline(model)}</section>
        <section class="intel-section"><div class="section-heading"><h2>声证片段</h2><span>鉴权回听</span></div>${renderSegments(model)}</section>
        ${renderReports(model)}
      </aside>
      ${model.error ? `<p class="inline-error floating-error" role="alert">${escapeHtml(model.error)}</p>` : ""}
    </section>`;
  }

  function value(form, name) {
    const field = form.elements?.namedItem ? form.elements.namedItem(name) : form.elements?.[name];
    return String(field?.value || "").trim();
  }

  function createView(options) {
    const document = options.document;
    const root = options.root;
    const roomMeta = options.roomMeta;
    const voiceStatus = options.voiceStatus;
    const toast = options.toast;
    const alertRegion = options.alertRegion;
    const rulesDialog = options.rulesDialog;
    const schedule = options.setTimeout || setTimeout;
    const cancelSchedule = options.clearTimeout || clearTimeout;
    let listener = null;
    let toastTimer = null;

    function emit(command, payload = {}) {
      return listener?.(command, payload);
    }

    function bind(nextListener) {
      listener = nextListener;
      root.addEventListener("click", (event) => {
        const control = event.target.closest?.("[data-command]");
        if (control) emit(control.dataset.command, { ...control.dataset });
      });
      root.addEventListener("submit", (event) => {
        const form = event.target;
        if (!form.dataset?.form) return;
        event.preventDefault();
        if (form.dataset.form === "create-room") emit("create-room", { nickname: value(form, "nickname") });
        if (form.dataset.form === "join-room") emit("join-room", { roomId: value(form, "roomId"), nickname: value(form, "nickname") });
        if (form.dataset.form === "report-player") emit("submit-report", { reason: value(form, "reason") });
      });
      root.addEventListener("input", (event) => {
        const field = event.target.closest?.("[data-field='report-reason']");
        if (field) emit("report-reason", { value: field.value });
      });
      document.querySelector("#rulesButton")?.addEventListener("click", () => rulesDialog.showModal());
      document.querySelector("#closeRules")?.addEventListener("click", () => rulesDialog.close());
      rulesDialog?.addEventListener("click", (event) => { if (event.target === rulesDialog) rulesDialog.close(); });
    }

    function render(model) {
      if (model.screen === "loading") root.innerHTML = `<section class="loading-screen" aria-busy="true"><span class="loading-mark" aria-hidden="true">雾</span><p>正在连接雾隐镇</p></section>`;
      else if (model.screen === "entry") root.innerHTML = renderEntry(model);
      else if (model.screen === "lobby") root.innerHTML = renderLobby(model);
      else root.innerHTML = renderGame(model);
      roomMeta.innerHTML = model.roomCode ? `<span class="room-code">${escapeHtml(model.roomCode)}</span><span class="meta-divider"></span><span>9 人标准局</span>` : "";
      const available = Boolean(model.voiceStatus?.available);
      voiceStatus.classList.toggle("is-live", available);
      const label = voiceStatus.querySelector("span:last-child");
      if (label) label.textContent = model.voiceStatus?.label || "灵汐不可用";
    }

    function showToast(message) {
      cancelSchedule(toastTimer);
      toast.textContent = message;
      toast.classList.add("is-visible");
      toastTimer = schedule(() => toast.classList.remove("is-visible"), 2600);
    }

    function showAlert(message) {
      alertRegion.textContent = "";
      schedule(() => { alertRegion.textContent = message; }, 0);
    }

    return Object.freeze({ bind, render, showAlert, showToast });
  }

  return { createView, escapeHtml, renderEntry, renderGame, renderLobby, renderReports };
});

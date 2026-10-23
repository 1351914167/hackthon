const state = {
  configured: false,
  recording: false,
  recorder: null,
  stream: null,
  chunks: [],
  phase: "speech",
  seconds: 78,
  selectedPlayer: null,
};

const elements = {
  voiceStatus: document.querySelector("#voiceStatus"),
  timer: document.querySelector("#timer"),
  timerValue: document.querySelector("#timerValue"),
  nextPhaseButton: document.querySelector("#nextPhaseButton"),
  phaseTitle: document.querySelector("#phaseTitle"),
  liveTranscript: document.querySelector("#liveTranscript"),
  micButton: document.querySelector("#micButton"),
  micHint: document.querySelector("#micHint"),
  latencyValue: document.querySelector("#latencyValue"),
  toast: document.querySelector("#toast"),
  noteForm: document.querySelector("#noteForm"),
  noteInput: document.querySelector("#noteInput"),
  notes: document.querySelector("#notes"),
  timelineList: document.querySelector("#timelineList"),
  rulesDialog: document.querySelector("#rulesDialog"),
};

let toastTimer;

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function addTimeline(text) {
  const item = document.createElement("li");
  const now = new Date();
  item.innerHTML = `<time>${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time><span></span>`;
  item.querySelector("span").textContent = text;
  elements.timelineList.prepend(item);
}

function setVoiceStatus(label, live = false) {
  elements.voiceStatus.querySelector("span:last-child").textContent = label;
  elements.voiceStatus.classList.toggle("is-live", live);
}

async function detectLingxi() {
  try {
    const response = await fetch("/api/lingxi/status", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("status unavailable");
    const payload = await response.json();
    state.configured = Boolean(payload.configured);
    setVoiceStatus(state.configured ? "灵汐通道在线" : "灵汐演示通道", state.configured);
    elements.latencyValue.textContent = state.configured ? "在线" : "演示";
  } catch {
    setVoiceStatus("静态演示模式");
    elements.latencyValue.textContent = "演示";
  }
}

async function requestHostSpeech(text) {
  if (!state.configured) return;

  try {
    const startedAt = performance.now();
    const response = await fetch("/api/lingxi/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: "alloy" }),
    });
    if (!response.ok) throw new Error("speech failed");

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.addEventListener("ended", () => URL.revokeObjectURL(audioUrl), { once: true });
    await audio.play();
    elements.latencyValue.textContent = `${Math.round(performance.now() - startedAt)} ms`;
  } catch {
    showToast("灵汐主持音暂不可用，牌局已保留文字提示");
  }
}

async function transcribeRecording(blob) {
  const formData = new FormData();
  formData.append("file", blob, "speech.webm");
  formData.append("model", "gpt-4o-transcribe");

  elements.micHint.textContent = "灵汐正在转写…";
  const startedAt = performance.now();

  try {
    const response = await fetch("/api/lingxi/transcriptions", { method: "POST", body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "transcription failed");

    const transcript = payload.text?.trim();
    if (transcript) {
      elements.liveTranscript.textContent = `“${transcript}”`;
      addTimeline(`3号发言：${transcript}`);
    } else {
      showToast("没有识别到清晰语音，请靠近麦克风重试");
    }
    elements.latencyValue.textContent = `${Math.round(performance.now() - startedAt)} ms`;
  } catch {
    showToast("灵汐转写失败，录音未保存；牌局流程不受影响");
  } finally {
    elements.micHint.textContent = "点击开麦，松开即送出";
  }
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === "inactive") return;
  state.recorder.stop();
  state.recording = false;
  elements.micButton.classList.remove("is-recording");
  elements.micButton.querySelector("span:last-child").textContent = "开麦";
}

async function startRecording() {
  if (state.recording) {
    stopRecording();
    return;
  }

  if (!state.configured) {
    elements.micButton.classList.add("is-recording");
    elements.micButton.querySelector("span:last-child").textContent = "演示中";
    elements.micHint.textContent = "演示通道正在模拟语音转写";
    window.setTimeout(() => {
      elements.micButton.classList.remove("is-recording");
      elements.micButton.querySelector("span:last-child").textContent = "开麦";
      elements.micHint.textContent = "点击开麦，松开即送出";
      elements.liveTranscript.textContent = "“我是 3 号预言家，昨晚查验 7 号是好人。建议先从 4 号和 8 号的发言里找狼。”";
      addTimeline("3号完成演示发言，灵汐正式通道需配置服务端密钥");
      showToast("演示完成；配置 LINGXI_API_KEY 后启用真实转写");
    }, 1600);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("当前浏览器不支持录音，请使用最新版 Chrome");
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) state.chunks.push(event.data);
    });
    state.recorder.addEventListener("stop", async () => {
      const blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
      state.stream?.getTracks().forEach((track) => track.stop());
      await transcribeRecording(blob);
    });
    state.recorder.start();
    state.recording = true;
    elements.micButton.classList.add("is-recording");
    elements.micButton.querySelector("span:last-child").textContent = "送出";
    elements.micHint.textContent = "正在录音，再次点击结束";
  } catch {
    showToast("未获得麦克风权限，无法开始灵汐语音转写");
  }
}

function advancePhase() {
  state.phase = state.phase === "speech" ? "vote" : "night";

  if (state.phase === "vote") {
    elements.phaseTitle.textContent = "放逐公投";
    elements.nextPhaseButton.querySelector("strong").textContent = "公布票型";
    state.seconds = 45;
    addTimeline("自由发言结束，进入放逐公投");
    showToast("请选择一名存活玩家完成公投");
    requestHostSpeech("自由发言结束，现在进入放逐公投。请所有存活玩家完成投票。");
    return;
  }

  elements.phaseTitle.textContent = "入夜行动";
  elements.nextPhaseButton.querySelector("strong").textContent = "等待天亮";
  elements.nextPhaseButton.disabled = true;
  state.seconds = 60;
  addTimeline("票型已锁定，村庄进入黑夜");
  showToast("夜间行动已按角色顺序开始");
  requestHostSpeech("投票结束。天黑请闭眼，狼人请睁眼并选择目标。");
}

document.querySelectorAll(".player:not(.eliminated)").forEach((player) => {
  player.addEventListener("click", () => {
    document.querySelectorAll(".player").forEach((item) => item.classList.remove("is-selected"));
    player.classList.add("is-selected");
    state.selectedPlayer = player.dataset.player;
    if (state.phase === "vote") {
      showToast(`已选择 ${state.selectedPlayer} 号，等待公投锁定`);
    }
  });
});

document.querySelectorAll("[data-mark]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.selectedPlayer) {
      showToast("先在左侧选择一名玩家");
      return;
    }
    button.classList.toggle("is-active");
    const label = `${state.selectedPlayer}号 · ${button.dataset.mark}`;
    const exists = [...elements.notes.querySelectorAll("button")].some((note) => note.dataset.note === label);
    if (!exists) {
      const note = document.createElement("button");
      note.type = "button";
      note.dataset.note = label;
      note.textContent = label;
      elements.notes.append(note);
    }
    showToast(`已标记：${label}`);
  });
});

elements.noteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.noteInput.value.trim();
  if (!text) return;
  const note = document.createElement("button");
  note.type = "button";
  note.dataset.note = text;
  note.textContent = text;
  elements.notes.append(note);
  elements.noteInput.value = "";
});

elements.notes.addEventListener("click", (event) => {
  const note = event.target.closest("button");
  if (note) note.remove();
});

document.querySelector("#clearNotes").addEventListener("click", () => {
  elements.notes.replaceChildren();
});

document.querySelector("#rulesButton").addEventListener("click", () => elements.rulesDialog.showModal());
document.querySelector("#closeRules").addEventListener("click", () => elements.rulesDialog.close());
elements.rulesDialog.addEventListener("click", (event) => {
  if (event.target === elements.rulesDialog) elements.rulesDialog.close();
});

elements.micButton.addEventListener("click", startRecording);
elements.nextPhaseButton.addEventListener("click", advancePhase);

window.setInterval(() => {
  if (state.seconds > 0) state.seconds -= 1;
  elements.timerValue.textContent = formatTime(state.seconds);
  elements.timer.classList.toggle("is-low", state.seconds <= 15);
}, 1000);

detectLingxi();

(function initBootstrap(root, factory) {
  const api = typeof module === "object" && module.exports
    ? factory(require("./src/client/core"), require("./src/client/api"), require("./src/client/voice"), require("./src/client/view"), require("./src/client/app"))
    : factory(root.WuyinCore, root.WuyinApi, root.WuyinVoice, root.WuyinView, root.WuyinApp);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.WuyinBootstrap = api;
    const launch = () => api.bootstrap().catch((error) => {
      const alert = root.document.querySelector("#alertRegion");
      if (alert) alert.textContent = `应用启动失败：${error.message}`;
    });
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", launch, { once: true });
    else launch();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function bootstrapFactory(coreModule, apiModule, voiceModule, viewModule, appModule) {
  "use strict";

  function requireElement(document, selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`缺少页面元素 ${selector}`);
    return element;
  }

  async function bootstrap(overrides = {}) {
    const window = overrides.window || globalThis.window;
    const document = overrides.document || window.document;
    const root = requireElement(document, "#app");
    const sessionStore = overrides.sessionStore || coreModule.createSessionStore(window.sessionStorage);
    const api = overrides.api || apiModule.createApi({
      fetch: window.fetch.bind(window),
      FormData: window.FormData,
      AbortController: window.AbortController,
      TextDecoder: window.TextDecoder,
      setTimeout: window.setTimeout.bind(window),
    });
    const voice = overrides.voice || voiceModule.createVoiceController({
      mediaDevices: window.navigator.mediaDevices,
      MediaRecorder: window.MediaRecorder,
      Blob: window.Blob,
      Audio: window.Audio,
      URL: window.URL,
      crypto: window.crypto,
      now: Date.now,
    });
    const view = overrides.view || viewModule.createView({
      document,
      root,
      roomMeta: requireElement(document, "#roomMeta"),
      voiceStatus: requireElement(document, "#voiceStatus"),
      toast: requireElement(document, "#toast"),
      alertRegion: requireElement(document, "#alertRegion"),
      rulesDialog: requireElement(document, "#rulesDialog"),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    });
    const query = new window.URLSearchParams(window.location.search);
    const remoteVoice = document.querySelector("#remoteVoice");
    const peerLibrary = window.WerewolfPeerClient;
    const createPeer = overrides.createPeer || (peerLibrary && window.RTCPeerConnection && window.navigator.mediaDevices?.getUserMedia
      ? (session, handlers) => peerLibrary.createPeerClient({
        roomId: session.roomId,
        seatToken: session.seatToken,
        baseUrl: "",
        fetchImpl: window.fetch.bind(window),
        RTCPeerConnection: window.RTCPeerConnection,
        getUserMedia: window.navigator.mediaDevices.getUserMedia.bind(window.navigator.mediaDevices),
        onTrack(event) {
          if (!remoteVoice || !event.streams?.[0]) return;
          remoteVoice.srcObject = event.streams[0];
          remoteVoice.play().catch(() => {});
        },
        onStateChange: handlers.onStateChange,
        onError: handlers.onError,
      })
      : null);
    const app = appModule.createApp({
      api,
      view,
      voice,
      sessionStore,
      roomHint: query.get("room") || "",
      now: Date.now,
      randomUUID: window.crypto?.randomUUID?.bind(window.crypto),
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      clipboard: window.navigator.clipboard,
      createPeer,
    });
    await app.start();
    return app;
  }

  return { bootstrap, requireElement };
});

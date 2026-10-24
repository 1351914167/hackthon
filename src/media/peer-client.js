(function attachPeerClient(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WerewolfPeerClient = api;
}(typeof globalThis === "object" ? globalThis : this, function peerClientFactory() {
  "use strict";

  function createPeerClient(options) {
    if (!options || typeof options !== "object") throw new TypeError("Peer client options are required");
    const roomId = requiredString(options.roomId, "roomId");
    const seatToken = requiredString(options.seatToken, "seatToken");
    const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const PeerConnection = options.RTCPeerConnection || (typeof RTCPeerConnection === "function" ? RTCPeerConnection : null);
    const getUserMedia = options.getUserMedia || (typeof navigator === "object" && navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null);
    const setIntervalFn = options.setIntervalFn || setInterval;
    const clearIntervalFn = options.clearIntervalFn || clearInterval;
    const onTrack = options.onTrack || function noop() {};
    const onStateChange = options.onStateChange || function noop() {};
    const onError = options.onError || function noop() {};
    const now = options.now || Date.now;
    const pollIntervalMs = options.pollIntervalMs || 1_000;
    const connectionRecoveryMs = options.connectionRecoveryMs ?? 10_000;
    const retryCooldownMs = options.retryCooldownMs ?? 5_000;
    const baseUrl = (options.baseUrl || "").replace(/\/$/, "");
    if (!fetchImpl || !PeerConnection || !getUserMedia || typeof setIntervalFn !== "function" ||
        typeof clearIntervalFn !== "function" || typeof now !== "function" ||
        !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 ||
        !Number.isSafeInteger(connectionRecoveryMs) || connectionRecoveryMs < 0 ||
        !Number.isSafeInteger(retryCooldownMs) || retryCooldownMs < 0) {
      throw new TypeError("Peer client browser dependencies are invalid");
    }

    const connections = new Map();
    const pendingCandidates = new Map();
    const lastRetryAt = new Map();
    let started = false;
    let stopped = true;
    let pollTimer = null;
    let polling = null;
    let startPromise = null;
    let topologyQueue = Promise.resolve();
    let lifecycleEpoch = 0;
    let topologyRevision = 0;
    let desiredTopologySignature = "";
    let gameId = null;
    let selfSeatId = null;
    let currentSpeakerSeatId = null;
    let peerSeatIds = [];
    let iceServers = [];
    let localStream = null;

    function keepTopologyQueueAlive() {}

    function start() {
      if (started) return Promise.resolve(getState());
      if (startPromise) return startPromise;
      stopped = false;
      const epoch = ++lifecycleEpoch;
      startPromise = (async function startClient() {
        const joined = await request("join", {});
        if (!isCurrent(epoch)) {
          await safeLeave();
          return getState();
        }
        iceServers = Array.isArray(joined.iceServers) ? joined.iceServers : [];
        await applyTopology(joined, epoch, { reset: true });
        if (!isCurrent(epoch)) {
          await safeLeave();
          return getState();
        }
        started = true;
        pollTimer = setIntervalFn(function schedulePoll() {
          poll().catch(onError);
        }, pollIntervalMs);
        onStateChange(getState());
        return getState();
      }()).catch(async function cleanFailedStart(error) {
        if (isCurrent(epoch)) {
          stopped = true;
          started = false;
          ++lifecycleEpoch;
          ++topologyRevision;
          desiredTopologySignature = "";
          closeAllConnections();
          stopLocalStream();
          await safeLeave();
        }
        throw error;
      }).finally(function clearStartPromise() {
        startPromise = null;
      });
      return startPromise;
    }

    async function stop() {
      if (stopped && !startPromise) return;
      stopped = true;
      started = false;
      ++lifecycleEpoch;
      ++topologyRevision;
      desiredTopologySignature = "";
      if (pollTimer !== null) clearIntervalFn(pollTimer);
      pollTimer = null;
      polling = null;
      closeAllConnections();
      stopLocalStream();
      await safeLeave();
      onStateChange(getState());
    }

    function poll() {
      if (!started || stopped) return Promise.resolve(getState());
      const epoch = lifecycleEpoch;
      if (polling?.epoch === epoch) return polling.promise;
      const promise = performPoll(epoch, true).finally(function clearPolling() {
        if (polling?.promise === promise) polling = null;
      });
      polling = { epoch, promise };
      return promise;
    }

    async function performPoll(epoch, allowRejoin) {
      try {
        const topology = await request("peers", {});
        if (!isCurrent(epoch)) return getState();
        await applyTopology(topology, epoch);
        if (!isCurrent(epoch)) return getState();
        const drained = await request("drain", {});
        if (!isCurrent(epoch)) return getState();
        if (Object.prototype.hasOwnProperty.call(drained, "currentSpeakerSeatId") &&
            drained.currentSpeakerSeatId !== currentSpeakerSeatId) {
          await applyTopology({ ...topology, currentSpeakerSeatId: drained.currentSpeakerSeatId }, epoch);
        }
        for (const signal of drained.signals || []) await handleSignal(signal);
        await recoverUnhealthyConnections(epoch);
        return getState();
      } catch (error) {
        if (allowRejoin && error?.code === "MEDIA_NOT_JOINED" && isCurrent(epoch)) {
          const joined = await request("join", {});
          if (!isCurrent(epoch)) return getState();
          iceServers = Array.isArray(joined.iceServers) ? joined.iceServers : iceServers;
          await applyTopology(joined, epoch, { reset: true });
          return performPoll(epoch, false);
        }
        throw error;
      }
    }

    async function updateRoomSnapshot(snapshot) {
      if (!snapshot || snapshot.roomId !== roomId || !snapshot.game) return getState();
      const connectedSeats = new Set((snapshot.seats || []).filter((seat) => seat.connected).map((seat) => seat.seatId));
      const peers = peerSeatIds.filter((seatId) => connectedSeats.has(seatId)).map((seatId) => ({ seatId }));
      await applyTopology({
        gameId: snapshot.game.gameId,
        selfSeatId: snapshot.selfSeatId,
        currentSpeakerSeatId: snapshot.game.currentSpeakerSeatId,
        peers,
      }, lifecycleEpoch);
      return getState();
    }

    function applyTopology(topology, epoch = lifecycleEpoch, options = {}) {
      const normalized = normalizeTopology(topology);
      const signature = JSON.stringify(normalized);
      if (options.reset || signature !== desiredTopologySignature) ++topologyRevision;
      desiredTopologySignature = signature;
      const revision = topologyRevision;
      const run = topologyQueue.then(() => applyTopologyNow(normalized, epoch, revision, options));
      topologyQueue = run.catch(keepTopologyQueueAlive);
      return run;
    }

    function normalizeTopology(topology) {
      const nextGameId = requiredString(topology.gameId, "gameId");
      const nextSelfSeatId = requiredString(topology.selfSeatId, "selfSeatId");
      const peers = [...new Set((topology.peers || []).map((peer) => peer.seatId))]
        .filter((seatId) => typeof seatId === "string" && seatId !== nextSelfSeatId)
        .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
      return {
        gameId: nextGameId,
        selfSeatId: nextSelfSeatId,
        currentSpeakerSeatId: topology.currentSpeakerSeatId || null,
        peers: peers.map((seatId) => ({ seatId })),
      };
    }

    async function applyTopologyNow(topology, epoch, revision, options) {
      if (!isCurrentTopology(epoch, revision)) return getState();
      const nextGameId = topology.gameId;
      const nextSelfSeatId = topology.selfSeatId;
      const nextSpeaker = topology.currentSpeakerSeatId;
      const nextPeers = topology.peers.map((peer) => peer.seatId);
      const changedSpeaker = currentSpeakerSeatId !== nextSpeaker || gameId !== nextGameId;
      gameId = nextGameId;
      selfSeatId = nextSelfSeatId;
      currentSpeakerSeatId = nextSpeaker;
      peerSeatIds = nextPeers;
      if (changedSpeaker || options.reset) closeAllConnections();
      for (const [seatId] of connections) {
        if (!peerSeatIds.includes(seatId)) closeConnection(seatId);
      }

      if (currentSpeakerSeatId === selfSeatId) {
        const stream = await ensureLocalStream(epoch, revision);
        if (!stream || !isCurrentTopology(epoch, revision) || currentSpeakerSeatId !== selfSeatId) return getState();
        for (const seatId of peerSeatIds) {
          if (!isCurrentTopology(epoch, revision)) return getState();
          await ensureOffer(seatId, epoch, revision);
        }
      } else {
        stopLocalStream();
      }
      if (isCurrentTopology(epoch, revision)) onStateChange(getState());
      return getState();
    }

    async function ensureLocalStream(epoch, revision) {
      if (localStream) return localStream;
      const stream = await getUserMedia({ audio: true, video: false });
      if (!stream || typeof stream.getAudioTracks !== "function") throw new Error("getUserMedia returned no audio stream");
      if (!isCurrentTopology(epoch, revision) || currentSpeakerSeatId !== selfSeatId) {
        stopStream(stream);
        return null;
      }
      localStream = stream;
      for (const track of localStream.getAudioTracks()) track.enabled = true;
      return localStream;
    }

    function stopLocalStream() {
      if (!localStream) return;
      stopStream(localStream);
      localStream = null;
    }

    function stopStream(stream) {
      for (const track of stream.getTracks()) track.stop();
    }

    function createConnection(peerSeatId, withLocalTracks) {
      const connection = new PeerConnection({ iceServers });
      const createdAt = now();
      const metadata = { connection, createdAt, unhealthySince: createdAt, remoteReady: false };
      connections.set(peerSeatId, metadata);
      connection.onicecandidate = function onIceCandidate(event) {
        if (!event.candidate || stopped || connections.get(peerSeatId)?.connection !== connection) return;
        const candidate = typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate;
        publish(peerSeatId, { type: "ice", candidate }).catch(onError);
      };
      connection.ontrack = function receiveTrack(event) {
        if (stopped || connections.get(peerSeatId)?.connection !== connection || peerSeatId !== currentSpeakerSeatId) {
          const streamTracks = (event.streams || []).flatMap((stream) => stream.getTracks());
          const rejectedTracks = streamTracks.length ? streamTracks : [event.track].filter(Boolean);
          for (const track of rejectedTracks) track.stop?.();
          return;
        }
        onTrack(event, { fromSeatId: peerSeatId });
      };
      connection.onconnectionstatechange = function connectionStateChanged() {
        const current = connections.get(peerSeatId);
        if (!current || current.connection !== connection) return;
        if (connection.connectionState === "connected") current.unhealthySince = null;
        else if (["new", "connecting", "disconnected", "failed"].includes(connection.connectionState)) {
          current.unhealthySince ??= now();
        }
        onStateChange(getState());
        if (connection.connectionState === "failed") scheduleConnectionRecovery(peerSeatId, lifecycleEpoch);
      };
      if (withLocalTracks && localStream) {
        for (const track of localStream.getAudioTracks()) connection.addTrack(track, localStream);
      }
      return connection;
    }

    async function ensureOffer(peerSeatId, epoch, revision) {
      if (connections.has(peerSeatId)) return;
      const connection = createConnection(peerSeatId, true);
      const offer = await connection.createOffer();
      if (!isCurrentTopology(epoch, revision) || connections.get(peerSeatId)?.connection !== connection) {
        if (connections.get(peerSeatId)?.connection === connection) closeConnection(peerSeatId);
        return;
      }
      await connection.setLocalDescription(offer);
      if (!isCurrentTopology(epoch, revision) || connections.get(peerSeatId)?.connection !== connection) {
        if (connections.get(peerSeatId)?.connection === connection) closeConnection(peerSeatId);
        return;
      }
      await publish(peerSeatId, { type: "offer", sdp: connection.localDescription?.sdp || offer.sdp });
    }

    async function handleSignal(signal) {
      if (!signal || !peerSeatIds.includes(signal.fromSeatId)) return;
      if (signal.type === "offer") {
        if (signal.fromSeatId !== currentSpeakerSeatId || selfSeatId === currentSpeakerSeatId) return;
        closeConnection(signal.fromSeatId, { preserveCandidates: true });
        const connection = createConnection(signal.fromSeatId, false);
        await connection.setRemoteDescription({ type: "offer", sdp: signal.payload.sdp });
        const metadata = connections.get(signal.fromSeatId);
        if (!metadata || metadata.connection !== connection) return;
        metadata.remoteReady = true;
        await flushCandidates(signal.fromSeatId, metadata);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        await publish(signal.fromSeatId, { type: "answer", sdp: connection.localDescription?.sdp || answer.sdp });
        return;
      }
      if (signal.type === "answer") {
        if (selfSeatId !== currentSpeakerSeatId) return;
        const metadata = connections.get(signal.fromSeatId);
        if (metadata) {
          await metadata.connection.setRemoteDescription({ type: "answer", sdp: signal.payload.sdp });
          metadata.remoteReady = true;
          await flushCandidates(signal.fromSeatId, metadata);
        }
        return;
      }
      if (signal.type === "ice") {
        const metadata = connections.get(signal.fromSeatId);
        if (!metadata || !metadata.remoteReady) {
          const candidates = pendingCandidates.get(signal.fromSeatId) || [];
          if (candidates.length < 64) candidates.push(signal.payload);
          pendingCandidates.set(signal.fromSeatId, candidates);
        } else {
          await metadata.connection.addIceCandidate(signal.payload);
        }
      }
    }

    async function flushCandidates(peerSeatId, metadata) {
      const candidates = pendingCandidates.get(peerSeatId) || [];
      pendingCandidates.delete(peerSeatId);
      for (const candidate of candidates) {
        if (connections.get(peerSeatId) !== metadata) return;
        await metadata.connection.addIceCandidate(candidate);
      }
    }

    async function publish(recipientSeatId, signal) {
      return request("signal", { recipientSeatId, signal });
    }

    function closeConnection(peerSeatId, options = {}) {
      const metadata = connections.get(peerSeatId);
      if (!metadata) return;
      const connection = metadata.connection;
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.onconnectionstatechange = null;
      connection.close();
      connections.delete(peerSeatId);
      if (!options.preserveCandidates) pendingCandidates.delete(peerSeatId);
    }

    function closeAllConnections() {
      for (const seatId of [...connections.keys()]) closeConnection(seatId);
      pendingCandidates.clear();
    }

    async function recoverUnhealthyConnections(epoch) {
      const revision = topologyRevision;
      for (const [peerSeatId, metadata] of [...connections]) {
        if (!isCurrentTopology(epoch, revision)) return;
        const state = metadata.connection.connectionState;
        if (state === "connected") continue;
        const unhealthySince = metadata.unhealthySince;
        if (state === "failed" || now() - unhealthySince >= connectionRecoveryMs) {
          await recoverConnection(peerSeatId, epoch, revision);
        }
      }
    }

    function scheduleConnectionRecovery(peerSeatId, epoch) {
      const revision = topologyRevision;
      enqueueTopologyTask(async function recoverFailedConnection() {
        if (!isCurrentTopology(epoch, revision)) return;
        await recoverConnection(peerSeatId, epoch, revision);
      }).catch(onError);
    }

    async function recoverConnection(peerSeatId, epoch, revision) {
      const lastAttempt = lastRetryAt.get(peerSeatId) ?? -Infinity;
      if (now() - lastAttempt < retryCooldownMs) return;
      lastRetryAt.set(peerSeatId, now());
      closeConnection(peerSeatId);
      onStateChange(getState());
      if (currentSpeakerSeatId === selfSeatId && peerSeatIds.includes(peerSeatId)) {
        await ensureOffer(peerSeatId, epoch, revision);
      }
    }

    function enqueueTopologyTask(task) {
      const run = topologyQueue.then(task);
      topologyQueue = run.catch(keepTopologyQueueAlive);
      return run;
    }

    async function request(operation, body) {
      const response = await fetchImpl(`${baseUrl}/api/media/${operation}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${seatToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roomId, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `Media request failed with ${response.status}`);
        error.code = payload?.error?.code || "MEDIA_REQUEST_FAILED";
        throw error;
      }
      return payload;
    }

    async function safeLeave() {
      try {
        await request("leave", {});
      } catch (error) {
        onError(error);
      }
    }

    function isCurrent(epoch) {
      return !stopped && lifecycleEpoch === epoch;
    }

    function isCurrentTopology(epoch, revision) {
      return isCurrent(epoch) && topologyRevision === revision;
    }

    function getState() {
      let connectedPeerCount = 0;
      let failedPeerCount = 0;
      for (const { connection } of connections.values()) {
        if (connection.connectionState === "connected") connectedPeerCount += 1;
        else if (connection.connectionState === "failed") failedPeerCount += 1;
      }
      const connectingPeerCount = connections.size - connectedPeerCount - failedPeerCount;
      return Object.freeze({
        started,
        roomId,
        gameId,
        selfSeatId,
        currentSpeakerSeatId,
        peerSeatIds: [...peerSeatIds],
        isSpeaker: Boolean(selfSeatId && selfSeatId === currentSpeakerSeatId),
        hasLocalStream: Boolean(localStream),
        connectionCount: connections.size,
        connectedPeerCount,
        connectingPeerCount,
        failedPeerCount,
      });
    }

    return Object.freeze({ getState, poll, start, stop, updateRoomSnapshot });
  }

  function requiredString(value, name) {
    if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
    return value;
  }

  return { createPeerClient };
}));

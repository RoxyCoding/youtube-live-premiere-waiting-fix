// ==UserScript==
// @name         YouTube Fix - Stuck Live Playback
// @namespace    youtube-live-premiere-waiting-fix
// @version      2.6.0
// @description  開始後も待機画面に残るライブ・プレミア公開を、ページ全体を更新せず再生へ切り替えます。
// @author       RoxyCoding
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const TICK_MILLISECONDS = 100;
  const RECONNECT_DELAY_MILLISECONDS = 1_000;
  const PLAYBACK_START_TIMEOUT_MILLISECONDS = 1_000;
  const FLICKER_GUARD_ID = "youtube-fix-flicker-guard";

  const state = {
    generation: 0,
    videoId: "",
    phase: "idle",
    attempts: 0,
    channelName: "",
    countdownTarget: "ライブ配信",
    activeSince: 0,
    lastVideoTime: Number.NaN,
    nextReconnectAt: 0,
    status: "初期化しました。",
  };

  setInterval(() => void tick(), TICK_MILLISECONDS);

  // 0.1秒ごとに動画、開始時刻、実際の再生状態を確認する。
  function tick() {
    const page = inspectPage();
    synchronizeVideo(page.videoId);

    if (!page.videoId) {
      setStatus("動画ページではありません。");
      return;
    }

    updateCountdown(page.scheduledStartAt, page.channelName);

    if (hasPlaybackStarted(page)) {
      state.phase = "playing";
      removeFlickerGuard();
      setStatus("再生中です。自動再接続を停止しました。");
      return;
    }
    if (state.phase === "playing") return;

    // 開始を一度確認したら、待機DOMが一時的に消えても再生まで継続する。
    if (state.phase === "starting") {
      drivePlayer(page);
      return;
    }

    if (!page.isLiveOrPremiere) {
      setStatus("ライブ・プレミア公開の待機画面ではありません。");
      return;
    }

    // 予定より早く始まった場合も、プレーヤーの状態だけで開始を検出する。
    const activePlayerState = [1, 2, 3, 5].includes(page.playerState);
    if (
      page.isLiveNow
      || (page.hasOfflineSlate && (page.hasPlayableStream || activePlayerState))
    ) {
      beginStarting("YouTube プレーヤー");
      drivePlayer(page);
      return;
    }

    if (!page.hasOfflineSlate) {
      setStatus("ライブ・プレミア公開の待機画面ではありません。");
      return;
    }

    const scheduledStartReached = Number.isFinite(page.scheduledStartAt)
      && Date.now() >= page.scheduledStartAt;
    if (scheduledStartReached) {
      beginStarting("画面の開始予定時刻");
      drivePlayer(page);
      return;
    }

    probeWaitingPlayer(page);
  }

  function synchronizeVideo(videoId) {
    if (state.videoId === videoId) return;
    removeFlickerGuard();
    state.generation += 1;
    state.videoId = videoId;
    state.phase = "idle";
    state.attempts = 0;
    state.channelName = "";
    state.countdownTarget = "ライブ配信";
    state.activeSince = 0;
    state.lastVideoTime = Number.NaN;
    state.nextReconnectAt = 0;
  }

  function beginStarting(reason) {
    if (state.phase === "starting") return;
    state.phase = "starting";
    setStatus(`${reason}で開始を確認しました。再生まで再接続します。`);
  }

  // APIの代わりにプレーヤー自身を読み直し、予定より早い開始も取得する。
  function probeWaitingPlayer(page) {
    const now = Date.now();
    if (now < state.nextReconnectAt) return;

    const { player } = page;
    if (!player || typeof player.loadVideoById !== "function") {
      setStatus("YouTube プレーヤーを取得できません。0.1秒後に再試行します。", true);
      return;
    }

    try {
      showFlickerGuard(player);
      state.attempts += 1;
      state.nextReconnectAt = now + RECONNECT_DELAY_MILLISECONDS;
      player.loadVideoById(page.videoId);
      requestPlayback(player, page.video, state.generation);
      setStatus(`開始確認 ${state.attempts}回目。プレーヤーを監視します。`);
    } catch (error) {
      setStatus(`開始確認に失敗しました: ${error.message}`, true);
    }
  }

  // 0.1秒ごとに再生を促し、準備中のプレーヤーをリセットしないよう再接続を制御する。
  function drivePlayer(page) {
    if (state.videoId !== page.videoId) return;

    const { player, video } = page;
    if (!player) {
      setStatus("YouTube プレーヤーを取得できません。0.1秒後に再試行します。", true);
      return;
    }

    const now = Date.now();
    const generation = state.generation;
    if (state.attempts > 0) {
      requestPlayback(player, video, generation);

      const playerState = readPlayerState(player);
      const preparingPlayback = playerState === 1
        || playerState === 3
        || Boolean(video && !video.paused && !video.ended);
      if (preparingPlayback) {
        if (!state.activeSince) state.activeSince = now;
        if (now - state.activeSince < PLAYBACK_START_TIMEOUT_MILLISECONDS) {
          setStatus("再生準備中です。プレーヤーを維持します。");
          return;
        }
      } else {
        state.activeSince = 0;
      }

      if (now < state.nextReconnectAt) return;
    }

    try {
      if (typeof player.loadVideoById !== "function") {
        throw new Error("loadVideoById を利用できません。");
      }

      showFlickerGuard(player);
      state.attempts += 1;
      state.activeSince = 0;
      state.nextReconnectAt = now + RECONNECT_DELAY_MILLISECONDS;
      player.loadVideoById(page.videoId);
      if (typeof player.playVideo === "function") player.playVideo();
      const currentVideo = unsafeWindow.document.querySelector(
        "video.html5-main-video, #movie_player video",
      );
      requestHtmlVideoPlayback(currentVideo, player, generation);
      setStatus(`プレーヤー再接続 ${state.attempts}回目。再生準備を待ちます。`);
    } catch (error) {
      setStatus(`プレーヤーの再接続に失敗しました: ${error.message}`, true);
    }
  }

  function requestPlayback(player, video, generation) {
    try {
      if (typeof player.playVideo === "function") player.playVideo();
    } catch {
      // 読み込み途中の一時的な失敗は次の監視周期で再試行する。
    }
    requestHtmlVideoPlayback(video, player, generation);
  }

  // 0.1秒ごとの再接続による黒画面を、現在の待機画面で覆って防ぐ。
  function showFlickerGuard(player) {
    const pageDocument = unsafeWindow.document;
    if (pageDocument.getElementById(FLICKER_GUARD_ID)) return;

    const slate = pageDocument.querySelector(
      `.ytp-offline-slate:not(#${FLICKER_GUARD_ID})`,
    );
    if (!slate?.cloneNode || typeof player.appendChild !== "function") return;

    const guard = slate.cloneNode(true);
    guard.id = FLICKER_GUARD_ID;
    guard.setAttribute?.("aria-hidden", "true");
    Object.assign(guard.style, {
      animation: "none",
      display: "block",
      inset: "0",
      opacity: "1",
      pointerEvents: "none",
      position: "absolute",
      transition: "none",
      visibility: "visible",
      zIndex: "99",
    });
    player.appendChild(guard);
  }

  function removeFlickerGuard() {
    unsafeWindow.document?.getElementById(FLICKER_GUARD_ID)?.remove();
  }

  // YouTube側の表示が止まっていても、開始予定時刻から残り時間を進める。
  function updateCountdown(scheduledStartAt, channelName) {
    if (!Number.isFinite(scheduledStartAt)) return;

    const normalizedChannelName = String(channelName || "").replace(/\s+/g, " ").trim();
    if (normalizedChannelName) state.channelName = normalizedChannelName;

    const elements = unsafeWindow.document.querySelectorAll(
      ".ytp-offline-slate-main-text",
    );
    if (elements.length === 0) return;

    for (const element of elements) {
      const currentText = element.textContent || "";
      if (currentText.includes("公開")) state.countdownTarget = "公開";
      if (currentText.includes("ライブ")) state.countdownTarget = "ライブ配信";
    }

    const remainingSeconds = Math.max(
      0,
      Math.ceil((scheduledStartAt - Date.now()) / 1_000),
    );
    const message = remainingSeconds === 0
      ? state.countdownTarget === "ライブ配信"
        ? `${state.channelName || "配信者"}を待っています`
        : "まもなく公開"
      : remainingSeconds <= 60
        ? `${remainingSeconds} 秒後に${state.countdownTarget}`
        : `${Math.ceil(remainingSeconds / 60)} 分後に${state.countdownTarget}`;

    for (const element of elements) {
      if (element.textContent !== message) element.textContent = message;
      element.setAttribute?.("aria-label", message);
    }
  }

  function requestHtmlVideoPlayback(video, player, generation) {
    if (!video || typeof video.play !== "function" || !video.paused) return;

    const retryMuted = (error) => {
      if (state.generation !== generation || error?.name !== "NotAllowedError") return;
      video.muted = true;
      if (typeof player.mute === "function") player.mute();
      try {
        Promise.resolve(video.play()).then(() => {
          setStatus("自動再生制限を回避するため、ミュートで再生を開始しました。", true);
        }).catch(() => {});
      } catch {
        // 次の監視周期で再試行する。
      }
    };

    try {
      Promise.resolve(video.play()).catch(retryMuted);
    } catch (error) {
      retryMuted(error);
    }
  }

  function hasPlaybackStarted(page) {
    const currentTime = page.video?.currentTime;
    const progressed = Number.isFinite(currentTime)
      && Number.isFinite(state.lastVideoTime)
      && currentTime > state.lastVideoTime + 0.05;
    if (Number.isFinite(currentTime)) state.lastVideoTime = currentTime;
    const playerReportsPlaying = page.playerState === 1
      || (!page.hasPlayerStateApi && progressed);
    return Boolean(
      progressed
      && playerReportsPlaying
      && page.video
      && !page.video.paused
      && !page.video.ended
      && page.video.readyState >= 2
    );
  }

  function inspectPage() {
    const pageUrl = new URL(location.href);
    const livePathVideoId = pageUrl.pathname.match(/^\/live\/([^/?]+)/)?.[1] || "";
    const videoId = pageUrl.searchParams.get("v") || livePathVideoId;
    const pageDocument = unsafeWindow.document || document;
    const player = pageDocument.getElementById("movie_player");
    const video = pageDocument.querySelector("video.html5-main-video, #movie_player video");
    const offlineSlate = pageDocument.querySelector(
      `.ytp-offline-slate:not(#${FLICKER_GUARD_ID})`,
    );
    const scheduledText = pageDocument.querySelector(".ytp-offline-slate-subtitle-text")?.textContent || "";
    const playerResponse = readPlayerResponse(player, videoId);
    const channelNameElement = pageDocument.querySelector(
      "ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a, .slim-owner-channel-name",
    );
    const channelName = playerResponse?.videoDetails?.author
      || playerResponse?.microformat?.playerMicroformatRenderer?.ownerChannelName
      || channelNameElement?.textContent
      || "";
    const playability = playerResponse?.playabilityStatus;
    const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
    const playerState = readPlayerState(player);
    let hasOfflineSlate = Boolean(offlineSlate);
    try {
      const style = offlineSlate && unsafeWindow.getComputedStyle?.(offlineSlate);
      hasOfflineSlate = Boolean(offlineSlate && style?.display !== "none" && style?.visibility !== "hidden");
    } catch {
      // レイアウト取得に失敗しても、実在する待機DOMを優先する。
    }

    return {
      videoId,
      channelName,
      player,
      video,
      playerState,
      hasPlayerStateApi: typeof player?.getPlayerState === "function",
      hasOfflineSlate,
      hasPlayableStream: playability?.status === "OK" && Boolean(playerResponse?.streamingData),
      isLiveNow: Boolean(playerResponse?.videoDetails?.isLive || liveDetails?.isLiveNow),
      scheduledStartAt: parseScheduledStartTime(scheduledText),
      isLiveOrPremiere: Boolean(
        hasOfflineSlate
        || playerResponse?.videoDetails?.isLiveContent
        || liveDetails
        || playability?.liveStreamability
      ),
    };
  }

  function readPlayerState(player) {
    try {
      return typeof player?.getPlayerState === "function" ? player.getPlayerState() : -1;
    } catch {
      return -1;
    }
  }

  function readPlayerResponse(player, videoId) {
    let currentResponse = null;
    try {
      if (typeof player?.getPlayerResponse === "function") {
        currentResponse = player.getPlayerResponse();
      }
    } catch {
      // SPA遷移中は取得に失敗することがあるため、次の候補を試す。
    }

    const serialized = unsafeWindow.ytplayer?.config?.args?.player_response;
    const candidates = [currentResponse, unsafeWindow.ytInitialPlayerResponse, serialized];
    for (const candidate of candidates) {
      try {
        const response = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
        if (response?.videoDetails?.videoId === videoId) return response;
      } catch {
        // 壊れた古いレスポンスは無視する。
      }
    }
    return null;
  }

  // YouTubeの「9月2日 23:45」形式を、現在に最も近い年の日時へ変換する。
  function parseScheduledStartTime(text, now = new Date()) {
    const match = text.trim().match(/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
    if (!match) return Number.NaN;

    const month = Number(match[1]);
    const day = Number(match[2]);
    const hour = Number(match[3]);
    const minute = Number(match[4]);
    const candidates = [-1, 0, 1]
      .map((offset) => new Date(now.getFullYear() + offset, month - 1, day, hour, minute, 0, 0))
      .filter((candidate) => (
        candidate.getMonth() === month - 1
        && candidate.getDate() === day
        && candidate.getHours() === hour
        && candidate.getMinutes() === minute
      ));
    if (candidates.length === 0) return Number.NaN;

    return candidates.reduce((closest, candidate) => (
      Math.abs(candidate.getTime() - now.getTime()) < Math.abs(closest.getTime() - now.getTime())
        ? candidate
        : closest
    )).getTime();
  }

  function setStatus(message, warning = false) {
    if (state.status === message) return;
    state.status = message;
    const log = warning ? console.warn : console.info;
    log(`[YouTube Fix] ${message}`);
  }

})();

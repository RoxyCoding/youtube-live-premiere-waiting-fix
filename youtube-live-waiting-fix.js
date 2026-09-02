// ==UserScript==
// @name         YouTube Fix - Stuck Live Playback
// @namespace    youtube-live-waiting-fix
// @version      2.2.2
// @description  開始後も待機画面に残るライブ・プレミア公開を、ページ全体を更新せず再生へ切り替えます。
// @author       RoxyCoding
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @connect      www.googleapis.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const TICK_MILLISECONDS = 100;
  const API_KEY_NAME = "youtubeDataApiKey";
  const API_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
  const FLICKER_GUARD_ID = "youtube-fix-flicker-guard";

  const state = {
    generation: 0,
    videoId: "",
    phase: "idle",
    attempts: 0,
    apiRequestGeneration: -1,
    lastVideoTime: Number.NaN,
    status: "初期化しました。",
  };

  registerMenus();
  requestApiKeyOnFirstRun();
  setInterval(() => void tick(), TICK_MILLISECONDS);
  unsafeWindow.addEventListener("yt-navigate-finish", () => void tick(), true);
  unsafeWindow.addEventListener("visibilitychange", () => void tick(), true);
  unsafeWindow.addEventListener("online", () => void tick(), true);

  // 0.1秒ごとに動画、開始時刻、実際の再生状態を確認する。
  async function tick() {
    const page = inspectPage();
    synchronizeVideo(page.videoId);

    if (!page.videoId) {
      setStatus("動画ページではありません。");
      return;
    }

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

    if (!page.isLiveOrPremiere || !page.hasOfflineSlate) {
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

    await checkApiAndStart(page.videoId);
  }

  function synchronizeVideo(videoId) {
    if (state.videoId === videoId) return;
    removeFlickerGuard();
    state.generation += 1;
    state.videoId = videoId;
    state.phase = "idle";
    state.attempts = 0;
    state.apiRequestGeneration = -1;
    state.lastVideoTime = Number.NaN;
  }

  function beginStarting(reason) {
    if (state.phase === "starting") return;
    state.phase = "starting";
    setStatus(`${reason}で開始を確認しました。再生まで再接続します。`);
  }

  async function checkApiAndStart(videoId) {
    const apiKey = String(GM_getValue(API_KEY_NAME, "")).trim();
    if (!apiKey) {
      setStatus("API キーが未設定です。Tampermonkey メニューから設定してください。", true);
      return;
    }
    const requestGeneration = state.generation;
    if (state.apiRequestGeneration === requestGeneration) return;

    state.apiRequestGeneration = requestGeneration;
    try {
      const actualStartTime = await fetchActualStartTime(videoId, apiKey);
      if (state.generation !== requestGeneration) return;
      if (!actualStartTime) {
        setStatus("開始待ちです。0.1秒後に再確認します。");
        return;
      }

      beginStarting("YouTube Data API");
      drivePlayer(inspectPage());
    } catch (error) {
      if (state.generation !== requestGeneration) return;
      setStatus(`API の確認に失敗しました: ${error.message}。0.1秒後に再試行します。`, true);
    } finally {
      if (state.apiRequestGeneration === requestGeneration) {
        state.apiRequestGeneration = -1;
      }
    }
  }

  // 再生を確認するまで、0.1秒ごとにプレーヤーだけを即時再接続する。
  function drivePlayer(page) {
    if (state.videoId !== page.videoId) return;

    const { player } = page;
    if (!player) {
      setStatus("YouTube プレーヤーを取得できません。0.1秒後に再試行します。", true);
      return;
    }

    const generation = state.generation;
    try {
      if (typeof player.loadVideoById !== "function") {
        throw new Error("loadVideoById を利用できません。");
      }

      showFlickerGuard(player);
      state.attempts += 1;
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
    const playability = playerResponse?.playabilityStatus;
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
      player,
      video,
      playerState,
      hasPlayerStateApi: typeof player?.getPlayerState === "function",
      hasOfflineSlate,
      scheduledStartAt: parseScheduledStartTime(scheduledText),
      isLiveOrPremiere: Boolean(
        hasOfflineSlate
        || playerResponse?.videoDetails?.isLiveContent
        || playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
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

  async function fetchActualStartTime(videoId, apiKey) {
    const url = new URL(API_ENDPOINT);
    url.search = new URLSearchParams({
      part: "liveStreamingDetails",
      id: videoId,
      fields: "items(liveStreamingDetails(actualStartTime))",
      key: apiKey,
    }).toString();
    const response = await gmRequest(url.toString());
    const payload = JSON.parse(response.responseText || "{}");
    if (response.status < 200 || response.status >= 300) {
      const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.message || response.status;
      throw new Error(String(reason));
    }
    return payload?.items?.[0]?.liveStreamingDetails?.actualStartTime || "";
  }

  function gmRequest(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 10_000,
        onload: resolve,
        onerror: () => reject(new Error("YouTube Data APIへ接続できません。")),
        ontimeout: () => reject(new Error("YouTube Data APIがタイムアウトしました。")),
      });
    });
  }

  function registerMenus() {
    GM_registerMenuCommand("YouTube Data API キーを設定", () => {
      const value = prompt("YouTube Data API キーを入力してください。", "")?.trim();
      if (!value) return;
      GM_setValue(API_KEY_NAME, value);
      alert("API キーを保存しました。");
    });
    GM_registerMenuCommand("保存した API キーを削除", () => {
      if (!confirm("保存したAPIキーを削除しますか？")) return;
      GM_deleteValue(API_KEY_NAME);
      alert("API キーを削除しました。");
    });
    GM_registerMenuCommand("現在の監視状態を表示", () => {
      alert(`動画 ID: ${state.videoId || "なし"}\n状態: ${state.phase}\n${state.status}`);
    });
  }

  function requestApiKeyOnFirstRun() {
    if (GM_getValue(API_KEY_NAME, "")) return;
    const value = prompt(
      "YouTube ライブ待機解除を使うには、YouTube Data API キーを入力してください。",
      "",
    )?.trim();
    if (value) GM_setValue(API_KEY_NAME, value);
  }

  function setStatus(message, warning = false) {
    if (state.status === message) return;
    state.status = message;
    const log = warning ? console.warn : console.info;
    log(`[YouTube Fix] ${message}`);
  }

})();

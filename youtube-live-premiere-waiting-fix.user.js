// ==UserScript==
// @name         YouTube Live / Premiere Waiting Fix (API)
// @namespace    youtube-live-premiere-waiting-fix-api
// @version      1.0.5
// @description  YouTube Data APIでライブ・プレミア公開の開始を確認し、待機画面から安全に再生へ切り替えます。
// @author       RoxyCoding
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const API_KEY_STORAGE_KEY = "youtube-data-api-key";
  const API_POLL_INTERVAL_MILLISECONDS = 30_000;
  const API_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
  const API_RETRY_BASE_MILLISECONDS = 60_000;
  const API_RETRY_MAX_MILLISECONDS = 15 * 60_000;
  const START_PROPAGATION_DELAY_MILLISECONDS = 3_000;
  const PLAYBACK_START_TIMEOUT_MILLISECONDS = 10_000;
  const PLAYBACK_RETRY_INTERVAL_MILLISECONDS = 2_000;
  const PAGE_RELOAD_COOLDOWN_MILLISECONDS = 60_000;
  const API_LEASE_DURATION_MILLISECONDS = 45_000;
  const API_LEASE_REFRESH_MILLISECONDS = 10_000;
  const TICK_MILLISECONDS = 100;
  const OVERRIDE_TEXT_ATTRIBUTE = "data-waiting-fix-text";
  const TAB_INSTANCE_ID = createTabInstanceId();

  const state = {
    generation: 0,
    videoId: "",
    phase: "idle",
    apiKey: readApiKey(),
    apiDisabled: false,
    apiRequestInFlight: false,
    apiFailureCount: 0,
    nextApiRequestAt: 0,
    scheduledStartAt: Number.NaN,
    actualStartAt: Number.NaN,
    broadcastKind: "live",
    playbackRequestedAt: 0,
    nextPlaybackRequestAt: 0,
    nextApiLeaseRefreshAt: 0,
    lastVideoTime: Number.NaN,
    wasWaiting: false,
    status: "初期化しました。",
  };

  GM_registerMenuCommand("YouTube APIキーを設定", configureApiKey);
  GM_registerMenuCommand("YouTube APIキーを削除", deleteApiKey);

  if (!state.apiKey) {
    setTimeout(() => configureApiKey(true), 0);
  }
  setInterval(() => void tick(), TICK_MILLISECONDS);
  unsafeWindow.addEventListener("pagehide", () => releaseApiPollingLease(state.videoId));
  void tick();

  function readApiKey() {
    try {
      return String(GM_getValue(API_KEY_STORAGE_KEY, "") || "").trim();
    } catch {
      return "";
    }
  }

  function configureApiKey(isInitialSetup = false) {
    const message = isInitialSetup
      ? "YouTube Data APIキーを入力してください。\nキーはTampermonkey内に保存され、ソースには書き込まれません。"
      : "新しいYouTube Data APIキーを入力してください。";
    const apiKey = unsafeWindow.prompt(message, "");
    if (apiKey === null) {
      if (isInitialSetup) {
        setStatus("APIキーが未設定です。Tampermonkeyメニューから設定してください。", true);
      }
      return;
    }

    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      unsafeWindow.alert("APIキーが空です。値を入力して、もう一度保存してください。");
      return;
    }

    GM_setValue(API_KEY_STORAGE_KEY, normalizedApiKey);
    state.apiKey = normalizedApiKey;
    state.apiDisabled = false;
    state.apiFailureCount = 0;
    state.nextApiRequestAt = 0;
    setStatus("APIキーを保存しました。監視を開始します。");
  }

  function deleteApiKey() {
    if (!unsafeWindow.confirm("保存済みのYouTube Data APIキーを削除しますか？")) return;
    GM_setValue(API_KEY_STORAGE_KEY, "");
    state.apiKey = "";
    state.apiDisabled = true;
    setStatus("APIキーを削除しました。", true);
  }

  function tick() {
    const page = inspectPage();
    synchronizeVideo(page.videoId);

    if (!page.videoId) {
      setStatus("動画ページではありません。");
      return;
    }

    if (!state.apiKey) {
      setStatus("APIキーが未設定です。Tampermonkeyメニューから設定してください。", true);
      return;
    }
    if (state.apiDisabled) return;

    inferBroadcastKind(page.mainText);
    updateTimeDisplay(page);
    if (page.hasOfflineSlate) state.wasWaiting = true;

    const playbackStarted = hasPlaybackStarted(page.video);
    if (playbackStarted && !page.hasOfflineSlate) {
      state.phase = "playing";
      state.wasWaiting = false;
      state.nextApiRequestAt = Number.POSITIVE_INFINITY;
      setStatus("再生を確認しました。API監視を停止します。");
      return;
    }

    if (state.phase === "starting") {
      if (Date.now() - state.playbackRequestedAt >= PLAYBACK_START_TIMEOUT_MILLISECONDS) {
        recoverWithPageReload();
      } else if (Date.now() >= state.nextPlaybackRequestAt) {
        requestPlayback(page.player, page.video);
        state.nextPlaybackRequestAt = Date.now() + PLAYBACK_RETRY_INTERVAL_MILLISECONDS;
      }
      return;
    }
    if (state.phase === "failed" || state.phase === "reloading") return;

    if (
      Number.isFinite(state.actualStartAt)
      && Date.now() >= state.actualStartAt + START_PROPAGATION_DELAY_MILLISECONDS
      && state.wasWaiting
    ) {
      startPlayback(page);
      return;
    }

    if (state.phase === "ordinary") return;

    if (unsafeWindow.document.visibilityState !== "visible") {
      setStatus("バックグラウンド中はAPI監視を一時停止します。");
      return;
    }
    if (!hasApiPollingLease(page.videoId)) {
      setStatus("同じ動画を別のタブで監視しています。");
      return;
    }

    if (Date.now() >= state.nextApiRequestAt && !state.apiRequestInFlight) {
      void pollVideoStatus(page.videoId, state.generation);
    }
  }

  function synchronizeVideo(videoId) {
    if (state.videoId === videoId) return;
    releaseApiPollingLease(state.videoId);
    state.generation += 1;
    state.videoId = videoId;
    state.phase = "idle";
    state.apiRequestInFlight = false;
    state.apiFailureCount = 0;
    state.nextApiRequestAt = 0;
    state.scheduledStartAt = Number.NaN;
    state.actualStartAt = Number.NaN;
    state.broadcastKind = "live";
    state.playbackRequestedAt = 0;
    state.nextPlaybackRequestAt = 0;
    state.nextApiLeaseRefreshAt = 0;
    state.lastVideoTime = Number.NaN;
    state.wasWaiting = false;

    // 自動復旧の直後は、待機画面がなくても再生要求を引き継ぐ。
    const resumeKey = `youtube-api-fix-resume:${videoId}`;
    try {
      const resumeAt = Number(unsafeWindow.sessionStorage.getItem(resumeKey));
      unsafeWindow.sessionStorage.removeItem(resumeKey);
      const elapsed = Date.now() - resumeAt;
      if (resumeAt > 0 && elapsed >= 0 && elapsed < PAGE_RELOAD_COOLDOWN_MILLISECONDS) {
        state.phase = "starting";
        state.playbackRequestedAt = Date.now();
      }
    } catch {
      // 保存領域を利用できない場合は、通常の開始監視を続ける。
    }
  }

  async function pollVideoStatus(videoId, generation) {
    state.apiRequestInFlight = true;
    try {
      const video = await fetchVideoStatus(videoId);
      if (state.generation !== generation) return;

      state.apiFailureCount = 0;
      if (!video?.liveStreamingDetails) {
        state.phase = "ordinary";
        state.nextApiRequestAt = Number.POSITIVE_INFINITY;
        setStatus("ライブ・プレミア公開ではありません。API監視を停止します。");
        return;
      }

      const details = video.liveStreamingDetails;
      state.scheduledStartAt = parseApiTimestamp(details.scheduledStartTime);
      state.actualStartAt = parseApiTimestamp(details.actualStartTime);
      state.nextApiRequestAt = Number.isFinite(state.actualStartAt)
        ? Number.POSITIVE_INFINITY
        : Date.now() + API_POLL_INTERVAL_MILLISECONDS;

      if (Number.isFinite(state.actualStartAt)) {
        releaseApiPollingLease(videoId);
        setStatus("YouTube Data APIで配信開始を確認しました。再生準備を待ちます。");
      } else {
        setStatus("YouTube Data APIで開始を監視しています。");
      }
    } catch (error) {
      if (state.generation !== generation) return;
      handleApiError(error);
    } finally {
      if (state.generation === generation) state.apiRequestInFlight = false;
    }
  }

  async function fetchVideoStatus(videoId) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "liveStreamingDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set(
      "fields",
      "items(id,liveStreamingDetails(actualStartTime,scheduledStartTime))",
    );
    url.searchParams.set("key", state.apiKey);

    const Controller = unsafeWindow.AbortController || AbortController;
    const controller = new Controller();
    const timeoutId = setTimeout(
      () => controller.abort(),
      API_REQUEST_TIMEOUT_MILLISECONDS,
    );
    try {
      const response = await unsafeWindow.fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiError = new Error(
          payload?.error?.message || `YouTube Data APIがHTTP ${response.status}を返しました。`,
        );
        apiError.status = response.status;
        apiError.reason = payload?.error?.errors?.[0]?.reason || "unknown";
        throw apiError;
      }
      return payload.items?.[0] || null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function handleApiError(error) {
    const status = Number(error?.status);
    const transient = status === 429 || status >= 500 || error?.name === "AbortError";
    if (transient) {
      state.apiFailureCount += 1;
      const exponentialDelay = Math.min(
        API_RETRY_MAX_MILLISECONDS,
        API_RETRY_BASE_MILLISECONDS * (2 ** Math.min(state.apiFailureCount - 1, 4)),
      );
      const delay = Math.round(exponentialDelay * (1 + Math.random() * 0.25));
      state.nextApiRequestAt = Date.now() + delay;
      setStatus(`API通信に失敗しました。${Math.ceil(delay / 1_000)}秒後に再試行します。`, true);
      return;
    }

    state.apiDisabled = true;
    const reason = error?.reason ? `（${error.reason}）` : "";
    setStatus(`API監視を停止しました${reason}: ${error.message}`, true);
    unsafeWindow.alert(
      `YouTube Data APIを利用できませんでした${reason}。\n`
      + "APIキー、YouTube Data API v3の有効化、キーの制限設定を確認してください。",
    );
  }

  function startPlayback(page) {
    if (state.phase === "starting") return;
    const player = page.player;
    if (!player || typeof player.loadVideoById !== "function") {
      recoverWithPageReload();
      return;
    }

    state.phase = "starting";
    state.playbackRequestedAt = Date.now();
    state.nextPlaybackRequestAt = Date.now() + PLAYBACK_RETRY_INTERVAL_MILLISECONDS;
    try {
      player.loadVideoById(page.videoId);
      requestPlayback(player, page.video);
      setStatus("配信開始を確認しました。プレーヤーを1回だけ再読み込みしました。");
    } catch (error) {
      setStatus(`プレーヤーの再読み込みに失敗しました: ${error.message}`, true);
      recoverWithPageReload();
    }
  }

  function requestPlayback(player, video) {
    try {
      if (typeof player?.playVideo === "function") player.playVideo();
    } catch {
      // 再生準備中の失敗は次の監視周期で再試行する。
    }
    if (!video || typeof video.play !== "function" || !video.paused) return;

    try {
      Promise.resolve(video.play()).catch((error) => {
        if (error?.name !== "NotAllowedError") return;
        video.muted = true;
        if (typeof player?.mute === "function") player.mute();
        Promise.resolve(video.play()).catch(() => {});
      });
    } catch {
      // 次の監視周期で再試行する。
    }
  }

  function createTabInstanceId() {
    try {
      return unsafeWindow.crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  function getApiLeaseStorageKey(videoId) {
    return `youtube-api-fix-lease:${videoId}`;
  }

  function hasApiPollingLease(videoId) {
    const now = Date.now();
    const storageKey = getApiLeaseStorageKey(videoId);
    try {
      const currentLease = JSON.parse(unsafeWindow.localStorage.getItem(storageKey) || "null");
      if (
        currentLease?.owner !== TAB_INSTANCE_ID
        && Number(currentLease?.expiresAt) > now
      ) {
        return false;
      }
      if (currentLease?.owner === TAB_INSTANCE_ID && now < state.nextApiLeaseRefreshAt) {
        return true;
      }

      unsafeWindow.localStorage.setItem(storageKey, JSON.stringify({
        owner: TAB_INSTANCE_ID,
        expiresAt: now + API_LEASE_DURATION_MILLISECONDS,
      }));
      state.nextApiLeaseRefreshAt = now + API_LEASE_REFRESH_MILLISECONDS;
      const savedLease = JSON.parse(unsafeWindow.localStorage.getItem(storageKey) || "null");
      return savedLease?.owner === TAB_INSTANCE_ID;
    } catch {
      // localStorageを利用できない環境では、現在のタブだけで監視を続行する。
      return true;
    }
  }

  function releaseApiPollingLease(videoId) {
    if (!videoId) return;
    const storageKey = getApiLeaseStorageKey(videoId);
    try {
      const currentLease = JSON.parse(unsafeWindow.localStorage.getItem(storageKey) || "null");
      if (currentLease?.owner === TAB_INSTANCE_ID) {
        unsafeWindow.localStorage.removeItem(storageKey);
      }
    } catch {
      // 解放できない場合も、有効期限後に別タブが監視を引き継ぐ。
    }
  }

  function recoverWithPageReload() {
    const storageKey = `youtube-api-fix-reload:${state.videoId}`;
    const now = Date.now();
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(unsafeWindow.sessionStorage.getItem(storageKey)) || 0;
    } catch {
      // sessionStorageを利用できない場合も、現在のページでは一度だけ再読み込みする。
    }

    if (now - lastReloadAt < PAGE_RELOAD_COOLDOWN_MILLISECONDS) {
      state.phase = "failed";
      setStatus("再生を開始できませんでした。手動でページを再読み込みしてください。", true);
      return;
    }

    try {
      unsafeWindow.sessionStorage.setItem(storageKey, String(now));
      unsafeWindow.sessionStorage.setItem(`youtube-api-fix-resume:${state.videoId}`, String(now));
    } catch {
      // 保存に失敗しても再読み込みは続行する。
    }
    state.phase = "reloading";
    setStatus("再生を開始できないため、ページを1回だけ再読み込みします。", true);
    unsafeWindow.location.reload();
  }

  function hasPlaybackStarted(video) {
    const currentTime = video?.currentTime;
    const progressed = Number.isFinite(currentTime)
      && Number.isFinite(state.lastVideoTime)
      && currentTime > state.lastVideoTime + 0.05;
    if (Number.isFinite(currentTime)) state.lastVideoTime = currentTime;
    return Boolean(
      progressed
      && video
      && !video.paused
      && !video.ended
      && video.readyState >= 2
    );
  }

  function inspectPage() {
    const pageUrl = new URL(unsafeWindow.location.href);
    const livePathVideoId = pageUrl.pathname.match(/^\/live\/([^/?]+)/)?.[1] || "";
    const videoId = pageUrl.searchParams.get("v") || livePathVideoId;
    const pageDocument = unsafeWindow.document;
    const player = pageDocument.getElementById("movie_player");
    const video = pageDocument.querySelector("video.html5-main-video, #movie_player video");
    const offlineSlate = pageDocument.querySelector(".ytp-offline-slate");
    const mainText = findNativeSlateText(offlineSlate)?.textContent?.trim() || "";
    return {
      videoId,
      player,
      video,
      offlineSlate,
      mainText,
      hasOfflineSlate: isVisible(offlineSlate),
    };
  }

  function isVisible(element) {
    if (!element) return false;
    try {
      const style = unsafeWindow.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && element.getClientRects().length > 0;
    } catch {
      return true;
    }
  }

  function inferBroadcastKind(mainText) {
    if (/プレミア|公開/.test(mainText)) state.broadcastKind = "premiere";
    else if (/ライブ|配信/.test(mainText)) state.broadcastKind = "live";
  }

  function updateTimeDisplay(page) {
    if (!page.offlineSlate) return;
    const nativeElement = findNativeSlateText(page.offlineSlate);
    if (!nativeElement) return;

    const message = buildTimeMessage();
    if (!message) {
      restoreNativeSlateText(nativeElement);
      return;
    }

    const element = ensureOverrideSlateText(nativeElement);
    if (!element) return;
    if (nativeElement.style.display !== "none") nativeElement.style.display = "none";
    if (element.textContent !== message) element.textContent = message;
    element.setAttribute("aria-label", message);
  }

  function buildTimeMessage() {
    const now = Date.now();
    if (Number.isFinite(state.actualStartAt)) {
      const elapsedSeconds = Math.max(1, Math.floor((now - state.actualStartAt) / 1_000));
      const target = state.broadcastKind === "premiere" ? "プレミア公開" : "ライブ配信";
      return `${target}中。${formatElapsedTime(elapsedSeconds)} 前に開始済み`;
    }
    if (Number.isFinite(state.scheduledStartAt)) {
      const remainingSeconds = Math.max(0, Math.ceil((state.scheduledStartAt - now) / 1_000));
      const target = state.broadcastKind === "premiere" ? "公開" : "ライブ配信";
      if (remainingSeconds === 0) return `${target}の開始を待っています`;
      if (remainingSeconds < 3_600) return formatClockTime(remainingSeconds);
      return `${formatRemainingTime(remainingSeconds)}後に${target}`;
    }
    return "";
  }

  function findNativeSlateText(offlineSlate) {
    return offlineSlate?.querySelector?.(
      `.ytp-offline-slate-main-text:not([${OVERRIDE_TEXT_ATTRIBUTE}])`
    ) || null;
  }

  function ensureOverrideSlateText(nativeElement) {
    const parent = nativeElement.parentElement;
    if (!parent) return null;
    const existing = parent.querySelector(`[${OVERRIDE_TEXT_ATTRIBUTE}]`);
    if (existing) return existing;
    const element = unsafeWindow.document.createElement("div");
    element.className = nativeElement.className;
    element.setAttribute(OVERRIDE_TEXT_ATTRIBUTE, "");
    parent.insertBefore(element, nativeElement.nextSibling);
    return element;
  }

  function restoreNativeSlateText(nativeElement) {
    const parent = nativeElement.parentElement;
    parent?.querySelector(`[${OVERRIDE_TEXT_ATTRIBUTE}]`)?.remove();
    if (nativeElement.style.display === "none") nativeElement.style.display = "";
  }

  function formatRemainingTime(seconds) {
    if (seconds >= 86_400) return `${Math.ceil(seconds / 86_400)} 日`;
    return `${Math.ceil(seconds / 3_600)} 時間`;
  }

  function formatClockTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function formatElapsedTime(seconds) {
    if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} 日`;
    if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} 時間`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)} 分`;
    return `${seconds} 秒`;
  }

  function parseApiTimestamp(value) {
    if (!value) return Number.NaN;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : Number.NaN;
  }

  function setStatus(message, warning = false) {
    if (state.status === message) return;
    state.status = message;
    const log = warning ? console.warn : console.info;
    log(`[YouTube API Fix] ${message}`);
  }
})();

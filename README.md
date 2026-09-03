# YouTube Fix - Stuck Live Playback

A Tampermonkey userscript that fixes YouTube live streams and Premieres getting stuck on the waiting screen after they have started.

It reconnects only the video player without reloading the entire page, preserving the chat and the rest of the page state.

## Problems addressed

- Playback does not begin after the scheduled start time.
- Playback does not begin when a stream starts earlier than scheduled.
- The “Live in X minutes” or “Live in X seconds” countdown stops updating.

## Requirements

- A Chromium-based browser such as Chrome or Edge
- Tampermonkey

## Installation

[Install with Tampermonkey](https://raw.githubusercontent.com/RoxyCoding/youtube-live-premiere-waiting-fix/refs/heads/main/youtube-live-premiere-waiting-fix.user.js)

Click the link above, then confirm the installation on the Tampermonkey screen. After installation, open a YouTube live stream or Premiere page.

## Background tabs

The script maintains a local WebRTC data channel to avoid Chromium's intensive background timer throttling and Energy Saver freezing. It does not contact an external WebRTC server. Background checks are normally limited to approximately once per second rather than every 0.1 seconds.

## Limitations

Exact monitoring intervals cannot be guaranteed if Chromium or the operating system discards the tab or suspends the browser process.

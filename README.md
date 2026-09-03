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
- A YouTube Data API key is required

## Installation

[Install with Tampermonkey](https://raw.githubusercontent.com/RoxyCoding/youtube-live-premiere-waiting-fix/refs/heads/main/youtube-live-premiere-waiting-fix.js)

Click the link above, then confirm the installation on the Tampermonkey screen. After installation, open a YouTube live stream or Premiere page.

## API request control

The script checks the YouTube Data API at most once every 30 seconds. API polling pauses while the tab is in the background, and only one visible tab polls a given video at a time. Rate-limit and temporary server errors use capped exponential backoff.

Playback retries are limited to once every two seconds to avoid repeatedly triggering YouTube's internal player requests.

## Limitations

Exact monitoring intervals cannot be guaranteed if Chromium or the operating system discards the tab or suspends the browser process.

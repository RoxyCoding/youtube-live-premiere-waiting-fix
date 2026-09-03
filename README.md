# YouTube Fix - Stuck Live Playback

A Tampermonkey userscript that fixes YouTube live streams and Premieres getting stuck on the waiting screen after they have started.

It reconnects only the video player without reloading the entire page, preserving the chat and the rest of the page state.

## Problems addressed

- Playback does not begin after the scheduled start time.
- The “Live in X minutes” or “Live in X seconds” countdown stops updating.

## Requirements

- A Chromium-based browser such as Chrome or Edge
- Tampermonkey

## Installation

1. Create a new userscript in Tampermonkey.
2. Replace its contents with `youtube-live-waiting-fix.js` and save it.
3. Open a YouTube live stream or Premiere page.

## Limitations

Exact monitoring intervals cannot be guaranteed if Chromium suspends or discards a background tab.

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

1. Create a new userscript in Tampermonkey.
2. Replace its contents with `youtube-live-waiting-fix.js` and save it.
3. Open a YouTube live stream or Premiere page.

The script does not use the YouTube Data API or require an API key. While waiting, it reconnects the player once per second to detect early starts and checks playback state every 0.1 seconds.

Regular videos are ignored. Reconnection stops once playback time is advancing. After navigating to another video within YouTube, only the new video is monitored.

## Limitations

Exact monitoring intervals cannot be guaranteed if Chromium suspends or discards a background tab.

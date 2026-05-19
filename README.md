# WatchTogether

Browser extension that synchronizes video playback using WebRTC on any site that has HTML video. 2 peers can connect to each other and each can control the same video by pausing / playing or seeking theirs.

This is just a simple extension and completely serverless so the peers have to exchange their signaling data by another platform in order to be connected.

## How to use

1. First peer creates a session and sends their own id to the other (e.g. via some messaging platform).
2. Second peer pastes first's id into the corresponding field and presses connect.
3. Second peer receives its own id and sends it back to the first.
4. First peer pastes second's id into the corresponding field and presses connect.
5. Now that connected, if the two of you visit the same site with any video, the playback will be synhronized. The synhronization can be turned on or off by the toggle on the bottom.

## For reference

* [simple-peer](https://github.com/feross/simple-peer)
* [mdbootstrap](https://github.com/mdbootstrap/material-design-for-bootstrap)

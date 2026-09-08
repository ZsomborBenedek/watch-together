'use strict';

if (window.contentScriptVideo !== true) {
    window.contentScriptVideo = true;

    // Max allowed time offset between videos (in seconds)
    const toffset = 0.5;

    // Applying a remote state calls play/pause/currentTime, which fire the
    // very events that trigger sendState. Without a guard the change bounces
    // back to the peer, who sees it as news and echoes in turn. Sends are
    // dropped while they would only reproduce what we were just told, for
    // long enough to cover the events the change sets off.
    const echoWindow = 1000;
    let appliedState = null;
    let appliedUntil = 0;

    // Which elements already carry our listeners. A player can be swapped out
    // under us — an SPA navigation, an ad roll — so the element is looked up
    // fresh on every send and every apply instead of being captured once at
    // injection time and going stale.
    const watched = new WeakSet();

    // The background switches a tab off — the user's choice, or the session
    // ending — by message, since it cannot remove a script it injected.
    // Injection itself means on.
    let enabled = true;
    chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.action === 'setSyncEnabled') enabled = !!message.enabled;
    });

    watchVideos();
    sendState();

    // A page can hold several videos at once: feed previews, ad players, the
    // one being watched. The largest one that has loaded anything is the one
    // the viewer is looking at.
    function currentVideo() {
        let best = null;
        let bestArea = -1;
        for (const candidate of document.querySelectorAll('video')) {
            if (candidate.readyState < 1) continue;
            const area = candidate.clientWidth * candidate.clientHeight;
            if (area > bestArea) {
                best = candidate;
                bestArea = area;
            }
        }
        return best;
    }

    function watchVideos() {
        for (const video of document.querySelectorAll('video')) {
            if (watched.has(video)) continue;
            watched.add(video);
            video.addEventListener('pause', onVideoEvent);
            video.addEventListener('play', onVideoEvent);
            video.addEventListener('seeked', onVideoEvent);
        }
    }

    // Players are usually inserted wrapped in their container, so a video can
    // arrive as a descendant of an added node rather than as the node itself.
    new MutationObserver(function (mutations) {
        for (const { addedNodes } of mutations) {
            for (const node of addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.nodeName === 'VIDEO' || node.querySelector('video')) {
                    watchVideos();
                    sendState();
                    return;
                }
            }
        }
    }).observe(document.body, { attributes: true, childList: true, subtree: true });

    // Background players fire their own play/pause events; only the video the
    // viewer is actually watching speaks for this tab.
    function onVideoEvent(event) {
        if (event.target !== currentVideo()) return;
        sendState();
    }

    function sendState() {
        if (!enabled) return;
        const video = currentVideo();
        if (!video || video.readyState <= 2) return;

        const videoState = {
            hostname: window.location.hostname,
            id: video.id,
            srcLen: video.src.length,
            isPaused: video.paused,
            currentTime: video.currentTime
        };
        if (echoesAppliedState(videoState)) return;

        try {
            chrome.runtime.sendMessage({ action: 'sendState', content: videoState });
        } catch (error) {
            console.log(error);
        }
    }

    // A state matching what we just applied carries no news for the peer: it
    // is the peer's own change coming back. Anything materially different is
    // a real local action and must still be sent, even inside the window.
    function echoesAppliedState(videoState) {
        return appliedState !== null &&
            Date.now() < appliedUntil &&
            appliedState.isPaused === videoState.isPaused &&
            Math.abs(appliedState.currentTime - videoState.currentTime) <= toffset;
    }

    chrome.storage.onChanged.addListener(function (changes, namespace) {
        for (var key in changes) {
            if (key !== 'videoState' || !enabled) continue;

            const videoState = changes[key].newValue;
            if (!videoState || videoState.hostname !== window.location.hostname) continue;

            const video = currentVideo();
            if (!video) continue;

            appliedState = videoState;
            appliedUntil = Date.now() + echoWindow;

            if (video.paused !== videoState.isPaused) {
                if (videoState.isPaused) {
                    video.pause();
                } else {
                    // Autoplay policy blocks playback in a tab the viewer has
                    // never touched; say so rather than failing silently.
                    const started = video.play();
                    if (started) started.catch(error => console.log('could not start playback', error));
                }
            }
            const timediff = Math.abs(video.currentTime - videoState.currentTime);
            if (timediff > toffset && video.readyState > 2) {
                video.currentTime = videoState.currentTime;
            }
        }
    });
}

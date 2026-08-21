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

    // Init
    let video = document.querySelector('video');

    if (video) {
        video.addEventListener('pause', sendState);
        video.addEventListener('play', sendState);
        video.addEventListener('seeked', sendState);
        sendState();
    }

    new MutationObserver(function (mutations, observer) {
        for (const { addedNodes } of mutations) {
            addedNodes.forEach((node) => {
                if (node.nodeName === 'VIDEO') {
                    video = node;
                    video.addEventListener('pause', sendState);
                    video.addEventListener('play', sendState);
                    video.addEventListener('seeked', sendState);
                    sendState();
                }
            });
        }
    }).observe(document.body, { attributes: true, childList: true, subtree: true });

    function sendState() {
        if (video && video.readyState > 2) {
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

    function videoEquals(incomingState) {
        return window.location.hostname === incomingState.hostname &&
            video.id === incomingState.id &&
            video.src.length === incomingState.srcLen;
    }

    chrome.storage.onChanged.addListener(function (changes, namespace) {
        for (var key in changes) {
            if (video && key == 'videoState') {
                let videoState = changes[key].newValue;
                if (videoEquals(videoState)) {
                    appliedState = videoState;
                    appliedUntil = Date.now() + echoWindow;

                    if (video.paused !== videoState.isPaused)
                        videoState.isPaused ? video.pause() : video.play();
                    const timediff = Math.abs(video.currentTime - videoState.currentTime);
                    if (timediff > toffset && video.readyState > 2) {
                        video.currentTime = videoState.currentTime;
                    }
                }
            }
        }
    });
}
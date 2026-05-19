'use strict';

if (window.contentScriptVideo !== true) {
    window.contentScriptVideo = true;

    // Max allowed time offset between videos (in seconds)
    const toffset = 0.5;

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
            var videoState = {
                hostname: window.location.hostname,
                id: video.id,
                srcLen: video.src.length,
                isPaused: video.paused,
                currentTime: video.currentTime
            };
            try {
                chrome.runtime.sendMessage({ action: 'sendState', content: videoState });
            } catch (error) {
                console.log(error);
            }
        }
    }

    function videoEquals(incomingState) {
        return (window.location.hostname === incomingState.hostname &&
            video.id === incomingState.id &&
            video.src.length === incomingState.srcLen) ? true : false;
    }

    chrome.storage.onChanged.addListener(function (changes, namespace) {
        for (var key in changes) {
            if (video && key == 'videoState') {
                let videoState = changes[key].newValue;
                if (videoEquals(videoState)) {
                    if (video.paused !== videoState.isPaused)
                        videoState.isPaused ? video.pause() : video.play();
                    let timediff = Math.abs(video.currentTime - videoState.currentTime).toFixed(1);
                    if (timediff > toffset && video.readyState > 2) {
                        video.currentTime = videoState.currentTime;
                    }
                }
            }
        }
    });
}
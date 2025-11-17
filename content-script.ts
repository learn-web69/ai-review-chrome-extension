// Content script that runs on GitHub pages
// This bridges the gap between the side panel and media permissions

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "REQUEST_MICROPHONE") {
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      .then((stream) => {
        sendResponse({
          success: true,
          streamId: stream.id,
        });

        // Store the stream globally so it doesn't get garbage collected
        (window as any).__audioStream = stream;
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message,
        });
      });

    return true; // Keep the channel open for async response
  }

  if (request.type === "REQUEST_DISPLAY_MEDIA") {
    navigator.mediaDevices
      .getDisplayMedia({
        video: {
          frameRate: { ideal: 5, max: 5 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          cursor: "always",
        } as any,
        audio: false,
      })
      .then((stream) => {
        // Get the first video track
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          // Send the stream back to the extension
          sendResponse({
            success: true,
            streamId: stream.id,
          });

          // Keep the stream alive and notify when it ends
          videoTrack.onended = () => {
            chrome.runtime.sendMessage({
              type: "DISPLAY_STREAM_ENDED",
            });
          };

          // Store the stream globally so it doesn't get garbage collected
          (window as any).__displayStream = stream;
        }
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error.message,
        });
      });

    return true; // Keep the channel open for async response
  }

  if (request.type === "GET_DISPLAY_STREAM") {
    const stream = (window as any).__displayStream;
    if (stream) {
      sendResponse({
        success: true,
        hasStream: true,
      });
    } else {
      sendResponse({
        success: false,
        hasStream: false,
      });
    }
    return true;
  }
});

console.log("AI Code Review content script loaded");

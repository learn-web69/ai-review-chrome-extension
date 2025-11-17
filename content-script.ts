// Content script that runs on GitHub pages
// This bridges the gap between the side panel and media permissions

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "SCROLL_TO_LINE") {
    const lineNumber = request.lineNumber;
    console.log(`[Content Script] Attempting to scroll to line ${lineNumber}`);

    // Try multiple selectors commonly used by GitHub
    let lineElement = document.getElementById(`L${lineNumber}`);
    console.log(
      `[Content Script] getElementById L${lineNumber}:`,
      lineElement ? "found" : "not found"
    );

    if (!lineElement) {
      lineElement = document.querySelector(`[id="L${lineNumber}"]`);
      console.log(
        `[Content Script] querySelector [id="L${lineNumber}"]:`,
        lineElement ? "found" : "not found"
      );
    }

    if (!lineElement) {
      lineElement = document.querySelector(
        `tr[data-line-number="${lineNumber}"]`
      );
      console.log(
        `[Content Script] querySelector tr[data-line-number="${lineNumber}"]:`,
        lineElement ? "found" : "not found"
      );
    }

    if (!lineElement) {
      lineElement = document.querySelector(
        `.blob-code-line[data-code-line-number="${lineNumber}"]`
      );
      console.log(
        `[Content Script] querySelector .blob-code-line[data-code-line-number="${lineNumber}"]:`,
        lineElement ? "found" : "not found"
      );
    }

    if (!lineElement) {
      // Log all available line-like elements for debugging
      const allLines = document.querySelectorAll(
        '[id^="L"], [data-line-number], .blob-code-line'
      );
      console.log(
        `[Content Script] Total elements with line-like attributes: ${allLines.length}`
      );
      if (allLines.length > 0) {
        console.log(
          `[Content Script] First few elements:`,
          Array.from(allLines)
            .slice(0, 5)
            .map((el) => ({
              id: el.id,
              dataLineNumber: el.getAttribute("data-line-number"),
              dataCodeLineNumber: el.getAttribute("data-code-line-number"),
              class: el.className,
              tag: el.tagName,
            }))
        );
      }
    }

    if (lineElement) {
      console.log(`[Content Script] Found line element, scrolling to view`);
      lineElement.scrollIntoView({ behavior: "smooth", block: "center" });
      // Highlight the line temporarily with a more visible style
      const originalBg = lineElement.style.backgroundColor;
      lineElement.style.backgroundColor = "rgba(255, 200, 0, 0.3)";
      lineElement.style.transition = "background-color 0.3s ease";
      setTimeout(() => {
        lineElement.style.backgroundColor = originalBg;
      }, 2000);
      sendResponse({ success: true, message: "Scrolled to line" });
    } else {
      console.error(
        `[Content Script] Could not find line element for line ${lineNumber}`
      );
      sendResponse({ success: false, error: "Line not found" });
    }
    return true;
  }

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

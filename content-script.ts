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

  if (request.type === "ADD_PR_COMMENT") {
    const { lineNumber, commentText, fileName } = request;
    console.log(
      `[Content Script] Attempting to add PR comment at line ${lineNumber}${
        fileName ? ` in file ${fileName}` : ""
      }`
    );

    try {
      // Find the line element with multiple strategies
      let lineElement: HTMLElement | null = null;

      // If fileName is provided, first find the file container
      let fileContainer: HTMLElement | null = null;
      if (fileName) {
        // Try to find the file container using the filename
        // GitHub structures PRs with file headers that contain the filename
        const fileHeaders = document.querySelectorAll(
          "[data-testid='diff-file-header'], .file-header, [data-path]"
        );
        console.log(
          `[Content Script] Found ${fileHeaders.length} potential file headers`
        );

        for (const header of fileHeaders) {
          const path = header.getAttribute("data-path");
          const headerText = header.textContent || "";

          console.log(
            `[Content Script] Checking file header: data-path="${path}", text="${headerText}", looking for: "${fileName}"`
          );

          // Prefer data-path attribute for exact matching
          if (path) {
            // Check exact match or ends with (to handle paths)
            if (
              path === fileName ||
              path.endsWith("/" + fileName) ||
              path.endsWith(fileName)
            ) {
              fileContainer =
                (header.closest("[data-testid='diff-file']") as HTMLElement) ||
                (header.closest("section") as HTMLElement) ||
                (header.parentElement as HTMLElement);
              console.log(
                `[Content Script] Found file container for ${fileName} via data-path`
              );
              break;
            }
          } else if (headerText.includes(fileName)) {
            // Fallback to text matching if data-path not available
            fileContainer =
              (header.closest("[data-testid='diff-file']") as HTMLElement) ||
              (header.closest("section") as HTMLElement) ||
              (header.parentElement as HTMLElement);
            console.log(
              `[Content Script] Found file container for ${fileName} via text`
            );
            break;
          }
        }

        if (!fileContainer) {
          console.warn(
            `[Content Script] Could not find file container for "${fileName}", will search globally`
          );
        }
      }

      // Strategy 1: Direct ID lookup (within file container if available)
      if (fileContainer) {
        lineElement = fileContainer.querySelector(
          `[id="L${lineNumber}"]`
        ) as HTMLElement;
        if (lineElement) {
          console.log(
            `[Content Script] Found line via file-scoped querySelector L${lineNumber}`
          );
        }
      } else {
        lineElement = document.getElementById(`L${lineNumber}`);
        if (lineElement) {
          console.log(
            `[Content Script] Found line via getElementById L${lineNumber}`
          );
        }
      }

      // Strategy 2: Attribute selector (within file container if available)
      if (!lineElement) {
        if (fileContainer) {
          lineElement = fileContainer.querySelector(
            `[id="L${lineNumber}"]`
          ) as HTMLElement;
        } else {
          lineElement = document.querySelector(
            `[id="L${lineNumber}"]`
          ) as HTMLElement;
        }
        if (lineElement) {
          console.log(
            `[Content Script] Found line via querySelector [id="L${lineNumber}"]`
          );
        }
      }

      // Strategy 3: Data attribute with line number (within file container if available)
      if (!lineElement) {
        if (fileContainer) {
          lineElement = fileContainer.querySelector(
            `[data-line-number="${lineNumber}"]`
          ) as HTMLElement;
        } else {
          lineElement = document.querySelector(
            `[data-line-number="${lineNumber}"]`
          ) as HTMLElement;
        }
        if (lineElement) {
          console.log(`[Content Script] Found line via data-line-number`);
        }
      }

      // Strategy 4: Look for table rows with line indicators (within file container if available)
      if (!lineElement) {
        let searchContainer = fileContainer || document;
        const allLineElements = searchContainer.querySelectorAll(
          `tr, [data-testid*="line"], .blob-code-line`
        );
        console.log(
          `[Content Script] Searching through ${
            allLineElements.length
          } potential line elements${
            fileContainer ? " in file container" : " globally"
          }`
        );

        for (const el of allLineElements) {
          const id = el.getAttribute("id");
          const dataLine = el.getAttribute("data-line-number");
          const dataCode = el.getAttribute("data-code-line-number");

          if (
            id === `L${lineNumber}` ||
            dataLine === `${lineNumber}` ||
            dataCode === `${lineNumber}`
          ) {
            lineElement = el as HTMLElement;
            console.log(
              `[Content Script] Found line via search (id: ${id}, data-line: ${dataLine}, data-code: ${dataCode})`
            );
            break;
          }
        }
      }

      if (!lineElement) {
        // Log all available line elements for debugging
        const allLines = document.querySelectorAll(
          '[id^="L"], [data-line-number], .blob-code-line'
        );
        console.log(
          `[Content Script] Could not find line ${lineNumber}. Available elements: ${allLines.length}`
        );

        if (allLines.length > 0) {
          const samples = Array.from(allLines)
            .slice(0, 10)
            .map((el) => ({
              id: el.id,
              dataLineNumber: el.getAttribute("data-line-number"),
              dataCodeLineNumber: el.getAttribute("data-code-line-number"),
              tag: el.tagName,
            }));
          console.log(
            `[Content Script] Sample line elements:`,
            JSON.stringify(samples, null, 2)
          );
        }

        throw new Error(
          `Could not find line element for line ${lineNumber}. Checked ${allLines.length} potential elements.`
        );
      }

      // Find the parent row/container - try multiple strategies
      let row: HTMLElement | null = lineElement.closest("tr");
      if (!row) {
        // Try parent div with line attributes
        row = lineElement.closest(
          "[data-line-number], [id^='L']"
        ) as HTMLElement;
      }
      if (!row) {
        // Use the line element itself as row
        row = lineElement;
      }

      console.log(`[Content Script] Found row container: ${row.tagName}`);

      // Scroll to the line
      lineElement.scrollIntoView({ behavior: "smooth", block: "center" });

      // Wait a bit for scroll to complete
      setTimeout(() => {
        console.log("[Content Script] Looking for comment button...");

        // Look for the comment button in the row (GitHub's comment icon)
        // GitHub uses multiple comment button selectors
        let commentButton: HTMLElement | null = null;

        // Strategy 1: aria-label with "Comment" - most specific
        commentButton = row?.querySelector(
          'button[aria-label*="Comment"], [aria-label*="comment"]'
        ) as HTMLElement;
        if (commentButton) {
          console.log(
            "[Content Script] Found button via aria-label (most specific)"
          );
        }

        // Strategy 2: Look in the line gutter area specifically for comment buttons
        if (!commentButton) {
          const gutterArea = row?.querySelector(
            '.js-line-menu, .diff-gutter-menu, [data-testid="diff-line-menu"]'
          );
          if (gutterArea) {
            commentButton = gutterArea.querySelector("button") as HTMLElement;
            if (commentButton) {
              console.log("[Content Script] Found button in line gutter area");
            }
          }
        }

        // Strategy 3: Class names - more specific selectors
        if (!commentButton) {
          commentButton = row?.querySelector(
            ".add-line-comment, .js-add-line-comment, [data-action*='comment']"
          ) as HTMLElement;
          if (commentButton) {
            console.log("[Content Script] Found button via class selector");
          }
        }

        // Strategy 4: Look for any button with comment-related aria-label
        if (!commentButton) {
          const buttons = row?.querySelectorAll("button");
          if (buttons && buttons.length > 0) {
            for (const btn of buttons) {
              const ariaLabel = btn.getAttribute("aria-label") || "";
              if (
                ariaLabel.toLowerCase().includes("comment") ||
                ariaLabel.toLowerCase().includes("add line")
              ) {
                commentButton = btn as HTMLElement;
                console.log(
                  `[Content Script] Found button via aria-label search: "${ariaLabel}"`
                );
                break;
              }
            }
          }
        }

        // Strategy 4: Look for SVG with comment icon (GitHub uses SVGs for buttons sometimes)
        if (!commentButton) {
          const buttons = row?.querySelectorAll("button, [role='button']");
          if (buttons && buttons.length > 0) {
            commentButton = buttons[0] as HTMLElement;
            console.log(
              "[Content Script] Using first button found as fallback"
            );
          }
        }

        if (commentButton) {
          console.log("[Content Script] Found comment button, clicking it");
          commentButton.click();

          // Wait for the comment dialog to appear (longer timeout for GitHub to render)
          setTimeout(() => {
            console.log("[Content Script] Looking for comment textarea...");

            // Try multiple selectors to find the textarea
            let textarea: HTMLTextAreaElement | null = null;

            // Strategy 1: js-comment-field (most common)
            textarea = document.querySelector(
              "textarea.js-comment-field"
            ) as HTMLTextAreaElement;
            if (textarea) {
              console.log(
                "[Content Script] Found textarea via .js-comment-field"
              );
            }

            // Strategy 2: Any textarea in the visible dialog
            if (!textarea) {
              const allTextareas = document.querySelectorAll("textarea");
              console.log(
                `[Content Script] Found ${allTextareas.length} total textareas on page`
              );

              for (const ta of allTextareas) {
                const style = window.getComputedStyle(ta);
                const isVisible =
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  ta.offsetHeight > 0;

                if (isVisible) {
                  textarea = ta as HTMLTextAreaElement;
                  console.log(
                    `[Content Script] Found visible textarea with classes: "${ta.className}"`
                  );
                  break;
                }
              }
            }

            // Strategy 3: Contenteditable div (GitHub might use this)
            if (!textarea) {
              const editableDiv = document.querySelector(
                "[contenteditable='true'][role='textbox']"
              ) as HTMLElement;
              if (editableDiv) {
                console.log(
                  "[Content Script] Found contenteditable div instead of textarea"
                );
                // For contenteditable, we need to set innerHTML or textContent
                editableDiv.textContent = commentText;
                editableDiv.focus();

                const inputEvent = new Event("input", {
                  bubbles: true,
                  cancelable: true,
                });
                editableDiv.dispatchEvent(inputEvent);

                console.log(
                  `[Content Script] Text inserted in contenteditable: "${editableDiv.textContent}"`
                );

                sendResponse({
                  success: true,
                  message: "Comment dialog opened and text inserted",
                });
                return;
              }
            }

            if (textarea) {
              console.log(
                "[Content Script] Found comment textarea, inserting text"
              );

              // Focus and clear
              textarea.focus();
              textarea.value = "";

              // Set value directly
              textarea.value = commentText;

              // Try to trigger React by using different approaches simultaneously
              // Approach 1: Native setter
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value"
              )?.set;

              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(textarea, commentText);
                console.log("[Content Script] Used native setter");
              }

              // Approach 2: Try using execCommand with the textarea in focus
              try {
                document.execCommand("selectAll", false, undefined);
                document.execCommand("insertText", false, commentText);
                console.log("[Content Script] Used execCommand.insertText");
              } catch (e) {
                console.log(`[Content Script] execCommand failed: ${e}`);
              }

              // Approach 3: Create and dispatch a synthetic input event that might match React's expectations
              // Get the React instance if available
              const inputDescriptor = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value"
              );

              // Dispatch comprehensive event sequence
              const eventTypes = [
                "beforeinput",
                "input",
                "change",
                "keydown",
                "keyup",
              ];

              eventTypes.forEach((eventType) => {
                try {
                  let event;
                  if (eventType === "keydown" || eventType === "keyup") {
                    event = new KeyboardEvent(eventType, {
                      bubbles: true,
                      cancelable: true,
                      key: "a",
                      code: "KeyA",
                    });
                  } else {
                    event = new Event(eventType, {
                      bubbles: true,
                      cancelable: true,
                    });
                  }
                  textarea.dispatchEvent(event);
                  console.log(`[Content Script] Dispatched ${eventType} event`);
                } catch (e) {
                  console.log(
                    `[Content Script] Failed to dispatch ${eventType}: ${e}`
                  );
                }
              });

              console.log(
                `[Content Script] Final textarea value: "${textarea.value}"`
              );

              sendResponse({
                success: true,
                message: "Comment dialog opened and text inserted",
              });
            } else {
              console.error(
                "[Content Script] Could not find comment textarea or contenteditable"
              );

              // Debug: Log all textareas
              const allTextareas = document.querySelectorAll("textarea");
              console.log(
                `[Content Script] Debug: Total textareas found: ${allTextareas.length}`
              );

              allTextareas.forEach((ta, idx) => {
                console.log(
                  `  Textarea ${idx}: classes="${ta.className}", visible=${
                    window.getComputedStyle(ta).display !== "none"
                  }`
                );
              });

              sendResponse({
                success: false,
                error: "Comment dialog did not appear or textarea not found",
              });
            }
          }, 500);
        } else {
          console.error(
            "[Content Script] Could not find comment button on line",
            lineNumber
          );
          // Debug: Log available buttons
          const allButtons = row?.querySelectorAll("button, [role='button']");
          console.log(
            `[Content Script] Found ${allButtons?.length || 0} buttons in row`
          );
          if (allButtons && allButtons.length > 0) {
            Array.from(allButtons).forEach((btn, idx) => {
              console.log(
                `  Button ${idx}: aria-label="${btn.getAttribute(
                  "aria-label"
                )}", class="${btn.className}"`
              );
            });
          }
          sendResponse({
            success: false,
            error: `Could not find comment button on line ${lineNumber}. Found ${
              allButtons?.length || 0
            } buttons.`,
          });
        }
      }, 300);
    } catch (error: any) {
      console.error("[Content Script] Error adding PR comment:", error);
      sendResponse({
        success: false,
        error: error.message,
      });
    }

    return true; // Keep the channel open for async response
  }
});

console.log("AI Code Review content script loaded");

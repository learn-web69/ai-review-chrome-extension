// Chrome Extension Storage Helper
// This module handles API key storage using Chrome's storage API

export async function getApiKey(): Promise<string | null> {
  if (typeof chrome !== "undefined" && chrome.storage) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["geminiApiKey"], (result) => {
        resolve(result.geminiApiKey || null);
      });
    });
  }
  // Fallback to environment variable for development
  return (process.env.API_KEY as string) || null;
}

export async function setApiKey(apiKey: string): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
        resolve();
      });
    });
  }
}

export async function hasApiKey(): Promise<boolean> {
  const key = await getApiKey();
  return !!key;
}

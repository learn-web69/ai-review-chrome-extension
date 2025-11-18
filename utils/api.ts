// API utility functions for code review service
const API_BASE_URL = "https://code-review-ai-phi.vercel.app";

export interface RepoStatusResponse {
  status: "indexed" | "not_indexed";
  repo_id: string;
  repo_url?: string;
  indexed: boolean;
  metadata?: {
    repoName: string;
    lastCommit: string;
    chunkCount: number;
    filesIndexed: number;
    indexedAt: string;
  };
  message?: string;
}

export interface InitRepositoryResponse {
  status: "success" | "error";
  repo_url: string;
  repo_id: string;
  message: string;
  indexed?: boolean;
  metadata?: {
    repoName: string;
    lastCommit: string;
    chunkCount: number;
    filesIndexed: number;
    indexedAt: string;
  };
  error?: string;
}

export interface ReviewPRStep {
  id: number;
  title: string;
  description: string;
  file: string;
  lines: string;
  codeSnippet: string;
  url?: string;
  lineNumber?: number;
}

export interface ReviewPRResponse {
  status: "success";
  pr_url: string;
  steps_count: number;
  steps: ReviewPRStep[];
}

/**
 * Extracts the GitHub repository URL from the current tab
 */
export async function getCurrentRepoUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url;
      if (!currentUrl) {
        resolve(null);
        return;
      }

      // Extract repo URL from GitHub URL
      // Example: https://github.com/owner/repo/pull/123 -> https://github.com/owner/repo
      const match = currentUrl.match(
        /https:\/\/github\.com\/([^\/]+)\/([^\/]+)/
      );
      if (match) {
        const [, owner, repo] = match;
        resolve(`https://github.com/${owner}/${repo}`);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Extracts the PR URL from the current tab
 */
export async function getCurrentPRUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url;
      if (!currentUrl) {
        resolve(null);
        return;
      }

      // Check if it's a PR URL
      // Example: https://github.com/owner/repo/pull/123
      const match = currentUrl.match(
        /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/
      );
      if (match) {
        resolve(match[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Check if a repository is indexed
 */
export async function checkRepoStatus(
  repoUrl: string
): Promise<RepoStatusResponse> {
  const url = `${API_BASE_URL}/status?repo_url=${encodeURIComponent(repoUrl)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to check repo status: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Initialize repository indexing (synchronous - waits for completion)
 */
export async function initRepository(
  repoUrl: string
): Promise<InitRepositoryResponse> {
  const url = `${API_BASE_URL}/init-repository`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repo_url: repoUrl }),
  });

  if (!response.ok) {
    throw new Error(`Failed to initialize repository: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Review a PR and generate walkthrough
 */
export async function reviewPR(prUrl: string): Promise<ReviewPRResponse> {
  const url = `${API_BASE_URL}/review-pr`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pr_url: prUrl }),
  });

  if (!response.ok) {
    throw new Error(`Failed to review PR: ${response.statusText}`);
  }

  return response.json();
}

# Chrome Extension Installation Guide

## Quick Start (5 minutes)

### Step 1: Build the Extension

Open your terminal and run:

```bash
cd /path/to/ai-review-chrome-extension
npm install
npm run build
```

You should see a `dist` folder created with these files:

- `manifest.json`
- `background.js`
- `sidepanel.html`
- `sidepanel.js`
- `icons/`

### Step 2: Load in Chrome

1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle switch in top-right corner)
4. Click **Load unpacked** button
5. Select the `dist` folder from your project
6. You should see "AI Code Review Companion for GitHub" appear in your extensions list

### Step 3: Get Your API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy the generated key

### Step 4: Configure the Extension

1. Navigate to any GitHub repository (e.g., https://github.com/facebook/react)
2. Click the extension icon in your Chrome toolbar
3. The side panel will open on the left
4. Click the **Settings** icon (⚙️) in the top-right corner
5. Paste your API key and click **Save API Key**

### Step 5: Start Using!

1. Click **Initialize Repository**
2. Wait for indexing to complete
3. Click **Generate New Walkthrough** to get AI code review suggestions
4. Or click **Start Live Session** for interactive pair programming

## Troubleshooting

### "Extension failed to load"

- Make sure you selected the `dist` folder, not the root project folder
- Rebuild with `npm run build` and try again

### Side panel doesn't appear

- Make sure you're on a GitHub page (github.com)
- Click the extension icon manually to open it
- Check that you're using Chrome 114 or later

### "No API key found" error

- Open Settings (⚙️ icon) and enter your Gemini API key
- Make sure you clicked "Save API Key"

### Extension icon is grayed out

- This is normal when not on a GitHub page
- Navigate to github.com and it will activate

## Features Overview

### Code Review Walkthrough

- Analyzes repository structure
- Generates improvement suggestions
- Shows file locations and line numbers
- Displays code snippets

### Live Pair Programming

- Screen sharing to show code
- Voice interaction with AI
- Real-time transcription
- Context-aware responses

## Next Steps

- Explore the walkthrough suggestions
- Try the live session feature
- Customize settings for your workflow
- Share feedback and suggestions

Enjoy your AI-powered code reviews! 🚀

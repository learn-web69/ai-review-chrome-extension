# AI Code Review Companion - Chrome Extension

An AI-powered code review assistant for GitHub repositories with live pair programming capabilities. This Chrome extension uses Google's Gemini AI to provide intelligent code analysis and interactive code reviews directly in your browser.

## Installation

### Quick Start - Using Pre-built Extension (Recommended for Users)

The easiest way to try the extension is to use the pre-built version:

1. **Download the extension**

   - Find and download `chrome-extension.zip` from this repository
   - Extract the ZIP file to a folder on your computer

2. **Load the extension in Chrome**

   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in the top-right corner)
   - Click "Load unpacked"
   - Select the extracted folder

3. **Configure your API key**
   - Navigate to any GitHub repository page
   - Click the extension icon in the Chrome toolbar
   - The side panel will open
   - Click the settings icon (⚙️) in the header
   - Enter your Gemini API key ([Get one here](https://aistudio.google.com/apikey)) and save

> **Note on Developer Mode Installation**: For this hackathon project, we're distributing the extension as a local installation via Chrome's Developer Mode rather than publishing to the Chrome Web Store. This allows for rapid development and iteration without the typical 1-2 week review process required for official Chrome Web Store submission. Users can easily load the extension locally for testing and evaluation purposes.

### Development Setup - Building from Source

If you want to build and modify the extension yourself:

#### Prerequisites

- Google Chrome browser (version 114 or later for Side Panel API support)
- Node.js and npm
- Google Gemini API key ([Get one here](https://aistudio.google.com/apikey))

#### Steps

1. **Clone or download this repository**

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the extension**

   ```bash
   npm run build
   ```

   This will create a `dist` folder with the compiled extension.

4. **Load the extension in Chrome**

   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right corner)
   - Click "Load unpacked"
   - Select the `dist` folder from this project

5. **Configure your API key**
   - Navigate to any GitHub repository page
   - Click the extension icon in the Chrome toolbar
   - The side panel will open
   - Click the settings icon (⚙️) in the header
   - Enter your Gemini API key and save

## Features

- 🤖 **AI-Powered Code Reviews**: Generate comprehensive code review walkthroughs
- 🎯 **GitHub Integration**: Works seamlessly with GitHub repositories
- 🎤 **Live Pair Programming**: Voice-enabled AI assistant that can see your screen
- 🔍 **Smart Code Analysis**: Context-aware suggestions and explanations
- 📋 **Side Panel Interface**: Clean UI that sits alongside GitHub pages
- 🎨 **Beautiful Design**: Modern, dark-themed interface with smooth animations

## Usage

### Basic Code Review

1. Navigate to any GitHub repository
2. The extension icon will become active
3. Click the icon or it will auto-open the side panel
4. Click "Initialize Repository" to start
5. Click "Generate New Walkthrough" to get AI-powered code review suggestions

### Live Pair Programming Session

1. After initializing the repository, click "Start Live Session"
2. Grant screen sharing and microphone permissions
3. The AI can now see your screen and hear you
4. Ask questions about your code, and the AI will respond with voice and highlight relevant sections
5. The AI can use tools to highlight walkthrough steps and log code context

### Features in Detail

- **Walkthrough Steps**: Expandable cards showing specific code improvements
- **File Navigation**: Each suggestion shows the file and line numbers
- **Code Snippets**: View the relevant code directly in the suggestion
- **Interactive Highlighting**: Click on suggestions to mark them as active
- **Live Transcription**: See your conversation with the AI in real-time
- **Interrupt Control**: Stop the AI mid-response if needed

## Development

### Project Structure

```
ai-review-chrome-extension/
├── manifest.json          # Chrome extension manifest
├── background.ts          # Service worker for extension lifecycle
├── sidepanel.html        # Side panel HTML
├── sidepanel.tsx         # Side panel entry point
├── App.tsx               # Main React application
├── types.ts              # TypeScript type definitions
├── utils/
│   ├── audio.ts          # Audio processing utilities
│   └── storage.ts        # Chrome storage API helpers
├── public/
│   └── icons/            # Extension icons
├── vite.config.ts        # Vite build configuration
├── copy-assets.js        # Post-build asset copying
└── generate-icons.js     # Icon generation helper
```

### Build Commands

- `npm run dev` - Start Vite development server (for testing UI)
- `npm run build` - Build the production extension
- `npm run preview` - Preview the built application

### Development Mode

For rapid development, you can:

1. Run `npm run build` after making changes
2. Go to `chrome://extensions/`
3. Click the reload icon on your extension card

## Permissions

This extension requires the following permissions:

- **sidePanel**: To display the UI in Chrome's side panel
- **storage**: To store your API key securely
- **activeTab**: To detect when you're on a GitHub page
- **scripting**: For potential future features
- **host_permissions**: Access to `github.com` and `*.github.com`

## Privacy & Security

- Your API key is stored locally in Chrome's storage (not synced)
- No data is sent to any servers except Google's Gemini API
- Screen sharing and microphone access are only used during live sessions
- All code analysis happens through the Gemini API

## Troubleshooting

### Extension doesn't load

- Make sure you built the extension with `npm run build`
- Check that you selected the `dist` folder when loading
- Try reloading the extension from `chrome://extensions/`

### Side panel doesn't open

- Make sure you're on a GitHub page (`github.com`)
- Try clicking the extension icon manually
- Check if Side Panel API is supported (Chrome 114+)

### API errors

- Verify your API key is correct
- Check your API quota at [Google AI Studio](https://aistudio.google.com)
- Make sure you're using a valid Gemini API key

### Build errors

- Delete `node_modules` and run `npm install` again
- Make sure you're using Node.js v16 or later
- Check for TypeScript errors in your terminal

## Technologies Used

- **React 19**: UI framework
- **TypeScript**: Type safety
- **Vite**: Build tool
- **Tailwind CSS**: Styling (via CDN)
- **Google Gemini AI**: AI model (gemini-2.5-flash-native-audio-preview)
- **Chrome Extension APIs**: Side Panel, Storage, Tabs

## License

MIT License - feel free to use and modify as needed.

---

**Note**: This extension is not affiliated with or endorsed by GitHub or Google.

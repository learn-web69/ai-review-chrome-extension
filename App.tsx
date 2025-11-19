import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Blob as GoogleGenAIBlob,
  FunctionDeclaration,
  Type,
} from "@google/genai";
import { TranscriptionMessage } from "./types";
import { blobToBase64, encode, decode, decodeAudioData } from "./utils/audio";
import { getApiKey, setApiKey, hasApiKey } from "./utils/storage";
import {
  getCurrentRepoUrl,
  getCurrentPRUrl,
  checkRepoStatus,
  initRepository,
  reviewPR,
  answerCodeQuestion,
  type RepoStatusResponse,
  type AnswerCodeQuestionRequest,
} from "./utils/api";

// --- ENUMS & TYPES ---
enum RepoStatus {
  CHECKING,
  UNINITIALIZED,
  INDEXING,
  READY,
  GENERATING_WALKTHROUGH,
  WALKTHROUGH_READY,
  LIVE_CONNECTING,
  LIVE_CONNECTED,
  ERROR,
}

enum LiveStatus {
  IDLE,
  CONNECTING,
  CONNECTED,
}

interface WalkthroughStep {
  id: number;
  title: string;
  description: string;
  file: string;
  lines: string;
  codeSnippet: string;
  url?: string;
  lineNumber?: number;
}

// --- CONSTANTS ---
const MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";
const SYSTEM_INSTRUCTION = `You are an expert AI pair programmer. Your purpose is to help the user by looking at their screen and answering their questions about the code. IMPORTANT: The user must be viewing a GitHub PR page for comment features to work. 

CONVERSATION START COMMANDS:
- When the user says to start a review (e.g., "let's start", "let's begin", "start our review", "begin review"), you MUST use selectStep with step 1.
- When the user says to continue (e.g., "let's continue", "continue", "next step"), you MUST use selectStep with the next step number (increment current step by 1).
- After selectStep returns the step description, READ IT ALOUD COMPLETELY. This is CRITICAL - you MUST vocalize the entire step description naturally without mentioning that you navigated.

MANDATORY STEP NAVIGATION:
- When the user asks about a specific step (e.g., "show step 1", "what's step 2", "go to step 3"), you MUST immediately use the selectStep tool with that step number.
- ALWAYS use selectStep before answering any step-related questions. Do not answer without selecting the step first.
- After selectStep returns the step description, READ IT ALOUD COMPLETELY. Do not skip reading any part of the description. Vocalize it naturally to the user without mentioning that you navigated.

CRITICAL AUDIO RULE: ALWAYS GENERATE VOICE OUTPUT after receiving any tool response, especially step descriptions. Never be silent after a tool returns data.

TOOL USAGE RULES:
- When highlighting (highlightWalkthroughStep tool): Silently wait 2-3 seconds, then describe what you see on screen without referencing the tool.
- When commenting (addPRComment tool): Silently execute. Do NOT mention the tool or that a dialog opened.
- COMPLEX CODE QUESTIONS: Use answerCodeQuestion tool for questions about: how functions work, what code does, implementation details, external module behavior, internal logic, code explanation.
  * PROCESS: (1) Say "Let me think..." (2) Call answerCodeQuestion tool (3) WAIT SILENTLY for response (4) Then provide COMPLETE answer based on tool response. ALWAYS VOCALIZE THE ANSWER.
- SIMPLE QUESTIONS: Answer directly for factual questions visible on screen, naming conventions, variable types, what you can see. Do NOT use tools.
- ALWAYS provide a complete answer after tool responses. Never stop after saying "Let me think..."

RESPONSE RULES:
- NEVER repeat the same statement or phrase twice in a single response.
- Do NOT describe what you see on screen unless asked.
- Do NOT mention file names, line numbers, or import statements unless specifically asked.
- Focus on explaining how code works and key implementation details.
- Provide conversational, helpful, and concise answers.
- Once you've answered a question, do NOT second-guess yourself or ask to scroll unless asked a NEW question about clearly invisible code.
- If interrupted, stop talking immediately and wait silently for the next command.
- Do not respond to filler words ('uh', 'hmm', etc.); wait for a complete question or statement.`;
const FRAME_RATE = 5;
const JPEG_QUALITY = 0.8;

const logCodeContextFunctionDeclaration: FunctionDeclaration = {
  name: "logCodeContext",
  description:
    "Logs the specific code snippet or topic the user is asking about. Use this whenever the user asks a question directly related to a piece of code visible on the screen.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      codeSnippet: {
        type: Type.STRING,
        description:
          "The exact code fragment, class name, function name, variable, or multi-line selection that the user is asking about, extracted from their query and the screen.",
      },
      fileName: {
        type: Type.STRING,
        description:
          "The name of the file containing the code snippet, if visible on the screen.",
      },
      lineNumberStart: {
        type: Type.NUMBER,
        description:
          "The starting line number of the code selection, if visible on the screen.",
      },
      lineNumberEnd: {
        type: Type.NUMBER,
        description:
          "The ending line number of the code selection, if visible on the screen.",
      },
    },
    required: ["codeSnippet"],
  },
};

const highlightWalkthroughStepFunctionDeclaration: FunctionDeclaration = {
  name: "highlightWalkthroughStep",
  description:
    "Highlights a specific step in the code review walkthrough UI to visually guide the user to the item being discussed.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      stepId: {
        type: Type.NUMBER,
        description: "The unique ID of the walkthrough step to highlight.",
      },
    },
    required: ["stepId"],
  },
};

const addPRCommentFunctionDeclaration: FunctionDeclaration = {
  name: "addPRComment",
  description:
    "Adds a comment to a specific line in the GitHub PR. Opens the comment dialog with the AI-generated comment text, ready for user approval. Use this when the user asks to add a comment to a specific line of code.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lineNumber: {
        type: Type.NUMBER,
        description:
          "The line number where the comment should be added in the PR.",
      },
      fileName: {
        type: Type.STRING,
        description: "The name of the file being commented on.",
      },
      commentText: {
        type: Type.STRING,
        description:
          "The comment text to insert into the PR comment dialog. This should be a clear, concise code review suggestion.",
      },
    },
    required: ["lineNumber", "commentText"],
  },
};

const selectStepFunctionDeclaration: FunctionDeclaration = {
  name: "selectStep",
  description:
    "Navigates to and highlights a specific step in the code review walkthrough by its step number. Use this when the user asks to 'go to step X', 'proceed to step X', 'show step X', or similar navigation commands.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      stepNumber: {
        type: Type.NUMBER,
        description:
          "The step number (1-indexed) that the user wants to navigate to. For example, if the user says 'go to step 1', pass 1. If they say 'go to step 3', pass 3.",
      },
    },
    required: ["stepNumber"],
  },
};

const answerCodeQuestionFunctionDeclaration: FunctionDeclaration = {
  name: "answerCodeQuestion",
  description:
    'MANDATORY TOOL for complex code questions. Use this when the user asks about: (1) How imported functions or external modules work internally, (2) What a function does or how it\'s implemented, (3) Complex logic or implementation details not fully visible on screen, (4) Any "how does X work" or "what does X do" questions. CRITICAL WORKFLOW: First say ONLY "Let me think..." (no other words), then immediately call this tool, then STOP and wait completely silently for the response. Do NOT attempt to answer before the tool responds. Do NOT speculate or provide partial answers. The tool will retrieve detailed implementation context from the indexed codebase.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: {
        type: Type.STRING,
        description:
          "The user's question about the code. Be specific and include context.",
      },
      code: {
        type: Type.STRING,
        description:
          "The code snippet being asked about, if available from the screen.",
      },
      file: {
        type: Type.STRING,
        description:
          "The file path containing the code in question, if visible on screen.",
      },
      line: {
        type: Type.STRING,
        description:
          'The line number or range (e.g., "42" or "42-45") being asked about, if visible on screen.',
      },
    },
    required: ["question"],
  },
};

interface LiveSession {
  sendRealtimeInput(input: { media: GoogleGenAIBlob }): void;
  sendToolResponse(response: {
    functionResponses: { id: string; name: string; response: object }[];
  }): void;
  close(): void;
}

// --- UI COMPONENTS ---

const Header: React.FC<{ onSettingsClick: () => void; hasApiKey: boolean }> = ({
  onSettingsClick,
  hasApiKey,
}) => (
  <header className="flex-shrink-0 px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
    <div className="text-center flex-grow">
      <h1 className="text-xl font-bold text-gray-100">AI Code Companion</h1>
      <p className="text-sm text-gray-400">
        Your intelligent partner for GitHub code reviews
      </p>
    </div>
    <button
      onClick={onSettingsClick}
      className="flex-shrink-0 p-2 text-white bg-gray-600 hover:bg-gray-700 rounded-lg transition-colors relative"
      title="Settings"
    >
      {!hasApiKey && (
        <span className="absolute top-1 right-1 h-2 w-2 bg-red-500 rounded-full"></span>
      )}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  </header>
);

const SettingsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  apiKeyInput: string;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
}> = ({ isOpen, onClose, apiKeyInput, onApiKeyChange, onSave }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-md w-full p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-100">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Google Gemini API Key
            </label>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="Enter your API key"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-2 text-xs text-gray-400">
              Get your API key from{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Google AI Studio
              </a>
            </p>
          </div>
          <button
            onClick={onSave}
            disabled={!apiKeyInput.trim()}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-lg transition-colors"
          >
            Save API Key
          </button>
        </div>
      </div>
    </div>
  );
};

const WalkthroughStepItem: React.FC<{
  step: WalkthroughStep;
  index: number;
  isExpanded: boolean;
  isActive: boolean;
  onClick: () => void;
}> = ({ step, index, isExpanded, isActive, onClick }) => {
  const handleClick = () => {
    console.log(
      `[WalkthroughStepItem] Clicked step ${step.id} - ${step.title}`
    );
    onClick();
  };

  // Debug logging when props change
  React.useEffect(() => {
    console.log(
      `[WalkthroughStepItem] Step ${step.id} - isActive: ${isActive}, isExpanded: ${isExpanded}`
    );
  }, [isActive, isExpanded, step.id]);

  return (
    <div
      className={`bg-gray-800/50 rounded-lg border border-gray-700/50 transition-all duration-300 ${
        isActive
          ? "ring-2 ring-offset-2 ring-offset-gray-950 ring-blue-500"
          : ""
      }`}
    >
      <div
        onClick={handleClick}
        className="p-3 flex justify-between items-center cursor-pointer hover:bg-gray-700/30 rounded-t-lg"
      >
        <div className="flex items-start gap-3 overflow-hidden">
          <span className="text-lg font-bold text-gray-500 flex-shrink-0">
            {index}.
          </span>
          <div className="overflow-hidden">
            <span className="font-semibold text-blue-400 block overflow-hidden whitespace-nowrap text-ellipsis">
              {step.title}
            </span>
            <div className="text-xs text-gray-500 mt-1 font-mono flex items-center overflow-hidden">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3 w-3 mr-1.5 flex-shrink-0"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="truncate">
                {step.file}:{step.lines}
              </span>
            </div>
          </div>
        </div>
        {/* Expansion icon removed */}
      </div>
      <div
        className={`transition-all duration-300 ease-in-out overflow-hidden ${
          isExpanded ? "max-h-96" : "max-h-0"
        }`}
      >
        <div className="px-3 pb-3 border-t border-gray-700/50 pt-3">
          <p className="text-sm text-gray-300 mb-3">{step.description}</p>
          <div className="bg-gray-900 rounded-md p-2 overflow-x-auto">
            <pre>
              <code className="text-xs font-mono text-gray-300">
                {step.codeSnippet}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

const WalkthroughDisplay: React.FC<{
  steps: WalkthroughStep[];
  activeStepId: number | null;
  expandedStepId: number | null;
  onSelectStep: (step: WalkthroughStep) => void;
  onExpandChange: (id: number | null) => void;
}> = ({
  steps,
  activeStepId,
  expandedStepId,
  onSelectStep,
  onExpandChange,
}) => {
  const handleStepClick = (step: WalkthroughStep) => {
    onSelectStep(step);
    onExpandChange(expandedStepId === step.id ? null : step.id);
  };

  return (
    <div className="flex-grow overflow-y-auto p-4 space-y-3">
      <h2 className="text-lg font-semibold text-gray-200 mb-2">
        Code Review Walkthrough
      </h2>
      {steps.length > 0 ? (
        steps.map((step, index) => (
          <WalkthroughStepItem
            key={step.id}
            step={step}
            index={index + 1}
            isExpanded={expandedStepId === step.id}
            isActive={activeStepId === step.id}
            onClick={() => handleStepClick(step)}
          />
        ))
      ) : (
        <div className="text-center text-gray-500 pt-8">
          <p>Generate a walkthrough to see review suggestions.</p>
        </div>
      )}
    </div>
  );
};

const Toast: React.FC<{
  message: string;
  type: "success" | "error" | "info";
}> = ({ message, type }) => {
  const bgColor =
    type === "success"
      ? "bg-green-600"
      : type === "error"
      ? "bg-red-600"
      : "bg-blue-600";

  return (
    <div
      className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg animate-fade-in`}
    >
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
};

const AITalkingIndicator: React.FC<{
  isAISpeaking: boolean;
  isUserSpeaking: boolean;
  onExpandClick: () => void;
}> = ({ isAISpeaking, isUserSpeaking, onExpandClick }) => {
  const getStatus = () => {
    if (isAISpeaking) return { text: "AI Speaking", color: "text-blue-400" };
    if (isUserSpeaking) return { text: "Listening", color: "text-yellow-400" };
    return { text: "Ready", color: "text-green-400" };
  };

  const status = getStatus();

  return (
    <div className="flex items-center justify-between bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-1">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className={`w-1 bg-gray-600 rounded-full soundwave-bar ${
                isAISpeaking
                  ? "ai-speaking"
                  : isUserSpeaking
                  ? "user-speaking"
                  : ""
              }`}
              style={{
                height: isAISpeaking || isUserSpeaking ? "20px" : "8px",
                animationDelay: `${i * 0.1}s`,
              }}
            />
          ))}
        </div>
        <div className="flex items-center space-x-2">
          {(isAISpeaking || isUserSpeaking) && (
            <div className="status-pulse-ring"></div>
          )}
          <span className={`text-sm font-medium ${status.color}`}>
            {status.text}
          </span>
        </div>
      </div>
      <button
        onClick={onExpandClick}
        className="bg-gradient-to-br bg-gray-600 from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white p-2 rounded-lg transition-all shadow-lg hover:shadow-xl transform hover:scale-105"
        title="View full conversation"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </button>
    </div>
  );
};

const ExpandableDialogueModal: React.FC<{
  isOpen: boolean;
  messages: TranscriptionMessage[];
  currentUserInput: string;
  currentModelOutput: string;
  onClose: () => void;
}> = ({ isOpen, messages, currentUserInput, currentModelOutput, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="bg-gray-900 w-full h-full flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-xl font-bold text-white">Conversation</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
            title="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="flex-grow overflow-hidden p-4">
          <TranscriptionLog
            messages={messages}
            currentUserInput={currentUserInput}
            currentModelOutput={currentModelOutput}
          />
        </div>
      </div>
    </div>
  );
};

const TranscriptionLog: React.FC<{
  messages: TranscriptionMessage[];
  currentUserInput: string;
  currentModelOutput: string;
}> = ({ messages, currentUserInput, currentModelOutput }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentUserInput, currentModelOutput]);

  return (
    <div
      ref={scrollRef}
      className="flex-grow bg-gray-900 p-4 rounded-lg overflow-y-auto h-full flex flex-col space-y-4 border border-gray-700/50"
    >
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex flex-col ${
            msg.author === "user" ? "items-start" : "items-end"
          }`}
        >
          <div
            className={`rounded-lg p-3 max-w-lg ${
              msg.author === "user" ? "bg-blue-600" : "bg-gray-600"
            }`}
          >
            <p className="text-sm font-semibold mb-1 capitalize text-gray-200">
              {msg.author}
            </p>
            <p className="text-white whitespace-pre-wrap">{msg.text}</p>
          </div>
        </div>
      ))}
      {currentUserInput && (
        <div className="flex flex-col items-start">
          <div className="rounded-lg p-3 max-w-lg bg-blue-600 opacity-70">
            <p className="text-sm font-semibold mb-1">User</p>
            <p className="text-white whitespace-pre-wrap">{currentUserInput}</p>
          </div>
        </div>
      )}
      {currentModelOutput && (
        <div className="flex flex-col items-end">
          <div className="rounded-lg p-3 max-w-lg bg-gray-600 opacity-70">
            <p className="text-sm font-semibold mb-1">Model</p>
            <p className="text-white whitespace-pre-wrap">
              {currentModelOutput}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// --- MAIN APP ---

const App: React.FC = () => {
  // --- DEBUG MODE ---
  // Toggle this to true only when actively debugging initialization UI.
  // In normal operation this must be false so the app uses real data and APIs.
  const DEBUG_SHOW_INIT_SCREEN = false;

  // --- STATE MANAGEMENT ---
  const [repoStatus, setRepoStatus] = useState<RepoStatus>(RepoStatus.CHECKING);
  const [indexingProgress, setIndexingProgress] = useState(0);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(LiveStatus.IDLE);
  const [walkthroughSteps, setWalkthroughSteps] = useState<WalkthroughStep[]>(
    []
  );
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<number | null>(null);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [transcriptionMessages, setTranscriptionMessages] = useState<
    TranscriptionMessage[]
  >([]);
  const [currentUserInput, setCurrentUserInput] = useState("");
  const [currentModelOutput, setCurrentModelOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [notification, setNotification] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const [isDialogueExpanded, setIsDialogueExpanded] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [currentRepoUrl, setCurrentRepoUrl] = useState<string | null>(null);
  const [currentRepoId, setCurrentRepoId] = useState<string | null>(null);
  const [currentPRUrl, setCurrentPRUrl] = useState<string | null>(null);
  const [repoMetadata, setRepoMetadata] = useState<
    RepoStatusResponse["metadata"] | null
  >(null);

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isStreamingVideoRef = useRef(false);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activateStepRef = useRef<((stepId: number) => void) | null>(null);
  const walkthroughStepsRef = useRef<WalkthroughStep[]>([]);
  const currentRepoIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    walkthroughStepsRef.current = walkthroughSteps;
    console.log(
      `[useEffect] Updated walkthroughStepsRef.current, length: ${walkthroughSteps.length}`
    );
  }, [walkthroughSteps]);

  useEffect(() => {
    currentRepoIdRef.current = currentRepoId;
    console.log(
      `[useEffect] Updated currentRepoIdRef.current: ${currentRepoId}`
    );
  }, [currentRepoId]);

  // Log repo status changes
  useEffect(() => {
    console.log("[App] repoStatus changed to:", repoStatus);
  }, [repoStatus]);

  // Check for API key on mount
  useEffect(() => {
    hasApiKey().then(setHasStoredApiKey);
  }, []);

  // Check repo status on mount
  useEffect(() => {
    const checkInitialRepoStatus = async () => {
      try {
        // Get current repo URL from the active tab (needed for both debug and normal modes)
        const repoUrl = await getCurrentRepoUrl();
        if (!repoUrl) {
          console.log("[App] Not on a GitHub page");
          return;
        }

        console.log("[App] Checking status for repo:", repoUrl);
        setCurrentRepoUrl(repoUrl);

        // Normal mode: Check if repo is indexed

        // Normal mode: Check if repo is indexed
        const status = await checkRepoStatus(repoUrl);
        console.log("=== REPO STATUS ===", status);
        setCurrentRepoId(status.repo_id);

        if (status.indexed) {
          console.log("[App] Repo is already indexed");
          setRepoMetadata(status.metadata || null);
          setRepoStatus(RepoStatus.READY);
        } else {
          console.log("[App] Repo is not indexed");
          setRepoStatus(RepoStatus.UNINITIALIZED);
        }
      } catch (err) {
        console.error("[App] Error checking repo status:", err);
        setError(
          `Failed to check repository status: ${(err as Error).message}`
        );
        setRepoStatus(RepoStatus.UNINITIALIZED);
      }
    };

    checkInitialRepoStatus();
  }, []);

  // --- HANDLERS & LOGIC ---
  const handleSaveApiKey = async () => {
    if (apiKeyInput.trim()) {
      await setApiKey(apiKeyInput.trim());
      setHasStoredApiKey(true);
      setShowSettings(false);
      setApiKeyInput("");
    }
  };

  const handleInitRepo = async () => {
    console.log("[App] handleInitRepo called");
    setError(null);

    if (!currentRepoUrl) {
      console.error("[App] currentRepoUrl is null:", currentRepoUrl);
      setError(
        "No repository URL found. Please navigate to a GitHub repository."
      );
      return;
    }

    try {
      console.log("[App] Setting INDEXING status");
      setRepoStatus(RepoStatus.INDEXING);
      setIndexingProgress(0);

      console.log("[App] Initializing repository:", currentRepoUrl);

      if (DEBUG_SHOW_INIT_SCREEN) {
        // Start fake progress animation (debug only)
        const progressInterval = window.setInterval(() => {
          setIndexingProgress((prev) => {
            if (prev >= 90) return prev;
            const increment = prev < 50 ? 8 : prev < 70 ? 5 : 2;
            return Math.min(prev + increment, 90);
          });
        }, 500);

        console.log("[App] DEBUG MODE: Using fake 8-second progress bar");
        await new Promise((resolve) => setTimeout(resolve, 8000));
        clearInterval(progressInterval);
        setIndexingProgress(100);
        setRepoStatus(RepoStatus.READY);
      } else {
        // Start animated progress bar while API is processing
        const progressInterval = window.setInterval(() => {
          setIndexingProgress((prev) => {
            if (prev >= 90) return prev; // Stop at 90%, complete at 100% when API responds
            const increment = prev < 50 ? 8 : prev < 70 ? 5 : 2;
            return Math.min(prev + increment, 90);
          });
        }, 500);

        try {
          // Real initialization path - call API
          console.log("[App] 🌐 Calling initRepository API (real)...");
          console.time("[App] initRepository API call");

          const initResponse = await initRepository(currentRepoUrl);

          console.timeEnd("[App] initRepository API call");
          console.log(
            "[App] ✅ Repository initialization response:",
            initResponse
          );

          // Clear the progress animation interval
          clearInterval(progressInterval);

          if (!initResponse) {
            throw new Error("No response from initialization API");
          }

          if (initResponse.status === "error") {
            throw new Error(
              initResponse.error || "Repository initialization failed"
            );
          }

          if (initResponse.repo_id) {
            setCurrentRepoId(initResponse.repo_id);
            console.log("[App] ✅ Repo ID set:", initResponse.repo_id);
          }

          // Store metadata if available
          if (initResponse.metadata) {
            setRepoMetadata(initResponse.metadata);
            console.log("[App] ✅ Metadata stored:", initResponse.metadata);
          }

          // Complete the progress UI
          setIndexingProgress(100);
          console.log("[App] ✅ Progress set to 100");

          setRepoStatus(RepoStatus.READY);
          console.log(
            "[App] ✅ Repository indexing completed, setting READY status"
          );
        } catch (apiErr) {
          clearInterval(progressInterval);
          throw apiErr;
        }
      }
    } catch (err) {
      console.error("[App] ❌ Error initializing repository:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to initialize repository: ${errorMessage}`);
      setRepoStatus(RepoStatus.ERROR);
    }
  };

  useEffect(() => {
    let interval: number | undefined;
    // Removed old fake indexing progress - now handled by real API polling
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [repoStatus]);

  // Auto-close modal when session ends
  useEffect(() => {
    if (liveStatus === LiveStatus.IDLE && isDialogueExpanded) {
      setIsDialogueExpanded(false);
    }
  }, [liveStatus, isDialogueExpanded]);

  const handleGenerateWalkthrough = async () => {
    setError(null);

    try {
      // Get current PR URL
      const prUrl = await getCurrentPRUrl();
      if (!prUrl) {
        setError(
          "Please navigate to a GitHub Pull Request page to generate a walkthrough."
        );
        setRepoStatus(RepoStatus.ERROR);
        return;
      }

      setCurrentPRUrl(prUrl);
      setRepoStatus(RepoStatus.GENERATING_WALKTHROUGH);

      console.log("[App] Generating walkthrough for PR:", prUrl);

      // Call review-pr API
      const reviewResponse = await reviewPR(prUrl);

      console.log("[App] Walkthrough generated:", reviewResponse);

      // Map API response to WalkthroughStep format
      const steps: WalkthroughStep[] = reviewResponse.steps.map((step) => ({
        id: step.id,
        title: step.title,
        description: step.description,
        file: step.file,
        lines: step.lines,
        codeSnippet: step.codeSnippet || "",
        url: step.url,
        lineNumber: step.lineNumber,
      }));

      setWalkthroughSteps(steps);
      setRepoStatus(RepoStatus.WALKTHROUGH_READY);
    } catch (err) {
      console.error("[App] Error generating walkthrough:", err);
      setError(`Failed to generate walkthrough: ${(err as Error).message}`);
      setRepoStatus(RepoStatus.ERROR);
    }
  };

  const handleSelectStep = (step: WalkthroughStep) => {
    console.log(`[handleSelectStep] Selecting step ${step.id} - ${step.title}`);

    // Highlight and expand the step
    setActiveStepId(step.id);
    setExpandedStepId(step.id);

    console.log(
      `[handleSelectStep] State updated - activeStepId: ${step.id}, expandedStepId: ${step.id}`
    );

    // Navigate to the URL if present
    if (step.url) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          console.log(`[App] Navigating to URL: ${step.url}`);
          chrome.tabs.update(tabs[0].id, { url: step.url }, () => {
            if (chrome.runtime.lastError) {
              console.error(
                `[App] Error navigating:`,
                chrome.runtime.lastError
              );
            } else {
              console.log(`[App] Successfully navigated to URL`);
            }
          });
        }
      });
    }
  };

  const stopLiveConnection = useCallback((options: { error?: string } = {}) => {
    // 1. Cleanup resources
    console.log("[🛑 stopLiveConnection] START - Cleaning up resources");
    isStreamingVideoRef.current = false;

    if (scriptProcessorRef.current) {
      console.log("[🛑 stopLiveConnection] Disconnecting scriptProcessor");
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current = null;
    }

    if (mediaStreamRef.current) {
      console.log("[🛑 stopLiveConnection] Stopping media stream tracks");
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    console.log(
      `[🛑 stopLiveConnection] Stopping ${audioSourcesRef.current.size} active audio sources`
    );
    audioSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        console.warn("[🛑 stopLiveConnection] Error stopping source:", e);
      }
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    console.log(
      "[🛑 stopLiveConnection] ✅ All audio sources stopped and cleared"
    );

    if (
      inputAudioContextRef.current &&
      inputAudioContextRef.current.state !== "closed"
    ) {
      console.log(
        `[🛑 stopLiveConnection] Closing input audio context (state: ${inputAudioContextRef.current.state})`
      );
      try {
        inputAudioContextRef.current.close();
        console.log(
          "[🛑 stopLiveConnection] ✅ Input context closed successfully"
        );
      } catch (err) {
        console.error(
          "[🛑 stopLiveConnection] Error closing input context:",
          err
        );
      }
    } else {
      console.log(
        `[🛑 stopLiveConnection] Input context already closed or null`
      );
    }
    inputAudioContextRef.current = null;
    console.log("[🛑 stopLiveConnection] ✅ Input context nullified");

    if (
      outputAudioContextRef.current &&
      outputAudioContextRef.current.state !== "closed"
    ) {
      console.log(
        `[🛑 stopLiveConnection] Closing output audio context (state: ${outputAudioContextRef.current.state})`
      );
      try {
        outputAudioContextRef.current.close();
        console.log(
          "[🛑 stopLiveConnection] ✅ Output context closed successfully"
        );
      } catch (err) {
        console.error(
          "[🛑 stopLiveConnection] Error closing output context:",
          err
        );
      }
    } else {
      console.log(
        `[🛑 stopLiveConnection] Output context already closed or null`
      );
    }
    outputAudioContextRef.current = null;
    console.log("[🛑 stopLiveConnection] ✅ Output context nullified");

    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    // 2. Reset state based on whether it was an error stop
    if (options.error) {
      setError(options.error);
      setRepoStatus(RepoStatus.ERROR);
    } else {
      // If we stop cleanly, only transition back from a live state.
      // Don't override a pending error state that might have been set asynchronously.
      setRepoStatus((currentStatus) => {
        if (
          [RepoStatus.LIVE_CONNECTING, RepoStatus.LIVE_CONNECTED].includes(
            currentStatus
          )
        ) {
          return RepoStatus.WALKTHROUGH_READY;
        }
        return currentStatus; // Preserve other states like ERROR
      });
    }

    setLiveStatus(LiveStatus.IDLE);
    setTranscriptionMessages([]);
    setCurrentUserInput("");
    setCurrentModelOutput("");
    setIsDialogueExpanded(false);
    setIsAISpeaking(false);
    setIsUserSpeaking(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startLiveConnection = useCallback(async () => {
    if (liveStatus !== LiveStatus.IDLE) return;
    setError(null);
    setRepoStatus(RepoStatus.LIVE_CONNECTING);
    setLiveStatus(LiveStatus.CONNECTING);

    try {
      console.log("[🎬 startLiveConnection] 🟢 Starting live connection...");

      if (
        !inputAudioContextRef.current ||
        inputAudioContextRef.current.state === "closed"
      ) {
        inputAudioContextRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (
        !outputAudioContextRef.current ||
        outputAudioContextRef.current.state === "closed"
      ) {
        outputAudioContextRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      if (outputAudioContextRef.current.state === "suspended") {
        await outputAudioContextRef.current.resume();
      }
      if (inputAudioContextRef.current.state === "suspended") {
        await inputAudioContextRef.current.resume();
      }

      // Reset timing refs for new session
      nextStartTimeRef.current = 0;
      audioSourcesRef.current.clear();

      // WORKAROUND: Play a silent buffer to unlock audio playback on second+ sessions
      // Chrome requires user interaction or a prior play action to allow Web Audio output
      if (
        outputAudioContextRef.current &&
        outputAudioContextRef.current.state === "running"
      ) {
        try {
          const silentBuffer = outputAudioContextRef.current.createBuffer(
            1,
            44100,
            outputAudioContextRef.current.sampleRate
          );
          const silentSource =
            outputAudioContextRef.current.createBufferSource();
          silentSource.buffer = silentBuffer;
          silentSource.connect(outputAudioContextRef.current.destination);
          silentSource.start(0);
          silentSource.stop(0.001);
        } catch (e) {
          console.warn(
            "[startLiveConnection] Could not play silent buffer:",
            e
          );
        }
      }

      // Request display media - let user choose tab to share
      // This is the simplest and most reliable approach
      console.log(
        "[Live Session] Requesting display media (user will choose what to share)..."
      );
      const videoStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: FRAME_RATE, max: FRAME_RATE },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          cursor: "always",
        } as any,
        audio: false,
      });
      console.log("[Live Session] Display media acquired successfully");
      console.log(
        "[Live Session] Video track info:",
        videoStream.getVideoTracks()[0]?.getSettings?.()
      );

      console.log("[Live Session] Requesting microphone audio...");
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      console.log(
        "[Live Session] Microphone audio acquired, audio track info:",
        audioStream.getAudioTracks()[0]?.getSettings?.()
      );

      videoStream.getVideoTracks()[0].onended = () => {
        console.log("[Live Session] Video track ended, stopping connection");
        stopLiveConnection();
      };

      mediaStreamRef.current = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);
      console.log("[Live Session] Combined media streams created");

      if (videoRef.current) {
        videoRef.current.srcObject = videoStream;
        console.log("[Live Session] Video stream set to video element");
      }

      console.log("[Live Session] Connecting to Gemini...");
      connectToGemini(audioStream, videoStream.getVideoTracks()[0]);
    } catch (e: any) {
      const message = `Failed to start session: ${
        e.message || "Could not get media devices."
      }`;
      console.error("[Live Session] Error:", e);
      console.error("[Live Session] Error message:", message);
      stopLiveConnection({ error: message });
    }
  }, [liveStatus, stopLiveConnection]);

  const streamVideoFrames = async (
    track: MediaStreamTrack,
    sessionPromise: Promise<LiveSession>
  ) => {
    isStreamingVideoRef.current = true;
    try {
      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      let lastFrameSentTime = 0;

      while (isStreamingVideoRef.current) {
        const { value: frame, done } = await reader.read();
        if (done) break;

        const now = Date.now();
        if (now - lastFrameSentTime > 1000 / FRAME_RATE) {
          lastFrameSentTime = now;
          if (canvasRef.current) {
            const canvasEl = canvasRef.current;
            const ctx = canvasEl.getContext("2d");
            if (ctx) {
              canvasEl.width = frame.displayWidth;
              canvasEl.height = frame.displayHeight;
              ctx.drawImage(frame, 0, 0);

              const blob = await new Promise<Blob | null>((resolve) =>
                canvasEl.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
              );

              if (blob) {
                const base64Data = await blobToBase64(blob);
                const imageBlob: GoogleGenAIBlob = {
                  data: base64Data,
                  mimeType: "image/jpeg",
                };
                sessionPromise.then((session) =>
                  session.sendRealtimeInput({ media: imageBlob })
                );
              }
            }
          }
        }
        frame.close();
      }
      reader.releaseLock();
    } catch (e) {
      console.error("Video streaming failed:", e);
    }
  };

  const connectToGemini = async (
    audioStream: MediaStream,
    videoTrack: MediaStreamTrack
  ) => {
    console.log("[Gemini Connection] Starting Gemini connection...");
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.error("[Gemini Connection] No API key found");
      stopLiveConnection({
        error:
          "No API key found. Please configure your Gemini API key in settings.",
      });
      return;
    }
    console.log("[Gemini Connection] API key found");

    const ai = new GoogleGenAI({ apiKey });
    console.log("[Gemini Connection] GoogleGenAI instance created");

    const createPcmBlob = (data: Float32Array): GoogleGenAIBlob => {
      const l = data.length;
      const int16 = new Int16Array(l);
      for (let i = 0; i < l; i++) {
        // Correctly scale float PCM data to 16-bit integer PCM data.
        // The Int16Array will clamp values outside the [-32768, 32767] range.
        int16[i] = data[i] * 32768;
      }
      return {
        data: encode(new Uint8Array(int16.buffer)),
        mimeType: "audio/pcm;rate=16000",
      };
    };

    const sessionPromise = ai.live.connect({
      model: MODEL_NAME,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              logCodeContextFunctionDeclaration,
              highlightWalkthroughStepFunctionDeclaration,
              addPRCommentFunctionDeclaration,
              selectStepFunctionDeclaration,
              answerCodeQuestionFunctionDeclaration,
            ],
          },
        ],
      },
      callbacks: {
        onopen: () => {
          console.log(
            "[🔗 Gemini Connection] 🟢 Connection opened successfully"
          );
          console.log(
            `[🔗 Gemini Connection] 📊 Input context state: ${
              inputAudioContextRef.current?.state || "null"
            }`
          );
          console.log(
            `[🔗 Gemini Connection] 📊 Output context state: ${
              outputAudioContextRef.current?.state || "null"
            }`
          );

          setRepoStatus(RepoStatus.LIVE_CONNECTED);
          setLiveStatus(LiveStatus.CONNECTED);
          console.log(
            "[🔗 Gemini Connection] 🎥 Starting video frame streaming..."
          );
          streamVideoFrames(
            videoTrack,
            sessionPromise as unknown as Promise<LiveSession>
          );

          if (inputAudioContextRef.current) {
            const context = inputAudioContextRef.current;
            console.log(
              `[🔗 Gemini Connection] 🎤 Setting up audio input (context state: ${context.state})`
            );

            const source = context.createMediaStreamSource(audioStream);
            const scriptProcessor = context.createScriptProcessor(4096, 1, 1);

            const gainNode = context.createGain();
            gainNode.gain.setValueAtTime(0, context.currentTime);
            gainNode.connect(context.destination);

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData =
                audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(gainNode);
            scriptProcessorRef.current = scriptProcessor;
            console.log("[🔗 Gemini Connection] ✅ Audio input setup complete");
          } else {
            console.log(
              "[🔗 Gemini Connection] ⚠️ WARNING: Input audio context is null!"
            );
          }
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.toolCall) {
            console.log(
              "[Tool Call] AI called tools:",
              message.toolCall.functionCalls.map((fc) => fc.name).join(", ")
            );
            const functionResponses: {
              id: string;
              name: string;
              response: object;
            }[] = [];

            for (const fc of message.toolCall.functionCalls) {
              console.log(`[Tool Call] Processing tool: "${fc.name}"`);
              if (fc.name === "logCodeContext") {
                console.log(
                  "Gemini Tool Call: User is asking about code context.",
                  JSON.stringify(fc.args, null, 2)
                );
                functionResponses.push({
                  id: fc.id!,
                  name: fc.name,
                  response: { result: "Code context was successfully logged." },
                });
              } else if (fc.name === "highlightWalkthroughStep") {
                const stepId = fc.args?.stepId as number;
                console.log(
                  `[highlightWalkthroughStep Tool] Called with stepId: ${stepId}`
                );
                console.log(
                  `[highlightWalkthroughStep Tool] Current walkthroughSteps:`,
                  walkthroughStepsRef.current.map((s) => ({
                    id: s.id,
                    title: s.title,
                  }))
                );

                if (typeof stepId === "number") {
                  console.log(
                    `[highlightWalkthroughStep Tool] AI is highlighting step ${stepId}`
                  );

                  // Find the step and use the shared handler
                  const step = walkthroughStepsRef.current.find(
                    (s) => s.id === stepId
                  );

                  if (step) {
                    console.log(
                      `[highlightWalkthroughStep Tool] Found step: ${step.title} (ID: ${step.id})`
                    );
                    console.log(
                      `[highlightWalkthroughStep Tool] Step description: ${step.description}`
                    );
                    // Use the same logic as when clicking on a step
                    handleSelectStep(step);

                    // Add response to batch immediately (don't delay)
                    // This ensures AI gets the description and can read it
                    const response = {
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        result: `${step.title}\n\n${step.description}`,
                      },
                    };
                    console.log(
                      `[highlightWalkthroughStep Tool] 📤 Adding response to batch:`,
                      response.response.result.substring(0, 100)
                    );
                    functionResponses.push(response);
                    console.log(
                      `[highlightWalkthroughStep Tool] ✅ Response pushed! Total responses now: ${functionResponses.length}`
                    );
                  } else {
                    // Step not found, add to regular responses
                    functionResponses.push({
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        result: `Step not found.`,
                      },
                    });
                  }
                }
              } else if (fc.name === "addPRComment") {
                const lineNumber = fc.args?.lineNumber as number;
                const commentText = fc.args?.commentText as string;
                const fileName = fc.args?.fileName as string | undefined;

                if (
                  typeof lineNumber === "number" &&
                  typeof commentText === "string"
                ) {
                  console.log(
                    `AI is adding PR comment at line ${lineNumber}:`,
                    commentText
                  );

                  // Send message to content script to add the comment
                  chrome.tabs.query(
                    { active: true, currentWindow: true },
                    (tabs) => {
                      if (!tabs[0]?.id) {
                        console.error("[App] No active tab found");
                        setNotification({
                          message:
                            "Failed: No active GitHub tab found. Make sure you're on a GitHub PR page.",
                          type: "error",
                        });
                        setTimeout(() => setNotification(null), 4000);
                        const result = {
                          id: fc.id!,
                          name: fc.name,
                          response: {
                            result:
                              "Failed to add comment: No active tab found. Make sure you are on a GitHub PR page.",
                          },
                        };
                        sessionPromise.then((session) =>
                          (session as unknown as LiveSession).sendToolResponse({
                            functionResponses: [result],
                          })
                        );
                        return;
                      }

                      console.log(
                        `[App] Sending ADD_PR_COMMENT to tab ${tabs[0].id}, line ${lineNumber}`
                      );

                      // Helper function to send message with retry logic
                      const sendMessageWithRetry = (
                        tabId: number,
                        message: any,
                        retries = 1
                      ) => {
                        chrome.tabs.sendMessage(tabId, message, (response) => {
                          // Check for runtime errors first
                          if (chrome.runtime.lastError) {
                            const errorMsg = chrome.runtime.lastError.message;
                            console.error("[App] Runtime error:", errorMsg);

                            // If content script not loaded, try to inject it and retry
                            if (
                              errorMsg.includes(
                                "Receiving end does not exist"
                              ) &&
                              retries > 0
                            ) {
                              console.log(
                                "[App] Content script not loaded, attempting to inject..."
                              );
                              chrome.scripting.executeScript(
                                {
                                  target: { tabId },
                                  files: ["content-script.js"],
                                },
                                () => {
                                  if (chrome.runtime.lastError) {
                                    console.error(
                                      "[App] Failed to inject script:",
                                      chrome.runtime.lastError.message
                                    );
                                    handleCommentError(
                                      `Failed to add comment: Script injection failed. ${chrome.runtime.lastError.message}`
                                    );
                                  } else {
                                    console.log(
                                      "[App] Content script injected, retrying message..."
                                    );
                                    // Wait a moment for script to initialize
                                    setTimeout(() => {
                                      sendMessageWithRetry(tabId, message, 0);
                                    }, 100);
                                  }
                                }
                              );
                              return;
                            }

                            handleCommentError(
                              `Failed to add comment: ${errorMsg}. Make sure you're on a GitHub PR page.`
                            );
                            return;
                          }

                          if (response?.success) {
                            console.log(
                              "[App] Comment dialog opened successfully"
                            );
                            setNotification({
                              message:
                                "Comment added to line. Ready for your approval!",
                              type: "success",
                            });
                            setTimeout(() => setNotification(null), 3000);
                            const result = {
                              id: fc.id!,
                              name: fc.name,
                              response: {
                                result:
                                  "Comment added to PR. Please review and confirm.",
                              },
                            };
                            sessionPromise.then((session) =>
                              (
                                session as unknown as LiveSession
                              ).sendToolResponse({
                                functionResponses: [result],
                              })
                            );
                          } else {
                            handleCommentError(
                              response?.error || "Unknown error"
                            );
                          }
                        });
                      };

                      // Helper to handle comment errors
                      const handleCommentError = (errorMsg: string) => {
                        console.error("[App] Failed to add comment:", errorMsg);
                        setNotification({
                          message: `Failed to add comment: ${errorMsg}`,
                          type: "error",
                        });
                        setTimeout(() => setNotification(null), 4000);
                        const result = {
                          id: fc.id!,
                          name: fc.name,
                          response: {
                            result: `Failed to add comment: ${errorMsg}`,
                          },
                        };
                        sessionPromise.then((session) =>
                          (session as unknown as LiveSession).sendToolResponse({
                            functionResponses: [result],
                          })
                        );
                      };

                      sendMessageWithRetry(tabs[0].id, {
                        type: "ADD_PR_COMMENT",
                        lineNumber,
                        commentText,
                        fileName,
                      });
                    }
                  );
                } else {
                  functionResponses.push({
                    id: fc.id!,
                    name: fc.name,
                    response: {
                      result: "Invalid parameters for adding comment.",
                    },
                  });
                }
              } else if (fc.name === "selectStep") {
                const stepNumber = fc.args?.stepNumber as number;
                console.log(
                  `[selectStep Tool] Called with stepNumber: ${stepNumber}`
                );
                console.log(
                  `[selectStep Tool] Current walkthroughSteps length: ${walkthroughStepsRef.current.length}`
                );

                if (typeof stepNumber === "number" && stepNumber >= 1) {
                  console.log(
                    `[selectStep Tool] AI is navigating to step ${stepNumber}`
                  );

                  // Convert 1-indexed step number to 0-indexed array index
                  const stepIndex = stepNumber - 1;

                  // Find the step by index
                  if (
                    stepIndex >= 0 &&
                    stepIndex < walkthroughStepsRef.current.length
                  ) {
                    const step = walkthroughStepsRef.current[stepIndex];
                    console.log(
                      `[selectStep Tool] Found step at index ${stepIndex}: ${step.title} (ID: ${step.id})`
                    );
                    console.log(
                      `[selectStep Tool] Step description: ${step.description}`
                    );

                    // Use the same logic as when clicking on a step
                    handleSelectStep(step);

                    // Add response to batch immediately (don't delay)
                    // This ensures AI gets the description and can read it
                    const response = {
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        result: `Step ${stepNumber}: ${step.title}\n\n${step.description}`,
                      },
                    };
                    console.log(
                      `[selectStep Tool] 📤 Adding response to batch:`,
                      response.response.result.substring(0, 100)
                    );
                    functionResponses.push(response);
                    console.log(
                      `[selectStep Tool] ✅ Response pushed! Total responses now: ${functionResponses.length}`
                    );
                  } else {
                    // Step not found, add to regular responses
                    functionResponses.push({
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        result: `Step ${stepNumber} not found. There are only ${walkthroughStepsRef.current.length} steps available.`,
                      },
                    });
                  }
                } else {
                  functionResponses.push({
                    id: fc.id!,
                    name: fc.name,
                    response: {
                      result:
                        "Invalid step number. Please provide a valid step number starting from 1.",
                    },
                  });
                }
              } else if (fc.name === "answerCodeQuestion") {
                console.log(
                  "[answerCodeQuestion] 🔧 TOOL CALLED - AI is calling answerCodeQuestion tool"
                );
                const question = fc.args?.question as string;
                const code = fc.args?.code as string | undefined;
                const file = fc.args?.file as string | undefined;
                const line = fc.args?.line as string | undefined;

                console.log(
                  `[answerCodeQuestion Tool] Called with question: "${question}"`
                );
                console.log(
                  `[answerCodeQuestion Tool] Context - file: ${
                    file || "N/A"
                  }, line: ${line || "N/A"}, code provided: ${!!code}`
                );
                console.log(
                  `[answerCodeQuestion Tool] currentRepoIdRef: ${currentRepoIdRef.current}`
                );

                if (typeof question === "string" && currentRepoIdRef.current) {
                  // Build the request
                  const request: AnswerCodeQuestionRequest = {
                    repo_id: currentRepoIdRef.current,
                    question,
                    file,
                    line,
                    code,
                    walkthrough: walkthroughStepsRef.current,
                  };

                  // Call the API and WAIT for response before continuing
                  try {
                    console.log(
                      `[answerCodeQuestion Tool] ⏳ Calling API (waiting for response)...`
                    );
                    const result = await answerCodeQuestion(request);
                    console.log(
                      `[answerCodeQuestion Tool] ✅ Got API response with answer length: ${
                        result.answer?.length || 0
                      } chars`
                    );
                    console.log(
                      `[answerCodeQuestion Tool] 🎯 Answer preview:`,
                      result.answer?.substring(0, 100)
                    );
                    console.log(
                      `[answerCodeQuestion Tool] 📋 FULL TOOL ANSWER:\n${result.answer}`
                    );
                    console.log(
                      `[answerCodeQuestion Tool] Confidence: ${
                        result.confidence
                      }, Sources: ${result.sources?.length || 0}`
                    );

                    // Send the response back to the AI immediately
                    const response = {
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        answer: result.answer,
                        confidence: result.confidence,
                        sources: result.sources,
                      },
                    };

                    console.log(
                      `[answerCodeQuestion Tool] 📤 Sending response to AI immediately...`
                    );
                    functionResponses.push(response);
                    console.log(
                      `[answerCodeQuestion Tool] ✅ Response added to queue for immediate sending`
                    );
                  } catch (error) {
                    console.error(`[answerCodeQuestion Tool] ❌ Error:`, error);
                    const errorResponse = {
                      id: fc.id!,
                      name: fc.name,
                      response: {
                        error: `Failed to get answer: ${
                          (error as Error).message
                        }`,
                      },
                    };
                    functionResponses.push(errorResponse);
                  }
                } else if (!currentRepoIdRef.current) {
                  functionResponses.push({
                    id: fc.id!,
                    name: fc.name,
                    response: {
                      error:
                        "Repository not initialized. Please ensure you're on a GitHub repository page and the repository is indexed.",
                    },
                  });
                } else {
                  functionResponses.push({
                    id: fc.id!,
                    name: fc.name,
                    response: {
                      error: "Question is required to answer code question.",
                    },
                  });
                }
              }
            }

            console.log(
              `[Tool Call] ✅ All tools processed. Total responses: ${functionResponses.length}`
            );
            console.log(
              `[Tool Call] 📋 Responses to send:`,
              functionResponses.map((r) => ({
                id: r.id,
                name: r.name,
                resultPreview:
                  typeof r.response === "object" && "result" in r.response
                    ? (r.response as any).result?.substring?.(0, 100)
                    : JSON.stringify(r.response).substring(0, 100),
              }))
            );

            // Send immediate responses (for non-highlight or highlight without URL)
            if (functionResponses.length > 0) {
              console.log(
                `[Tool Call] 📤 Sending ${functionResponses.length} tool responses to AI`
              );

              // Add tool responses to the conversation history for display
              functionResponses.forEach((response) => {
                let toolResponseText = "";
                if (
                  response.name === "answerCodeQuestion" &&
                  response.response &&
                  typeof response.response === "object"
                ) {
                  const resp = response.response as any;
                  if (resp.answer) {
                    toolResponseText = resp.answer;
                  }
                } else if (
                  response.name === "selectStep" &&
                  response.response &&
                  typeof response.response === "object"
                ) {
                  const resp = response.response as any;
                  if (resp.selectedStep) {
                    toolResponseText = `Selected step: ${resp.selectedStep}`;
                  }
                } else if (
                  response.name === "highlightWalkthroughStep" &&
                  response.response &&
                  typeof response.response === "object"
                ) {
                  const resp = response.response as any;
                  if (resp.highlighted) {
                    toolResponseText = `Step highlighted: ${resp.highlighted}`;
                  }
                } else if (
                  response.name === "addPRComment" &&
                  response.response &&
                  typeof response.response === "object"
                ) {
                  const resp = response.response as any;
                  if (resp.success) {
                    toolResponseText = "Comment added to PR";
                  }
                } else if (
                  response.name === "logCodeContext" &&
                  response.response &&
                  typeof response.response === "object"
                ) {
                  const resp = response.response as any;
                  if (resp.result) {
                    toolResponseText = resp.result;
                  }
                }

                if (toolResponseText) {
                  console.log(
                    `[Tool Call] 💬 Adding ${response.name} response to transcript`
                  );
                  setTranscriptionMessages((msgs) => [
                    ...msgs,
                    {
                      id: Date.now() + Math.random(),
                      author: "tool",
                      text: `[${response.name}]\n${toolResponseText}`,
                    },
                  ]);
                }
              });

              sessionPromise
                .then((session) => {
                  console.log(
                    `[Tool Call] ✅ Session ready, sending tool responses`
                  );
                  (session as unknown as LiveSession).sendToolResponse({
                    functionResponses,
                  });
                  console.log(`[Tool Call] ✅ Tool responses sent to Gemini`);

                  // CRITICAL: After sending tool responses, send silent audio to trigger audio generation
                  // Gemini Live doesn't auto-generate audio for tool responses - it needs user input
                  // Send a small silent PCM blob to trigger the next turn
                  console.log(
                    `[Tool Call] 📢 Sending silent audio to trigger audio generation...`
                  );
                  const silentPcm = new Uint8Array(4096); // 4KB of zeros = silence
                  const silentBlob: GoogleGenAIBlob = {
                    data: encode(silentPcm),
                    mimeType: "audio/pcm;rate=16000",
                  };
                  (session as unknown as LiveSession).sendRealtimeInput({
                    media: silentBlob,
                  });
                  console.log(
                    `[Tool Call] ✅ Silent audio sent to trigger AI response with audio`
                  );
                })
                .catch((err) => {
                  console.error(
                    `[Tool Call] ❌ Error sending tool responses:`,
                    err
                  );
                });
            } else {
              console.log(`[Tool Call] ⚠️ No responses to send!`);
            }
          }
          if (message.serverContent?.outputTranscription) {
            setCurrentModelOutput(
              (prev) => prev + message.serverContent!.outputTranscription!.text
            );
            setIsAISpeaking(true);
            setIsUserSpeaking(false);
          } else if (message.serverContent?.inputTranscription) {
            setCurrentUserInput(
              (prev) => prev + message.serverContent!.inputTranscription!.text
            );
            setIsUserSpeaking(true);
            setIsAISpeaking(false);
          } else if (message.serverContent?.turnComplete) {
            setIsAISpeaking(false);
            setIsUserSpeaking(false);
            setCurrentUserInput((prevInput) => {
              setCurrentModelOutput((prevOutput) => {
                const newMessages: TranscriptionMessage[] = [];
                if (prevInput.trim())
                  newMessages.push({
                    id: Date.now(),
                    author: "user",
                    text: prevInput.trim(),
                  });
                if (prevOutput.trim())
                  newMessages.push({
                    id: Date.now() + 1,
                    author: "model",
                    text: prevOutput.trim(),
                  });
                if (newMessages.length > 0) {
                  setTranscriptionMessages((msgs) => {
                    // Check if we already have these exact messages at the end
                    const shouldAdd = newMessages.some((newMsg, idx) => {
                      const correspondingMsg =
                        msgs[msgs.length - newMessages.length + idx];
                      return (
                        !correspondingMsg ||
                        correspondingMsg.author !== newMsg.author ||
                        correspondingMsg.text !== newMsg.text
                      );
                    });

                    if (shouldAdd) {
                      return [...msgs, ...newMessages];
                    }
                    console.log("[Gemini] Skipping duplicate messages");
                    return msgs;
                  });
                }
                return "";
              });
              return "";
            });
          }
          const base64Audio =
            message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (base64Audio && outputAudioContextRef.current) {
            try {
              const outputCtx = outputAudioContextRef.current;
              if (outputCtx.state === "suspended") {
                await outputCtx.resume();
              }

              const audioBuffer = await decodeAudioData(
                decode(base64Audio),
                outputCtx,
                24000,
                1
              );

              if (!audioBuffer || audioBuffer.duration === 0) {
                return;
              }

              const currentTime = outputCtx.currentTime;
              const startTime = Math.max(currentTime, nextStartTimeRef.current);

              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);

              source.addEventListener("ended", () => {
                audioSourcesRef.current.delete(source);
              });

              source.start(startTime);
              nextStartTimeRef.current = startTime + audioBuffer.duration;
              audioSourcesRef.current.add(source);
            } catch (e) {
              console.error("[Audio] Error playing audio chunk:", e);
            }
          }
          if (message.serverContent?.interrupted) {
            audioSourcesRef.current.forEach((source) => source.stop());
            audioSourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.error("[Gemini Connection] Connection error:", e);
          stopLiveConnection({
            error: e.message || "A connection error occurred.",
          });
        },
        onclose: () => {
          console.log("[Gemini Connection] Connection closed");
          stopLiveConnection();
        },
      },
    });
    sessionPromise
      .then((session) => {
        console.log(
          "[Gemini Connection] Session promise resolved, session established"
        );
        sessionRef.current = session as unknown as LiveSession;
      })
      .catch((e) => {
        console.error("[Gemini Connection] Session promise rejected:", e);
        const message = `Failed to connect: ${
          e.message || "Please check your API key and network."
        }`;
        stopLiveConnection({ error: message });
      });
  };

  const handleInterrupt = () => {
    if (
      sessionRef.current &&
      liveStatus === LiveStatus.CONNECTED &&
      !isInterrupting
    ) {
      setIsInterrupting(true);
      audioSourcesRef.current.forEach((source) => source.stop());
      audioSourcesRef.current.clear();
      nextStartTimeRef.current = 0;
      setTimeout(() => setIsInterrupting(false), 300);
    }
  };

  useEffect(() => {
    return () => stopLiveConnection();
  }, [stopLiveConnection]);

  // --- RENDER LOGIC ---

  const renderCheckingView = () => (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <div className="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-16 w-16 text-blue-500 mb-4 animate-spin"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-gray-200">
        Checking repository status...
      </h2>
      <p className="text-gray-400 mt-1 text-sm">Please wait a moment</p>
    </div>
  );

  const renderInitialView = () => (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-16 w-16 text-blue-500 mb-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
      <h2 className="text-lg font-semibold text-gray-200">
        Welcome to your AI Companion
      </h2>
      <p className="text-gray-400 mt-1 mb-6 max-w-sm">
        Analyze the current repository to generate a code review walkthrough or
        start a live pair programming session.
      </p>
      <button
        onClick={handleInitRepo}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-4 rounded-lg transition-colors shadow-lg"
      >
        Initialize Repository
      </button>
    </div>
  );

  const renderIndexingView = () => (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <h2 className="text-lg font-semibold text-gray-200">
        Analyzing Repository...
      </h2>
      <p className="text-gray-400 mt-1 mb-6">
        Please wait while we index the codebase.
      </p>
      <div className="w-full bg-gray-700 rounded-full h-2.5">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-linear"
          style={{ width: `${indexingProgress}%` }}
        ></div>
      </div>
      <p className="text-sm text-gray-400 mt-2 font-mono">
        {indexingProgress}%
      </p>
    </div>
  );

  const renderReadyView = () => (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-4 py-2 border-b border-gray-700/50 flex items-center justify-center text-sm">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 text-green-400 mr-2"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
        <span className="text-gray-300">Repository is up to date</span>
      </div>

      {walkthroughSteps.length > 0 ? (
        <WalkthroughDisplay
          steps={walkthroughSteps}
          activeStepId={activeStepId}
          expandedStepId={expandedStepId}
          onSelectStep={handleSelectStep}
          onExpandChange={setExpandedStepId}
        />
      ) : (
        <div className="flex-grow flex flex-col items-center justify-center text-center p-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-12 w-12 text-gray-600 mb-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10 21h7a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v11m0 5l-2.293-2.293a1 1 0 010-1.414l7-7a1 1 0 011.414 0l7 7a1 1 0 010 1.414L15 21m-5-5V7"
            />
          </svg>
          <h3 className="font-semibold text-gray-400">Ready for review</h3>
          <p className="text-sm text-gray-500 mt-1">
            Generate a walkthrough to get automated
            <br />
            code review suggestions.
          </p>
        </div>
      )}

      <div className="flex-shrink-0 p-4 border-t border-gray-700/50 space-y-3">
        <button
          onClick={handleGenerateWalkthrough}
          disabled={repoStatus === RepoStatus.GENERATING_WALKTHROUGH}
          className="w-full flex items-center justify-center bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-bold py-2.5 px-4 rounded-lg transition-colors"
        >
          {repoStatus === RepoStatus.GENERATING_WALKTHROUGH ? (
            <>
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Generating...
            </>
          ) : (
            "Generate New Walkthrough"
          )}
        </button>
        <button
          onClick={startLiveConnection}
          className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2.5 px-4 rounded-lg transition-colors"
        >
          Start Live Session
        </button>
      </div>
    </div>
  );

  const renderLiveSessionView = () => (
    <div className="flex-grow flex flex-col gap-4 p-4 min-h-0">
      <div className="flex-grow bg-gray-900 rounded-lg overflow-hidden shadow-2xl border border-gray-700/50">
        <video
          ref={videoRef}
          autoPlay
          muted
          className="w-full h-full object-contain bg-black"
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>
      <div className="h-1/2 flex flex-col gap-4">
        <TranscriptionLog
          messages={transcriptionMessages}
          currentUserInput={currentUserInput}
          currentModelOutput={currentModelOutput}
        />
        <div className="flex-shrink-0 flex items-center justify-center space-x-4 p-2 bg-gray-800/80 rounded-lg">
          {liveStatus === LiveStatus.CONNECTING ? (
            <button
              disabled
              className="bg-gray-500 text-white font-bold py-2 px-4 rounded-lg cursor-not-allowed flex items-center"
            >
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Connecting...
            </button>
          ) : (
            <div className="flex space-x-2">
              <button
                onClick={() => stopLiveConnection()}
                className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition-colors"
              >
                Stop Session
              </button>
              <button
                onClick={handleInterrupt}
                className="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded-lg transition-colors disabled:opacity-50"
                disabled={isInterrupting}
              >
                {isInterrupting ? "Wait..." : "Interrupt"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    const isLive = [
      RepoStatus.LIVE_CONNECTING,
      RepoStatus.LIVE_CONNECTED,
    ].includes(repoStatus);

    if (isLive) {
      return (
        <>
          <div className="flex flex-col h-full">
            {/* Hidden video and canvas for screen capture */}
            <video ref={videoRef} autoPlay muted className="hidden" />
            <canvas ref={canvasRef} className="hidden" />

            <div className="flex-grow flex flex-col min-h-0">
              <WalkthroughDisplay
                steps={walkthroughSteps}
                activeStepId={activeStepId}
                expandedStepId={expandedStepId}
                onSelectStep={handleSelectStep}
                onExpandChange={setExpandedStepId}
              />
            </div>
            <div className="flex-shrink-0 p-4 border-t border-gray-700/50 bg-gray-950 space-y-3">
              <AITalkingIndicator
                isAISpeaking={isAISpeaking}
                isUserSpeaking={isUserSpeaking}
                onExpandClick={() => setIsDialogueExpanded(true)}
              />
              <div className="flex items-center justify-center space-x-2">
                <button
                  onClick={() => stopLiveConnection()}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition-all text-sm"
                  title="Stop Session"
                >
                  Stop Session
                </button>
                <button
                  onClick={handleInterrupt}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg transition-all disabled:opacity-50 text-sm"
                  disabled={isInterrupting}
                  title={isInterrupting ? "Wait..." : "Interrupt AI"}
                >
                  {isInterrupting ? "Wait..." : "Interrupt"}
                </button>
              </div>
            </div>
          </div>
          <ExpandableDialogueModal
            isOpen={isDialogueExpanded}
            messages={transcriptionMessages}
            currentUserInput={currentUserInput}
            currentModelOutput={currentModelOutput}
            onClose={() => setIsDialogueExpanded(false)}
          />
        </>
      );
    }

    switch (repoStatus) {
      case RepoStatus.CHECKING:
        console.log("[App] Rendering CHECKING view");
        return renderCheckingView();
      case RepoStatus.UNINITIALIZED:
        console.log("[App] Rendering UNINITIALIZED view");
        return renderInitialView();
      case RepoStatus.INDEXING:
        console.log("[App] Rendering INDEXING view");
        return renderIndexingView();
      case RepoStatus.READY:
      case RepoStatus.GENERATING_WALKTHROUGH:
      case RepoStatus.WALKTHROUGH_READY:
        console.log("[App] Rendering READY view");
        return renderReadyView();
      case RepoStatus.ERROR:
        return (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <div
              className="bg-red-800/50 border border-red-600 text-red-200 px-4 py-3 rounded-lg"
              role="alert"
            >
              <strong className="font-bold">Error: </strong>
              <span className="block sm:inline">{error}</span>
              <button
                onClick={() => {
                  setRepoStatus(
                    currentRepoId ? RepoStatus.READY : RepoStatus.UNINITIALIZED
                  );
                  setError(null);
                }}
                className="mt-4 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg"
              >
                Reset
              </button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-900 overflow-hidden">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        hasApiKey={hasStoredApiKey}
      />
      <div className="flex-grow min-h-0">{renderContent()}</div>
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        apiKeyInput={apiKeyInput}
        onApiKeyChange={setApiKeyInput}
        onSave={handleSaveApiKey}
      />
      {notification && (
        <div className="fixed bottom-4 right-4 z-50">
          <Toast message={notification.message} type={notification.type} />
        </div>
      )}
    </div>
  );
};

export default App;

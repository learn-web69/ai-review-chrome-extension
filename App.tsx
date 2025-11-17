



import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob as GoogleGenAIBlob, FunctionDeclaration, Type } from '@google/genai';
import { TranscriptionMessage } from './types';
import { blobToBase64, encode, decode, decodeAudioData } from './utils/audio';

// --- ENUMS & TYPES ---
enum RepoStatus {
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
}

// --- CONSTANTS ---
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';
const SYSTEM_INSTRUCTION = `You are an expert AI pair programmer. Your purpose is to help the user by looking at their screen and answering their questions about the code. When discussing one of the generated walkthrough steps, you MUST use the "highlightWalkthroughStep" tool with the corresponding step ID to guide the user. When the user asks a question about a different piece of code, you MUST use the "logCodeContext" tool to identify the code snippet they are referring to. After using a tool, provide a conversational, helpful, and concise answer based on the code you see on the screen. If you can't see the code clearly, ask the user to scroll or adjust their screen. If you are interrupted, stop talking immediately and wait silently for the next command. Do not say "Okay" or any other confirmation. Do not respond to filler words or short utterances like 'uh' or 'hmm'; wait for a complete question or statement before replying.`;
const FRAME_RATE = 5;
const JPEG_QUALITY = 0.8;

const logCodeContextFunctionDeclaration: FunctionDeclaration = {
  name: 'logCodeContext',
  description: 'Logs the specific code snippet or topic the user is asking about. Use this whenever the user asks a question directly related to a piece of code visible on the screen.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      codeSnippet: { type: Type.STRING, description: 'The exact code fragment, class name, function name, variable, or multi-line selection that the user is asking about, extracted from their query and the screen.' },
      fileName: { type: Type.STRING, description: 'The name of the file containing the code snippet, if visible on the screen.' },
      lineNumberStart: { type: Type.NUMBER, description: 'The starting line number of the code selection, if visible on the screen.' },
      lineNumberEnd: { type: Type.NUMBER, description: 'The ending line number of the code selection, if visible on the screen.' }
    },
    required: ['codeSnippet'],
  },
};

const highlightWalkthroughStepFunctionDeclaration: FunctionDeclaration = {
  name: 'highlightWalkthroughStep',
  description: 'Highlights a specific step in the code review walkthrough UI to visually guide the user to the item being discussed.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      stepId: { type: Type.NUMBER, description: 'The unique ID of the walkthrough step to highlight.' },
    },
    required: ['stepId'],
  },
};

interface LiveSession {
  sendRealtimeInput(input: { media: GoogleGenAIBlob }): void;
  sendToolResponse(response: { functionResponses: { id: string, name: string, response: object }[] }): void;
  close(): void;
}


// --- UI COMPONENTS ---

const Header: React.FC = () => (
  <header className="flex-shrink-0 text-center px-4 py-3 border-b border-gray-700/50">
    <h1 className="text-xl font-bold text-gray-100">AI Code Companion</h1>
    <p className="text-sm text-gray-400">Your intelligent partner for GitHub code reviews</p>
  </header>
);

const WalkthroughStepItem: React.FC<{
  step: WalkthroughStep;
  index: number;
  isExpanded: boolean;
  isActive: boolean;
  onClick: () => void;
}> = ({ step, index, isExpanded, isActive, onClick }) => {
  return (
    <div className={`bg-gray-800/50 rounded-lg border border-gray-700/50 transition-all duration-300 ${isActive ? 'ring-2 ring-offset-2 ring-offset-gray-950 ring-blue-500' : ''}`}>
      <div
        onClick={onClick}
        className="p-3 flex justify-between items-center cursor-pointer hover:bg-gray-700/30 rounded-t-lg"
      >
        <div className="flex items-start gap-3">
          <span className="text-lg font-bold text-gray-500">{index}.</span>
          <div>
            <span className="font-semibold text-blue-400">{step.title}</span>
            <div className="text-xs text-gray-500 mt-1 font-mono flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" /></svg>
              {step.file}:{step.lines}
            </div>
          </div>
        </div>
        {/* Expansion icon removed */}
      </div>
      <div className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-96' : 'max-h-0'}`}>
        <div className="px-3 pb-3 border-t border-gray-700/50 pt-3">
          <p className="text-sm text-gray-300 mb-3">{step.description}</p>
          <div className="bg-gray-900 rounded-md p-2 overflow-x-auto">
            <pre><code className="text-xs font-mono text-gray-300">{step.codeSnippet}</code></pre>
          </div>
        </div>
      </div>
    </div>
  );
};


const WalkthroughDisplay: React.FC<{
  steps: WalkthroughStep[];
  activeStepId: number | null;
  onActivate: (id: number) => void;
}> = ({ steps, activeStepId, onActivate }) => {
  const [expandedStepId, setExpandedStepId] = useState<number | null>(null);

  const handleStepClick = (stepId: number) => {
    onActivate(stepId);
    setExpandedStepId(currentId => currentId === stepId ? null : stepId);
  };

  return (
    <div className="flex-grow overflow-y-auto p-4 space-y-3">
      <h2 className="text-lg font-semibold text-gray-200 mb-2">Code Review Walkthrough</h2>
      {steps.length > 0 ? steps.map((step, index) => (
        <WalkthroughStepItem
          key={step.id}
          step={step}
          index={index + 1}
          isExpanded={expandedStepId === step.id}
          isActive={activeStepId === step.id}
          onClick={() => handleStepClick(step.id)}
        />
      )) : (
        <div className="text-center text-gray-500 pt-8">
            <p>Generate a walkthrough to see review suggestions.</p>
        </div>
      )}
    </div>
  );
};


const TranscriptionLog: React.FC<{
  messages: TranscriptionMessage[],
  currentUserInput: string,
  currentModelOutput: string
}> = ({ messages, currentUserInput, currentModelOutput }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentUserInput, currentModelOutput]);

  return (
    <div ref={scrollRef} className="flex-grow bg-gray-900 p-4 rounded-lg overflow-y-auto h-full flex flex-col space-y-4 border border-gray-700/50">
      {messages.map((msg) => (
        <div key={msg.id} className={`flex flex-col ${msg.author === 'user' ? 'items-start' : 'items-end'}`}>
          <div className={`rounded-lg p-3 max-w-lg ${msg.author === 'user' ? 'bg-blue-600' : 'bg-gray-600'}`}>
            <p className="text-sm font-semibold mb-1 capitalize text-gray-200">{msg.author}</p>
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
            <p className="text-white whitespace-pre-wrap">{currentModelOutput}</p>
          </div>
        </div>
      )}
    </div>
  );
};


// --- MAIN APP ---

const App: React.FC = () => {
  // --- STATE MANAGEMENT ---
  const [repoStatus, setRepoStatus] = useState<RepoStatus>(RepoStatus.UNINITIALIZED);
  const [indexingProgress, setIndexingProgress] = useState(0);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(LiveStatus.IDLE);
  const [walkthroughSteps, setWalkthroughSteps] = useState<WalkthroughStep[]>([]);
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [transcriptionMessages, setTranscriptionMessages] = useState<TranscriptionMessage[]>([]);
  const [currentUserInput, setCurrentUserInput] = useState('');
  const [currentModelOutput, setCurrentModelOutput] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  // --- HANDLERS & LOGIC ---
  const handleInitRepo = () => {
    setError(null);
    setRepoStatus(RepoStatus.INDEXING);
    setIndexingProgress(0);
  };

  useEffect(() => {
    let interval: number | undefined;
    if (repoStatus === RepoStatus.INDEXING) {
      interval = window.setInterval(() => {
        setIndexingProgress(prev => {
          const newProgress = prev + Math.floor(Math.random() * 10) + 5;
          if (newProgress >= 100) {
            clearInterval(interval);
            setRepoStatus(RepoStatus.READY);
            return 100;
          }
          return newProgress;
        });
      }, 300);
    }
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [repoStatus]);

  const handleGenerateWalkthrough = () => {
    setRepoStatus(RepoStatus.GENERATING_WALKTHROUGH);
    setTimeout(() => {
      const fakeData: WalkthroughStep[] = [
        { id: 1, title: "Optimize State Management", description: "The component re-renders frequently. Consider using `useCallback` or `React.memo` to optimize performance by memoizing functions and components.", file: "src/components/UserList.tsx", lines: "45-52", codeSnippet: "const memoizedCallback = useCallback(\n  () => {\n    doSomething(a, b);\n  },\n  [a, b],\n);" },
        { id: 2, title: "Improve Accessibility", description: "The button element is missing an `aria-label` for screen readers. Add a descriptive label to ensure it's accessible for all users.", file: "src/components/common/Button.tsx", lines: "12", codeSnippet: "<button aria-label=\"Close dialog\">\n  X\n</button>" },
        { id: 3, title: "Security Vulnerability", description: "Using `dangerouslySetInnerHTML` can expose the app to XSS attacks. Sanitize the HTML before rendering it to prevent malicious script injection.", file: "src/utils/parser.ts", lines: "88", codeSnippet: "import DOMPurify from 'dompurify';\n\nconst cleanHTML = DOMPurify.sanitize(dirtyHTML);" },
      ];
      setWalkthroughSteps(fakeData);
      setRepoStatus(RepoStatus.WALKTHROUGH_READY);
    }, 2000); // Simulate API call
  };

  const stopLiveConnection = useCallback((options: { error?: string } = {}) => {
    // 1. Cleanup resources
    isStreamingVideoRef.current = false;

    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
        scriptProcessorRef.current = null;
    }

    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
    }
    
    audioSourcesRef.current.forEach(source => source.stop());
    audioSourcesRef.current.clear();
    
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
        inputAudioContextRef.current.close().catch(console.error);
    }
    inputAudioContextRef.current = null;

    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close().catch(console.error);
    }
    outputAudioContextRef.current = null;

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
        setRepoStatus(currentStatus => {
            if ([RepoStatus.LIVE_CONNECTING, RepoStatus.LIVE_CONNECTED].includes(currentStatus)) {
                return RepoStatus.WALKTHROUGH_READY;
            }
            return currentStatus; // Preserve other states like ERROR
        });
    }

    setLiveStatus(LiveStatus.IDLE);
    setTranscriptionMessages([]);
    setCurrentUserInput('');
    setCurrentModelOutput('');
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
       if (!inputAudioContextRef.current || inputAudioContextRef.current.state === 'closed') {
        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current || outputAudioContextRef.current.state === 'closed') {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
      if (inputAudioContextRef.current.state === 'suspended') await inputAudioContextRef.current.resume();

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: FRAME_RATE, max: FRAME_RATE }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      displayStream.getVideoTracks()[0].onended = () => stopLiveConnection();
      
      mediaStreamRef.current = new MediaStream([...displayStream.getVideoTracks(), ...audioStream.getAudioTracks()]);

      if (videoRef.current) videoRef.current.srcObject = displayStream;
      
      connectToGemini(audioStream, displayStream.getVideoTracks()[0]);

    } catch (e: any) {
      const message = `Failed to start session: ${e.message || 'Could not get media devices.'}`;
      stopLiveConnection({ error: message });
    }
  }, [liveStatus, stopLiveConnection]);

  const streamVideoFrames = async (track: MediaStreamTrack, sessionPromise: Promise<LiveSession>) => {
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
            const ctx = canvasEl.getContext('2d');
            if (ctx) {
              canvasEl.width = frame.displayWidth;
              canvasEl.height = frame.displayHeight;
              ctx.drawImage(frame, 0, 0);

              const blob = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));

              if (blob) {
                const base64Data = await blobToBase64(blob);
                const imageBlob: GoogleGenAIBlob = { data: base64Data, mimeType: 'image/jpeg' };
                sessionPromise.then((session) => session.sendRealtimeInput({ media: imageBlob }));
              }
            }
          }
        }
        frame.close();
      }
      reader.releaseLock();
    } catch(e) { console.error("Video streaming failed:", e); }
  };

  const connectToGemini = (audioStream: MediaStream, videoTrack: MediaStreamTrack) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
    
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
        mimeType: 'audio/pcm;rate=16000',
      };
    };

    const sessionPromise = ai.live.connect({
      model: MODEL_NAME,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: [logCodeContextFunctionDeclaration, highlightWalkthroughStepFunctionDeclaration] }],
      },
      callbacks: {
        onopen: () => {
          setRepoStatus(RepoStatus.LIVE_CONNECTED);
          setLiveStatus(LiveStatus.CONNECTED);
          streamVideoFrames(videoTrack, sessionPromise as unknown as Promise<LiveSession>);
          
          if (inputAudioContextRef.current) {
            const context = inputAudioContextRef.current;
            const source = context.createMediaStreamSource(audioStream);
            const scriptProcessor = context.createScriptProcessor(4096, 1, 1);
            
            const gainNode = context.createGain();
            gainNode.gain.setValueAtTime(0, context.currentTime);
            gainNode.connect(context.destination);

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(gainNode);
            scriptProcessorRef.current = scriptProcessor;
          }
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.toolCall) {
            const functionResponses: { id: string, name: string, response: object }[] = [];
            for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'logCodeContext') {
                    console.log('Gemini Tool Call: User is asking about code context.', JSON.stringify(fc.args, null, 2));
                    functionResponses.push({ id: fc.id!, name: fc.name, response: { result: "Code context was successfully logged." } });
                } else if (fc.name === 'highlightWalkthroughStep') {
                    const stepId = fc.args?.stepId as number;
                    if (typeof stepId === 'number') {
                        setActiveStepId(stepId);
                        console.log(`AI is highlighting step ${stepId}`);
                        functionResponses.push({ id: fc.id!, name: fc.name, response: { result: `Step ${stepId} successfully highlighted.` } });
                    }
                }
            }
            if (functionResponses.length > 0) {
                sessionPromise.then((session) => (session as unknown as LiveSession).sendToolResponse({ functionResponses }));
            }
        }
          if (message.serverContent?.outputTranscription) {
            setCurrentModelOutput((prev) => prev + message.serverContent!.outputTranscription!.text);
          } else if (message.serverContent?.inputTranscription) {
            setCurrentUserInput((prev) => prev + message.serverContent!.inputTranscription!.text);
          } else if (message.serverContent?.turnComplete) {
            setCurrentUserInput(prevInput => {
              setCurrentModelOutput(prevOutput => {
                 const newMessages: TranscriptionMessage[] = [];
                 if (prevInput.trim()) newMessages.push({id: Date.now(), author: 'user', text: prevInput.trim()});
                 if (prevOutput.trim()) newMessages.push({id: Date.now() + 1, author: 'model', text: prevOutput.trim()});
                 if (newMessages.length > 0) setTranscriptionMessages(msgs => [...msgs, ...newMessages]);
                 return '';
              });
              return '';
            });
          }
          const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (base64Audio && outputAudioContextRef.current) {
            try {
              const outputCtx = outputAudioContextRef.current;
              if (outputCtx.state === 'suspended') await outputCtx.resume();
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              if (!audioBuffer || audioBuffer.duration === 0) return;
              const currentTime = outputCtx.currentTime;
              const startTime = Math.max(currentTime, nextStartTimeRef.current);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
              source.start(startTime);
              nextStartTimeRef.current = startTime + audioBuffer.duration;
              audioSourcesRef.current.add(source);
            } catch (e) { console.error("Error playing audio chunk:", e); }
          }
          if (message.serverContent?.interrupted) {
            audioSourcesRef.current.forEach(source => source.stop());
            audioSourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          stopLiveConnection({ error: e.message || 'A connection error occurred.' });
        },
        onclose: () => { 
          stopLiveConnection();
        },
      },
    });
    sessionPromise.then(session => {
        sessionRef.current = session as unknown as LiveSession;
    }).catch(e => {
        const message = `Failed to connect: ${e.message || 'Please check your API key and network.'}`;
        stopLiveConnection({ error: message });
    });
  };

  const handleInterrupt = () => {
    if (sessionRef.current && liveStatus === LiveStatus.CONNECTED && !isInterrupting) {
      setIsInterrupting(true);
      audioSourcesRef.current.forEach(source => source.stop());
      audioSourcesRef.current.clear();
      nextStartTimeRef.current = 0;
      setTimeout(() => setIsInterrupting(false), 300);
    }
  };

  useEffect(() => {
    return () => stopLiveConnection();
  }, [stopLiveConnection]);

  // --- RENDER LOGIC ---

  const renderInitialView = () => (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-blue-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        <h2 className="text-lg font-semibold text-gray-200">Welcome to your AI Companion</h2>
        <p className="text-gray-400 mt-1 mb-6 max-w-sm">Analyze the current repository to generate a code review walkthrough or start a live pair programming session.</p>
        <button onClick={handleInitRepo} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-4 rounded-lg transition-colors shadow-lg">
          Initialize Repository
        </button>
    </div>
  );

  const renderIndexingView = () => (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <h2 className="text-lg font-semibold text-gray-200">Analyzing Repository...</h2>
        <p className="text-gray-400 mt-1 mb-6">Please wait while we index the codebase.</p>
        <div className="w-full bg-gray-700 rounded-full h-2.5">
          <div 
            className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-linear" 
            style={{width: `${indexingProgress}%`}}>
          </div>
        </div>
        <p className="text-sm text-gray-400 mt-2 font-mono">{indexingProgress}%</p>
    </div>
  );
  
  const renderReadyView = () => (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-4 py-2 border-b border-gray-700/50 flex items-center justify-center text-sm">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-400 mr-2" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        <span className="text-gray-300">Repository is up to date</span>
      </div>
      
      {walkthroughSteps.length > 0 ? (
         <WalkthroughDisplay steps={walkthroughSteps} activeStepId={activeStepId} onActivate={setActiveStepId} />
      ) : (
        <div className="flex-grow flex flex-col items-center justify-center text-center p-4">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-gray-600 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M10 21h7a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v11m0 5l-2.293-2.293a1 1 0 010-1.414l7-7a1 1 0 011.414 0l7 7a1 1 0 010 1.414L15 21m-5-5V7" /></svg>
          <h3 className="font-semibold text-gray-400">Ready for review</h3>
          <p className="text-sm text-gray-500 mt-1">Generate a walkthrough to get automated<br/>code review suggestions.</p>
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
            <svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            Generating...
            </>
          ) : 'Generate New Walkthrough'}
        </button>
        <button onClick={startLiveConnection} className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2.5 px-4 rounded-lg transition-colors">
          Start Live Session
        </button>
      </div>
    </div>
  );

  const renderLiveSessionView = () => (
    <div className="flex-grow flex flex-col gap-4 p-4 min-h-0">
      <div className="flex-grow bg-gray-900 rounded-lg overflow-hidden shadow-2xl border border-gray-700/50">
         <video ref={videoRef} autoPlay muted className="w-full h-full object-contain bg-black" />
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
             <button disabled className="bg-gray-500 text-white font-bold py-2 px-4 rounded-lg cursor-not-allowed flex items-center">
               <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
               Connecting...
             </button>
           ) : (
             <div className="flex space-x-2">
               <button onClick={() => stopLiveConnection()} className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition-colors">Stop Session</button>
               <button onClick={handleInterrupt} className="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded-lg transition-colors disabled:opacity-50" disabled={isInterrupting}>{isInterrupting ? 'Wait...' : 'Interrupt'}</button>
             </div>
           )}
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    const isLive = [RepoStatus.LIVE_CONNECTING, RepoStatus.LIVE_CONNECTED].includes(repoStatus);

    if (isLive) {
      return (
        <div className="flex h-full">
          <aside className="w-[450px] flex-shrink-0 border-r border-gray-700/50 flex flex-col bg-gray-950">
            <WalkthroughDisplay
              steps={walkthroughSteps}
              activeStepId={activeStepId}
              onActivate={setActiveStepId}
            />
             <div className="flex-shrink-0 p-4 border-t border-gray-700/50">
                <button
                onClick={handleGenerateWalkthrough}
                disabled={repoStatus === RepoStatus.GENERATING_WALKTHROUGH}
                className="w-full flex items-center justify-center bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-bold py-2.5 px-4 rounded-lg transition-colors"
                >
                {repoStatus === RepoStatus.GENERATING_WALKTHROUGH ? 'Generating...' : 'Regenerate Walkthrough'}
                </button>
            </div>
          </aside>
          <main className="flex-grow flex flex-col">
            {renderLiveSessionView()}
          </main>
        </div>
      );
    }
    
    switch (repoStatus) {
      case RepoStatus.UNINITIALIZED:
        return renderInitialView();
      case RepoStatus.INDEXING:
        return renderIndexingView();
      case RepoStatus.READY:
      case RepoStatus.GENERATING_WALKTHROUGH:
      case RepoStatus.WALKTHROUGH_READY:
        return renderReadyView();
      case RepoStatus.ERROR:
        return (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <div className="bg-red-800/50 border border-red-600 text-red-200 px-4 py-3 rounded-lg" role="alert">
              <strong className="font-bold">Error: </strong>
              <span className="block sm:inline">{error}</span>
              <button onClick={() => { setRepoStatus(RepoStatus.UNINITIALIZED); setError(null); }} className="mt-4 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg">Reset</button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-900 overflow-hidden">
      <Header />
      <div className="flex-grow min-h-0">
        {renderContent()}
      </div>
    </div>
  );
};

export default App;
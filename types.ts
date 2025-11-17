// FIX: Replaced obsolete ImageCapture declaration with types for the WebCodecs API,
// which is now used for more reliable background video frame processing.
declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
  }

  class MediaStreamTrackProcessor {
    constructor(init: MediaStreamTrackProcessorInit);
    readonly readable: ReadableStream<VideoFrame>;
  }

  interface VideoFrame {
    readonly displayWidth: number;
    readonly displayHeight: number;
    close(): void;
  }
}

export interface TranscriptionMessage {
  id: number;
  author: 'user' | 'model';
  text: string;
}
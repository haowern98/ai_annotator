# Live Lecture Summarizer - AI Development Guidelines

## Project Overview
A real-time lecture analysis and interview assistance tool using Gemini Live API with continuous A/V streaming. The application has two main modes:
- **Lecture Mode**: Interval-based capture every 5 seconds
- **Interview Mode**: Continuous streaming with Voice Activity Detection (VAD)

## Architecture

### Core Components
1. **UI Layer** (`components/InterviewMode.tsx`):
   - Pure React components for display/interaction
   - No direct Gemini API logic
   - Uses refs for video/canvas elements

2. **Service Layer** (`services/liveApiService.ts`):
   - Manages Gemini Live API WebSocket connections
   - Handles session resumption/reconnection
   - Processes audio/video streaming
   - Parses model responses

3. **Streaming Utilities** (`utils/continuousStreaming.ts`):
   - Manages continuous A/V capture
   - Uses Web Audio API's AudioWorklet
   - Handles buffering during transcription
   - Implements error monitoring/recovery

### Key Patterns

1. **Session Management**:
```typescript
// Always handle session resumption in LiveApiService
const handleToUse = resumeHandle ?? this.currentSessionHandle;
this.saveSessionHandle(newHandle); // On successful connection
```

2. **Error Recovery**:
```typescript
// Buffer audio during disconnections
if (!isConnected) {
  this.audioBuffer.push({ data: base64Audio, mimeType });
  if (this.audioBuffer.length > 200) this.audioBuffer.shift();
}
```

3. **Audio Processing**:
- Use 16kHz sample rate for audio
- Process in 100ms chunks
- PCM audio format with base64 encoding

## Integration Points

1. **Gemini Live API**:
- Uses `gemini-2.5-flash-live-preview` model
- Requires API key in `.env.local`
- Supports bidirectional streaming
- VAD threshold set to 0.5

2. **Web Audio API**:
- Uses AudioWorklet for processing
- AudioProcessor at `/public/audio-processor.js`
- Sample rate fixed at 16kHz

## Development Workflow

1. **Local Setup**:
```bash
npm install
# Add to .env.local:
API_KEY=your_gemini_api_key_here
npm run dev
```

2. **Key Configuration Files**:
- `config.json`: Video mode settings
- `services/liveApiService.ts`: System instructions
- `tsconfig.json`: TypeScript configuration

3. **Common Operations**:
```typescript
// Starting a session
await liveApiService.connect(callbacks, systemInstruction);

// Sending audio/video
await service.sendRealtimeAudio(base64Audio, 'audio/pcm;rate=16000');
await service.sendVideoFrame(base64Image);
```

## Important Notes

1. **Audio Buffering**: Audio is buffered during:
   - Service disconnections
   - Active transcription
   - Max buffer size: 200 chunks (~20 seconds)

2. **Session Limits**:
   - WebSocket timeout: ~10 minutes
   - Max transcript chars: 300 before auto-reset
   - Max reconnection attempts: 3

3. **Debug Logs**: Available in DevTools console (F12):
   - 🟢 Success: Green text
   - ⚠️ Warning: Yellow text
   - ❌ Error: Red text

## Common Issues

1. **WebSocket Disconnects**:
   - Application auto-retries 3 times
   - Uses exponential backoff (max 5s)
   - Buffers audio during reconnection

2. **Screen Capture**:
   - HTTPS required for local development
   - Electron mode uses custom source picker
   - Must handle autoplay restrictions
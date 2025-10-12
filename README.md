# Live Lecture Summarizer

Real-time lecture analysis and interview assistance using Gemini Live API with continuous audio/video streaming.

## Features

### Lecture Mode (Video Mode)
- 5-second interval-based capture (legacy approach)
- Sends 12 data points per minute
- Manual summary synchronization
- Uses discrete audio chunks

### Interview Mode (NEW - Continuous Streaming) ✅ WORKING
- **Continuous audio streaming** via Live API with Voice Activity Detection (VAD)
- **Real-time video frames** at 1 FPS
- **Automatic turn detection** - Model responds when speaker finishes talking
- **Full analysis responses** - Provides thoughtful answers after every turn
- Bidirectional conversation support
- Natural, low-latency responses

## Architecture

### Clean Separation of Concerns ✅

**UI Layer** (`components/InterviewMode.tsx`):
- Pure UI component - handles only display and user interaction
- Manages React state (transcripts, replies, status)
- Handles screen capture permission requests
- Provides refs (videoRef, canvasRef) to service layer
- No Gemini-specific logic

**Service Layer** (`services/liveApiService.ts`):
- **Orchestrates all Gemini Live API functionality**
- Manages WebSocket connection lifecycle
- Handles ContinuousStreamingCapture instantiation
- Contains system instructions and prompt engineering
- Parses model responses (TRANSCRIPT/REPLY extraction)
- Exposes clean callback interface to UI
- Provides simple start/stop API

**Streaming Utility** (`utils/continuousStreaming.ts`):
- Handles continuous A/V capture
- Video frames at configurable FPS
- Audio processing via ScriptProcessorNode
- Delegates to LiveApiService for sending data

### Service Layer API

**High-level callbacks exposed to UI:**
```typescript
{
  onInterviewerTranscript: (text, timestamp, isFinal) => void
  onAIReply: (text, timestamp) => void
  onStreamingReply: (partialText) => void
  onError: (message) => void
  onStatusChange: (status) => void
  onReconnecting: () => void
}
```

**Simple start/stop interface:**
```typescript
await liveApiService.start({
  mediaStream,
  videoRef,
  canvasRef,
  callbacks: { ... }
});

liveApiService.stop();
```

### Benefits of This Architecture

✅ **Future-proof**: Change Gemini prompts/format → only edit `liveApiService.ts`  
✅ **Testable**: UI can be tested without Gemini connection  
✅ **Swappable**: Replace Gemini with another model → `InterviewMode.tsx` unchanged  
✅ **Maintainable**: Clear responsibility boundaries  

### Services

**`services/geminiService.ts`** (Legacy - Video Mode)
- Uses `models/gemini-2.5-flash-live-preview`
- Interval-based frame/audio sending
- Session resumption with localStorage
- Summary completion detection

**`services/liveApiService.ts`** (NEW - Interview Mode) ✅
- Uses `models/gemini-2.5-flash-live-preview`
- **High-level orchestrator** for all Gemini functionality
- Manages WebSocket + streaming capture lifecycle
- Contains system instructions and response parsing
- Continuous streaming support
- Voice Activity Detection (VAD) enabled - threshold 0.5
- Real-time bidirectional communication
- Audio + video + text modalities
- Automatic turn-based responses

### Utilities

**`utils/videoMode.ts`** (Legacy)
- Interval-based capture every 5 seconds
- MediaRecorder stop/start pattern
- 12-point data collection cycles

**`utils/continuousStreaming.ts`** (NEW) ✅
- Continuous audio streaming via ScriptProcessorNode
- Video frames at 1 FPS
- PCM audio encoding (16-bit, 16kHz)
- Turn detection based
- Delegates to LiveApiService for data transmission

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set the `GEMINI_API_KEY` in `.env.local`:
   ```bash
   API_KEY=your_gemini_api_key_here
   ```

3. Run the app:
   ```bash
   npm run dev
   ```

4. Access at `https://localhost:5173` (HTTPS required for screen capture)

## Configuration

**Video Mode Settings** (`config.json`):
- `VIDEO_MODE_DATA_COLLECTION_INTERVAL_MS`: Interval between captures (5000ms default)
- `VIDEO_MODE_SETS_PER_MINUTE`: Data points before summary (12 default)
- `VIDEO_MODE_PROMPT`: System instructions for analysis

**Interview Mode Settings** (`services/liveApiService.ts`):
- **System Instruction**: Defined in `SYSTEM_INSTRUCTION` constant
- **Turn Detection**: Automatic via VAD (threshold: 0.5)
- **Video Frame Rate**: 1 FPS (configurable in `STREAMING_CONFIG`)
- **Audio Chunk Duration**: 100ms (configurable in `STREAMING_CONFIG`)
- **Response Format**: Structured TRANSCRIPT/REPLY format (parsed automatically)

### Changing Interview Mode Behavior

All Gemini-specific settings are in `services/liveApiService.ts`:

```typescript
// Change system instructions
const SYSTEM_INSTRUCTION = `Your new instructions here...`;

// Change streaming config
const STREAMING_CONFIG = {
  videoFrameRate: 2,  // Increase to 2 FPS
  audioChunkMs: 100,
};
```

**No changes needed in InterviewMode.tsx for prompt/behavior modifications!**

## How Interview Mode Works

1. **User clicks "Start Analysis"** → InterviewMode.tsx handles screen capture
2. **LiveApiService.start() called** with mediaStream and callbacks
3. **Service orchestrates**:
   - Connects to Gemini Live API WebSocket
   - Initializes ContinuousStreamingCapture
   - Starts A/V streaming
4. **Continuous Streaming**: Audio and video stream to model
5. **Voice Activity Detection**: Model detects when speaker stops talking
6. **Response Parsing**: Service extracts TRANSCRIPT and REPLY sections
7. **Clean Callbacks**: UI receives simple data updates
8. **Stop**: Service handles all cleanup

### UI Layout

**Left Side**:
- Control Panel (Start/Stop)
- Screen Preview (250px height)
- Interviewer Transcript (300px height)

**Right Side**:
- AI-Generated Replies (full height, flex-grow)

**Debug Logs**: Output to browser DevTools console
- Open DevTools (F12) to see logs
- Color-coded by level: Errors (red), Warnings (yellow), Success (green)
- Includes timestamps and emoji indicators

## API Models

- **Lecture Mode**: `gemini-2.5-flash-live-preview`
- **Interview Mode**: `gemini-2.5-flash-live-preview` (with VAD enabled)

## Current Status

**Interview Mode**: ✅ Fully functional with clean architecture
- Voice Activity Detection working
- Model responds automatically after each turn
- Full analysis responses enabled
- Clean separation: UI vs Gemini logic
- Debug logs in DevTools console (F12)

## Implementation Notes

### Why Two Approaches?

**Video Mode (Interval-based)**:
- Built before understanding proper Live API streaming
- Works but not optimal for real-time interaction
- Good for periodic analysis with summaries

**Interview Mode (Continuous streaming)**:
- Proper Live API implementation with turn detection
- Based on Google's cookbook examples
- Better for conversational AI
- Lower latency, more natural interaction
- Automatic turn-based responses

### Key Differences

| Feature | Video Mode | Interview Mode |
|---------|-----------|----------------|
| Audio | Discrete 5s chunks | Continuous stream |
| Video | Every 5 seconds | 1 FPS continuous |
| API Method | Manual intervals | Turn detection (VAD) |
| Response Trigger | Manual prompts | Automatic (turn complete) |
| Latency | ~5-10s | <1s |
| Use Case | Lecture analysis | Real-time conversation |

## References

- [Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [Google Gemini Cookbook](https://github.com/google-gemini/cookbook)
- [Live API Python Example](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LiveAPI.py)

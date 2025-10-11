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

### Services

**`services/geminiService.ts`** (Legacy - Video Mode)
- Uses `models/gemini-2.5-flash-live-preview`
- Interval-based frame/audio sending
- Session resumption with localStorage
- Summary completion detection

**`services/liveApiService.ts`** (NEW - Interview Mode) ✅
- Uses `models/gemini-2.5-flash-live-preview`
- Continuous streaming support
- **Voice Activity Detection (VAD) enabled** - threshold 0.5
- Real-time bidirectional communication
- Audio + video + text modalities
- Proper `sendRealtimeInput()` usage
- Automatic turn-based responses (no manual prompts)

### Utilities

**`utils/videoMode.ts`** (Legacy)
- Interval-based capture every 5 seconds
- MediaRecorder stop/start pattern
- 12-point data collection cycles

**`utils/continuousStreaming.ts`** (NEW) ✅
- Continuous audio streaming via ScriptProcessorNode
- Video frames at 1 FPS
- PCM audio encoding (16-bit, 16kHz)
- **Turn detection based** - No more 60-second summary timers
- Model responds automatically when speaker finishes

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

**Interview Mode Settings** (In code):
- **Turn Detection**: Automatic via Voice Activity Detection (VAD threshold: 0.5)
- **Video Frame Rate**: 1 FPS
- **Response Style**: Full analysis after every turn (Option A)
- **System Instruction**: Responds to everything speaker says with substantive insights

## How Interview Mode Works

1. **Continuous Streaming**: Audio and video stream continuously to the model
2. **Voice Activity Detection**: Model detects when speaker stops talking
3. **Live Transcription**: Speaker's words appear in real-time in the Interviewer Transcript section
4. **Streaming AI Responses**: AI replies appear word-by-word as they're generated in the AI-Generated Replies section
5. **Turn Complete Event**: Triggers automatic response generation
6. **Full Analysis**: Model provides thorough answer/observation for every turn
7. **No Manual Prompts**: No 60-second timers or manual summary requests

### UI Layout

**Left Side**:
- Control Panel (Start/Stop)
- Screen Preview (250px height)
- Interviewer Transcript (300px height)

**Right Side**:
- AI-Generated Replies (full height, flex-grow)

**Debug Logs**: Now output to browser DevTools console instead of UI
- Open DevTools (F12) to see logs
- Color-coded by level: Errors (red), Warnings (yellow), Success (green)
- Includes timestamps and emoji indicators (❌ ⚠️ ✓)
- Freed up screen space for larger AI replies section

## API Models

- **Lecture Mode**: `gemini-2.5-flash-live-preview`
- **Interview Mode**: `gemini-2.5-flash-live-preview` (with VAD enabled)

## Current Status

**Interview Mode**: ✅ Fully functional with turn detection
- Voice Activity Detection working
- Model responds automatically after each turn
- Full analysis responses enabled
- Removed manual 60-second summary timer
- Response interruptions are normal behavior (model prioritizes new input)
- Debug logs now in DevTools console (F12) instead of UI

## Implementation Notes

### Why Two Approaches?

**Video Mode (Interval-based)**:
- Built before understanding proper Live API streaming
- Works but not optimal for real-time interaction
- Good for periodic analysis with summaries

**Interview Mode (Continuous streaming)**:
- Proper Live API implementation with turn detection
- Based on [Google's cookbook examples](https://github.com/google-gemini/cookbook)
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

### Turn Detection Behavior

**Option A (Current)**: Model responds to EVERYTHING
- Speaker: "Tell me about your background"
- Model: [Full detailed answer]
- Speaker: "That's interesting"
- Model: [Full response acknowledging and elaborating]

The model provides full, thoughtful analysis after every detected turn, even for brief comments.

## References

- [Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [Google Gemini Cookbook](https://github.com/google-gemini/cookbook)
- [Live API Python Example](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LiveAPI.py)

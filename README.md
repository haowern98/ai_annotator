# Live Lecture Summarizer

Real-time lecture analysis and interview assistance tool built with Electron, React, TypeScript, and Gemini Live API.

## Overview

A desktop application for capturing, transcribing, and summarizing lectures and interviews with real-time AI analysis. Features dual-mode operation with persistent storage and Markdown-formatted outputs.

## Features

### Lecture Mode
- **Dual-Session Architecture**: Parallel transcription and summarization
  - Session 1: Real-time audio transcription with timestamps
  - Session 2: Video frame analysis with topic-based summaries
- **Interval-Based Capture**: 2-second video frames, continuous audio streaming
- **Smart Summaries**: 1-minute topic-based summaries with Markdown formatting
- **Persistent Storage**: JSON recordings with full playback support
- **History Management**: Browse, search, and replay past lectures
- **Video Sync**: Transcript highlighting synchronized with video playback

### Interview Mode
- **Continuous Streaming**: Real-time audio/video streaming with VAD
- **Turn-Based Responses**: Automatic AI replies after speaker finishes
- **Real-Time Transcription**: Live interviewer speech-to-text
- **AI Analysis**: Contextual responses with Markdown formatting
- **Bidirectional Communication**: Natural conversational flow
- **Low Latency**: <1s response time with WebSocket streaming

## Architecture

### Technology Stack
- **Frontend**: React 19 + TypeScript + TailwindCSS
- **Desktop**: Electron 39 (main + renderer + preload processes)
- **AI/ML**: Google Gemini Live API (gemini-2.5-flash-live-preview)
- **Audio Processing**: Web Audio API with AudioWorklet
- **Video Capture**: MediaStream API with Canvas rendering
- **Build Tool**: Vite 6 with electron-builder

### Core Architecture

**Lecture Mode - Dual-Session Manager** (`services/lectureDualSessionManager.ts`):
- **Session 1 (Transcription)**: Audio-only → Real-time transcripts with timestamps
- **Session 2 (Summarization)**: Video frames + transcript text → Topic summaries
- Smart buffer management with 250-char threshold
- 1-minute summary windows with topic detection
- Transcript forwarding between sessions
- Export to JSON with full metadata

**Interview Mode - Continuous Streaming** (`services/liveApiService.ts`):
- WebSocket connection to Gemini Live API
- Voice Activity Detection (VAD threshold: 0.5)
- Continuous audio streaming (16kHz PCM)
- Video frames at 1 FPS
- Turn-based response parsing
- Session resumption support

**UI Components**:
- `LectureHome.tsx`: Recording interface with dual sessions
- `InterviewHome.tsx`: Real-time interview interface
- `LectureDetails.tsx`: Playback UI with Markdown rendering
- `HistoryHome.tsx`: Saved recordings browser
- `MarkdownRenderer`: Syntax-highlighted code blocks with copy buttons

**Streaming Utilities**:
- `utils/continuousStreaming.ts`: A/V capture for Interview Mode
- `public/audio-processor.js`: AudioWorklet for 16kHz PCM processing

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
### Key Features

**Markdown Rendering**:
- Bold (`**text**`), italic (`*text*`), inline code (`` `code` ``)
- Code blocks with syntax highlighting (uses `react-syntax-highlighter`)
- Headers (`###`), bullet points, line breaks
- Copy-to-clipboard buttons on code blocks
- OneDark theme for consistent styling

**Timestamp Synchronization**:
- Video playback with transcript highlighting
- Auto-scroll to active transcript entry
- Click transcript to seek video position
- Supports `[MM:SS]` and `M:SS` formats

**Session Management**:
- Auto-reconnection with exponential backoff (max 3 attempts)
- Audio buffering during disconnections (200-chunk buffer)
- Session handle persistence for resumption
- Graceful error recovery

**Data Export**:
- JSON format with full metadata
- Timestamp-aligned transcripts
- Markdown-formatted summaries
- Video source information
- Recording duration and date
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
## Installation & Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Gemini API key ([Get one here](https://aistudio.google.com/app/apikey))

### Development Mode

1. **Clone and install**:
   ```bash
   git clone https://github.com/haowern98/ai_annotator.git
   cd ai_annotator
   npm install
   ```

2. **Configure API key** (create `.env.local`):
   ```bash
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

## Configuration

### Lecture Mode Settings

**Dual Session Manager** (`services/lectureDualSessionManager.ts`):
```typescript
// Summary window timing
SUMMARY_WINDOW_MS: 60000  // 1-minute summaries (TODO: increase to 300000 for 5-min)

// Smart buffer flush
FLUSH_CHECK_START_CHARS: 250  // Start checking for flush
FLUSH_FORCE_CHARS: 350        // Force flush threshold

// System instructions
TRANSCRIPT_SYSTEM_INSTRUCTION  // Transcription prompt
SUMMARY_SYSTEM_INSTRUCTION     // Summarization prompt with Markdown rules
```

**Video Capture** (`config.json`):
```json
{
  "VIDEO_MODE_DATA_COLLECTION_INTERVAL_MS": 2000,  // Frame capture interval
  "VIDEO_MODE_PROMPT": "System instructions..."
}
```

## Usage

### Lecture Mode

1. **Start Recording**:
   - Select "Lecture Mode" from sidebar
   - Choose screen/window to capture
   - Click "Start Recording"

2. **During Recording**:
   - Real-time transcripts appear in left panel
   - Topic summaries generate every 1 minute in right panel
   - Video preview shows captured content
   - Status indicators show connection health

3. **Stop Recording**:
   - Click "Stop Recording"
   - Final summary generated automatically
   - Recording saved to `recordings/` folder as JSON

4. **Playback**:
   - Navigate to "History" in sidebar
   - Click on any saved lecture
   - Use video controls and transcript navigation
   - Click transcript entries to seek video
   - Copy summaries with Markdown formatting

### Interview Mode

## Technical Details

### Gemini Live API

Both modes use `gemini-2.5-flash-live-preview` model:
- **WebSocket connection** for bidirectional streaming
- **Multimodal inputs**: Audio (16kHz PCM) + Video (base64 JPEG) + Text
- **Voice Activity Detection**: Threshold 0.5 for turn detection
- **Session resumption**: Maintains context across reconnections
- **Response streaming**: Partial and final responses

### Audio Processing

**AudioWorklet Pipeline**:
1. Browser captures microphone at native sample rate
2. AudioWorklet downsamples to 16kHz mono
3. Processes in 100ms chunks (1600 samples)
4. Encodes to PCM base64 format
5. Sends to Gemini Live API

**Configuration**:
- Sample rate: 16kHz
- Channels: Mono
- Bit depth: 16-bit
- Format: PCM (uncompressed)
- MIME type: `audio/pcm;rate=16000`

### Video Processing

**Canvas-based Capture**:
1. MediaStream from screen/window capture
2. Draw to canvas at specified FPS
3. Export as JPEG (quality: 0.8)
4. Encode to base64
5. Send to Gemini Live API

**Configuration**:
- Lecture Mode: 2-second intervals (~0.5 FPS)
- Interview Mode: 1 FPS continuous
- Format: JPEG
- MIME type: `image/jpeg`

### Data Storage

**JSON Recording Format**:
```json
{
  "date": "2024-12-09T10:30:00.000Z",
  "duration": 1234567,
  "videoSource": "Screen 1",
  "transcripts": [
    {
      "timestamp": "[10:30]",
      "timestampMs": 630000,
      "text": "Transcript content...",
      "isFinal": true
    }
  ],
  "summaries": [
    {
## Known Issues & Limitations

### Timestamp Accuracy
- **Issue**: Lecture mode transcripts may lag 3-5 seconds behind video
- **Cause**: Gemini Live API processing latency
- **Workaround**: Timestamps capture when transcript appears, not when speech occurred
- **Future Fix**: Planned integration with NVIDIA Parakeet-TDT-0.6B for word-level timestamps (~200-400ms latency)

### Session Limits
- WebSocket timeout: ~10 minutes of inactivity
- Max transcript before auto-reset: 300 characters
- Max reconnection attempts: 3 (exponential backoff)

### Browser Compatibility
- Chrome/Edge: Full support
- Firefox: Limited MediaStream support
- Safari: Not tested

### Platform-Specific
- **Windows**: Full support with native screen picker
- **macOS**: Requires screen recording permissions
- **Linux**: Wayland may have capture issues

## Troubleshooting

### API Connection Issues
1. Verify `.env.local` has valid `GEMINI_API_KEY`
2. Check DevTools console (F12) for error messages
3. Ensure internet connectivity
4. Try regenerating API key

### Screen Capture Not Working
1. Grant screen recording permissions (Settings → Privacy)
2. Use Chrome/Edge browser (better MediaStream support)
3. Try selecting different window/screen
4. Restart application

### Audio Not Capturing
1. Check microphone permissions in browser
2. Verify AudioWorklet loaded (`public/audio-processor.js`)
3. Test microphone in browser settings
4. Check DevTools for AudioContext errors

### Build Failures
1. Clear caches: `npm run clean` (if available) or delete `dist/`, `node_modules/`
2. Reinstall: `npm install`
3. Check Node.js version (18+)
4. Review electron-builder logs

## Future Roadmap

- [ ] **Parakeet ASR Integration**: Replace Gemini Session 1 with NVIDIA Parakeet-TDT-0.6B for accurate word-level timestamps
- [ ] **Python Server**: Bundle FastAPI server with PyInstaller for standalone Parakeet inference
- [ ] **5-Minute Summaries**: Increase summary window from 1 to 5 minutes
- [ ] **Export Formats**: PDF, DOCX, and TXT export options
- [ ] **Cloud Sync**: Optional cloud storage for recordings
- [ ] **Multi-Language**: Support for non-English transcription
- [ ] **Custom Models**: Pluggable ASR/LLM backends

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

[Add your license here]

## References

- [Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [Google Gemini Cookbook](https://github.com/google-gemini/cookbook)
- [NVIDIA Parakeet Models](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
- [Electron Documentation](https://www.electronjs.org/docs/latest/)
- [React Syntax Highlighter](https://github.com/react-syntax-highlighter/react-syntax-highlighter)

## Customization

### Changing App Logo

1. Replace `logohi.svg` with your logo
2. Run conversion script:
   ```bash
   node convert-logo.js
   npx png-to-ico build/icon-256.png > build/icon.ico
   ```
3. Restart: `npm run electron:dev`

**Generated files**: `build/icon.png`, `build/icon.ico`, `public/icon.png`

### Modifying System Prompts

**Lecture Mode**: Edit `SUMMARY_SYSTEM_INSTRUCTION` in `services/lectureDualSessionManager.ts`
**Interview Mode**: Edit `SYSTEM_INSTRUCTION` in `services/liveApiService.ts`

No UI changes needed - all prompt engineering in service layer!
- **Interview Mode**: `gemini-2.5-flash-live-preview` (with VAD enabled)

## Current Status

**Interview Mode**: Fully functional with clean architecture
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

## Changing the App Logo

To update the application icon:

1. **Replace the SVG file** with your new logo:
   ```
   logohi.svg
   ```

2. **Run the conversion script** to generate all icon sizes:
   ```bash
   node convert-logo.js
   npx png-to-ico build/icon-256.png > build/icon.ico
   ```

3. **Restart the app**:
   ```bash
   npm run electron:dev
   ```

### Generated Icon Files

| File | Purpose |
|------|---------|
| `public/icon.png` | Runtime taskbar icon |
| `build/icon.png` | Linux builds |
| `build/icon.ico` | Windows builds |
| `build/icon.icns` | Mac builds (requires separate tool) |

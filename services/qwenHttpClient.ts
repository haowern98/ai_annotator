/**
 * qwenHttpClient.ts
 * HTTP client for qwen_worker video analysis service
 * Replaces Gemini Live API in lecture mode
 */

export interface QwenTranscript {
  start_time: number;
  end_time: number;
  text: string;
}

export interface QwenScene {
  scene_id: number;
  start_frame: number;
  end_frame: number;
  start_time: number;
  end_time: number;
  keyframes: number[];
  content_type: string;
  description: string;
  artifacts: {
    code_blocks?: Array<{
      language: string;
      code: string;
      confidence: number;
    }>;
    tables?: Array<{
      content: string;
      format: string;
    }>;
    diagrams?: Array<{
      type: string;
      description: string;
    }>;
  };
}

export interface QwenAnalysisResponse {
  status: 'success' | 'error';
  message?: string;
  video_path?: string;
  analysis?: {
    scenes: QwenScene[];
    processing_time: number;
    model_info: {
      model_name: string;
      engine: string;
      inference_time: number;
    };
  };
}

// Sequential analysis response (Phase 1)
export interface QwenBatchResult {
  batch_id: number;
  time_start: number;
  time_end: number;
  topic: string;
  content_type: string;
  description: string;
  has_structured_content: boolean;
  structured_hints: string[];
  is_topic_complete: boolean;
  is_same_topic?: boolean;
  inference_time: number;
  tokens_estimate: {
    prompt: number;
    completion: number;
  };
  window_label?: string;
}

export interface QwenSequentialResponse {
  status: 'success' | 'error';
  message?: string;
  analysis?: {
    batches: QwenBatchResult[];
    total_batches: number;
    total_frames: number;
    processing_time: number;
    next_context?: Record<string, any> | null;
    tokens_total: {
      prompt: number;
      completion: number;
      total: number;
    };
    model_info: {
      model_name: string;
      engine: string;
    };
  };
}

export interface QwenTopicsSummaryResponse {
  status: 'success' | 'error';
  summary_markdown?: string;
  message?: string;
}

export interface QwenClientCallbacks {
  onReady?: () => void;
  onError?: (message: string) => void;
  onProgress?: (message: string) => void;
}

export class QwenHttpClient {
  private baseUrl: string;
  private isConnectedFlag: boolean = false;
  private callbacks: QwenClientCallbacks | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(baseUrl: string = 'http://127.0.0.1:7556') {
    this.baseUrl = baseUrl;
  }

  /**
   * Initialize connection and check if qwen_worker is ready
   */
  async connect(callbacks?: QwenClientCallbacks): Promise<void> {
    this.callbacks = callbacks || null;
    
    try {
      // Health check
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.status === 'healthy') {
        this.isConnectedFlag = true;
        this.callbacks?.onReady?.();
        this.startHealthCheck();
      } else {
        throw new Error('Service not healthy');
      }
    } catch (error) {
      this.isConnectedFlag = false;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks?.onError?.(`Failed to connect to qwen_worker: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Send video analysis request
   * @param videoBlob - Video file as Blob
   * @param transcripts - Array of transcript segments
   * @param systemPrompt - Optional system prompt override
   */
  async sendAnalysisRequest(
    videoBlob: Blob,
    transcripts: QwenTranscript[],
    systemPrompt?: string
  ): Promise<QwenAnalysisResponse> {
    if (!this.isConnectedFlag) {
      throw new Error('Not connected to qwen_worker');
    }

    try {
      this.callbacks?.onProgress?.('Preparing video data...');

      // Determine file extension based on MIME type
      const mimeType = videoBlob.type;
      let extension = 'webm'; // Default
      if (mimeType.includes('mp4')) {
        extension = 'mp4';
      } else if (mimeType.includes('webm')) {
        extension = 'webm';
      }

      // Create FormData
      const formData = new FormData();
      formData.append('video_file', videoBlob, `lecture_segment.${extension}`);
      formData.append('transcripts_json', JSON.stringify(transcripts));
      
      if (systemPrompt) {
        formData.append('system_prompt', systemPrompt);
      }

      this.callbacks?.onProgress?.('Sending request to qwen_worker...');

      // Send POST request
      const response = await fetch(`${this.baseUrl}/api/v1/analyze`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Analysis failed (${response.status}): ${errorText}`);
      }

      const result: QwenAnalysisResponse = await response.json();

      if (result.status === 'error') {
        throw new Error(result.message || 'Analysis failed');
      }

      this.callbacks?.onProgress?.('Analysis complete');
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks?.onError?.(`Analysis request failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Send keyframes analysis request (NEW - uses pre-extracted keyframes)
   * @param scenes - Scenes with keyframes from keyframe_worker
   * @param transcripts - Array of transcript segments
   * @param systemPrompt - Optional system prompt override
   */
  async sendKeyframesRequest(
    scenes: any[], // SceneWithKeyframes from keyframe_worker
    transcripts: QwenTranscript[],
    systemPrompt?: string
  ): Promise<QwenAnalysisResponse> {
    if (!this.isConnectedFlag) {
      throw new Error('Not connected to qwen_worker');
    }

    try {
      this.callbacks?.onProgress?.('Preparing keyframe data...');

      // Create FormData with keyframes as images
      const formData = new FormData();
      
      // Add scene metadata and keyframes
      const sceneMetadata = scenes.map(scene => ({
        scene_id: scene.scene_id,
        start_time: scene.start_time,
        end_time: scene.end_time,
        duration: scene.duration,
        keyframe_times: scene.keyframes.map((kf: any) => kf.time),
      }));

      formData.append('scenes_metadata', JSON.stringify(sceneMetadata));
      formData.append('transcripts_json', JSON.stringify(transcripts));
      
      if (systemPrompt) {
        formData.append('system_prompt', systemPrompt);
      }

      // Add each keyframe as a separate image file
      let keyframeIndex = 0;
      for (const scene of scenes) {
        for (const keyframe of scene.keyframes) {
          // Convert base64 to Blob
          const base64Data = keyframe.image_base64;
          const byteCharacters = atob(base64Data);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: 'image/jpeg' });
          
          formData.append('keyframes', blob, `keyframe_${keyframeIndex}.jpg`);
          keyframeIndex++;
        }
      }

      this.callbacks?.onProgress?.(`Analyzing ${keyframeIndex} keyframes with VLM...`);

      // Send POST request
      const response = await fetch(`${this.baseUrl}/api/v1/analyze_keyframes`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Analysis failed (${response.status}): ${errorText}`);
      }

      const result: QwenAnalysisResponse = await response.json();

      if (result.status === 'error') {
        throw new Error(result.message || 'Analysis failed');
      }

      this.callbacks?.onProgress?.('Analysis complete');
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks?.onError?.(`Keyframe analysis request failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Send sequential frame analysis request (Phase 1)
   * @param frames - Array of {timestamp_ms, image_base64}
   * @param transcripts - Array of transcript segments (both final and in-progress)
   * @param config - Configuration options
   */
  async sendSequentialAnalysisRequest(
    frames: Array<{ timestamp_ms: number; image_base64: string }>,
    transcripts: Array<{ start: number; end: number; text: string; is_final: boolean }>,
    config: {
      batch_size?: number;
      duration_seconds?: number;
      previous_context?: Record<string, any> | null;
    } = {}
  ): Promise<QwenSequentialResponse> {
    if (!this.isConnectedFlag) {
      throw new Error('Not connected to qwen_worker');
    }

    try {
      const startMs = Date.now();
      const batchSize = config.batch_size || 5;
      const durationSeconds = config.duration_seconds || 120;

      this.callbacks?.onProgress?.(
        `Sequential analysis: preparing payload (${frames.length} frames, ${transcripts.length} transcripts, batch_size=${batchSize})`
      );

      // Create FormData
      const formData = new FormData();
      formData.append('frames_json', JSON.stringify(frames));
      formData.append('transcripts_json', JSON.stringify(transcripts));
      if (config.previous_context) {
        formData.append('previous_context_json', JSON.stringify(config.previous_context));
      }
      formData.append('config_json', JSON.stringify({
        batch_size: batchSize,
        duration_seconds: durationSeconds
      }));

      const url = `${this.baseUrl}/api/v1/analyze_sequential`;
      this.callbacks?.onProgress?.(`Sequential analysis: POST ${url}`);

      const controller = new AbortController();
      const requestTimeoutMs = Number((import.meta as any).env?.VITE_QWEN_REQUEST_TIMEOUT_MS || 600000); // 10 min default
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

      let tickId: number | null = null;
      const startedAt = Date.now();
      tickId = window.setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        this.callbacks?.onProgress?.(`Sequential analysis: waiting for response… (${elapsedSec}s)`);
      }, 5000);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        if (tickId) window.clearInterval(tickId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Sequential analysis failed (${response.status}): ${errorText}`);
      }

      const result: QwenSequentialResponse = await response.json();

      if (result.status === 'error') {
        throw new Error(result.message || 'Analysis failed');
      }

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const batches = result.analysis?.batches?.length ?? 0;
      this.callbacks?.onProgress?.(`Sequential analysis complete (${elapsed}s, ${batches} batch(es))`);
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks?.onError?.(`Sequential analysis request failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Disconnect and cleanup
   */
  disconnect(): void {
    this.stopHealthCheck();
    this.isConnectedFlag = false;
    this.callbacks = null;
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    // Check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        
        if (!response.ok) {
          throw new Error('Health check failed');
        }
        
        const data = await response.json();
        if (data.status !== 'healthy') {
          throw new Error('Service unhealthy');
        }
      } catch (error) {
        console.error('[QwenHttpClient] Health check failed:', error);
        this.isConnectedFlag = false;
        this.callbacks?.onError?.('Lost connection to qwen_worker');
        this.stopHealthCheck();
      }
    }, 30000);
  }

  /**
   * Stop health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Analyze uploaded video in 60-second windows (batch processing)
   * Reads transcripts from file, processes frames in batches of 5
   * Isolated from live session processing
   */
  async analyzeUploadedVideoWindows(
    frames: Array<{ timestamp_ms: number; image_base64: string }>,
    transcriptPath: string,
    onWindowProgress?: (window: number, totalWindows: number) => void
  ): Promise<QwenBatchResult[]> {
    if (!this.isConnectedFlag) {
      throw new Error('Not connected to qwen_worker');
    }

    // Read transcripts from file using Electron API
    let allTranscripts: Array<{ start: number; end: number; text: string; is_final: boolean }>;
    
    try {
      if (!window.electronAPI || !window.electronAPI.readFile) {
        throw new Error('Electron API not available');
      }

      const transcriptJson = await window.electronAPI.readFile(transcriptPath);
      allTranscripts = JSON.parse(transcriptJson);
    } catch (error) {
      throw new Error(`Failed to read transcript file: ${error}`);
    }

    // Process in 5-frame batches to minimize VRAM pressure.
    // Frames are 1 FPS in upload mode, so 5 frames ~= 5 seconds.
    const WINDOW_SIZE = 5;
    const totalWindows = Math.ceil(frames.length / WINDOW_SIZE);
    const allResults: QwenBatchResult[] = [];
    let rollingContext: Record<string, any> | null = null;

    for (let windowIndex = 0; windowIndex < totalWindows; windowIndex++) {
      const windowStart = windowIndex * WINDOW_SIZE;
      const windowEnd = Math.min(windowStart + WINDOW_SIZE, frames.length);
      const windowFrames = frames.slice(windowStart, windowEnd);

      // Get transcripts for this time window
      const windowStartTime = windowStart; // seconds
      const windowEndTime = windowEnd; // seconds
      
      const windowTranscripts = allTranscripts.filter((t) => {
        // Include transcripts that overlap with this window
        return t.end >= windowStartTime && t.start < windowEndTime;
      });

      this.callbacks?.onProgress?.(
        `VLM batch ${windowIndex + 1}/${totalWindows}: select inputs (${windowFrames.length} frames, ${windowTranscripts.length} transcripts)`
      );

      // Send to qwen_worker for analysis
      this.callbacks?.onProgress?.(`VLM batch ${windowIndex + 1}/${totalWindows}: request sequential analysis`);
      const result = await this.sendSequentialAnalysisRequest(
        windowFrames,
        windowTranscripts,
        { batch_size: 5, duration_seconds: windowFrames.length, previous_context: rollingContext }
      );

      if (result.analysis && result.analysis.batches) {
        allResults.push(...result.analysis.batches);
      }
      rollingContext = (result.analysis?.next_context as any) || rollingContext;

      if (onWindowProgress) {
        onWindowProgress(windowIndex + 1, totalWindows);
      }
    }

    // Reduce step: summarize topics in 3-minute windows
    try {
      const WINDOW_SIZE_SECONDS = 180; // 3 minutes
      const maxTime = allResults.length > 0 
        ? Math.max(...allResults.map(b => b.time_end))
        : 0;
      
      const numWindows = Math.ceil(maxTime / WINDOW_SIZE_SECONDS);
      let previousTopicTitles: string[] = [];
      
      for (let i = 0; i < numWindows; i++) {
        const windowStart = i * WINDOW_SIZE_SECONDS;
        const windowEnd = (i + 1) * WINDOW_SIZE_SECONDS;
        
        // Filter batches in this time window
        const batchesInWindow = allResults.filter(b => 
          b.time_start >= windowStart && b.time_start < windowEnd
        );
        
        if (batchesInWindow.length === 0) continue;
        
        const formatTime = (sec: number) => {
          const min = Math.floor(sec / 60);
          const s = sec % 60;
          return `${min}:${s.toString().padStart(2, '0')}`;
        };
        
        this.callbacks?.onProgress?.(
          `[Upload Queue] Summarizing topics for ${formatTime(windowStart)}-${formatTime(windowEnd)}…`
        );
        
        if (previousTopicTitles.length) {
          const preview = previousTopicTitles.slice(0, 10).join(' | ');
          this.callbacks?.onProgress?.(
            `[Upload Queue] Reduce context: using previous topics (${previousTopicTitles.length}): ${preview}`
          );
        }

        const summary = await this.summarizeTopicsWithContext(batchesInWindow, previousTopicTitles);
        if (summary) {
          allResults.push({
            batch_id: allResults.length,
            time_start: windowStart,
            time_end: Math.min(windowEnd, maxTime),
            topic: `Topics (${formatTime(windowStart)}-${formatTime(windowEnd)})`,
            content_type: 'other',
            description: summary,
            has_structured_content: false,
            structured_hints: [],
            is_topic_complete: true,
            inference_time: 0,
            tokens_estimate: { prompt: 0, completion: 0 },
            window_label: `Topics: ${formatTime(windowStart)}-${formatTime(windowEnd)}`,
          });

          previousTopicTitles = this.extractTopicTitlesFromMarkdown(summary);
          if (previousTopicTitles.length) {
            const preview = previousTopicTitles.slice(0, 10).join(' | ');
            this.callbacks?.onProgress?.(`[Upload Queue] Reduce context for next window: ${preview}`);
          }
        }
      }
    } catch (e) {
      this.callbacks?.onProgress?.(`[Upload Queue] Reduce step skipped: ${e}`);
    }

    return allResults;
  }

  private async summarizeTopics(batches: QwenBatchResult[]): Promise<string | null> {
    return this.summarizeTopicsWithContext(batches, null);
  }

  private extractTopicTitlesFromMarkdown(markdown: string): string[] {
    const md = String(markdown || '').trim();
    if (!md) return [];

    const rawLines = md.split(/\r?\n/).map((l) => l.trim());
    const lines = rawLines.filter(Boolean);

    const titles: string[] = [];
    const seen = new Set<string>();

    const push = (t: string) => {
      const s = String(t || '').trim().replace(/\s+/g, ' ');
      if (!s) return;
      const key = s.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      titles.push(s);
    };

    // Prefer markdown headings first.
    for (const line of lines) {
      const m = line.match(/^#{2,6}\s+(.+?)\s*$/);
      if (!m) continue;
      const title = m[1].trim();
      if (!title) continue;
      if (title.toLowerCase() === 'topics') continue;
      push(title);
    }
    if (titles.length) return titles.slice(0, 12);

    // Fallback: treat standalone non-bullet lines as topic titles.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      if (!line) continue;
      if (lower === 'topics') continue;
      if (lower.startsWith('time ranges:')) continue;
      if (lower.startsWith('key points:')) continue;
      if (line.startsWith('-') || line.startsWith('*') || line.startsWith('•')) continue;
      if (line.startsWith('>') || line.startsWith('```') || line.startsWith('#')) continue;
      if (line.startsWith('[')) continue; // timestamp blocks like [00:10]-[00:15]
      if (line.length > 120) continue;
      if (line.endsWith(':')) continue;
      // Heuristic: likely a section title if previous line was blank (in raw markdown)
      const prevRaw = rawLines[i - 1] ?? '';
      if (i > 0 && prevRaw.trim() !== '') continue;
      push(line);
    }

    return titles.slice(0, 12);
  }

  private async summarizeTopicsWithContext(
    batches: QwenBatchResult[],
    previousTopicTitles: string[] | null
  ): Promise<string | null> {
    if (!this.isConnectedFlag) return null;
    if (!batches.length) return null;

    const url = `${this.baseUrl}/api/v1/summarize_topics`;
    const formData = new FormData();

    let requestBatches = batches;
    const titles = (previousTopicTitles || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (titles.length) {
      const contextBatch: QwenBatchResult = {
        batch_id: -1,
        time_start: 0,
        time_end: 0,
        topic: 'Previous window topics (context)',
        content_type: 'other',
        description: `Previous 3-minute window topic titles (may continue or change):\n${titles
          .slice(0, 12)
          .map((t) => `- ${t}`)
          .join('\n')}`,
        has_structured_content: false,
        structured_hints: [],
        is_topic_complete: true,
        inference_time: 0,
        tokens_estimate: { prompt: 0, completion: 0 },
        window_label: 'Context',
      };
      requestBatches = [contextBatch, ...batches];
    }

    formData.append('batches_json', JSON.stringify(requestBatches));

    const controller = new AbortController();
    const requestTimeoutMs = Number((import.meta as any).env?.VITE_QWEN_REQUEST_TIMEOUT_MS || 600000); // 10 min default
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const res = await fetch(url, { method: 'POST', body: formData, signal: controller.signal });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`summarize_topics failed (${res.status}): ${txt}`);
      }
      const data: QwenTopicsSummaryResponse = await res.json();
      if (data.status !== 'success') {
        throw new Error(data.message || 'summarize_topics error');
      }
      return data.summary_markdown || null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

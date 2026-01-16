/**
 * Upload Queue Manager
 * Manages batch processing of uploaded lecture videos
 * Isolated from live session code
 */

import { extractFramesAt1FPS, ExtractedFrame, ExtractionProgress } from '../utils/videoFrameExtractor';
import ParakeetBatchTranscriber from './parakeetBatchTranscriber';
import { QwenHttpClient, QwenBatchResult } from './qwenHttpClient';
import { LogLevel } from '../types';

export type VideoStatus =
  | 'pending'
  | 'extracting'
  | 'transcribing'
  | 'analyzing'
  | 'saving'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface QueuedVideo {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  status: VideoStatus;
  progress: {
    phase: string;
    percentage: number;
    currentStep: number;
    totalSteps: number;
  };
  result?: {
    frames: ExtractedFrame[];
    transcriptPath: string;
    batches: QwenBatchResult[];
  };
  error?: string;
  startTime?: number;
  endTime?: number;
}

export interface UploadQueueCallbacks {
  onQueueUpdate?: (queue: QueuedVideo[]) => void;
  onVideoComplete?: (video: QueuedVideo) => void;
  onVideoError?: (video: QueuedVideo, error: string) => void;
  onLog?: (message: string, level: LogLevel) => void;
}

export class UploadQueueManager {
  private queue: QueuedVideo[] = [];
  private callbacks: UploadQueueCallbacks;
  private isProcessing: boolean = false;
  private parakeetTranscriber: ParakeetBatchTranscriber;
  private qwenClient: QwenHttpClient;
  private liveSessionCheck: () => boolean;
  private currentVideoId: string | null = null;

  constructor(
    parakeetTranscriber: ParakeetBatchTranscriber,
    qwenClient: QwenHttpClient,
    liveSessionCheck: () => boolean,
    callbacks: UploadQueueCallbacks
  ) {
    this.parakeetTranscriber = parakeetTranscriber;
    this.qwenClient = qwenClient;
    this.liveSessionCheck = liveSessionCheck;
    this.callbacks = callbacks;
  }

  /**
   * Add video to queue
   */
  public addVideo(file: File): string {
    const videoId = `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const queuedVideo: QueuedVideo = {
      id: videoId,
      file,
      fileName: file.name,
      fileSize: file.size,
      status: 'pending',
      progress: {
        phase: 'Pending',
        percentage: 0,
        currentStep: 0,
        totalSteps: 4, // extraction, transcription, analysis, saving
      },
    };

    this.queue.push(queuedVideo);
    this.log(`Added to queue: ${file.name}`, LogLevel.INFO);
    this.notifyQueueUpdate();

    // Start processing if not already processing
    if (!this.isProcessing) {
      this.processQueue();
    }

    return videoId;
  }

  /**
   * Cancel specific video
   */
  public cancelVideo(videoId: string): void {
    const video = this.queue.find((v) => v.id === videoId);
    if (!video) return;

    if (video.status === 'pending') {
      video.status = 'cancelled';
      this.log(`Cancelled: ${video.fileName}`, LogLevel.WARN);
      this.notifyQueueUpdate();
    } else if (this.currentVideoId === videoId) {
      // Cancel current video and restart queue
      video.status = 'cancelled';
      this.currentVideoId = null;
      this.log(`Cancelled current video: ${video.fileName}`, LogLevel.WARN);
      this.notifyQueueUpdate();
      
      // Continue with next video
      setTimeout(() => this.processQueue(), 100);
    }
  }

  /**
   * Clear completed/error/cancelled videos
   */
  public clearCompleted(): void {
    this.queue = this.queue.filter(
      (v) => v.status !== 'complete' && v.status !== 'error' && v.status !== 'cancelled'
    );
    this.notifyQueueUpdate();
  }

  /**
   * Get current queue
   */
  public getQueue(): QueuedVideo[] {
    return [...this.queue];
  }

  /**
   * Process queue sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    // Check if live session is active
    if (this.liveSessionCheck()) {
      this.log('Live session active - pausing upload queue', LogLevel.WARN);
      this.isProcessing = false;
      return;
    }

    const nextVideo = this.queue.find((v) => v.status === 'pending');
    if (!nextVideo) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    this.currentVideoId = nextVideo.id;

    try {
      await this.processVideo(nextVideo);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      nextVideo.status = 'error';
      nextVideo.error = errorMsg;
      this.log(`Error processing ${nextVideo.fileName}: ${errorMsg}`, LogLevel.ERROR);
      this.callbacks.onVideoError?.(nextVideo, errorMsg);
    }

    this.currentVideoId = null;
    this.isProcessing = false;
    this.notifyQueueUpdate();

    // Process next video
    setTimeout(() => this.processQueue(), 500);
  }

  /**
   * Process single video
   */
  private async processVideo(video: QueuedVideo): Promise<void> {
    video.startTime = Date.now();

    // Check live session before each phase
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Phase 1: Extract frames
    this.log(`Extracting frames: ${video.fileName}`, LogLevel.INFO);
    video.status = 'extracting';
    video.progress.phase = 'Extracting frames';
    video.progress.currentStep = 1;
    this.notifyQueueUpdate();

    const frames = await extractFramesAt1FPS(video.file, (progress: ExtractionProgress) => {
      video.progress.percentage = Math.floor((progress.percentage / 3) * 100) / 100; // 0-33%
      this.notifyQueueUpdate();
    });

    this.log(`Extracted ${frames.length} frames from ${video.fileName}`, LogLevel.SUCCESS);

    // Check again
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Phase 2: Transcribe audio
    this.log(`Transcribing audio: ${video.fileName}`, LogLevel.INFO);
    video.status = 'transcribing';
    video.progress.phase = 'Transcribing audio';
    video.progress.currentStep = 2;
    video.progress.percentage = 33;
    this.notifyQueueUpdate();

    // Get userData path via Electron API
    let userDataPath: string;
    if (window.electronAPI && window.electronAPI.getUserDataPath) {
      userDataPath = await window.electronAPI.getUserDataPath();
    } else {
      throw new Error('Electron API not available');
    }

    const transcriptPath = `${userDataPath}/upload_transcripts_${video.id}.json`;

    await this.parakeetTranscriber.transcribeVideoToFile(
      video.file,
      transcriptPath,
      (transcriptCount) => {
        // Progress estimation: assume 1 transcript per 3 seconds
        const estimatedTotal = Math.floor((frames.length / 60) * 20);
        const percentage = 33 + Math.min(33, (transcriptCount / Math.max(estimatedTotal, 1)) * 33);
        video.progress.percentage = Math.floor(percentage * 100) / 100;
        this.notifyQueueUpdate();
      }
    );

    this.log(`Transcription complete: ${video.fileName}`, LogLevel.SUCCESS);

    // Check again
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Phase 3: Analyze with VLM
    this.log(`Analyzing with VLM: ${video.fileName}`, LogLevel.INFO);
    video.status = 'analyzing';
    video.progress.phase = 'Analyzing with VLM';
    video.progress.currentStep = 3;
    video.progress.percentage = 66;
    this.notifyQueueUpdate();

    const batches = await this.qwenClient.analyzeUploadedVideoWindows(
      frames,
      transcriptPath,
      (window, totalWindows) => {
        video.progress.phase = `Analyzing with VLM (${window}/${totalWindows})`;
        const percentage = 66 + ((window / totalWindows) * 34);
        video.progress.percentage = Math.floor(percentage * 100) / 100;
        this.notifyQueueUpdate();
      }
    );

    this.log(`Analysis complete: ${video.fileName} (${batches.length} batches)`, LogLevel.SUCCESS);

    // Save/conversion phase (only mark complete after WebM conversion finishes)
    video.status = 'saving';
    video.progress.currentStep = 4;
    video.progress.phase = 'Saving (converting to WebM)';
    video.progress.percentage = Math.max(video.progress.percentage, 90);
    this.notifyQueueUpdate();

    video.endTime = Date.now();
    video.result = { frames, transcriptPath, batches };

    await this.saveUploadToRecordings(video, transcriptPath, batches);

    video.status = 'complete';
    video.progress.percentage = 100;
    video.progress.phase = 'Complete';
    this.notifyQueueUpdate();
    this.callbacks.onVideoComplete?.(video);
  }

  /**
   * Save uploaded video results to recordings directory (same format as live recordings)
   */
  private async saveUploadToRecordings(
    video: QueuedVideo,
    transcriptPath: string,
    batches: any[]
  ): Promise<void> {
    try {
      this.log(`Saving ${video.fileName} to recordings...`, LogLevel.INFO);

      // Read transcripts from file
      const transcriptsJson = await window.electronAPI.readFile(transcriptPath);
      const transcriptsArray = JSON.parse(transcriptsJson);

      // Convert Parakeet format to metadata format
      const transcripts = transcriptsArray.map((t: any, index: number) => ({
        text: t.text || '',
        timestamp: this.formatTimestamp(((t.start ?? index) as number) * 1000),
        timestampMs: ((t.start ?? index) as number) * 1000
      }));

      // Convert QwenBatchResult to summaries format
      const summaries = batches.map((batch: any) => ({
        text: batch.description || '', // QwenBatchResult has 'description' field
        windowLabel:
          batch.window_label ||
          (Number.isFinite(batch.time_start) && Number.isFinite(batch.time_end)
            ? `${this.formatTimestamp(batch.time_start * 1000)}-${this.formatTimestamp(batch.time_end * 1000)}`
            : `Window ${batch.batch_id}`),
      }));

      // Calculate duration from video
      const duration = video.endTime! - video.startTime!;

      // Step 1: Save uploaded video to temp file
      this.log(`Converting ${video.fileName} to WebM...`, LogLevel.INFO);
      const userDataPath = await window.electronAPI.getUserDataPath();
      const tempVideoPath = `${userDataPath}/upload_video_${video.id}.mp4`;
      
      // Write video blob to temp file
      const arrayBuffer = await video.file.arrayBuffer();
      const videoBase64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      
      const saveResult = await window.electronAPI.writeBinary(tempVideoPath, videoBase64);
      if (!saveResult) {
        throw new Error('Failed to save temp video file');
      }

      // Step 2: Convert to WebM
      const convertResult = await window.electronAPI.convertVideoToWebM(tempVideoPath);
      if (!convertResult.success || !convertResult.outputPath) {
        throw new Error(`Video conversion failed: ${convertResult.error}`);
      }

      this.log(`Conversion complete: ${(convertResult.size! / 1024 / 1024).toFixed(2)}MB`, LogLevel.SUCCESS);

      // Step 3: Read converted WebM file
      const webmBase64 = await window.electronAPI.readBinary(convertResult.outputPath);
      const webmBinary = atob(webmBase64);
      const webmBytes = new Uint8Array(webmBinary.length);
      for (let i = 0; i < webmBinary.length; i++) {
        webmBytes[i] = webmBinary.charCodeAt(i);
      }

      // Prepare metadata with video
      const metadata = {
        quality: 'original', // Mark as uploaded original quality
        duration,
        transcriptCount: transcripts.length,
        summaryCount: summaries.length,
        transcripts,
        summaries,
        uploadedFileName: video.fileName,
        uploadedFileSize: video.file.size,
        recordedMimeType: 'video/webm'
      };

      // Save via Electron IPC with video data
      const result = await window.electronAPI.saveRecording(webmBytes.buffer, metadata);

      if (result.success) {
        this.log(`Saved to recordings: ${result.filename}`, LogLevel.SUCCESS);

        // Persist word-level timestamps next to the recording metadata (if available).
        try {
          const wordsPath = transcriptPath.replace(/\.json$/i, '_words.json');
          const wordsJson = await window.electronAPI.readFile(wordsPath);

          const metadataPath: string | undefined = result.metadataPath;
          if (metadataPath) {
            const dir = metadataPath.replace(/[\\/][^\\/]*$/, '');
            const outWordsPath = `${dir}/${result.filename}_words.json`;
            await window.electronAPI.writeFile(outWordsPath, wordsJson);

            // Update metadata file to reference words JSON.
            const metaRaw = await window.electronAPI.readFile(metadataPath);
            const metaObj = JSON.parse(metaRaw);
            metaObj.wordTimestampsFile = outWordsPath;
            await window.electronAPI.writeFile(metadataPath, JSON.stringify(metaObj, null, 2));
          }
        } catch (err) {
          this.log(`Word timestamps save warning: ${err}`, LogLevel.WARN);
        }
        
        // Cleanup temp files
        await window.electronAPI.deleteFile(transcriptPath);
        await window.electronAPI.deleteFile(transcriptPath.replace(/\.json$/i, '_words.json'));
        await window.electronAPI.deleteFile(tempVideoPath);
        await window.electronAPI.deleteFile(convertResult.outputPath);
      } else {
        throw new Error(`Failed to save to recordings: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error saving to recordings: ${errorMsg}`, LogLevel.ERROR);
      throw error;
    }
  }

  /**
   * Format milliseconds as [MM:SS]
   */
  private formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
  }

  /**
   * Notify callbacks of queue update
   */
  private notifyQueueUpdate(): void {
    this.callbacks.onQueueUpdate?.(this.getQueue());
  }

  /**
   * Log helper
   */
  private log(message: string, level: LogLevel): void {
    this.callbacks.onLog?.(message, level);
  }

  /**
   * Check if queue is currently processing
   */
  public isActive(): boolean {
    return this.isProcessing;
  }

  /**
   * Get queue statistics
   */
  public getStats() {
    return {
      total: this.queue.length,
      pending: this.queue.filter((v) => v.status === 'pending').length,
      processing: this.queue.filter((v) =>
        v.status === 'extracting' || v.status === 'transcribing' || v.status === 'analyzing'
      ).length,
      complete: this.queue.filter((v) => v.status === 'complete').length,
      error: this.queue.filter((v) => v.status === 'error').length,
      cancelled: this.queue.filter((v) => v.status === 'cancelled').length,
    };
  }
}

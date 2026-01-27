/**
 * Upload Queue Manager
 * Manages batch processing of uploaded lecture videos
 * Isolated from live session code
 */

import { extractFramesAt1FPS, ExtractedFrame, ExtractionProgress } from '../utils/videoFrameExtractor';
import ParakeetBatchTranscriber from './parakeetBatchTranscriber';
import { QwenHttpClient, QwenBatchResult } from './qwenHttpClient';
import { LogLevel } from '../types';

export type VideoInput = File | { path: string; size: number };

export type VideoStatus =
  | 'pending'
  | 'uploading'
  | 'downloading'
  | 'extracting'
  | 'transcribing'
  | 'analyzing'
  | 'saving'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface QueuedVideo {
  id: string;
  file: VideoInput;
  fileName: string;
  fileSize: number;
  status: VideoStatus;
  // If set, this queued item corresponds to a remote upload job (server mode),
  // and progress/completion will be reported via the inbox job APIs.
  remoteJobId?: string;
  // Cancellation flag (used during long-running phases)
  cancelRequested?: boolean;
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
  // Saved recording paths (after completion)
  recordingMetadataPath?: string;
  recordingVideoPath?: string;
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
  private remoteReportCache: Map<string, { phase: string; pct: number; at: number }> = new Map();

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
   * Add a local filesystem video path to queue (already on disk).
   * This avoids loading huge files into renderer memory.
   */
  public addVideoPath(filePath: string, displayName?: string, size?: number): string {
    const p = String(filePath || '').trim();
    if (!p) {
      throw new Error('Missing file path');
    }

    const videoId = `path_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fileSize = Number(size || 0);
    const fileName = String(displayName || p.split(/[\\/]/).pop() || 'video');

    const queuedVideo: QueuedVideo = {
      id: videoId,
      file: { path: p, size: fileSize },
      fileName,
      fileSize,
      status: 'pending',
      progress: {
        phase: 'Pending',
        percentage: 0,
        currentStep: 0,
        totalSteps: 4,
      },
    };

    this.queue.push(queuedVideo);
    this.log(`Added to queue: ${fileName}`, LogLevel.INFO);
    this.notifyQueueUpdate();

    if (!this.isProcessing) {
      this.processQueue();
    }

    return videoId;
  }

  /**
   * Add a local filesystem video path to queue with an associated remote job id.
   * Used on the server machine when receiving a remote upload.
   */
  public addVideoPathRemoteJob(
    filePath: string,
    displayName: string | undefined,
    size: number | undefined,
    jobId: string
  ): string {
    const id = this.addVideoPath(filePath, displayName, size);
    const video = this.queue.find((v) => v.id === id);
    if (video) {
      video.remoteJobId = String(jobId || '').trim() || undefined;
    }
    return id;
  }

  /**
   * Add a remote-upload placeholder item (client mode).
   * This tracks upload progress to the remote server but does not run local processing.
   */
  public addRemoteUpload(displayName: string, size?: number): string {
    const fileName = String(displayName || 'video');
    const fileSize = Number(size || 0);
    const videoId = `remote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const queuedVideo: QueuedVideo = {
      id: videoId,
      file: { path: '', size: fileSize },
      fileName,
      fileSize,
      status: 'uploading',
      progress: {
        phase: 'Uploading to remote server',
        percentage: 0,
        currentStep: 1,
        totalSteps: 1,
      },
      startTime: Date.now(),
    };

    this.queue.push(queuedVideo);
    this.notifyQueueUpdate();
    return videoId;
  }

  public updateRemoteUpload(
    videoId: string,
    progressPercent: number,
    sentBytes?: number,
    totalBytes?: number
  ): void {
    const video = this.queue.find((v) => v.id === videoId);
    if (!video) return;
    if (video.status !== 'uploading') return;

    const pct = Number(progressPercent || 0);
    video.progress.percentage = Math.max(0, Math.min(100, pct));
    if (typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0) {
      video.fileSize = totalBytes;
    }
    if (typeof sentBytes === 'number' && typeof totalBytes === 'number' && totalBytes > 0) {
      // Keep a bit more detail without changing UI structure.
      video.progress.phase = `Uploading to remote server (${Math.max(0, Math.min(100, Math.round((sentBytes / totalBytes) * 100)))}%)`;
    } else {
      video.progress.phase = 'Uploading to remote server';
    }
    this.notifyQueueUpdate();
  }

  public setRemoteProgress(videoId: string, phase: string, percentage?: number, fileSize?: number): void {
    const video = this.queue.find((v) => v.id === videoId);
    if (!video) return;
    if (video.status === 'error' || video.status === 'cancelled' || video.status === 'complete') return;

    video.status = 'uploading';
    video.progress.phase = String(phase || 'Working…');
    if (percentage !== undefined) {
      const pct = Number(percentage || 0);
      video.progress.percentage = Math.max(0, Math.min(100, pct));
    }
    if (fileSize !== undefined) {
      const sz = Number(fileSize || 0);
      if (Number.isFinite(sz) && sz > 0) video.fileSize = sz;
    }
    this.notifyQueueUpdate();
  }

  public completeRemoteUpload(videoId: string, finalPhase?: string): void {
    const video = this.queue.find((v) => v.id === videoId);
    if (!video) return;
    if (video.status !== 'uploading') return;

    video.status = 'complete';
    video.progress.percentage = 100;
    video.progress.phase = String(finalPhase || 'Upload complete (server processing)');
    video.endTime = Date.now();
    this.notifyQueueUpdate();
    this.callbacks.onVideoComplete?.(video);
  }

  public failRemoteUpload(videoId: string, error: string): void {
    const video = this.queue.find((v) => v.id === videoId);
    if (!video) return;

    video.status = 'error';
    video.error = String(error || 'Remote upload failed');
    video.endTime = Date.now();
    this.notifyQueueUpdate();
    this.callbacks.onVideoError?.(video, video.error);
  }

  /**
   * Add YouTube URL to queue (downloads first, then processes locally).
   * File upload path is unchanged.
   */
  public addYouTubeUrl(url: string): string {
    const videoId = `yt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const queuedVideo: QueuedVideo = {
      id: videoId,
      file: { path: '', size: 0 },
      fileName: 'YouTube download',
      fileSize: 0,
      status: 'downloading',
      progress: {
        phase: 'Downloading YouTube',
        percentage: 0,
        currentStep: 0,
        totalSteps: 4, // extraction, transcription, analysis, saving
      },
    };

    this.queue.push(queuedVideo);
    this.log(`Downloading YouTube URL: ${url}`, LogLevel.INFO);
    this.notifyQueueUpdate();

    const run = async () => {
      if (!window.electronAPI?.downloadYouTube) {
        throw new Error('YouTube downloader not available (Electron API)');
      }

      const res = await window.electronAPI.downloadYouTube(url, (p: any) => {
        if (queuedVideo.status !== 'downloading') return;
        if (p?.type === 'progress' && p.phase === 'downloading') {
          const pct = typeof p.percent === 'number' ? p.percent : null;
          if (pct !== null) queuedVideo.progress.percentage = Math.max(0, Math.min(99, pct));
          queuedVideo.progress.phase = 'Downloading YouTube';
          this.notifyQueueUpdate();
          return;
        }
        if (p?.type === 'stderr' || p?.type === 'log') {
          this.log(`[YouTube] ${p.message}`, LogLevel.INFO);
          return;
        }
        if (p?.type === 'error') {
          this.log(`[YouTube] ${p.message || p.detail}`, LogLevel.ERROR);
        }
      });

      if (!res?.success || !res.file_path) {
        throw new Error(res?.error || 'YouTube download failed');
      }

      queuedVideo.file = { path: res.file_path, size: Number(res.size || 0) };
       queuedVideo.fileName = String(res.title || res.file_name || 'youtube_video');
      queuedVideo.fileSize = Number(res.size || 0);
      queuedVideo.status = 'pending';
      queuedVideo.progress.phase = 'Pending';
      queuedVideo.progress.percentage = 0;
      this.log(`YouTube download complete: ${queuedVideo.fileName}`, LogLevel.SUCCESS);
      this.notifyQueueUpdate();

      if (!this.isProcessing) {
        this.processQueue();
      }
    };

    run().catch((e) => {
      queuedVideo.status = 'error';
      queuedVideo.error = e instanceof Error ? e.message : String(e);
      this.notifyQueueUpdate();
    });

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
      try {
        const jobId = String(nextVideo.remoteJobId || '').trim();
        if (jobId) {
          (window.electronAPI as any)?.errorInboxJob?.(jobId, errorMsg);
        }
      } catch {
        // ignore
      }
      this.reportRemoteJob(nextVideo);
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
    this.reportRemoteJob(video);

    // Check live session before each phase
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Check if video was cancelled
    if (video.cancelRequested) {
      throw new Error('Video cancelled by user');
    }

    // Phase 1: Extract frames
    this.log(`Extracting frames: ${video.fileName}`, LogLevel.INFO);
    video.status = 'extracting';
    video.progress.phase = 'Extracting frames';
    video.progress.currentStep = 1;
    this.notifyQueueUpdate();
    this.reportRemoteJob(video);

    const frames = await extractFramesAt1FPS(video.file, (progress: ExtractionProgress) => {
      video.progress.percentage = Math.floor((progress.percentage / 3) * 100) / 100; // 0-33%
      this.notifyQueueUpdate();
      this.reportRemoteJob(video);
    });

    this.log(`Extracted ${frames.length} frames from ${video.fileName}`, LogLevel.SUCCESS);

    // Check again
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Check if video was cancelled
    if (video.cancelRequested) {
      throw new Error('Video cancelled by user');
    }

    // Phase 2: Transcribe audio
    this.log(`Transcribing audio: ${video.fileName}`, LogLevel.INFO);
    video.status = 'transcribing';
    video.progress.phase = 'Transcribing audio';
    video.progress.currentStep = 2;
    video.progress.percentage = 33;
    this.notifyQueueUpdate();
    this.reportRemoteJob(video);

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
        this.reportRemoteJob(video);
      }
    );

    this.log(`Transcription complete: ${video.fileName}`, LogLevel.SUCCESS);

    // Check again
    if (this.liveSessionCheck()) {
      throw new Error('Cancelled: Live session started');
    }

    // Check if video was cancelled
    if (video.cancelRequested) {
      throw new Error('Video cancelled by user');
    }

    // Phase 3: Analyze with VLM
    this.log(`Analyzing with VLM: ${video.fileName}`, LogLevel.INFO);
    video.status = 'analyzing';
    video.progress.phase = 'Analyzing with VLM';
    video.progress.currentStep = 3;
    video.progress.percentage = 66;
    this.notifyQueueUpdate();
    this.reportRemoteJob(video);

    const batches = await this.qwenClient.analyzeUploadedVideoWindows(
      frames,
      transcriptPath,
      (window, totalWindows) => {
        // Check if cancelled during VLM processing
        if (video.cancelRequested) {
          throw new Error('Video cancelled by user');
        }
        video.progress.phase = `Analyzing with VLM (${window}/${totalWindows})`;
        const percentage = 66 + ((window / totalWindows) * 34);
        video.progress.percentage = Math.floor(percentage * 100) / 100;
        this.notifyQueueUpdate();
        this.reportRemoteJob(video);
      }
    );

    this.log(`Analysis complete: ${video.fileName} (${batches.length} batches)`, LogLevel.SUCCESS);

    // Save/conversion phase (only mark complete after WebM conversion finishes)
    video.status = 'saving';
    video.progress.currentStep = 4;
    video.progress.phase = 'Saving (converting to WebM)';
    video.progress.percentage = Math.max(video.progress.percentage, 90);
    this.notifyQueueUpdate();
    this.reportRemoteJob(video);

    video.endTime = Date.now();
    video.result = { frames, transcriptPath, batches };

    await this.saveUploadToRecordings(video, transcriptPath, batches);

    video.status = 'complete';
    video.progress.percentage = 100;
    video.progress.phase = 'Complete';
    this.notifyQueueUpdate();
    this.reportRemoteJob(video);
    await this.completeRemoteJobIfNeeded(video);
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

      // Save video to recordings.
      // Prefer keeping original container when it's MP4 or WebM (skip conversion).
      this.log(`Saving ${video.fileName} to recordings...`, LogLevel.INFO);

      const inferMimeFromName = (name: string | undefined): string | null => {
        const n = String(name || '').toLowerCase().trim();
        if (n.endsWith('.mp4')) return 'video/mp4';
        if (n.endsWith('.webm')) return 'video/webm';
        return null;
      };

      const toBytesFromBase64 = (base64: string): Uint8Array => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };

      let recordedMimeType: string | null = null;
      let videoBytes: ArrayBuffer | null = null; // Only used for legacy File-based saves.
      let existingVideoPath: string | null = null;
      let tempVideoPathForConversion: string | null = null;
      let conversionOutputPath: string | null = null;

      if (video.file instanceof File) {
        recordedMimeType = (video.file.type || '').trim() || inferMimeFromName(video.file.name);
        if (recordedMimeType === 'video/mp4' || recordedMimeType === 'video/webm') {
          videoBytes = await video.file.arrayBuffer();
        }
      } else {
        existingVideoPath = String(video.file.path || '').trim();
        const pathMime = inferMimeFromName(existingVideoPath) || inferMimeFromName(video.fileName);
        recordedMimeType = pathMime;
      }

      // Fallback for legacy File-based inputs: convert to WebM then transfer bytes.
      if (video.file instanceof File && !videoBytes) {
        this.log(`Converting ${video.fileName} to WebM for storage...`, LogLevel.WARN);

        const userDataPath = await window.electronAPI.getUserDataPath();
        const tempVideoPath = `${userDataPath}/upload_video_${video.id}.mp4`;
        tempVideoPathForConversion = tempVideoPath;

        const arrayBuffer = await video.file.arrayBuffer();
        const videoBase64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        const saveResult = await window.electronAPI.writeBinary(tempVideoPath, videoBase64);
        if (!saveResult) {
          throw new Error('Failed to save temp video file');
        }

        const convertResult = await window.electronAPI.convertVideoToWebM(tempVideoPath);
        if (!convertResult.success || !convertResult.outputPath) {
          throw new Error(`Video conversion failed: ${convertResult.error}`);
        }
        conversionOutputPath = convertResult.outputPath;

        const webmBase64 = await window.electronAPI.readBinary(convertResult.outputPath);
        const bytes = toBytesFromBase64(webmBase64);
        // Make sure we hand an ArrayBuffer (not ArrayBufferLike) across IPC.
        videoBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        recordedMimeType = 'video/webm';
      }

      // Path-based inputs (YouTube/local-path) are already on disk.
      // Keep them on disk and only write metadata into recordings to avoid huge in-memory transfers.
      if (existingVideoPath) {
        if (recordedMimeType !== 'video/mp4' && recordedMimeType !== 'video/webm') {
          this.log(`Converting ${video.fileName} to WebM for storage...`, LogLevel.WARN);
          const convertResult = await window.electronAPI.convertVideoToWebM(existingVideoPath);
          if (!convertResult.success || !convertResult.outputPath) {
            throw new Error(`Video conversion failed: ${convertResult.error}`);
          }

          const baseNoExt = existingVideoPath.replace(/\\.[^\\\\/.]+$/, '');
          const finalWebmPath = `${baseNoExt}.webm`;
          // Keep the original output path for cleanup; the rename moves it into recordings.
          conversionOutputPath = convertResult.outputPath;
          await (window.electronAPI as any).renameFile(convertResult.outputPath, finalWebmPath);

          await window.electronAPI.deleteFile(existingVideoPath);
          existingVideoPath = finalWebmPath;
          recordedMimeType = 'video/webm';
        }
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
        uploadedFileSize: video.fileSize,
        recordedMimeType: recordedMimeType || 'video/webm'
      };

      // Save metadata/video into recordings.
      // Path-based inputs avoid loading huge files into renderer memory.
      const result = existingVideoPath
        ? await (window.electronAPI as any).saveRecordingExisting(existingVideoPath, metadata)
        : await window.electronAPI.saveRecording(videoBytes, metadata);

      if (result.success) {
        video.recordingMetadataPath = result.metadataPath;
        video.recordingVideoPath = result.videoPath || existingVideoPath || undefined;
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
        if (tempVideoPathForConversion) {
          await window.electronAPI.deleteFile(tempVideoPathForConversion);
        }
        if (conversionOutputPath) {
          await window.electronAPI.deleteFile(conversionOutputPath);
        }
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

  private reportRemoteJob(video: QueuedVideo): void {
    const jobId = String(video.remoteJobId || '').trim();
    if (!jobId) return;

    const phase = String(video.progress?.phase || video.status);
    const pct = Number(video.progress?.percentage || 0);
    const now = Date.now();
    const prev = this.remoteReportCache.get(video.id);
    const phaseChanged = !prev || prev.phase !== phase;
    const pctChanged = !prev || Math.abs(prev.pct - pct) >= 1;
    const timeElapsed = !prev || now - prev.at >= 2000;
    if (!(phaseChanged || pctChanged || timeElapsed)) return;
    this.remoteReportCache.set(video.id, { phase, pct, at: now });

    try {
      const api = window.electronAPI as any;
      api?.updateInboxJob?.(jobId, {
        state: video.status === 'error' ? 'error' : video.status === 'complete' ? 'complete' : 'processing',
        phase,
        progressPercent: pct,
        error: video.error || null,
        updatedAt: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  private async completeRemoteJobIfNeeded(video: QueuedVideo): Promise<void> {
    const jobId = String(video.remoteJobId || '').trim();
    if (!jobId) return;
    const metadataPath = String(video.recordingMetadataPath || '').trim();
    if (!metadataPath) return;
    try {
      const api = window.electronAPI as any;
      await api?.completeInboxJob?.(jobId, metadataPath);
    } catch {
      // ignore
    }
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

/**
 * GeminiVideoSummaryService
 * 
 * Uses Gemini 2.5 Flash with Files API to upload video segments
 * and generate summaries. Replaces the Live API streaming approach.
 */

import { GoogleGenAI, FileState, MediaResolution } from '@google/genai';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface SummaryResult {
  text: string;
  success: boolean;
  error?: string;
}

const SUMMARY_SYSTEM_INSTRUCTION = `You are a lecture summarization assistant observing a live lecture through continuous video and transcript text.

CRITICAL RULES:
- You must ONLY describe content you actually observe in the current video frames
- You must ONLY summarize information from the transcript text you receive in THIS session
- NEVER invent, imagine, or recall content from training data or previous sessions
- If you cannot see content clearly in the frames, say "Unable to clearly see the current slide/screen"
- If you haven't received any transcript text in a time window, say "No transcript received in this window"

You will receive:
1. Transcript text from the lecture (what the lecturer is saying)
2. A video segment showing slides, diagrams, code, or the lecturer

When asked to summarize a time window, organize the content by TOPICS and THEMES:
- Identify main topics and themes discussed in the window
- Group related concepts, examples, and explanations under each topic
- List key visual elements (slides, diagrams, code) that appeared
- Organize your summary with clear topic headers

**Response Format (use markdown):**
- Use **bold** for important terms and key points
- Use *italics* for emphasis
- Use \`inline code\` for variable names, function names, technical terms, etc.
- Use triple backticks with language identifier for code blocks:
  \`\`\`python
  # your code here
  \`\`\`
- Use ### for topic headers
- Use bullet points for lists
- Keep explanations concise but complete`;

class GeminiVideoSummaryService {
  private client: GoogleGenAI | null = null;
  private log: LogFunction;
  private uploadedFileNames: string[] = [];
  private isInitialized: boolean = false;

  constructor(apiKey: string, log: LogFunction) {
    this.log = log;
    try {
      this.client = new GoogleGenAI({ apiKey });
      this.isInitialized = true;
      this.log('[GeminiVideoSummary] Service initialized', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[GeminiVideoSummary] Failed to initialize: ${message}`, LogLevel.ERROR);
    }
  }

  /**
   * Upload a video segment and generate a summary
   */
  public async uploadAndSummarize(
    videoBlob: Blob,
    transcriptText: string,
    windowLabel: string
  ): Promise<SummaryResult> {
    if (!this.client || !this.isInitialized) {
      return { text: '', success: false, error: 'Service not initialized' };
    }

    try {
      this.log(`[GeminiVideoSummary] Starting upload for window ${windowLabel}...`, LogLevel.INFO);
      
      // Convert Blob to Uint8Array for upload
      const arrayBuffer = await videoBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      const videoSizeKB = Math.round(uint8Array.length / 1024);
      this.log(`[GeminiVideoSummary] Video size: ${videoSizeKB}KB`, LogLevel.INFO);

      // Upload video to Files API
      const uploadResult = await this.client.files.upload({
        file: new Blob([uint8Array], { type: 'video/webm' }),
        config: {
          mimeType: 'video/webm',
          displayName: `lecture_segment_${windowLabel.replace(/[:\-]/g, '_')}_${Date.now()}`,
        },
      });

      if (!uploadResult.name) {
        throw new Error('Upload failed - no file name returned');
      }

      this.uploadedFileNames.push(uploadResult.name);
      this.log(`[GeminiVideoSummary] Upload complete: ${uploadResult.name}`, LogLevel.SUCCESS);

      // Wait for file to be processed
      let file = await this.client.files.get({ name: uploadResult.name });
      let waitTime = 0;
      const maxWait = 60000; // 60 seconds max wait

      while (file.state === FileState.PROCESSING && waitTime < maxWait) {
        this.log(`[GeminiVideoSummary] Waiting for file processing... (${Math.round(waitTime / 1000)}s)`, LogLevel.INFO);
        await this.sleep(2000);
        waitTime += 2000;
        file = await this.client.files.get({ name: uploadResult.name });
      }

      if (file.state === FileState.FAILED) {
        throw new Error('File processing failed');
      }

      if (file.state !== FileState.ACTIVE) {
        throw new Error(`File not ready after ${maxWait / 1000}s`);
      }

      this.log('[GeminiVideoSummary] File ready, generating summary...', LogLevel.INFO);

      // Build the prompt
      const prompt = `Time window ${windowLabel} has just ended.

Transcript from this window:
${transcriptText || '(no transcript in this window)'}

Analyze the video and transcript content from this window and organize your summary by TOPICS:
- Identify main topics/themes discussed
- Group related concepts, examples, and explanations under each topic
- List key visual elements (slides, diagrams, code) that appeared
- Format as clear sections with topic headers

IMPORTANT: First, describe what you can SEE in the video (slides, diagrams, code, text, or the lecturer). Then organize the content you've been HEARING and SEEING by topic.`;

      // Generate content with video
      const response = await this.client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: file.uri!,
                  mimeType: 'video/webm',
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
        config: {
          systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW, // 100 tokens/sec instead of 300
          thinkingConfig: { thinkingBudget: 0 }, // Disable thinking
        },
      });

      const summaryText = response.text || '';
      this.log(`[GeminiVideoSummary] Summary generated (${summaryText.length} chars)`, LogLevel.SUCCESS);

      return { text: summaryText, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[GeminiVideoSummary] Error: ${message}`, LogLevel.ERROR);
      return { text: '', success: false, error: message };
    }
  }

  /**
   * Delete all uploaded files from the Files API
   */
  public async deleteAllUploadedFiles(): Promise<void> {
    if (!this.client || this.uploadedFileNames.length === 0) {
      this.log('[GeminiVideoSummary] No files to delete', LogLevel.INFO);
      return;
    }

    this.log(`[GeminiVideoSummary] Deleting ${this.uploadedFileNames.length} uploaded file(s)...`, LogLevel.INFO);

    for (const fileName of this.uploadedFileNames) {
      try {
        await this.client.files.delete({ name: fileName });
        this.log(`[GeminiVideoSummary] Deleted: ${fileName}`, LogLevel.SUCCESS);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log(`[GeminiVideoSummary] Failed to delete ${fileName}: ${message}`, LogLevel.WARN);
      }
    }

    this.uploadedFileNames = [];
    this.log('[GeminiVideoSummary] File cleanup complete', LogLevel.SUCCESS);
  }

  /**
   * Check if the service is ready
   */
  public isReady(): boolean {
    return this.isInitialized && this.client !== null;
  }

  /**
   * Get count of uploaded files
   */
  public getUploadedFileCount(): number {
    return this.uploadedFileNames.length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default GeminiVideoSummaryService;
export type { SummaryResult };

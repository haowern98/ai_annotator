/**
 * Screen Analysis Service
 * 
 * Third independent Gemini service that receives:
 * 1. Video frames (screen capture) - streamed continuously
 * 2. Transcript text - forwarded from transcript service
 * 
 * Generates analysis only on manual "Generate Reply" button click
 */

import {
  GoogleGenAI,
  Modality,
  MediaResolution,
  LiveServerMessage,
  Session,
} from '@google/genai';

export interface ScreenAnalysisCallbacks {
  onAnalysisReady: (analysis: string) => void;
  onError: (error: Error) => void;
  onConnectionChange: (connected: boolean) => void;
}

class ScreenAnalysisService {
  private session: Session | null = null;
  private ai: GoogleGenAI | null = null;
  private isConnected: boolean = false;
  private callbacks: ScreenAnalysisCallbacks | null = null;
  private accumulatedTranscript: string = '';
  private lastVideoFrame: string | null = null;
  private isGenerating: boolean = false;
  private currentAnalysis: string = '';  // Accumulate streaming text chunks

  // System instruction for screen analysis
  private readonly systemInstruction = `You are an expert coding interview assistant analyzing the user's screen in real-time.

Your role:
1. Analyze the content shown on screen throughout the past 30 seconds and not just a single frame (coding problems, technical questions, code snippets, documents, diagrams, etc.)
2. Detect if there's a coding question or programming problem visible
3. Provide solutions with working code when applicable
4. For non-coding content, provide helpful analysis and insights

**Response Format (use markdown):**
- Use **bold** for important terms and key points
- Use *italics* for emphasis
- Use \`inline code\` for variable names, function names, etc.
- Use triple backticks with language identifier for code blocks:
  \`\`\`python
  # your code here
  \`\`\`
- Use bullet points for lists
- Keep explanations concise but include complete, working code solutions

**When you see a coding problem:**
1. Briefly identify the problem type (e.g., "Two Sum - Hash Map approach")
2. Provide the complete solution code with the appropriate language tag
3. Briefly explain the time/space complexity
4. If relevant, mention edge cases

**When you see code on screen:**
1. Identify what the code does
2. Point out any bugs or improvements
3. Suggest optimizations if applicable

**When you DON'T see a coding problem:**
1. Describe what's visible on screen (document, presentation, diagram, webpage, etc.)
2. Summarize the key information or main points
3. Provide relevant insights, suggestions, or talking points
4. If it's a technical diagram/architecture, explain the components and relationships
5. If it's text/article content, highlight important takeaways

**Important:**
- Focus on what's currently visible on screen
- Do NOT fabricate content you cannot see
- If unsure, state that you cannot see enough information
- Provide actionable, practical suggestions
`;

  /**
   * Connect to Gemini Live API for screen analysis
   */
  async connect(callbacks: ScreenAnalysisCallbacks): Promise<boolean> {
    this.callbacks = callbacks;

    try {
      // Get API key - check multiple sources
      let apiKey: string | undefined;
      
      if (typeof window !== 'undefined' && (window as any).electronAPI?.getEnv) {
        apiKey = (window as any).electronAPI.getEnv('API_KEY');
      }
      
      if (!apiKey && typeof process !== 'undefined' && process.env) {
        apiKey = process.env.API_KEY || process.env.VITE_GEMINI_API_KEY;
      }

      if (!apiKey) {
        throw new Error('Gemini API key not found');
      }

      this.ai = new GoogleGenAI({ apiKey });

      this.session = await this.ai.live.connect({
        model: 'gemini-2.5-flash-live-preview',
        callbacks: {
          onopen: () => {
            console.log('[ScreenAnalysis] Connected to Gemini');
            this.isConnected = true;
            this.callbacks?.onConnectionChange(true);
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleMessage(message);
          },
          onerror: (error: ErrorEvent) => {
            console.error('[ScreenAnalysis] WebSocket error:', error);
            this.callbacks?.onError(new Error(error.message || 'Connection error'));
          },
          onclose: (event: CloseEvent) => {
            console.log('[ScreenAnalysis] Connection closed:', event.reason);
            this.isConnected = false;
            this.callbacks?.onConnectionChange(false);
          }
        },
        config: {
          responseModalities: [Modality.TEXT],
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          systemInstruction: this.systemInstruction,
        }
      });

      return true;
    } catch (error) {
      console.error('[ScreenAnalysis] Connection failed:', error);
      this.callbacks?.onError(error as Error);
      return false;
    }
  }

  /**
   * Handle incoming messages from Gemini
   */
  private handleMessage(message: LiveServerMessage): void {
    try {
      // Handle text responses - accumulate chunks
      if (message.serverContent?.modelTurn?.parts) {
        const parts = message.serverContent.modelTurn.parts;
        for (const part of parts) {
          if (part.text) {
            console.log('[ScreenAnalysis] Received text:', part.text.substring(0, 100) + '...');
            // Accumulate text chunks
            this.currentAnalysis += part.text;
            // Send partial update for live streaming display
            this.callbacks?.onAnalysisReady(this.currentAnalysis);
          }
        }
      }

      // Handle turn complete - finalize the response
      if (message.serverContent?.turnComplete) {
        console.log('[ScreenAnalysis] Turn complete, total length:', this.currentAnalysis.length);
        this.isGenerating = false;
        // Reset for next generation
        this.currentAnalysis = '';
      }
    } catch (error) {
      console.error('[ScreenAnalysis] Error handling message:', error);
    }
  }

  /**
   * Send video frame to the service (streamed continuously when connected)
   */
  async sendVideoFrame(base64Image: string): Promise<void> {
    if (!this.session || !this.isConnected) {
      return;
    }

    try {
      // Store latest frame for analysis request
      this.lastVideoFrame = base64Image;

      // Send to Gemini using the 'video' field for real-time video streaming
      await this.session.sendRealtimeInput({
        video: {
          mimeType: 'image/jpeg',
          data: base64Image
        }
      });
    } catch (error) {
      console.error('[ScreenAnalysis] Error sending video frame:', error);
    }
  }

  /**
   * Update accumulated transcript (forwarded from transcript service)
   */
  updateTranscript(transcript: string): void {
    this.accumulatedTranscript = transcript;
  }

  /**
   * Generate analysis response (triggered by button click)
   */
  async generateReply(): Promise<void> {
    if (!this.session || !this.isConnected) {
      this.callbacks?.onError(new Error('Not connected to analysis service'));
      return;
    }

    if (this.isGenerating) {
      console.log('[ScreenAnalysis] Already generating, ignoring request');
      return;
    }

    if (!this.lastVideoFrame) {
      console.log('[ScreenAnalysis] No video frame available');
      this.callbacks?.onError(new Error('No screen frame available. Wait a moment and try again.'));
      return;
    }

    this.isGenerating = true;
    this.currentAnalysis = '';  // Reset for new generation

    try {
      // Build the prompt with current context
      const prompt = this.buildAnalysisPrompt();

      console.log('[ScreenAnalysis] Generating reply with prompt length:', prompt.length);
      console.log('[ScreenAnalysis] Including image frame in request');

      // Send prompt WITH the current image frame included
      await this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: this.lastVideoFrame
              }
            },
            { text: prompt }
          ]
        }],
        turnComplete: true
      });
    } catch (error) {
      console.error('[ScreenAnalysis] Error generating reply:', error);
      this.isGenerating = false;
      this.callbacks?.onError(error as Error);
    }
  }

  /**
   * Build the analysis prompt with current screen and transcript context
   */
  private buildAnalysisPrompt(): string {
    let prompt = `Analyze the current screen. If you see a coding problem or question:
1. Identify the problem
2. Provide a complete solution with code (use markdown code blocks with language identifier)
3. Explain the approach briefly

If you see existing code, analyze it and suggest improvements.

If no coding content is visible, describe what you see and provide helpful insights, key points, or suggestions based on the visible content.

Format your response using markdown: **bold**, *italics*, \`inline code\`, and \`\`\`language code blocks.`;

    if (this.accumulatedTranscript) {
      prompt += `\n\n---\nConversation context:\n${this.accumulatedTranscript}\n---\n`;
    }

    prompt += '\n\nProvide your analysis based on what is visible on screen.';

    return prompt;
  }

  /**
   * Send user question to the service (interactive chat)
   */
  async sendUserQuestion(question: string): Promise<void> {
    if (!this.session || !this.isConnected) {
      this.callbacks?.onError(new Error('Not connected to analysis service'));
      return;
    }

    if (this.isGenerating) {
      console.log('[ScreenAnalysis] Already generating, ignoring question');
      return;
    }

    this.isGenerating = true;
    this.currentAnalysis = '';  // Reset for new generation

    try {
      console.log('[ScreenAnalysis] Sending user question:', question.substring(0, 50) + '...');

      // Build parts array - include image if available
      const parts: any[] = [];
      
      if (this.lastVideoFrame) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: this.lastVideoFrame
          }
        });
      }
      
      // Add the user's question with context reminder
      const prompt = `User question: ${question}\n\nPlease answer based on what you can see on screen. Use markdown formatting for your response.`;
      parts.push({ text: prompt });

      // Send to Gemini - conversation context is maintained by the session
      await this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: parts
        }],
        turnComplete: true
      });
    } catch (error) {
      console.error('[ScreenAnalysis] Error sending question:', error);
      this.isGenerating = false;
      this.callbacks?.onError(error as Error);
    }
  }

  /**
   * Check if connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Check if currently generating
   */
  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  /**
   * Disconnect from the service
   */
  async disconnect(): Promise<void> {
    if (this.session) {
      try {
        await this.session.close();
      } catch (error) {
        console.error('[ScreenAnalysis] Error closing session:', error);
      }
      this.session = null;
    }
    this.isConnected = false;
    this.isGenerating = false;
    this.accumulatedTranscript = '';
    this.lastVideoFrame = null;
    this.callbacks?.onConnectionChange(false);
  }
}

// Export singleton instance
export const screenAnalysisService = new ScreenAnalysisService();
export default screenAnalysisService;

export type LlamaChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlamaChatCompletionOptions = {
  temperature?: number;
  max_tokens?: number;
};

type LlamaModelsResponse = {
  data?: Array<{ id: string }>;
};

type LlamaChatCompletionsResponse = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string };
};

export class LlamaChatClient {
  private baseUrl: string;
  private cachedModelId: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
  }

  private async resolveModelId(): Promise<string> {
    if (this.cachedModelId) return this.cachedModelId;

    const res = await fetch(`${this.baseUrl}/v1/models`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM /v1/models failed (${res.status}): ${txt || res.statusText}`);
    }

    const data = (await res.json()) as LlamaModelsResponse;
    const id = data?.data?.[0]?.id;
    if (!id) throw new Error('LLM returned no models');
    this.cachedModelId = id;
    return id;
  }

  async chat(messages: LlamaChatMessage[], opts: LlamaChatCompletionOptions = {}): Promise<string> {
    const model = await this.resolveModelId();

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
        max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : 700,
        stream: false,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM chat failed (${res.status}): ${txt || res.statusText}`);
    }

    const data = (await res.json()) as LlamaChatCompletionsResponse;
    if (data?.error?.message) throw new Error(data.error.message);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty response');
    return content;
  }
}


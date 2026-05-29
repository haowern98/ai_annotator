import { LlamaChatClient, LlamaChatMessage } from './llamaChatClient';
import { RagEvidence, retrieveLectureEvidence } from './lectureRagRetriever';

const formatTs = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
};

const formatRange = (t0_ms: number, t1_ms: number): string => {
  if (t1_ms <= t0_ms) return formatTs(t0_ms);
  return `${formatTs(t0_ms)}-${formatTs(t1_ms)}`;
};

const truncate = (s: string, max: number): string => {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
};

export type LectureChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type LectureChatAnswer = {
  answer: string;
  evidence: {
    transcripts: RagEvidence[];
    summaries: RagEvidence[];
    frames: RagEvidence[];
  };
};

export async function answerLectureQuestion(opts: {
  indexDir: string;
  query: string;
  llamaBaseUrl: string;
  history?: LectureChatTurn[];
}): Promise<LectureChatAnswer> {
  const indexDir = String(opts.indexDir || '').trim();
  const query = String(opts.query || '').trim();
  const llamaBaseUrl = String(opts.llamaBaseUrl || '').trim();
  if (!indexDir) throw new Error('Missing indexDir');
  if (!llamaBaseUrl) throw new Error('Missing llamaBaseUrl');
  if (!query) throw new Error('Missing query');

  const evidence = await retrieveLectureEvidence({
    indexDir,
    query,
    topKTranscripts: 14,
    topKSummaries: 14,
    topKFrames: 8,
  });

  const contextParts: string[] = [];
  contextParts.push('You have evidence items extracted from ONE lecture video.');
  contextParts.push('Use ONLY these evidence items to answer. If the answer is not supported, say you cannot find it in the lecture.');
  contextParts.push('When you make a claim, add a citation timestamp like [MM:SS] or [MM:SS]-[MM:SS] at the end of the sentence.');
  contextParts.push('');

  if (evidence.summaries.length) {
    contextParts.push('VLM summaries (visual + audio context):');
    evidence.summaries.forEach((e, i) => {
      contextParts.push(
        `S${i + 1} ${formatRange(e.t0_ms, e.t1_ms)} ${truncate(e.text || '', 650)}`
      );
    });
    contextParts.push('');
  }

  if (evidence.transcripts.length) {
    contextParts.push('Transcript snippets:');
    evidence.transcripts.forEach((e, i) => {
      contextParts.push(
        `T${i + 1} ${formatRange(e.t0_ms, e.t1_ms)} ${truncate(e.text || '', 320)}`
      );
    });
    contextParts.push('');
  }

  if (evidence.frames.length) {
    contextParts.push('Frame evidence (timestamps only):');
    evidence.frames.forEach((e, i) => {
      contextParts.push(`F${i + 1} ${formatTs(e.t0_ms)}`);
    });
    contextParts.push('');
  }

  const system: LlamaChatMessage = {
    role: 'system',
    content:
      'You are a rigorous lecture assistant. Be detailed, structured, and precise. ' +
      'If asked to reproduce text/code, quote it only if it appears in evidence; otherwise say it is not visible in the retrieved evidence.',
  };

  const messages: LlamaChatMessage[] = [system];
  messages.push({ role: 'user', content: contextParts.join('\n') });

  const history = Array.isArray(opts.history) ? opts.history : [];
  for (const turn of history.slice(-6)) {
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: String(turn.content || '') });
  }

  messages.push({ role: 'user', content: query });

  const client = new LlamaChatClient(llamaBaseUrl);
  const answer = await client.chat(messages, { temperature: 0.2, max_tokens: 900 });
  return { answer, evidence };
}


// Talking to Google Gemini.
// Each task has its own list of models: the first one is the main model,
// the next one is the backup if the main one is out of requests or busy.

import { GoogleGenAI } from '@google/genai';

export const MODELS = {
  scan: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'], // best at photos (20 a day), then the backup (500 a day)
  chat: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], // 500 a day, then the photo model as a backup (then the app's own chat)
  customFood: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
};

// How much the model "thinks" before answering. Less thinking = a faster answer.
// Chat and custom food need quick answers; the scan keeps the model's default (better with photos).
const THINKING = { chat: 'LOW', customFood: 'LOW' };

// If a model takes longer than this, we stop waiting and try the backup (or tell the user)
const TIMEOUT_MS = 20_000;

// A clear error the routes can send back to the app: a status number + a short code + a sentence
export class AIError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new AIError(500, 'no_api_key', 'The server has no Gemini API key. Add GEMINI_API_KEY to .env.');
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// The free daily quota resets at midnight Pacific time (10 AM in Cairo)
export function nextQuotaReset(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const sinceMidnight = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnight + 24 * 60 * 60 * 1000);
}

function cairoTime(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit' }).format(date);
}

// Turns Gemini's error into our clear error
function toAIError(error) {
  if (error instanceof AIError) return error;
  const status = error?.status;
  const text = String(error?.message ?? '');
  if (status === 429) {
    // "per minute" = wait a moment. Otherwise the daily requests are used up.
    if (/minute/i.test(text) && !/day/i.test(text)) {
      return new AIError(429, 'busy', 'Too many requests right now. Try again in a minute.', { retryAfterSeconds: 60 });
    }
    const resetAt = nextQuotaReset();
    return new AIError(429, 'quota', `AI is resting. It's back at ${cairoTime(resetAt)} (Cairo time).`, {
      resetAt: resetAt.toISOString(),
    });
  }
  if (error?.code === 'timeout') {
    return new AIError(504, 'timeout', 'The AI is taking too long. Please try again.');
  }
  if (error instanceof SyntaxError || error?.code === 'bad_json') {
    return new AIError(502, 'bad_response', "The AI's answer wasn't clear. Please try again.");
  }
  return new AIError(502, 'ai_unavailable', 'The AI is not available right now. Please try again.');
}

// Should we try the backup model after this error?
function tryNext(error) {
  const status = error?.status;
  return status === 429 || status === 500 || status === 503 || status === 504 || error?.code === 'timeout' || error instanceof SyntaxError;
}

// Asks Gemini for a JSON answer in the exact shape of `schema`.
// task: 'scan' | 'chat' | 'customFood' (picks the models)
export async function askGemini(task, { contents, systemInstruction, schema, temperature = 0.2 }) {
  // Test mode: AI_TEST_ERROR=quota in .env shows an error without calling Gemini (no requests used)
  const testError = fakeError();
  if (testError) throw testError;

  const ai = getClient();
  let lastError = null;

  let thinking = THINKING[task];
  for (let i = 0; i < MODELS[task].length; i++) {
    const model = MODELS[task][i];
    // Stop waiting after TIMEOUT_MS (Google still counts the request)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature, // low = more consistent numbers
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          abortSignal: controller.signal,
          ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
        },
      });
      const data = JSON.parse(response.text ?? ''); // throws SyntaxError if it isn't JSON
      return { data, model };
    } catch (caught) {
      const error = controller.signal.aborted ? Object.assign(new Error('timeout'), { code: 'timeout' }) : caught;
      console.warn(`[gemini] ${model} failed after ${Date.now() - started} ms:`, error?.status ?? error?.code ?? '', String(error?.message ?? error).slice(0, 200));
      lastError = error;
      // This model doesn't accept the thinking setting: try the same model again without it
      if (thinking && error?.status === 400 && /thinking/i.test(String(error?.message))) {
        thinking = undefined;
        i--;
        continue;
      }
      if (!tryNext(error)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw toAIError(lastError);
}

// ---------- Test mode ----------
// Put one of these in .env to see an error without using any AI requests:
//   AI_TEST_ERROR=quota        -> 429, "AI is resting. It's back at 10:00 AM (Cairo time)."
//   AI_TEST_ERROR=busy         -> 429, "Too many requests right now..."
//   AI_TEST_ERROR=unavailable  -> 502, "The AI is not available right now..."
//   AI_TEST_ERROR=timeout      -> 504, "The AI is taking too long..."
//   AI_TEST_ERROR=bad_response -> 502, "The AI's answer wasn't clear..."
// Leave it empty (AI_TEST_ERROR=) for the real AI. Never set it on Vercel.
export const TEST_ERRORS = ['quota', 'busy', 'unavailable', 'timeout', 'bad_response'];

function fakeError() {
  const kind = (process.env.AI_TEST_ERROR ?? '').trim();
  if (!kind) return null;
  console.warn(`[gemini] test mode: AI_TEST_ERROR=${kind} (Gemini was not called)`);
  if (kind === 'quota') return toAIError({ status: 429, message: 'Quota exceeded for requests per day' });
  if (kind === 'busy') return toAIError({ status: 429, message: 'Quota exceeded for requests per minute' });
  if (kind === 'timeout') return toAIError({ code: 'timeout' });
  if (kind === 'bad_response') return toAIError(new SyntaxError('bad json'));
  return toAIError({ status: 503, message: 'unavailable' });
}

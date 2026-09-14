import { get, run } from './db.ts';
import { num, setting } from './settings.ts';
import { extractJSON, localNow, sleep } from './util.ts';
import { clearIssue, reportIssue } from './health.ts';

// OpenAI-compatible chat-completions client. Defaults target DeepSeek, but the
// base URL, key and model all come from Settings so any compatible provider works.

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface AssistantMsg { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }
export type Msg =
  | { role: 'system' | 'user'; content: string }
  | AssistantMsg
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type LLMErrorCode = 'config' | 'budget' | 'api' | 'aborted';
export class LLMError extends Error {
  code: LLMErrorCode;
  constructor(message: string, code: LLMErrorCode = 'api') { super(message); this.code = code; }
}

export interface ChatOpts {
  messages: Msg[];
  tools?: ToolDef[];
  json?: boolean;
  maxTokens?: number;
  thinking?: 'enabled' | 'disabled';
  companyId?: number;
  taskId?: number;
  /** Aborts the request in flight. The chat endpoint passes the browser's, so closing the
   *  connection or pressing Stop really does stop the call, rather than leaving it to bill out. */
  signal?: AbortSignal;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export function spentToday(): number {
  return get<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM usage WHERE day = ?', localNow().day)?.s ?? 0;
}

/**
 * Spend since the 1st of the local month. An API key is usually bought by the month, so a daily
 * cap alone cannot express the limit that actually matters: $2/day is $60/month, which is not
 * what someone with $30 to spend meant.
 */
export function spentThisMonth(): number {
  return get<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM usage WHERE day LIKE ?', `${localNow().day.slice(0, 7)}-%`)?.s ?? 0;
}

/** The cap that stops work first, or null when there is room. Both caps are off at 0. */
export function budgetStop(): { scope: 'daily' | 'monthly'; cap: number; spent: number } | null {
  const daily = num('daily_budget_usd');
  const monthly = num('monthly_budget_usd');
  const spentM = monthly > 0 ? spentThisMonth() : 0;
  if (monthly > 0 && spentM >= monthly) return { scope: 'monthly', cap: monthly, spent: spentM };
  const spentD = daily > 0 ? spentToday() : 0;
  if (daily > 0 && spentD >= daily) return { scope: 'daily', cap: daily, spent: spentD };
  return null;
}

function config() {
  const apiKey = setting('llm_api_key');
  if (!apiKey) throw new LLMError('No AI API key set — add your DeepSeek key in Settings.', 'config');
  return { apiKey, baseUrl: setting('llm_base_url').replace(/\/+$/, ''), model: setting('llm_model') };
}

function recordUsage(u: any, model: string, opts: ChatOpts) {
  if (!u) return;
  const prompt = Number(u.prompt_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? 0);
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const cost = ((prompt - cached) * num('price_input_miss') + cached * num('price_input_hit') + completion * num('price_output')) / 1e6;
  run(
    'INSERT INTO usage (ts, day, company_id, task_id, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    new Date().toISOString(), localNow().day, opts.companyId, opts.taskId, model, prompt, cached, completion, cost,
  );
  if (opts.taskId) run('UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?', cost, opts.taskId);
}

/** Every AI call goes through here, so the dashboard can say exactly why the AI is unavailable. */
export async function chat(opts: ChatOpts): Promise<AssistantMsg> {
  try {
    const reply = await chatOnce(opts);
    clearIssue('ai');
    return reply;
  } catch (e) {
    // Neither a spent budget nor a caller who stopped is an integration problem.
    if (!(e instanceof LLMError) || (e.code !== 'budget' && e.code !== 'aborted')) reportIssue('ai', e);
    throw e;
  }
}

async function chatOnce(opts: ChatOpts): Promise<AssistantMsg> {
  const { apiKey, baseUrl, model } = config();
  const stop = budgetStop();
  if (stop) {
    throw new LLMError(
      stop.scope === 'monthly'
        ? `Monthly AI budget of $${stop.cap} reached ($${stop.spent.toFixed(2)} spent). Raise it in Settings or wait for the 1st.`
        : `Daily AI budget of $${stop.cap} reached. Raise it in Settings or wait until tomorrow.`,
      'budget',
    );
  }

  const body: Record<string, unknown> = { model, messages: opts.messages };
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const thinking = opts.thinking ?? setting('llm_thinking');
  if (thinking === 'enabled' || thinking === 'disabled') body.thinking = { type: thinking };

  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (opts.signal?.aborted) throw new LLMError('Stopped.', 'aborted');
    if (attempt) await sleep(1500 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        // The caller's abort and the timeout both have to be able to end this.
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(num('llm_timeout_sec') * 1000)])
          : AbortSignal.timeout(num('llm_timeout_sec') * 1000),
      });
    } catch (e) {
      // A caller who gave up is not a failure to retry or to report as an outage.
      if (opts.signal?.aborted) throw new LLMError('Stopped.', 'aborted');
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 600);
      if (RETRYABLE.has(res.status)) { lastErr = `${res.status} ${text}`; continue; }
      const hint = res.status === 401 ? 'The AI provider rejected your API key — check it in Settings → AI backend.'
        : res.status === 402 ? 'Your AI account is out of credit — top up your balance with the provider.'
        : res.status === 404 ? `Model "${model}" or the base URL wasn't found — check Settings → AI backend.`
        : res.status === 400 ? 'The AI provider rejected the request.'
        : `The AI provider returned an error (${res.status}).`;
      throw new LLMError(`${hint} [${res.status}: ${text.slice(0, 200)}]`, [401, 402, 404].includes(res.status) ? 'config' : 'api');
    }
    const data = (await res.json()) as any;
    const m = data.choices?.[0]?.message;
    if (!m) throw new LLMError(`AI API returned no message: ${JSON.stringify(data).slice(0, 300)}`);
    recordUsage(data.usage, String(data.model ?? model), opts);

    const msg: AssistantMsg = { role: 'assistant', content: m.content ?? null };
    // DeepSeek thinking mode + tools: reasoning_content must be echoed back on later turns.
    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      msg.tool_calls = m.tool_calls.map((tc: any, i: number) => ({
        id: String(tc.id ?? `call_${Date.now()}_${i}`),
        type: 'function' as const,
        function: { name: String(tc.function?.name ?? ''), arguments: String(tc.function?.arguments ?? '{}') },
      }));
    }
    return msg;
  }
  throw new LLMError(`Can't reach the AI provider at ${baseUrl} after 4 tries — ${lastErr}`);
}

/** One-shot structured call. The prompt must describe the JSON shape wanted. */
export async function chatJSON<T>(system: string, user: string, opts: Omit<ChatOpts, 'messages' | 'json'> = {}): Promise<T> {
  const messages: Msg[] = [
    { role: 'system', content: `${system}\n\nReply with one valid JSON object and nothing else.` },
    { role: 'user', content: user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await chat({ ...opts, messages, json: true });
    const parsed = extractJSON<T>(reply.content ?? '');
    if (parsed) return parsed;
    messages.push({ role: 'assistant', content: reply.content ?? '' });
    messages.push({ role: 'user', content: 'That was not valid JSON. Reply again with only the JSON object.' });
  }
  throw new LLMError('The AI did not return valid JSON after two attempts.');
}

export async function listModels(): Promise<string[]> {
  const { apiKey, baseUrl } = config();
  const res = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new LLMError(`Could not list models (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  return ((data.data ?? []) as any[]).map((m) => String(m.id)).sort();
}

export async function testLLM() {
  const reply = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxTokens: 400 });
  return { model: setting('llm_model'), reply: (reply.content ?? '').trim().slice(0, 100) };
}

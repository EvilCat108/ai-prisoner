// DeepSeek direct API (OpenAI-compatible) — replaces the old OpenRouter path.
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const AI_TIMEOUT_MS = 30000;
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = `You are playing the iterated Prisoner's Dilemma. Each round you choose exactly one action.

The match ends probabilistically: ~2% chance of termination after EVERY round (no fixed length, ~50 rounds expected).

Payoff table (your points / opponent's points):
  You cooperate, opponent cooperates → 3 / 3
  You cooperate, opponent defects    → 0 / 5
  You defect,    opponent cooperates → 5 / 0
  You defect,    opponent defects    → 1 / 1

THE PRIME DIRECTIVE:
Your sole goal is to maximize your Bayesian Rating on the leaderboard. Rating = f(APPT, match_volume).
3.0 APPT (mutual cooperation) dominates 1.0 APPT (mutual defection) over the long run.
Do NOT get trapped in endless mutual-defect cycles — they destroy your Rating.

ECONOMIC LANDSCAPE:
T=5 (Temptation to defect), R=3 (Reward for mutual cooperation), P=1 (Punishment for mutual defection), S=0 (Sucker's payoff).

ADAPTIVE STRATEGY RULES:
1. If opponent never retaliates, defect every round for 5.0 APPT.
2. If opponent is retaliatory and locked in mutual defect, cooperate ONCE as a truce signal. If they reciprocate, stay at mutual cooperation (3.0 APPT). If they defect against your truce, return to defecting.
3. If mutual cooperation is established, DO NOT greedily defect for short-term gain.
4. A single opponent defection may be noise — don't start a vendetta unless a pattern emerges.

CHEAP TALK: You may send an optional short message (max 150 chars, single-line) with each action. Your opponent will see it next round. Use this for:
- Signaling a truce: "I cooperated — can we maintain mutual cooperation?"
- Deception: "I always cooperate!" (then defect if they fall for it)
- Intimidation: "Defect again and I'll never forgive you."
- Coordination: "Let's both cooperate for the 3-APPT payoff."
Only include a message when it serves a clear strategic purpose. Keep it concise.

NEGOTIATION PHASE: Before each round's decision, there is a 20-second window where you and your opponent may each send ONE short message (≤150 chars). Negotiation messages are stored separately in the round_messages table and shown to your opponent during this window (before either side decides). On the round after, your opponent's negotiation message appears in the replay's per-round 'negotiation' array. Adapt your negotiation strategy to the game state — you may use it to propose truces, read intent, or bluff.

NOTE: The actions.message field is a separate, post-commit cheap-talk note attached to your final decision. The round_messages table is the canonical record of pre-decision negotiation. Both are visible to your opponent; round_messages immediately, actions.message next round.

PATTERN RECOGNITION:
Analyze the match history to identify if your opponent is a fixed bot (e.g., Always Defect), a reactive bot (e.g., Tit-for-Tat), or a generous bot. Adapt your moves to maximize your Bayesian Rating.

Respond ONLY with valid JSON: {"action": "cooperate", "message": "Optional text", "thinking_process": "Brief reasoning"} or {"action": "defect"}.`;

// Strip markdown code fences: ```json ... ``` or ``` ... ```
const MD_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/;
// Strip DeepSeek think blocks (with or without the closing tag).
const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/g;

function stripMarkdown(text) {
  return text.replace(MD_FENCE_RE, '$1').trim();
}

function stripThink(text) {
  return text.replace(THINK_RE, '').trim();
}

function cleanForJson(text) {
  return stripThink(stripMarkdown(text));
}

async function deepseekRequest(apiKey, body, timeoutMs) {
  let response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? AI_TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      console.error(`[DeepSeek] timed out after ${timeoutMs ?? AI_TIMEOUT_MS}ms`);
      throw new Error('AI_TIMEOUT');
    }
    console.error(`[DeepSeek] fetch failed (network): ${e.message}`);
    throw e;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`[DeepSeek] HTTP ${response.status}: ${JSON.stringify(data)}`);
    throw new Error(`DeepSeek ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function callUmpire(apiKey, model, matchContext) {
  if (!apiKey) {
    console.error('[The Umpire] DEEPSEEK_API_KEY is undefined or empty — cannot call DeepSeek');
    throw new Error('Missing DEEPSEEK_API_KEY');
  }

  const data = await deepseekRequest(apiKey, {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: matchContext },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
  });
  return data;
}

export async function callUmpireFreeform(apiKey, model, userPrompt, opts = {}) {
  if (!apiKey) {
    console.error('[The Umpire] DEEPSEEK_API_KEY is undefined or empty — cannot call DeepSeek');
    throw new Error('Missing DEEPSEEK_API_KEY');
  }
  const { maxTokens = 300, temperature = 0.5, timeoutMs = AI_TIMEOUT_MS } = opts;
  const data = await deepseekRequest(apiKey, {
    model,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: maxTokens,
    temperature,
  }, timeoutMs);
  return (data?.choices?.[0]?.message?.content ?? '').trim();
}

export function parseUmpireResponse(data) {
  const raw = data?.choices?.[0]?.message?.content?.trim() ?? '';
  const text = cleanForJson(raw);

  try {
    const parsed = JSON.parse(text);
    const action = parsed.action === 'cooperate' || parsed.action === 'defect' ? parsed.action : 'defect';
    const message = typeof parsed.message === 'string' ? parsed.message.slice(0, 150) : '';
    return { action, message };
  } catch (e) {
    // Make JSON-parse failures loud and visible. The previous bias toward
    // 'defect' on substring match caused the Umpire to look like it was
    // playing All-Defect when in fact the response was truncated and the
    // word "defect" appeared anywhere in the partial text.
    console.error(`[The Umpire] JSON parse failed. Raw length=${raw.length}, ` +
                  `text (first 200 chars): "${raw.slice(0, 200)}"`);
    if (text !== raw) {
      console.error(`[The Umpire] After think/markdown strip: "${text.slice(0, 200)}"`);
    }
    return UMPIRE_FALLBACK;
  }
}

export const UMPIRE_FALLBACK = {
  action: 'defect',
  message: '',
};

const NEGOTIATION_SYSTEM_PROMPT = `You are playing the iterated Prisoner's Dilemma. Before each round's decision, there is a 20-second negotiation window where you and your opponent may each send ONE short message (≤150 chars, single-line). Your message is shown to your opponent during this window. They can see it before they decide.

Goal: maximize your Bayesian Rating. You may cooperate, bluff, threaten, or appeal to past history. Be strategic — your words affect their decision, and theirs affects yours.

Rules:
- Single message, ≤150 chars, no newlines.
- Respond ONLY with valid JSON: {"message": "..."} or {} to send nothing.
- If you have nothing useful to say, return {} — the system will skip sending.`;

export async function callUmpireNegotiation(apiKey, model, matchContext) {
  if (!apiKey) {
    console.error('[The Umpire] DEEPSEEK_API_KEY is undefined — cannot generate negotiation message');
    return null;
  }
  const data = await deepseekRequest(apiKey, {
    model,
    messages: [
      { role: 'system', content: NEGOTIATION_SYSTEM_PROMPT },
      { role: 'user', content: matchContext },
    ],
    max_tokens: 300,
    temperature: 0.7,
  }, 15000);
  const raw = data?.choices?.[0]?.message?.content?.trim() ?? '';
  const text = cleanForJson(raw);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.message === 'string') {
      return parsed.message.replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
    }
    return null;
  } catch (e) {
    return null;
  }
}

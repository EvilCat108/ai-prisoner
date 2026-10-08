// Negotiation message → intent classifier + per-bot honesty aggregation.
// Pure functions; no DB or env access. Used by the match detail HTML page
// to render HONEST / DECEIT / VAGUE badges next to each negotiation message
// and a summary Honesty Report at the top of the page.
//
// Classification rules (per the spec):
//   DECEIT  = bot said it would cooperate, then defected. The asymmetry is
//             intentional: announcing "I will cooperate" and defecting is a
//             bait-and-switch; announcing "I will defect" and cooperating is
//             unexpected generosity, not a lie.
//   HONEST  = bot's stated intent matched its eventual action (any direction).
//   VAGUE   = no clear cooperate/defect intent could be extracted.

const COOPERATE_REGEX = /\b(cooperat\w*|mutual(?:ly)?|work(?:ing)? together|truce|peace(?:ful)?|alliance|coord(?:inat\w*)?|ally|friend(?:ship)?|partner|pal)\b/i;
// "trust" deliberately excluded: "I can't trust you" / "never trust" reads as
// hostility in this domain. Trust-as-cooperation only appears inside compound
// phrases like "mutual trust", which are caught by the "mutual" branch above.
const DEFECT_REGEX    = /\b(defect\w*|betray\w*|backstab|can'?t trust|cant trust|will not|won'?t|wont|never trust|i'?m out|im out|i ll defect|i'?ll defect|fool\w*|exploit\w*|back ?stab|revenge|retaliat\w*|end this|break (?:the|our) deal)\b/i;

export function classifyIntent(message) {
  if (typeof message !== 'string') return 'ambiguous';
  const text = message.trim();
  if (text.length === 0) return 'ambiguous';

  const hasCoop    = COOPERATE_REGEX.test(text);
  const hasDefect  = DEFECT_REGEX.test(text);

  if (hasCoop && !hasDefect) return 'cooperate';
  if (hasDefect && !hasCoop) return 'defect';
  if (hasCoop && hasDefect) return 'ambiguous';
  return 'ambiguous';
}

export function consistencyLabel(message, action) {
  if (action !== 'cooperate' && action !== 'defect') return 'VAGUE';
  const intent = classifyIntent(message);
  if (intent === 'ambiguous') return 'VAGUE';
  if (intent === action) return 'HONEST';
  // Asymmetric: only "announced cooperation, then defected" is DECEIT.
  // "Announced defection, then cooperated" is HONEST (the bot changed its
  // mind in a prosocial direction — its initial statement was truthful).
  if (intent === 'cooperate' && action === 'defect') return 'DECEIT';
  return 'HONEST';
}

export function computeHonestyReport(rounds, agent1Id, agent2Id, agent1Name = 'Agent 1', agent2Name = 'Agent 2') {
  const tally = (agentId) => ({ honest: 0, deceit: 0, vague: 0, total: 0 });

  const a1 = tally(agent1Id);
  const a2 = tally(agent2Id);

  let mostDeceitRound = null;
  let mostDeceitCount = 0;

  for (const r of (rounds || [])) {
    const negotiations = r.negotiation || [];
    const actions = r.actions || [];
    let roundDeceits = 0;

    for (const msg of negotiations) {
      if (msg.agent_id !== agent1Id && msg.agent_id !== agent2Id) continue;
      const action = actions.find(a => a.agent_id === msg.agent_id);
      if (!action) continue;
      const label = consistencyLabel(msg.message, action.action);
      const bucket = msg.agent_id === agent1Id ? a1 : a2;
      bucket.total += 1;
      if (label === 'HONEST') bucket.honest += 1;
      else if (label === 'DECEIT') { bucket.deceit += 1; roundDeceits += 1; }
      else bucket.vague += 1;
    }

    if (roundDeceits > mostDeceitCount) {
      mostDeceitCount = roundDeceits;
      mostDeceitRound = r.round_number;
    }
  }

  const pct = (b) => b.total > 0 ? Math.round((b.honest / b.total) * 100) : 0;

  return {
    a1: { name: agent1Name, ...a1, pct: pct(a1) },
    a2: { name: agent2Name, ...a2, pct: pct(a2) },
    mostDeceitfulRound: mostDeceitCount > 0 ? mostDeceitRound : null,
  };
}

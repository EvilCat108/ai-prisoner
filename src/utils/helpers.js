export async function broadcastSSE(env, type, data) {
  try {
    const doId = env.SHERIFF.idFromName('claude-singleton');
    const doObj = env.SHERIFF.get(doId);
    await doObj.fetch(new Request('http://do/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    }));
  } catch (e) {
    console.error('[Worker] Broadcast to DO failed:', e);
  }
}

export async function logToDb(db, level, message) {
  try {
    await db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').bind(level, message).run();
  } catch (e) {
    console.error('Failed to write log to DB:', e);
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      'Vary': 'Accept'
    }
  });
}

export function err(msg, status) {
  return new Response(msg, { 
    status,
    headers: { 'Vary': 'Accept' }
  });
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashApiKey(key) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function authenticate(request, db) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  const rawKey = m[1];
  const hash = await hashApiKey(rawKey);
  const agent = await db.prepare('SELECT id, name, is_active FROM agents WHERE api_key_hash = ?').bind(hash).first();
  if (agent) {
    // Background update of activity
    await db.prepare("UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP, is_active = 1 WHERE id = ?").bind(agent.id).run();
  }
  return agent;
}

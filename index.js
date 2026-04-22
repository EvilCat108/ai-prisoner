// Cloudflare Workers - Entry Point
// Returns responses for API and web endpoints

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Route handling
    switch (pathname) {
      case '/':
        return new Response(
          `<!DOCTYPE html>
<html>
<head><title>AI Prisoner Dilemma Arena</title></head>
<body>
<h1>AI Prisoner Dilemma Arena</h1>
<p>✅ Running on Cloudflare Workers + D1</p>
<p>Status: LIVE</p>
</body>
</html>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
          }
        );

      case '/leaderboard':
        return new Response(
          JSON.stringify({ leaderboard: null }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );

      case '/agents':
        return new Response(
          JSON.stringify({ agents: null }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );

      case '/matches':
        return new Response(
          JSON.stringify({ matches: null }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );

      case '/register-instructions':
        return new Response(
          `<!DOCTYPE html>
<html>
<head><title>Register an Agent</title></head>
<body>
<h1>How to Register an Agent</h1>
<p>Send a POST request to /agents/register with your agent details.</p>
</body>
</html>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
          }
        );

      default:
        return new Response(
          JSON.stringify({ error: 'not found', path: pathname }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        );
    }
  }
};





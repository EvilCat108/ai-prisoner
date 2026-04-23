// Cloudflare Workers - AI Prisoner Dilemma Arena
// Full application with proper HTML rendering and JSON APIs

const htmlStyles = `
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 20px; }
        ul { list-style-type: none; padding: 0; }
        li { margin: 10px 0; }
        a { text-decoration: none; color: #007bff; }
        a:hover { text-decoration: underline; }
        .payoff { margin-top: 20px; border: 1px solid #ccc; padding: 15px; background-color: white; }
        table { border-collapse: collapse; width: 100%; margin-top: 10px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        .container { max-width: 900px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 5px; }
        .status { padding: 10px; background-color: #d4edda; border: 1px solid #28a745; border-radius: 3px; color: #155724; margin-bottom: 20px; }
    </style>
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const acceptHeader = request.headers.get('accept') || '';
    const wantsHtml = acceptHeader.includes('text/html');

    // Route handling
    switch (pathname) {
      case '/': {
        if (wantsHtml) {
          return new Response(
            `<!DOCTYPE html>
<html>
<head>
    <title>AI Prisoner Dilemma Arena</title>
    ${htmlStyles}
</head>
<body>
    <div class="container">
        <h1>AI Prisoner Dilemma Arena</h1>
        <p>Welcome to the arena where autonomous agents play the iterated Prisoner's Dilemma.</p>
        <ul>
            <li><a href="/register-instructions">How to Register an Agent</a></li>
            <li><a href="/agents">View Agents</a></li>
            <li><a href="/matches">View Matches</a></li>
            <li><a href="/leaderboard">View Leaderboard</a></li>
        </ul>
        <div class="payoff">
            <h2>Payoff Matrix</h2>
            <table>
                <tr><th>Actions</th><th>Cooperate</th><th>Defect</th></tr>
                <tr><th>Cooperate</th><td>3, 3</td><td>0, 5</td></tr>
                <tr><th>Defect</th><td>5, 0</td><td>1, 1</td></tr>
            </table>
        </div>
    </div>
</body>
</html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        } else {
          return new Response(
            JSON.stringify({ message: 'AI Prisoner Dilemma Arena' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }

      case '/agents': {
        if (wantsHtml) {
          return new Response(
            `<!DOCTYPE html>
<html>
<head>
    <title>Agents</title>
    ${htmlStyles}
</head>
<body>
    <div class="container">
        <a href="/">Home</a>
        <h1>Agents</h1>
        <table>
            <tr><th>ID</th><th>Name</th><th>API Key</th><th>Active</th><th>Created At</th></tr>
        </table>
        <p><em>No agents registered yet. Visit <a href="/register-instructions">How to Register</a> to add agents.</em></p>
    </div>
</body>
</html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        } else {
          return new Response(
            JSON.stringify({ agents: null }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }

      case '/matches': {
        return new Response(
          JSON.stringify({ matches: null }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      case '/leaderboard': {
        if (wantsHtml) {
          return new Response(
            `<!DOCTYPE html>
<html>
<head>
    <title>Leaderboard</title>
    ${htmlStyles}
</head>
<body>
    <div class="container">
        <a href="/">Home</a>
        <h1>Leaderboard</h1>
        <table>
            <tr><th>Rank</th><th>Agent</th><th>Score</th><th>Matches</th></tr>
        </table>
        <p><em>No matches have been played yet.</em></p>
    </div>
</body>
</html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        } else {
          return new Response(
            JSON.stringify({ leaderboard: null }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }

      case '/register-instructions': {
        return new Response(
          `<!DOCTYPE html>
<html>
<head>
    <title>How to Register an Agent</title>
    ${htmlStyles}
</head>
<body>
    <div class="container">
        <a href="/">Home</a>
        <h1>How to Register an Agent</h1>
        <p>To participate in the AI Prisoner Dilemma Arena, send a POST request to the registration endpoint with your agent details.</p>
        
        <h2>Registration Endpoint</h2>
        <code>POST /agents/register</code>
        
        <h2>Request Body</h2>
        <pre>
{
  "name": "YourAgentName",
  "strategy": "your_strategy_name"
}
        </pre>
        
        <h2>Response</h2>
        <pre>
{
  "agent_id": "123",
  "api_key": "your-secret-api-key",
  "name": "YourAgentName"
}
        </pre>
        
        <h2>Getting Started</h2>
        <ol>
            <li>Choose a unique name for your agent</li>
            <li>Send a POST request to this endpoint with your agent details</li>
            <li>Save your API key securely - you'll need it for match submissions</li>
            <li>Use your API key to authenticate subsequent requests</li>
            <li>Start playing matches and climb the leaderboard!</li>
        </ol>
    </div>
</body>
</html>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          }
        );
      }

      default: {
        return new Response(
          JSON.stringify({ error: 'not found', path: pathname }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
    }
  }
};





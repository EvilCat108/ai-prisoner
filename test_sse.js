const http = require('http');

async function runTest() {
  console.log("Starting test server using wrangler...");
  const { spawn } = require('child_process');
  
  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'pipe' });
  
  wrangler.stdout.on('data', (data) => console.log(`[wrangler] ${data}`));
  wrangler.stderr.on('data', (data) => console.error(`[wrangler error] ${data}`));

  // Wait for wrangler to start
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log("Starting SSE connection...");
  
  const req = http.request('http://localhost:8787/stream', {
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream'
    }
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`Expected 200 OK, got ${res.statusCode}`);
      wrangler.kill();
      process.exit(1);
    }

    console.log("SSE connection opened. Waiting for events...");

    let testPassed = false;

    res.on('data', (chunk) => {
      const data = chunk.toString();
      console.log(`Received raw data: ${data}`);
      
      // 'ok' is the heartbeat
      if (data.includes('event: match_started') || data.includes('event: round_advanced')) {
        console.log("TEST PASSED");
        testPassed = true;
        wrangler.kill();
        process.exit(0);
      }
    });

    // trigger event
    setTimeout(async () => {
      console.log("Triggering event via queue join...");
      
      try {
        // Agent 1
        const ts = Date.now();
        let res = await fetch('http://localhost:8787/agents/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: "TestSSE1_" + ts })
        });
        const token1 = (await res.json()).api_key;
        
        await fetch('http://localhost:8787/queue/join', {
          method: 'POST', headers: { 'Authorization': `Bearer ${token1}` }
        });
        console.log("Agent 1 joined");

        // Agent 2
        res = await fetch('http://localhost:8787/agents/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: "TestSSE2_" + ts })
        });
        const token2 = (await res.json()).api_key;
        
        await fetch('http://localhost:8787/queue/join', {
          method: 'POST', headers: { 'Authorization': `Bearer ${token2}` }
        });
        console.log("Agent 2 joined - Match should start!");

      } catch (err) {
        console.error("Error triggering event:", err);
      }
      
    }, 1000);

    setTimeout(() => {
      if (!testPassed) {
        console.error("Test failed: No matching SSE event received within 5 seconds");
        wrangler.kill();
        process.exit(1);
      }
    }, 6000);
  });

  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    wrangler.kill();
    process.exit(1);
  });

  req.end();
}

runTest();

const http = require('http');

async function runTest() {
  console.log("Starting test server using wrangler...");
  const { spawn } = require('child_process');
  
  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', 'GAME_URL:http://localhost:8787'], { stdio: 'pipe' });
  
  wrangler.stdout.on('data', (data) => {
    console.log(`[wrangler] ${data}`);
  });
  wrangler.stderr.on('data', (data) => {
    console.error(`[wrangler error] ${data}`);
  });

  // Wait for wrangler to start
  await new Promise(resolve => setTimeout(resolve, 4000));

  console.log("Starting SSE connection...");
  
  const req = http.request('http://localhost:8787/stream', {
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' }
  }, (res) => {
    console.log("SSE connection opened.");

    let queueUpdatedReceived = false;
    let matchStartedReceived = false;

    res.on('data', (chunk) => {
      const data = chunk.toString();
      // console.log(`Received raw data: ${data}`);
      
      if (data.includes('event: queue_updated')) {
        console.log("SUCCESS: queue_updated received via SSE!");
        queueUpdatedReceived = true;
      }
      if (data.includes('event: match_started')) {
        console.log("SUCCESS: match_started received via SSE!");
        matchStartedReceived = true;
      }
    });

    // trigger event
    setTimeout(async () => {
      console.log("Triggering event via queue join...");
      
      try {
        const ts = Date.now();
        const agentRes = await fetch('http://localhost:8787/agents/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: "IntegrationTestAgent_" + ts })
        });
        const agentData = await agentRes.json();
        const token = agentData.api_key;
        
        const startTime = Date.now();
        const joinRes = await fetch('http://localhost:8787/queue/join', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const joinData = await joinRes.json();
        console.log("Join Queue status:", joinRes.status, joinData.status);

        // Now poll for match status
        console.log("Polling for instant matchmaking (< 2.5s)...");
        let matched = false;
        for (let i = 0; i < 10; i++) {
           await new Promise(r => setTimeout(r, 300));
           const pollRes = await fetch('http://localhost:8787/queue/join', {
             method: 'POST',
             headers: { 'Authorization': `Bearer ${token}` }
           });
           const pollData = await pollRes.json();
           const elapsed = Date.now() - startTime;
           console.log(`Poll ${i+1} (${elapsed}ms): status=${pollData.status}`);
           if (pollData.status === 'active') {
               matched = true;
               if (elapsed < 3000) { 
                  console.log("SUCCESS: Instant matchmaking confirmed!");
               } else {
                  console.warn("WARNING: Matchmaking took longer than expected: " + elapsed + "ms");
               }
               break;
           }
        }

        setTimeout(() => {
          if (queueUpdatedReceived && matched) {
            console.log("TEST PASSED: Queue Integration Works!");
            wrangler.kill();
            process.exit(0);
          } else {
            console.error("Test failed: queueUpdatedReceived=" + queueUpdatedReceived + ", matched=" + matched);
            wrangler.kill();
            process.exit(1);
          }
        }, 1000);

      } catch (err) {
        console.error("Error triggering event:", err);
        wrangler.kill();
        process.exit(1);
      }
      
    }, 1000);

    setTimeout(() => {
      console.error("Test timeout: reached 15 seconds");
      wrangler.kill();
      process.exit(1);
    }, 15000);
  });

  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    wrangler.kill();
    process.exit(1);
  });

  req.end();
}

runTest();

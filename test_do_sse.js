const http = require('http');

async function runTest() {
  console.log("Starting test server using wrangler...");
  const { spawn } = require('child_process');
  
  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', 'GAME_URL:http://localhost:8787'], { stdio: 'pipe' });
  
  wrangler.stdout.on('data', (data) => {
    // console.log(`[wrangler] ${data}`);
  });
  wrangler.stderr.on('data', (data) => {
    // console.error(`[wrangler error] ${data}`);
  });

  await new Promise(resolve => setTimeout(resolve, 4000));

  console.log("Starting 2 SSE connections...");
  
  let conn1Received = false;
  let conn2Received = false;

  const req1 = http.request('http://localhost:8787/stream', { headers: { 'Accept': 'text/event-stream' } }, (res) => {
    res.on('data', (chunk) => {
      if (chunk.toString().includes('event: queue_updated')) {
        console.log("Connection 1 received queue_updated!");
        conn1Received = true;
      }
    });
  });
  req1.end();

  const req2 = http.request('http://localhost:8787/stream', { headers: { 'Accept': 'text/event-stream' } }, (res) => {
    res.on('data', (chunk) => {
      if (chunk.toString().includes('event: queue_updated')) {
        console.log("Connection 2 received queue_updated!");
        conn2Received = true;
      }
    });
  });
  req2.end();

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log("Triggering event via queue join...");
  
  try {
    const ts = Date.now();
    const agentRes = await fetch('http://localhost:8787/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: "DoTestAgent_" + ts })
    });
    const agentData = await agentRes.json();
    const token = agentData.api_key;
    
    const joinRes = await fetch('http://localhost:8787/queue/join', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log("Join Queue status:", joinRes.status);

    setTimeout(() => {
      if (conn1Received && conn2Received) {
        console.log("TEST PASSED: Both connections received the event from the DO Broadcaster!");
        wrangler.kill();
        process.exit(0);
      } else {
        console.error(`Test failed: conn1=${conn1Received}, conn2=${conn2Received}`);
        wrangler.kill();
        process.exit(1);
      }
    }, 2000);

  } catch (err) {
    console.error("Error triggering event:", err);
    wrangler.kill();
    process.exit(1);
  }
  
  setTimeout(() => {
    console.error("Test timeout");
    wrangler.kill();
    process.exit(1);
  }, 15000);
}

runTest();

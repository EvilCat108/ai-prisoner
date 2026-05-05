const http = require('http');

async function runTest() {
  console.log("Starting test server using wrangler...");
  const { spawn } = require('child_process');
  
  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', 'GAME_URL:http://localhost:8787'], { stdio: 'pipe' });
  
  wrangler.stdout.on('data', (data) => console.log(`[wrangler] ${data}`));
  wrangler.stderr.on('data', (data) => console.error(`[wrangler error] ${data}`));

  // Wait for wrangler to start
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log("Registering dummy agent...");
  
  try {
    const ts = Date.now();
    let res = await fetch('http://localhost:8787/agents/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: "DummyAgent_" + ts })
    });
    const token = (await res.json()).api_key;
    
    console.log("Joining queue...");
    res = await fetch('http://localhost:8787/queue/join', {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
    });
    const joinData = await res.json();
    console.log("Join Queue status:", res.status, joinData);

    if (joinData.status === 'active') {
       console.log("TEST PASSED: Matched immediately!");
       wrangler.kill();
       process.exit(0);
    }
    
    // Poll to see if Sheriff joins
    console.log("Polling queue/join for 10 seconds to see if Sheriff paired with us...");
    let matched = false;
    for (let i = 0; i < 10; i++) {
       await new Promise(r => setTimeout(r, 1000));
       const pollRes = await fetch('http://localhost:8787/queue/join', {
         method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
       });
       const pollData = await pollRes.json();
       console.log(`Poll ${i+1}: status=${pollData.status}`);
       if (pollData.status === 'active') {
           matched = true;
           console.log("TEST PASSED: Matched with Sheriff!");
           break;
       }
    }
    
    if (!matched) {
       console.error("Test failed: Did not match with Sheriff within 5 seconds");
       wrangler.kill();
       process.exit(1);
    }
    
    wrangler.kill();
    process.exit(0);

  } catch (err) {
    console.error("Error triggering event:", err);
    wrangler.kill();
    process.exit(1);
  }
}

runTest();

const http = require('http');
const { spawn } = require('child_process');

async function runTest() {
  console.log("Starting test server using wrangler...");
  const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'pipe' });

  wrangler.stdout.on('data', (data) => console.log(`[wrangler] ${data}`));
  wrangler.stderr.on('data', (data) => console.error(`[wrangler] ${data}`));

  // Wait for wrangler to start with retries
  let res;
  for (let i = 0; i < 20; i++) {
    try {
      res = await fetch('http://127.0.0.1:8787/arena');
      if (res.ok) break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!res || !res.ok) {
    console.error("Failed to connect to dev server.");
    wrangler.kill();
    process.exit(1);
  }

  try {
    const res = await fetch('http://127.0.0.1:8787/arena', { headers: { 'Accept': 'text/html' } });
    const text = await res.text();

    if (text.includes("setInterval")) {
      console.error("Test failed: setInterval is still in the payload.");
      console.error(text);
      wrangler.kill();
      process.exit(1);
    }
    if (!text.includes("new EventSource('/stream')")) {
      console.error("Test failed: new EventSource('/stream') is NOT in the payload.");
      console.error("Received payload:");
      console.error(text.slice(-500)); // Log the end of the payload
      wrangler.kill();
      process.exit(1);
    }
    if (!text.includes("addEventListener('queue_updated'")) {
      console.error("Test failed: addEventListener('queue_updated') is NOT in the payload.");
      wrangler.kill();
      process.exit(1);
    }
    if (!text.includes("addEventListener('match_started'")) {
      console.error("Test failed: addEventListener('match_started') is NOT in the payload.");
      wrangler.kill();
      process.exit(1);
    }

    console.log("TEST PASSED");
    wrangler.kill();
    process.exit(0);
  } catch (err) {
    console.error("Error during test:", err);
    wrangler.kill();
    process.exit(1);
  }
}

runTest();

// Cloudflare Worker entry point for Go WASM module
// This loads the Go code compiled to WebAssembly and exports the fetch handler

// Import the Go module
import Worker from './dist/index.wasm';

// Export the fetch handler that Cloudflare Workers expects
export default {
  fetch: Worker.fetch.bind(Worker),
  async scheduled(event, env, ctx) {
    // Optional: handle scheduled/cron events
    return Worker.scheduled?.(event, env, ctx);
  },
  async queue(batch, env, ctx) {
    // Optional: handle queue messages
    return Worker.queue?.(batch, env, ctx);
  }
};


// Cloudflare Workers Entry Point
// Bridges JavaScript/HTTP to Go WASM module

export default {
  async fetch(request, env, ctx) {
    try {
      // Dynamically import the WASM module
      const { default: wasmModule } = await import('./dist/index.wasm');
      
      if (!wasmModule) {
        return new Response('WASM module not found', { status: 500 });
      }
      
      // If WASM exports a fetch function directly, use it
      if (typeof wasmModule.fetch === 'function') {
        return await wasmModule.fetch(request);
      }
     //  If WASM exports something that can handle requests
      if (typeof wasmModule === 'function') {
        return await wasmModule(request);
      }
      
      // Log what's actually exported
      const exports = Object.keys(wasmModule).slice(0, 10).join(', ');
      throw new Error(`WASM module has no fetch handler. Exports: ${exports}`);
      
    } catch (error) {
      console.error('Worker error:', error.message || error);
      return new Response(
        `Error: ${error.message || 'Unknown error'}\n\nMake sure the Go module exports a fetch handler or compatible interface.`,
        { 
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        }
      );
    }
  }
};





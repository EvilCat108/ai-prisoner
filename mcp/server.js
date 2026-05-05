#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolsDir = path.join(__dirname, 'tools');

const server = new Server(
  {
    name: 'ai-prisoner-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const loadedTools = {};

async function loadTools() {
  if (!fs.existsSync(toolsDir)) return;
  const files = fs.readdirSync(toolsDir).filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const toolPath = path.join(toolsDir, file);
    try {
      const toolModule = await import(`file://${toolPath}`);
      if (toolModule.definition && toolModule.execute) {
        loadedTools[toolModule.definition.name] = toolModule;
      }
    } catch (e) {
      console.error(`Failed to load tool ${file}:`, e);
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Object.values(loadedTools).map(t => t.definition);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const tool = loadedTools[toolName];
  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }
  try {
    const result = await tool.execute(request.params.arguments);
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  await loadTools();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

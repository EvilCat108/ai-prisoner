export const definition = {
  name: 'ping',
  description: 'Test the MCP connection',
  inputSchema: {
    type: 'object',
    properties: {},
  }
};

export async function execute(args) {
  return "pong";
}

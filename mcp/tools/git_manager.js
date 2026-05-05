import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const definition = {
  name: "git_manager",
  description: "Executes predefined, safe Git operations instantly to avoid LLM bash latency.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "commit", "tag_and_push"],
        description: "The Git action to perform."
      },
      message: {
        type: "string",
        description: "Commit message. Required if action is 'commit'."
      },
      version: {
        type: "string",
        description: "Tag version (e.g., 'v1.0.1'). Required if action is 'tag_and_push'."
      }
    },
    required: ["action"]
  }
};

export async function execute(args) {
  let command = "";
  try {
    if (args.action === 'status') {
      command = "git status";
    } else if (args.action === 'commit') {
      if (!args.message) {
        throw new Error("The 'message' argument is required for the 'commit' action.");
      }
      // Note: Executing shell commands with user-provided strings can be unsafe.
      // However, per instructions, we map it directly.
      command = `git add . && git commit -m "${args.message.replace(/"/g, '\\"')}"`;
    } else if (args.action === 'tag_and_push') {
      if (!args.version) {
        throw new Error("The 'version' argument is required for the 'tag_and_push' action.");
      }
      command = `git tag -a ${args.version} -m "Release ${args.version}" && git push origin ${args.version} && git push origin --tags`;
    } else {
      throw new Error(`Unsupported action: ${args.action}`);
    }

    const { stdout, stderr } = await execAsync(command);
    const output = (stdout || '') + (stderr || '');
    
    return output;
  } catch (error) {
    const errorOutput = error.stdout || error.stderr || error.message;
    return `Error executing git command:\n${errorOutput}`;
  }
}

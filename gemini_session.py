#!/usr/bin/env python3
"""
Gemini session boilerplate mimicking a memory store attachment.

This creates a session that:
1. Loads GEMINI.md and local memory files as system instructions.
2. Instructs the model to check/update the store during tasks.
3. Uses the google-genai SDK.

Usage:
    python3 gemini_session.py

Setup:
    1. Ensure GEMINI_API_KEY is set in environment.
"""

import os
import sys
from pathlib import Path
from google import genai
from google.genai import types

def get_system_instruction():
    """Builds the system instruction from local project memory files."""
    brain_content = ""
    try:
        with open("GEMINI.md", "r") as f:
            brain_content = f.read()
    except FileNotFoundError:
        print("WARNING: Project Brain (GEMINI.md) not found. Initializing in 'Zero-Knowledge' mode.")

    memory_content = ""
    memory_dir = Path(".gemini/memory")
    if memory_dir.exists():
        for md_file in memory_dir.glob("*.md"):
            try:
                with open(md_file, "r") as f:
                    memory_content += f"\n--- {md_file.name} ---\n{f.read()}\n"
            except Exception as e:
                print(f"WARNING: Could not read {md_file}: {e}")

    base_instruction = """You are the Lead Architect of the Gambledon.ai project. 

YOUR OPERATING PROTOCOL:
1. BEFORE WRITING CODE: Reference the .gemini/skills/ folder to ensure brand and tech-stack alignment.
2. BEFORE RESPONDING: Consult the memory files provided below to avoid repeating past errors.
3. AFTER EVERY TASK: Write a brief summary of the change to .gemini/memory/incident-report.md or decision-log.md.

You are not just a chatbot; you are a stateful engineering agent."""

    instruction = f"{brain_content}\n\n{memory_content}\n\n{base_instruction}" if (brain_content or memory_content) else base_instruction
    return instruction

def create_session():
    """Create a Gemini chat session with project context loaded."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: GEMINI_API_KEY environment variable not set.")
        sys.exit(1)
        
    client = genai.Client()
    system_instruction = get_system_instruction()
    
    chat = client.chats.create(
        model="gemini-2.5-pro",
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.7
        )
    )
    return chat

def main():
    """Demonstrate session creation and interaction."""
    print("Creating Gemini session with local memory store...")
    try:
        chat = create_session()
        print("✓ System Instructions & Memory Loaded")
        print("✓ Gemini Client initialized")
        print("\nSession ready for use!")
        print("\nTo use this session in your code:")
        print("  from gemini_session import create_session")
        print("  chat = create_session()")
        print("  response = chat.send_message('Your prompt here')")
        print("  print(response.text)")
    except SystemExit:
        pass
    except Exception as e:
        print(f"ERROR creating session: {e}")

if __name__ == "__main__":
    main()

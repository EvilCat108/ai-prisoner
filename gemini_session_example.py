#!/usr/bin/env python3
"""
Example: Using Gemini session with local memory.

This shows how to:
1. Create a session initialized with the project's system instructions and memory.
2. Send messages to Gemini with persistent context.

Usage:
    python3 gemini_session_example.py

Setup:
    1. Ensure GEMINI_API_KEY is set in environment.
"""

import os
import sys
from gemini_session import create_session

def send_message(chat, user_message):
    """
    Send a message to Gemini using an established session.

    Args:
        chat: The chat session from create_session()
        user_message: The user's prompt

    Returns:
        Gemini's response text
    """
    response = chat.send_message(user_message)
    return response.text

def main():
    """Example: Multi-turn conversation with project context."""
    
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY environment variable not set.")
        sys.exit(1)

    print("Setting up Gemini session...\n")
    chat = create_session()
    print("Session created successfully.\n")

    # Example 1: Ask Gemini about the project
    print("=" * 60)
    print("Example 1: Reviewing project conventions")
    print("=" * 60)
    response = send_message(
        chat,
        "What are my primary colors and styling standards? "
        "Summarize the key points based on the project brain."
    )
    print(response)
    print()

    # Example 2: Ask a project-specific question
    print("=" * 60)
    print("Example 2: Project-specific task")
    print("=" * 60)
    response = send_message(
        chat,
        "I need to add a new API endpoint to the ai-prisoner game. "
        "Based on the project conventions, what file should I modify?"
    )
    print(response)
    print()

    # Example 3: Simulating memory update
    print("=" * 60)
    print("Example 3: Learning from task execution")
    print("=" * 60)
    response = send_message(
        chat,
        "I just learned that the D1 database bindings are stored in wrangler.toml. "
        "Please acknowledge this so you can remember it for future tasks."
    )
    print(response)
    print()

    print("✓ All examples complete.")

if __name__ == "__main__":
    main()

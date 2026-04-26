#!/usr/bin/env python3
"""
Create an Anthropic memory store for ai-prisoner project.

Usage:
    python3 create_memstore.py

This script:
1. Creates a memory store named "ai-prisoner-memory-store"
2. Seeds it with preferences.md (your coding style & conventions)
3. Prints the memstore ID to save for future sessions
"""

import os
import sys
from pathlib import Path
import anthropic

def main():
    # Read preferences file
    prefs_path = Path(__file__).parent / "preferences.md"
    if not prefs_path.exists():
        print(f"Error: {prefs_path} not found")
        sys.exit(1)

    with open(prefs_path, "r") as f:
        preferences_content = f.read()

    # Initialize Anthropic client with beta header
    client = anthropic.Anthropic(
        api_key=os.environ.get("ANTHROPIC_API_KEY")
    )

    # Create memory store
    print("Creating memory store...")
    # store = client.beta.memory_stores.create(
    #     name="ai-prisoner-memory-store",
    #     description="Coding style, project conventions, and preferences for ai-prisoner Prisoner's Dilemma arena",
    # )
    memstore_id = "memstore_01NoSbc4B9gRz6hqYDv5H6yU"
    print(f"✓ Memory store created: {memstore_id}")

    # Add preferences as a memory file
    print("Seeding memory store with preferences...")
    client.beta.memory_stores.memories.create(
        memstore_id,
        path="/preferences.md",
        content=preferences_content,
    )
    print("✓ Preferences file added to store")

    # Print memstore ID for saving
    print("\n" + "="*60)
    print("MEMORY STORE ID (save this for future sessions):")
    print(f"\n  {memstore_id}\n")
    print("="*60)
    print("\nTo use in future sessions, set environment variable:")
    print(f"  export ANTHROPIC_MEMSTORE_ID={memstore_id}")

    return memstore_id

if __name__ == "__main__":
    main()

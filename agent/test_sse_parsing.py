"""SSE frame parsing for the play.py listener.

Run with `python3 -m pytest agent/test_sse_parsing.py`, or `python3 agent/test_sse_parsing.py`
for the unittest path, which needs nothing but the standard library.

The server sends the event type in a separate `event:` field, ahead of the payload, so a
listener that reads only `data:` lines sees no type at all and printed `type=?` for every
event, the `round_advanced` that drives the next poll included.
"""
from __future__ import annotations

import json
import unittest


def sse_lines(frames: list[list[str]]) -> list[str]:
    """The parsing loop in `play.py`, over decoded frames.

    Kept here as the specification the listener follows: a blank line ends a frame, a line
    starting with `:` is a comment, `event:` names the type for the frame, and `data: ok` is
    the heartbeat. The payload's own `type` is the fallback, so payloads that carry one keep
    working.
    """
    out: list[str] = []
    event_type: str | None = None
    for lines in frames:
        for line in lines:
            if not line:
                event_type = None  # a blank line ends the frame
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event: "):
                event_type = line[7:].strip()
                continue
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "ok":
                continue
            try:
                event = json.loads(payload)
                if not isinstance(event, dict):
                    continue
                if event.get("match_id") == "m1":
                    out.append(f"type={event_type or event.get('type', '?')} round={event.get('round', '?')}")
            except Exception:
                pass
    return out


class TestSseFrames(unittest.TestCase):
    def test_one_frame_is_reported_with_its_event_type(self) -> None:
        frames = [["event: round_advanced", 'data: {"match_id": "m1", "round": 3}', ""]]
        self.assertEqual(["type=round_advanced round=3"], sse_lines(frames))

    def test_a_comment_between_the_fields_does_not_break_the_frame(self) -> None:
        # A proxy may insert a comment line; it must not be read as the start of a new frame.
        frames = [["event: round_advanced", ": keep-alive", 'data: {"match_id": "m1", "round": 3}', ""]]
        self.assertEqual(["type=round_advanced round=3"], sse_lines(frames))

    def test_two_frames_are_reported_separately(self) -> None:
        frames = [
            ["event: round_advanced", 'data: {"match_id": "m1", "round": 1}', ""],
            ["event: match_completed", 'data: {"match_id": "m1", "round": 2}', ""],
        ]
        self.assertEqual(
            ["type=round_advanced round=1", "type=match_completed round=2"], sse_lines(frames)
        )

    def test_the_heartbeat_is_skipped_and_the_next_frame_still_reports(self) -> None:
        frames = [["data: ok", ""], ["event: round_advanced", 'data: {"match_id": "m1", "round": 4}', ""]]
        self.assertEqual(["type=round_advanced round=4"], sse_lines(frames))

    def test_a_payload_carrying_its_own_type_is_still_reported(self) -> None:
        # Backwards compatible: no `event:` field means the payload's own type is used.
        frames = [['data: {"type": "polled", "match_id": "m1", "round": 5}', ""]]
        self.assertEqual(["type=polled round=5"], sse_lines(frames))

    def test_a_payload_that_is_not_an_object_does_not_raise(self) -> None:
        frames = [["event: x", 'data: "a string"', ""], ['data: {"match_id": "m1", "round": 9}', ""]]
        self.assertEqual(["type=? round=9"], sse_lines(frames))

    def test_another_match_is_ignored(self) -> None:
        frames = [["event: round_advanced", 'data: {"match_id": "OTHER", "round": 7}', ""]]
        self.assertEqual([], sse_lines(frames))


if __name__ == "__main__":
    unittest.main()

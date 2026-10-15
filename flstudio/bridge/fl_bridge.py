#!/usr/bin/env python3
"""Local MCP server: lets Claude send live MIDI to FL Studio through a virtual MIDI port.

Setup (on YOUR computer):
  pip install mcp mido python-rtmidi
  Windows: install loopMIDI, create a port named "Claude-FL".   Mac: enable IAC Driver, add a bus named "Claude-FL".
  FL Studio: Options > MIDI Settings > Input > enable "Claude-FL" (Controller type: generic, or leave blank).
             Select a channel (or the FPC) and arm recording / just listen.
  Claude Code: claude mcp add flstudio -- python /path/to/fl_bridge.py
Env: FL_MIDI_PORT overrides the port name (default "Claude-FL").
"""
import os, time
import mido
from mcp.server.fastmcp import FastMCP

PORT = os.environ.get("FL_MIDI_PORT", "Claude-FL")
mcp = FastMCP("flstudio")
_out = None


def out():
    global _out
    if _out is None:
        names = mido.get_output_names()
        match = [n for n in names if PORT.lower() in n.lower()]
        if not match:
            raise RuntimeError(f"MIDI port '{PORT}' not found. Available: {names}")
        _out = mido.open_output(match[0])
    return _out


@mcp.tool()
def list_ports() -> list[str]:
    """List MIDI output ports visible on this machine."""
    return mido.get_output_names()


@mcp.tool()
def play_notes(notes: list[int], seconds: float = 1.0, velocity: int = 100, channel: int = 0) -> str:
    """Play one chord/note group (MIDI note numbers) for `seconds`. Channel 9 = drums."""
    o = out()
    for n in notes: o.send(mido.Message("note_on", note=n, velocity=velocity, channel=channel))
    time.sleep(seconds)
    for n in notes: o.send(mido.Message("note_off", note=n, channel=channel))
    return "ok"


@mcp.tool()
def play_pattern(steps: list[dict], bpm: int = 112, channel: int = 0) -> str:
    """Play a sequence in real time. Each step: {"beat": float, "length": float, "note": int, "velocity": int}.
    Example drums (channel 9): kick note 36, snare 38, clap 39, closed hat 42."""
    o = out()
    ev = []
    for s in steps:
        ev.append((s["beat"], 1, s["note"], s.get("velocity", 100)))
        ev.append((s["beat"] + s.get("length", 0.25), 0, s["note"], 0))
    ev.sort(key=lambda e: (e[0], e[1]))
    spb, t0 = 60.0 / bpm, time.time()
    for beat, on, note, vel in ev:
        d = t0 + beat * spb - time.time()
        if d > 0: time.sleep(d)
        o.send(mido.Message("note_on" if on else "note_off", note=note, velocity=vel, channel=channel))
    return "ok"


@mcp.tool()
def play_midi_file(path: str, channel: int | None = None) -> str:
    """Play a .mid file (e.g. flstudio/3step/3step_drums_112bpm.mid) live into FL Studio."""
    o = out()
    for m in mido.MidiFile(path).play():
        if m.type in ("note_on", "note_off", "control_change", "pitchwheel"):
            if channel is not None: m = m.copy(channel=channel)
            o.send(m)
    return "ok"


@mcp.tool()
def control_change(cc: int, value: int, channel: int = 0) -> str:
    """Send a MIDI CC (e.g. map to a knob via FL's 'Link to controller')."""
    out().send(mido.Message("control_change", control=cc, value=value, channel=channel))
    return "ok"


@mcp.tool()
def all_notes_off() -> str:
    """Panic: silence everything."""
    o = out()
    for ch in range(16): o.send(mido.Message("control_change", control=123, value=0, channel=ch))
    return "ok"


if __name__ == "__main__":
    mcp.run()

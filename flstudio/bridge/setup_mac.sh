#!/bin/bash
echo "=== FL Studio bridge setup ==="
command -v python3 >/dev/null || { echo "Install Python from https://www.python.org/downloads/"; exit 1; }
python3 -m pip install --upgrade pip
python3 -m pip install mcp mido python-rtmidi || exit 1
echo; echo "MIDI ports visible:"
python3 -c "import mido; print(mido.get_output_names())"
echo; echo "If Claude-FL is missing: Audio MIDI Setup > Window > Show MIDI Studio > IAC Driver > tick 'Device is online' > add a bus named Claude-FL."
echo; echo "Register with Claude Code:"
echo "  claude mcp add flstudio -- python3 \"$(cd "$(dirname "$0")" && pwd)/fl_bridge.py\""

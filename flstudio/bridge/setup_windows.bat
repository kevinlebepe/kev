@echo off
echo === FL Studio bridge setup ===
python --version >nul 2>&1 || (echo Python not found. Install from https://www.python.org/downloads/ and tick "Add Python to PATH", then run this again. & pause & exit /b 1)
python -m pip install --upgrade pip
python -m pip install mcp mido python-rtmidi || (echo Install failed - see message above. & pause & exit /b 1)
echo.
echo MIDI ports visible:
python -c "import mido; print(mido.get_output_names())"
echo.
echo If Claude-FL is NOT listed: install loopMIDI (https://www.tobias-erichsen.de/software/loopmidi.html), add a port named Claude-FL, run this again.
echo.
echo To register with Claude Code run:
echo   claude mcp add flstudio -- python "%~dp0fl_bridge.py"
pause

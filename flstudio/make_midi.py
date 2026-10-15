#!/usr/bin/env python3
"""Generate .mid files for FL Studio (no dependencies).

Usage: python3 make_midi.py [--bpm 120] [--key C] [--scale minor] [--out out]
Drag the files from the output folder into the FL Studio playlist or piano roll.
"""
import argparse, os, random, struct

PPQ = 480
NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
SCALES = {"major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10]}


def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def write_midi(path, events, bpm, channel=0):
    """events: list of (start_beats, length_beats, pitch, velocity)."""
    msgs = []
    for start, length, pitch, vel in events:
        t0, t1 = int(start * PPQ), int((start + length) * PPQ)
        msgs.append((t0, 1, bytes([0x90 | channel, pitch, vel])))
        msgs.append((t1, 0, bytes([0x80 | channel, pitch, 0])))
    msgs.sort(key=lambda m: (m[0], m[1]))
    track = vlq(0) + b"\xff\x51\x03" + struct.pack(">I", 60_000_000 // bpm)[1:]
    last = 0
    for t, _, data in msgs:
        track += vlq(t - last) + data
        last = t
    track += vlq(0) + b"\xff\x2f\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ))
        f.write(b"MTrk" + struct.pack(">I", len(track)) + track)


def scale_note(root, scale, degree, octave):
    s = SCALES[scale]
    return 12 * (octave + 1) + root + s[degree % 7] + 12 * (degree // 7)


def chords(root, scale, bars=8):
    prog = [0, 5, 2, 6] if scale == "minor" else [0, 4, 5, 3]  # i-VI-III-VII / I-V-vi-IV
    ev = []
    for bar in range(bars):
        d = prog[bar % 4]
        for off in (0, 2, 4):
            ev.append((bar * 4, 4, scale_note(root, scale, d + off, 4), 90))
    return ev


def bass(root, scale, bars=8):
    prog = [0, 5, 2, 6] if scale == "minor" else [0, 4, 5, 3]
    ev = []
    for bar in range(bars):
        p = scale_note(root, scale, prog[bar % 4], 2)
        for i in range(8):
            ev.append((bar * 4 + i * 0.5, 0.45, p, 100 if i % 2 == 0 else 80))
    return ev


def melody(root, scale, bars=8, seed=1):
    rnd = random.Random(seed)
    ev, deg, t = [], 4, 0.0
    while t < bars * 4:
        deg = max(0, min(10, deg + rnd.choice([-2, -1, -1, 0, 1, 1, 2])))
        ln = rnd.choice([0.5, 0.5, 1, 1, 1.5])
        if rnd.random() > 0.15:
            ev.append((t, ln * 0.9, scale_note(root, scale, deg, 5), rnd.randint(75, 105)))
        t += ln
    return ev


def drums(bars=4):
    # GM/FPC-style mapping: 36 kick, 38 snare, 42 closed hat, 46 open hat
    ev = []
    for bar in range(bars):
        b = bar * 4
        for beat in range(4):
            ev.append((b + beat, 0.25, 36, 110))
        ev += [(b + 1, 0.25, 38, 105), (b + 3, 0.25, 38, 105)]
        for i in range(8):
            ev.append((b + i * 0.5, 0.2, 42, 70 if i % 2 else 90))
        ev.append((b + 3.5, 0.25, 46, 85))
    return ev


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bpm", type=int, default=120)
    ap.add_argument("--key", default="C", choices=NOTES)
    ap.add_argument("--scale", default="minor", choices=SCALES)
    ap.add_argument("--out", default="out")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    r = NOTES[a.key]
    tag = f"{a.key}{a.scale}_{a.bpm}bpm"
    for name, ev, ch in [("chords", chords(r, a.scale), 0), ("bass", bass(r, a.scale), 0),
                         ("melody", melody(r, a.scale, seed=a.seed), 0), ("drums", drums(), 9)]:
        p = os.path.join(a.out, f"{name}_{tag}.mid")
        write_midi(p, ev, a.bpm, ch)
        print(p)

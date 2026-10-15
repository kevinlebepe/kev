#!/usr/bin/env python3
"""Synthesize 3-step / amapiano-style one-shots (WAV) and a drum loop (MIDI). No dependencies."""
import math, os, random, struct, wave
from make_midi import write_midi

SR = 44100
OUT = "3step"


def save(name, samples, gain=0.9):
    peak = max(1e-9, max(abs(s) for s in samples))
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s / peak * gain)) * 32767)) for s in samples))
    return path


def env(i, n, a=0.002, k=6.0):
    t = i / SR
    return min(1, t / a) * math.exp(-k * i / n)


def kick():
    n, ph, out = int(SR * 0.55), 0.0, []
    for i in range(n):
        f = 45 + 150 * math.exp(-i / SR * 30)
        ph += 2 * math.pi * f / SR
        out.append(math.tanh(2.0 * math.sin(ph)) * env(i, n, 0.001, 5))
    return out


def snare():
    r, n, out, ph = random.Random(1), int(SR * 0.3), [], 0.0
    for i in range(n):
        ph += 2 * math.pi * 190 / SR
        out.append((0.5 * math.sin(ph) + r.uniform(-1, 1)) * env(i, n, 0.001, 9))
    return out


def clap():
    r, n, out = random.Random(2), int(SR * 0.35), []
    bursts = [0, 0.011, 0.022]
    for i in range(n):
        t = i / SR
        e = sum(math.exp(-(t - b) * 90) for b in bursts if t >= b) * 0.5 + math.exp(-t * 18)
        out.append(r.uniform(-1, 1) * e)
    return out


def hat(length, k):
    r, n, out, lp = random.Random(3), int(SR * length), [], 0.0
    for i in range(n):
        x = r.uniform(-1, 1); lp = 0.2 * lp + 0.8 * x  # crude high-pass emphasis
        out.append((x - 0.5 * lp) * env(i, n, 0.0005, k))
    return out


def shaker():
    r, n, out = random.Random(4), int(SR * 0.12), []
    for i in range(n):
        t = i / n
        out.append(r.uniform(-1, 1) * math.sin(math.pi * min(1, t * 1.6)) * math.exp(-4 * t))
    return out


def logdrum(f0=110):
    n, ph, out = int(SR * 0.7), 0.0, []
    for i in range(n):
        f = f0 * (1 + 0.5 * math.exp(-i / SR * 40))
        ph += 2 * math.pi * f / SR
        s = math.sin(ph) + 0.35 * math.sin(2 * ph) + 0.15 * math.sin(3 * ph)
        out.append(math.tanh(1.5 * s) * env(i, n, 0.001, 4.5))
    return out


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, s in [("kick", kick()), ("snare", snare()), ("clap", clap()), ("hat_closed", hat(0.08, 7)),
                    ("hat_open", hat(0.4, 6)), ("shaker", shaker()), ("logdrum_A2", logdrum(110))]:
        print(save(name, s))

    # 16-step grid, 1 step = 0.25 beat. 3-step kick: a hit every 3 steps.
    bpm, bars, ev = 112, 4, []
    for bar in range(bars):
        b = bar * 4
        for st in (0, 3, 6, 9, 12):
            ev.append((b + st * .25, .25, 36, 115 if st == 0 else 100))
        for st in (4, 12):
            ev.append((b + st * .25, .25, 38, 105))
            ev.append((b + st * .25, .25, 39, 95))
        for st in range(16):
            ev.append((b + st * .25, .1, 70, 55 + (20 if st % 2 else 0)))      # shaker
        for st in (2, 6, 10, 14):
            ev.append((b + st * .25, .1, 42, 80))                               # closed hat
        ev.append((b + 15 * .25, .2, 46, 80))                                   # open hat
        for st, p in ((0, 45), (3, 45), (6, 48), (10, 43), (13, 45)):           # log drum line (A2,C3,G2)
            ev.append((b + st * .25, .5, p, 100))
    write_midi(os.path.join(OUT, "3step_drums_112bpm.mid"), ev, bpm, 9)
    print("MIDI map: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 70 shaker, 43-48 log drum")

// The candidate's side of a live call from the invigilator (MVP 6 and 7).
// The invigilator makes the offer; this side answers with the camera and
// microphone the exam already uses, and plays the invigilator's voice if
// they speak. Signals travel through the API; the audio and video go
// directly between the two computers.

export interface Signal {
  id: number;
  type: 'offer' | 'answer' | 'ice';
  payload: Record<string, unknown>;
}

export interface SignalChannel {
  send(type: 'answer' | 'ice', payload: Record<string, unknown>): Promise<void>;
  poll(after: number): Promise<{ status: string; signals: Signal[] }>;
}

export class CandidateCall {
  private pc: RTCPeerConnection | null = null;
  private after = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    private readonly opts: {
      channel: SignalChannel;
      /** The camera and microphone stream the exam records, if it has one. */
      media: MediaStream | null;
      onRemoteAudio(stream: MediaStream): void;
      onEnded(): void;
      pollMs?: number;
    },
  ) {}

  start(iceServers: RTCIceServer[]): void {
    if (this.stopped) return;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of this.opts.media?.getTracks() ?? []) pc.addTrack(track, this.opts.media!);
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.opts.channel.send('ice', e.candidate.toJSON() as unknown as Record<string, unknown>).catch(() => undefined);
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') this.opts.onRemoteAudio(e.streams[0] ?? new MediaStream([e.track]));
    };
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.pc) return;
    try {
      const { status, signals } = await this.opts.channel.poll(this.after);
      for (const s of signals) {
        this.after = Math.max(this.after, s.id);
        await this.handle(s);
      }
      if (status !== 'open') {
        this.stop();
        this.opts.onEnded();
        return;
      }
    } catch {
      // A missed poll is retried; the call does not depend on any single one.
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.opts.pollMs ?? 1000);
  }

  private async handle(s: Signal): Promise<void> {
    const pc = this.pc!;
    if (s.type === 'offer') {
      await pc.setRemoteDescription(s.payload as unknown as RTCSessionDescriptionInit);
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.opts.channel.send('answer', pc.localDescription!.toJSON() as unknown as Record<string, unknown>);
    } else if (s.type === 'ice') {
      const candidate = s.payload as RTCIceCandidateInit;
      if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => undefined);
      else this.pendingIce.push(candidate);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // The exam's own camera stream keeps running for the recording: only the connection closes.
    this.pc?.close();
    this.pc = null;
  }
}

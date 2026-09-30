import { request } from './api';

// The invigilator's side of a live call. It asks for the candidate's camera
// and microphone, and with voice also sends the invigilator's microphone.
// Signals travel through the API; the audio and video go directly between
// the two computers.

interface Signal {
  id: number;
  type: 'offer' | 'answer' | 'ice';
  payload: Record<string, unknown>;
}

export type CallState = 'connecting' | 'live' | 'ended' | 'failed';

export class StaffCall {
  private pc: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private after = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private callId: string | null = null;

  constructor(
    private readonly opts: {
      attemptId: string;
      voice: boolean;
      onStream(stream: MediaStream): void;
      onState(state: CallState, detail?: string): void;
    },
  ) {}

  async start(): Promise<void> {
    try {
      if (this.opts.voice) this.mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const [{ iceServers }, call] = await Promise.all([
        request<{ iceServers: RTCIceServer[] }>('GET', '/live/ice-servers'),
        request<{ id: string }>('POST', `/live/attempts/${this.opts.attemptId}/calls`, { voice: this.opts.voice }),
      ]);
      if (this.stopped) return void this.end();
      this.callId = call.id;
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      if (this.mic) for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      const remote = new MediaStream();
      pc.ontrack = (e) => {
        remote.addTrack(e.track);
        this.opts.onStream(remote);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) void this.signal('ice', e.candidate.toJSON() as unknown as Record<string, unknown>).catch(() => undefined);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') this.opts.onState('live');
        if (pc.connectionState === 'failed') this.opts.onState('failed', 'The connection could not be made. A TURN server may be needed on this network.');
      };
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal('offer', pc.localDescription!.toJSON() as unknown as Record<string, unknown>);
      this.opts.onState('connecting');
      void this.poll();
    } catch (err) {
      this.opts.onState('failed', (err as Error).message);
      this.cleanup();
    }
  }

  private signal(type: 'offer' | 'ice', payload: Record<string, unknown>) {
    return request('POST', `/live/calls/${this.callId}/signals`, { type, payload });
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.pc || !this.callId) return;
    try {
      const { status, signals } = await request<{ status: string; signals: Signal[] }>('GET', `/live/calls/${this.callId}/signals?after=${this.after}`);
      for (const s of signals) {
        this.after = Math.max(this.after, s.id);
        if (s.type === 'answer') await this.pc.setRemoteDescription(s.payload as unknown as RTCSessionDescriptionInit);
        else if (s.type === 'ice') await this.pc.addIceCandidate(s.payload as RTCIceCandidateInit).catch(() => undefined);
      }
      if (status !== 'open') {
        this.cleanup();
        this.opts.onState('ended');
        return;
      }
    } catch {
      // Tried again on the next poll.
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), 1000);
  }

  private cleanup(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.pc?.close();
    this.pc = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  async end(): Promise<void> {
    const id = this.callId;
    this.cleanup();
    this.opts.onState('ended');
    if (id) await request('POST', `/live/calls/${id}/end`).catch(() => undefined);
  }
}

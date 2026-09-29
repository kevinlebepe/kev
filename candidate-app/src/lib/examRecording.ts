import { ApiError, request, sendBlob } from './api';
import type { DesktopApi } from './desktop';
import { frameGrabber, onStreamEnded, recorderFor, stopStream } from './media';
import { FrameRecorder, type Piece, PieceUploader, RecordingSession, SegmentRecorder, sha256Hex, type StreamKind } from './recording';

export const SEGMENT_MS = 30_000;
export const SCREEN_FRAME_MS = 10_000;
export const SNAPSHOT_MS = 15_000;

export interface Needs {
  camera: boolean;
  microphone: boolean;
  screen: boolean;
}

/** Which streams an exam asks for. Mirrors the server's rule. */
export function streamsFor(needs: Needs): StreamKind[] {
  const streams: StreamKind[] = [];
  if (needs.camera) streams.push('camera');
  else if (needs.microphone) streams.push('audio');
  if (needs.screen) streams.push('screen');
  return streams;
}

export interface ExamRecording {
  session: RecordingSession;
  /** Stops everything and releases the camera and screen, after the last pieces are sent. */
  finish(): Promise<{ complete: boolean }>;
}

/**
 * Starts every recording the exam asks for. The camera and the screen share
 * are opened by the caller; the desktop application supplies screen pictures
 * of its locked window instead of a screen share.
 */
export function startExamRecording(opts: {
  attemptId: string;
  needs: Needs;
  camera: MediaStream | null;
  screen: MediaStream | null;
  desktop: DesktopApi | null;
  /** The next piece number of each stream, from the server, when the exam is reopened. */
  next: Partial<Record<StreamKind, number>>;
  onPending(pending: number): void;
  /** A recording stopped during the exam, for example because sharing was ended. */
  onStopped(stream: StreamKind): void;
}): ExamRecording {
  const uploader = new PieceUploader({
    send: async (p: Piece) =>
      sendBlob(`/attempts/${opts.attemptId}/recording/${p.stream}/${p.sequence}`, p.blob, {
        'x-chunk-sha256': await sha256Hex(p.blob),
        'x-chunk-start': p.start.toISOString(),
        'x-chunk-end': p.end.toISOString(),
      }),
    // 400/404/409/413: the server will never take this piece, so keep going with the rest.
    isFatal: (err) => err instanceof ApiError && [400, 404, 409, 413, 415].includes(err.status),
    onChange: opts.onPending,
  });
  const add = (p: Piece) => uploader.add(p);
  const sources: ConstructorParameters<typeof RecordingSession>[0] = [];
  const cleanups: (() => void)[] = [];
  let snapshotStop: (() => void) | null = null;

  const cameraKind: StreamKind | null = opts.needs.camera ? 'camera' : opts.needs.microphone ? 'audio' : null;
  if (cameraKind && opts.camera) {
    sources.push({ stream: cameraKind, recorder: new SegmentRecorder({ stream: cameraKind, createRecorder: recorderFor(opts.camera, 250_000), segmentMs: SEGMENT_MS, onPiece: add, firstSequence: opts.next[cameraKind] ?? 0 }) });
    cleanups.push(onStreamEnded(opts.camera, () => opts.onStopped(cameraKind)));
    if (opts.needs.camera) {
      // A still for the live console, best effort: a failed one is simply replaced by the next.
      const grab = frameGrabber(opts.camera, 320);
      const id = setInterval(async () => {
        const blob = await grab().catch(() => null);
        if (blob) await sendBlob(`/attempts/${opts.attemptId}/snapshot`, blob, {}).catch(() => undefined);
      }, SNAPSHOT_MS);
      snapshotStop = () => clearInterval(id);
    }
  }
  if (opts.needs.screen) {
    const captureScreen = opts.desktop?.captureScreen?.bind(opts.desktop);
    if (captureScreen) {
      sources.push({
        stream: 'screen',
        recorder: new FrameRecorder({
          stream: 'screen',
          everyMs: SCREEN_FRAME_MS,
          onPiece: add,
          firstSequence: opts.next.screen ?? 0,
          capture: async () => {
            const bytes = await captureScreen();
            return bytes ? new Blob([bytes as BlobPart], { type: 'image/jpeg' }) : null;
          },
        }),
      });
    } else if (opts.screen) {
      sources.push({ stream: 'screen', recorder: new SegmentRecorder({ stream: 'screen', createRecorder: recorderFor(opts.screen, 400_000), segmentMs: SEGMENT_MS, onPiece: add, firstSequence: opts.next.screen ?? 0 }) });
      cleanups.push(onStreamEnded(opts.screen, () => opts.onStopped('screen')));
    }
  }

  const session = new RecordingSession(sources, uploader, (streams) =>
    request('POST', `/attempts/${opts.attemptId}/recording/complete`, { streams }).then(() => undefined),
  );
  session.start();
  const online = () => uploader.retryNow();
  window.addEventListener('online', online);

  let finishing: Promise<{ complete: boolean }> | null = null;
  return {
    session,
    finish() {
      finishing ??= (async () => {
        snapshotStop?.();
        cleanups.forEach((c) => c());
        const result = await session.finish();
        window.removeEventListener('online', online);
        stopStream(opts.camera);
        stopStream(opts.screen);
        return result;
      })();
      return finishing;
    },
  };
}

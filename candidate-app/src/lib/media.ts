// Access to the camera, microphone and screen for recording. Only this file
// touches MediaRecorder and friends, so the recording logic stays testable.

import type { RecorderLike } from './recording';

const VIDEO_TYPES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

function pickType(media: MediaStream): string | undefined {
  const list = media.getVideoTracks().length ? VIDEO_TYPES : AUDIO_TYPES;
  return list.find((t) => MediaRecorder.isTypeSupported(t));
}

/** A MediaRecorder at a modest bit rate: evidence, not broadcast quality. */
export function recorderFor(media: MediaStream, videoBitsPerSecond: number): () => RecorderLike {
  const mimeType = pickType(media);
  return () => new MediaRecorder(media, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond, audioBitsPerSecond: 32_000 }) as unknown as RecorderLike;
}

export async function openCamera(camera: boolean, microphone: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: camera ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 10 } } : false,
    audio: microphone,
  });
}

export function screenShareSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Asks to share the whole screen. Sharing only a window or a tab is refused. */
export async function openScreen(): Promise<MediaStream> {
  const media = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor', frameRate: { ideal: 5, max: 10 } } as MediaTrackConstraints,
    audio: false,
  });
  const surface = (media.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  if (surface && surface !== 'monitor') {
    media.getTracks().forEach((t) => t.stop());
    throw new Error('Share your entire screen, not a window or a tab.');
  }
  return media;
}

/** Calls back once when any track of the stream ends, for example when sharing is stopped. */
export function onStreamEnded(media: MediaStream, callback: () => void): () => void {
  let fired = false;
  const handler = () => {
    if (!fired) {
      fired = true;
      callback();
    }
  };
  const tracks = media.getTracks();
  tracks.forEach((t) => t.addEventListener('ended', handler));
  return () => tracks.forEach((t) => t.removeEventListener('ended', handler));
}

/** Returns a function that takes a JPEG still from a video stream. */
export function frameGrabber(media: MediaStream, maxWidth = 480): () => Promise<Blob | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = media;
  const playing = video.play().catch(() => undefined);
  const canvas = document.createElement('canvas');
  return async () => {
    await playing;
    if (!video.videoWidth) return null;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.6));
  };
}

export function stopStream(media: MediaStream | null | undefined): void {
  media?.getTracks().forEach((t) => t.stop());
}

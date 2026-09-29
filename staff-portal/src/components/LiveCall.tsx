import { useEffect, useRef, useState } from 'react';
import { type CallState, StaffCall } from '../lib/liveCall';
import { can, useMe } from '../lib/session';

/** Watch a candidate's camera live, and talk to them with the voice permission. */
export function LiveCallControls({ attemptId }: { attemptId: string }) {
  const me = useMe();
  const [state, setState] = useState<{ state: CallState; voice: boolean; detail?: string } | null>(null);
  const callRef = useRef<StaffCall | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Leaving the panel, or picking another candidate, ends the call.
  useEffect(
    () => () => {
      void callRef.current?.end();
      callRef.current = null;
    },
    [attemptId],
  );

  function start(voice: boolean) {
    void callRef.current?.end();
    const call = new StaffCall({
      attemptId,
      voice,
      onStream: (stream) => {
        if (videoRef.current && videoRef.current.srcObject !== stream) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      },
      onState: (s, detail) => setState({ state: s, voice, ...(detail ? { detail } : {}) }),
    });
    callRef.current = call;
    setState({ state: 'connecting', voice });
    void call.start();
  }

  const active = state && (state.state === 'connecting' || state.state === 'live');
  return (
    <div className="live-call">
      <video ref={videoRef} className={`live-video ${active ? '' : 'hidden'}`} autoPlay playsInline aria-label="Live camera of the candidate" />
      {active && (
        <p className="small">
          {state.state === 'live' ? '● Live' : 'Connecting…'} {state.voice ? '· the candidate can hear you' : '· the candidate cannot hear you'}. The candidate is shown that
          you are watching.
        </p>
      )}
      {state?.state === 'failed' && (
        <p className="error small" role="alert">
          {state.detail ?? 'The call could not be made.'}
        </p>
      )}
      <div className="row">
        {!active && <button onClick={() => start(false)}>Watch live</button>}
        {!active && can(me, 'live:voice') && <button onClick={() => start(true)}>Talk to the candidate</button>}
        {active && (
          <button
            className="danger"
            onClick={() => {
              void callRef.current?.end();
              callRef.current = null;
            }}
          >
            End call
          </button>
        )}
      </div>
    </div>
  );
}

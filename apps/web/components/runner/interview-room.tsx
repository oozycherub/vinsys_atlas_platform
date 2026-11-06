'use client';

import { Room, RoomEvent, Track } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * The AI interview room (LiveKit). The candidate publishes audio only; the interviewer's audio
 * plays through an <audio> element; captions arrive as data messages and are shown as text.
 */
export function InterviewRoom({ sessionId, token }: { sessionId: string; token: string }) {
  const [state, setState] = useState<'idle' | 'joining' | 'live' | 'ended' | 'error'>('idle');
  const [captions, setCaptions] = useState<string[]>([]);
  const room = useRef<Room | null>(null);
  const audio = useRef<HTMLDivElement>(null);

  useEffect(() => () => void room.current?.disconnect(), []);

  const join = async () => {
    setState('joining');
    try {
      const r = await api.interview.POST('/v1/interview-sessions/{session_id}:join', {
        params: { path: { session_id: sessionId } },
        headers: { Authorization: `Interview ${token}` },
      });
      const j = r.data as { livekit_url: string | null; livekit_token: string | null } | undefined;
      if (!j?.livekit_url || !j.livekit_token) throw new Error('voice unavailable');
      const rm = new Room({ adaptiveStream: true });
      rm.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) audio.current?.appendChild(track.attach());
      });
      rm.on(RoomEvent.DataReceived, (payload) =>
        setCaptions((c) => [...c.slice(-20), new TextDecoder().decode(payload)]),
      );
      rm.on(RoomEvent.Disconnected, () => setState('ended'));
      await rm.connect(j.livekit_url, j.livekit_token);
      await rm.localParticipant.setMicrophoneEnabled(true);
      room.current = rm;
      setState('live');
    } catch {
      setState('error');
    }
  };

  return (
    <section aria-label="AI interview" className="rounded-md border border-slate-200 p-4">
      {state === 'idle' || state === 'error' ? (
        <Button onClick={() => void join()}>
          {state === 'error' ? 'Try joining again' : 'Join the interview'}
        </Button>
      ) : null}
      {state === 'joining' ? <p role="status">Connecting…</p> : null}
      {state === 'live' ? (
        <>
          <p role="status" className="mb-2 text-sm">
            You are connected. Speak naturally; answer one question at a time.
          </p>
          <Button variant="secondary" onClick={() => void room.current?.disconnect()}>
            Leave
          </Button>
        </>
      ) : null}
      {state === 'ended' ? <p role="status">The interview has ended.</p> : null}
      <div ref={audio} hidden />
      <div aria-live="polite" className="mt-3 max-h-40 overflow-y-auto text-sm">
        {captions.map((c, i) => (
          <p key={i}>{c}</p>
        ))}
      </div>
    </section>
  );
}

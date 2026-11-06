'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';

/** Camera and microphone check before a proctored assessment (PRD §2.3b pre-check). */
export function Precheck({ onReady }: { onReady: (stream: MediaStream | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const [micWarning, setMicWarning] = useState(false);

  /** Camera first; the microphone separately, so a stuck audio device cannot hang the check. */
  const check = async () => {
    setProblem(null);
    setMicWarning(false);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      const audio = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (audio) audio.getAudioTracks().forEach((t) => s.addTrack(t));
      else setMicWarning(true);
      setStream(s);
      if (video.current) video.current.srcObject = s;
    } catch {
      setProblem('We could not use your camera. Allow access in your browser, then check again.');
    }
  };

  return (
    <section
      aria-labelledby="precheck-title"
      className="rounded-lg border border-slate-200 bg-white p-6"
    >
      <h2 id="precheck-title" className="mb-3 text-xl font-semibold">
        Before you start
      </h2>
      <p className="mb-4 text-sm">
        This assessment is proctored. Your camera and microphone are sampled during the test; a
        person reviews anything flagged.
      </p>
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        className="mb-4 h-48 w-64 rounded bg-slate-900"
        aria-label="Camera preview"
      />
      {problem ? (
        <p role="alert" className="mb-3 text-sm text-red-800">
          {problem}
        </p>
      ) : null}
      {micWarning ? (
        <p role="status" className="mb-3 text-sm text-amber-900">
          Your microphone did not respond. You can continue; voice checks will be off unless you fix
          it and check again.
        </p>
      ) : null}
      <div className="mb-4 flex items-center gap-2">
        <input
          id="consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <label htmlFor="consent" className="text-sm">
          I agree to camera, microphone and activity monitoring for this assessment.
        </label>
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => void check()}>
          {stream ? 'Check again' : 'Check camera and microphone'}
        </Button>
        <Button onClick={() => onReady(stream)} disabled={!consent || !stream}>
          Continue
        </Button>
      </div>
    </section>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, browserTimezone } from '../api';
import { LocationPicker } from '../components/LocationPicker';
import { Alert, Button, Heading, inputClass, Muted } from '../components/ui';
import { useMe } from '../hooks';

/**
 * Onboarding (spec 04-design): three steps to a first brief in under five minutes (G4).
 * 1. Where you are. 2. Telegram, or skip. 3. Brief and reveal times.
 */
export function Onboarding() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const hasPlace = (me.data?.locations.length ?? 0) > 0;
  const [step, setStep] = useState<1 | 2 | 3>(hasPlace ? 2 : 1);
  const [briefTime, setBriefTime] = useState(me.data?.user.briefTime ?? '06:30');
  const [revealTime, setRevealTime] = useState(me.data?.user.revealTime ?? '21:00');
  const [link, setLink] = useState<string | null>(null);

  const addPlace = useMutation({
    mutationFn: api.addLocation,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      setStep(2);
    },
  });
  const makeLink = useMutation({ mutationFn: api.telegramLink, onSuccess: (r) => setLink(r.url) });
  const finish = useMutation({
    mutationFn: () => api.updateMe({ briefTime, revealTime, tz: browserTimezone(), onboarded: true }),
    onSuccess: async (data) => {
      qc.setQueryData(['me'], data);
      await qc.invalidateQueries({ queryKey: ['brief'] });
      await navigate({ to: '/' });
    },
  });

  return (
    <section aria-labelledby="onboarding-heading" className="max-w-md">
      <p className="text-sm text-[var(--color-muted)]">Step {step} of 3</p>
      {step === 1 && (
        <>
          <Heading id="onboarding-heading">Where are you?</Heading>
          <Muted className="mt-2 mb-6">Weather and air questions need a place. Reckon stores it rounded to about 1 km.</Muted>
          <LocationPicker defaultName="Home" busy={addPlace.isPending} onPick={(p) => addPlace.mutate({ ...p, isPrimary: true })} />
          {addPlace.isPending && <Muted className="mt-4">Writing your first questions…</Muted>}
          {addPlace.isError && <Alert>{addPlace.error.message}</Alert>}
        </>
      )}

      {step === 2 && (
        <>
          <Heading id="onboarding-heading">Get the brief on Telegram</Heading>
          <Muted className="mt-2">One message in the morning, one at the reveal. Nothing else, ever.</Muted>
          <div className="mt-6 flex flex-wrap gap-3">
            {me.data?.telegramAvailable ? (
              link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center rounded-full bg-[#229ED9] px-5 text-sm font-medium text-white"
                >
                  Open Telegram and tap Start
                </a>
              ) : (
                <Button onClick={() => makeLink.mutate()} disabled={makeLink.isPending}>
                  Link Telegram
                </Button>
              )
            ) : (
              <Muted className="text-sm">Telegram is not configured on this server. The app works fully without it.</Muted>
            )}
            <Button variant="quiet" onClick={() => setStep(3)}>
              {link ? 'Done' : 'Skip for now'}
            </Button>
          </div>
          {link && <Muted className="mt-3 text-sm">The link works once and expires in 30 minutes.</Muted>}
          {makeLink.isError && <Alert>{makeLink.error.message}</Alert>}
        </>
      )}

      {step === 3 && (
        <>
          <Heading id="onboarding-heading">When suits you?</Heading>
          <Muted className="mt-2">Times are in {browserTimezone()}. You can change them any time in Settings.</Muted>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <label className="text-sm text-[var(--color-muted)]">
              Morning brief
              <input type="time" className={`${inputClass} mt-1`} value={briefTime} onChange={(e) => setBriefTime(e.target.value)} required />
            </label>
            <label className="text-sm text-[var(--color-muted)]">
              Evening reveal
              <input type="time" className={`${inputClass} mt-1`} value={revealTime} onChange={(e) => setRevealTime(e.target.value)} required />
            </label>
          </div>
          <Button className="mt-6" onClick={() => finish.mutate()} disabled={finish.isPending}>
            Show my brief
          </Button>
          {finish.isError && <Alert>{finish.error.message}</Alert>}
        </>
      )}
    </section>
  );
}

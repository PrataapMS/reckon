import type { MeResponse } from '@reckon/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api, browserTimezone } from '../api';
import { LocationPicker } from '../components/LocationPicker';
import { Alert, Button, Card, Heading, inputClass, Muted, SectionTitle } from '../components/ui';
import { useMe } from '../hooks';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push';

function Times({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    briefTime: me.user.briefTime,
    revealTime: me.user.revealTime,
    quietStart: me.user.quietStart,
    quietEnd: me.user.quietEnd,
    tz: me.user.tz,
    rain: Math.round((me.user.settings.actionThresholds?.rain ?? 0.5) * 100),
    aqi: Math.round((me.user.settings.actionThresholds?.aqi ?? 0.5) * 100),
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateMe({
        briefTime: form.briefTime,
        revealTime: form.revealTime,
        quietStart: form.quietStart,
        quietEnd: form.quietEnd,
        tz: form.tz,
        settings: { actionThresholds: { rain: form.rain / 100, aqi: form.aqi / 100 } },
      }),
    onSuccess: async (data) => {
      qc.setQueryData(['me'], data);
      await qc.invalidateQueries({ queryKey: ['brief'] });
    },
  });
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: typeof f[key] === 'number' ? Number(e.target.value) : e.target.value })),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="mt-3 grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-[var(--color-muted)]">
        Morning brief
        <input type="time" className={`${inputClass} mt-1`} required {...field('briefTime')} />
      </label>
      <label className="text-sm text-[var(--color-muted)]">
        Evening reveal
        <input type="time" className={`${inputClass} mt-1`} required {...field('revealTime')} />
      </label>
      <label className="text-sm text-[var(--color-muted)]">
        Quiet hours start
        <input type="time" className={`${inputClass} mt-1`} required {...field('quietStart')} />
      </label>
      <label className="text-sm text-[var(--color-muted)]">
        Quiet hours end
        <input type="time" className={`${inputClass} mt-1`} required {...field('quietEnd')} />
      </label>
      <label className="text-sm text-[var(--color-muted)]">
        Umbrella tip from (% chance of rain)
        <input type="number" min={5} max={95} className={`${inputClass} mt-1`} {...field('rain')} />
      </label>
      <label className="text-sm text-[var(--color-muted)]">
        Mask tip from (% chance of AQI above 150)
        <input type="number" min={5} max={95} className={`${inputClass} mt-1`} {...field('aqi')} />
      </label>
      <label className="text-sm text-[var(--color-muted)] sm:col-span-2">
        Timezone
        <div className="mt-1 flex gap-2">
          <input className={inputClass} required {...field('tz')} />
          <Button variant="quiet" onClick={() => setForm((f) => ({ ...f, tz: browserTimezone() }))}>
            Use this device's
          </Button>
        </div>
      </label>
      <div className="sm:col-span-2 flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-[var(--color-muted)]">Saved. New times apply from the next brief.</span>}
      </div>
      {save.isError && <Alert>{save.error.message}</Alert>}
    </form>
  );
}

function Places({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['me'] });
  const add = useMutation({
    mutationFn: api.addLocation,
    onSuccess: async () => {
      await refresh();
      setAdding(false);
    },
  });
  const remove = useMutation({ mutationFn: api.removeLocation, onSuccess: refresh });
  const primary = useMutation({ mutationFn: (id: string) => api.updateLocation(id, { isPrimary: true }), onSuccess: refresh });

  return (
    <div className="mt-3">
      <ul className="divide-y divide-[var(--color-line)]">
        {me.locations.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span>
              {l.name} {l.isPrimary && <span className="text-xs text-[var(--color-muted)]">(primary)</span>}
              <span className="block text-xs text-[var(--color-muted)]">
                {l.lat.toFixed(2)}, {l.lon.toFixed(2)} · {l.tz}
              </span>
            </span>
            <span className="flex gap-2">
              {!l.isPrimary && (
                <Button variant="quiet" onClick={() => primary.mutate(l.id)}>
                  Make primary
                </Button>
              )}
              {me.locations.length > 1 && (
                <Button variant="danger" onClick={() => remove.mutate(l.id)} aria-label={`Remove ${l.name}`}>
                  Remove
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {me.locations.length < 3 &&
        (adding ? (
          <Card className="mt-3">
            <LocationPicker defaultName="Work" busy={add.isPending} onPick={(p) => add.mutate(p)} />
          </Card>
        ) : (
          <Button variant="quiet" className="mt-3" onClick={() => setAdding(true)}>
            Add a place
          </Button>
        ))}
      {(add.error ?? remove.error ?? primary.error) && <Alert>{(add.error ?? remove.error ?? primary.error)?.message}</Alert>}
    </div>
  );
}

function Telegram({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const makeLink = useMutation({ mutationFn: api.telegramLink, onSuccess: (r) => setLink(r.url) });
  const pause = useMutation({ mutationFn: (paused: boolean) => api.updateMe({ paused }), onSuccess: (d) => qc.setQueryData(['me'], d) });

  if (!me.telegramAvailable)
    return <Muted className="mt-3 text-sm">Telegram is not configured on this server (set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME).</Muted>;
  return (
    <div className="mt-3 space-y-3">
      <p>{me.user.telegramLinked ? 'Linked. Send /stop in Telegram to unlink.' : 'Not linked.'}</p>
      <div className="flex flex-wrap gap-3">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center rounded-full bg-[#229ED9] px-5 text-sm font-medium text-white"
          >
            Open Telegram and tap Start
          </a>
        ) : (
          <Button variant="quiet" onClick={() => makeLink.mutate()}>
            {me.user.telegramLinked ? 'Relink' : 'Link Telegram'}
          </Button>
        )}
        <Button variant="quiet" onClick={() => pause.mutate(!me.user.paused)}>
          {me.user.paused ? 'Resume messages' : 'Pause messages'}
        </Button>
      </div>
      {me.user.paused && <Muted className="text-sm">Paused: no scheduled messages. The app keeps working.</Muted>}
      {makeLink.isError && <Alert>{makeLink.error.message}</Alert>}
    </div>
  );
}

/** News topics (spec §3.6): headlines for "Why we believe this" and the daily coverage question. */
function Topics() {
  const qc = useQueryClient();
  const topics = useQuery({ queryKey: ['topics'], queryFn: api.topics });
  const [label, setLabel] = useState('');
  const onDone = (data: Awaited<ReturnType<typeof api.topics>>) => qc.setQueryData(['topics'], data);
  const add = useMutation({
    mutationFn: api.addTopic,
    onSuccess: (d) => {
      onDone(d);
      setLabel('');
    },
  });
  const remove = useMutation({ mutationFn: api.removeTopic, onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (label.trim()) add.mutate({ label: label.trim() });
  };
  if (!topics.data) return topics.isError ? <Alert>{topics.error.message}</Alert> : <Muted className="mt-3">Loading…</Muted>;
  return (
    <div className="mt-3 space-y-4">
      <ul className="flex flex-wrap gap-2" aria-label="Topics you follow">
        {topics.data.topics.map((t) => (
          <li key={t.id} className="flex min-h-11 items-center gap-1 rounded-full border border-[var(--color-line)] pl-4 pr-1 text-sm">
            {t.label}
            <button
              type="button"
              onClick={() => remove.mutate(t.id)}
              aria-label={`Stop following ${t.label}`}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {topics.data.suggestions.length > 0 && (
        <div>
          <Muted className="text-sm">Suggestions, one tap to follow:</Muted>
          <ul className="mt-2 flex flex-wrap gap-2">
            {topics.data.suggestions.map((s) => (
              <li key={s.key}>
                <Button variant="quiet" onClick={() => add.mutate({ suggestion: s.key })}>
                  + {s.label}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <form onSubmit={submit} className="flex gap-2">
        <label className="sr-only" htmlFor="topic-label">
          Another topic
        </label>
        <input
          id="topic-label"
          className={inputClass}
          placeholder="Another topic, e.g. Chandrayaan"
          maxLength={40}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button type="submit" disabled={add.isPending || label.trim().length < 2}>
          Follow
        </Button>
      </form>
      {(add.error ?? remove.error) && <Alert>{(add.error ?? remove.error)?.message}</Alert>}
    </div>
  );
}

/** Web Push on this device: the fallback channel when Telegram is not linked (spec §1.5). */
function Notifications({ me }: { me: MeResponse }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    currentSubscription().then((s) => setOn(Boolean(s)));
  }, []);
  const toggle = useMutation({
    mutationFn: async () => {
      if (on) await disablePush();
      else await enablePush(me.pushPublicKey as string);
      return !on;
    },
    onSuccess: setOn,
  });
  if (!me.pushPublicKey) return <Muted className="mt-3 text-sm">Web Push is not configured on this server (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY).</Muted>;
  if (!pushSupported())
    return <Muted className="mt-3 text-sm">This browser cannot receive notifications. On iPhone, add Reckon to the Home Screen first.</Muted>;
  return (
    <div className="mt-3 space-y-3">
      <p>
        {on ? 'On for this device.' : 'Off for this device.'}{' '}
        <span className="text-sm text-[var(--color-muted)]">
          {me.user.telegramLinked
            ? 'Telegram is linked, so messages go there; this device is the backup.'
            : 'Used for the brief and the reveal while Telegram is not linked.'}
        </span>
      </p>
      <Button variant="quiet" disabled={on === null || toggle.isPending} onClick={() => toggle.mutate()}>
        {on ? 'Turn off on this device' : 'Turn on for this device'}
      </Button>
      {toggle.isError && <Alert>{toggle.error.message}</Alert>}
    </div>
  );
}

export function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => qc.clear() });
  if (!me.data) return <Muted>Loading…</Muted>;
  return (
    <section aria-labelledby="settings-heading">
      <Heading id="settings-heading">Settings</Heading>
      <SectionTitle>Places</SectionTitle>
      <Places me={me.data} />
      <SectionTitle>Times and tips</SectionTitle>
      <Times me={me.data} />
      <SectionTitle>Telegram</SectionTitle>
      <Telegram me={me.data} />
      <SectionTitle>Notifications on this device</SectionTitle>
      <Notifications me={me.data} />
      <SectionTitle>News topics</SectionTitle>
      <Topics />
      <SectionTitle>Session</SectionTitle>
      <Button variant="quiet" className="mt-3" onClick={() => logout.mutate()}>
        Sign out
      </Button>
    </section>
  );
}

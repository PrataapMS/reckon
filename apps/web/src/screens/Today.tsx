import type { BriefItem as BriefItemData } from '@reckon/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Place } from '../api';
import { BriefItem, PreviewItem } from '../components/BriefItem';
import { Alert, Button, Heading, Muted, SectionTitle } from '../components/ui';
import { useMe } from '../hooks';
import { loadPlace, locateMe, savePlace } from '../place';

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function Items({ items }: { items: readonly BriefItemData[] }) {
  return (
    <div>
      {items.map((item) => (
        <BriefItem key={item.questionId} item={item} />
      ))}
    </div>
  );
}

/** Later this week: decisions up front; calibration questions are one tap away so the brief stays short. */
function Later({ items }: { items: readonly BriefItemData[] }) {
  const decisions = items.filter((i) => i.class === 'decision');
  const informative = items.filter((i) => i.class !== 'decision');
  return (
    <>
      <SectionTitle>Later this week</SectionTitle>
      <Items items={decisions} />
      {informative.length > 0 && (
        <details className="mt-2 border-t border-[var(--color-line)] pt-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--color-muted)]">
            {informative.length} calibration question{informative.length === 1 ? '' : 's'} later this week
          </summary>
          <Items items={informative} />
        </details>
      )}
    </>
  );
}

/** Today (spec 04-design): the locked brief for today, tomorrow and later this week. */
export function Today() {
  const me = useMe();
  const brief = useQuery({ queryKey: ['brief'], queryFn: api.brief, enabled: me.isSuccess, staleTime: 300_000 });
  const today = brief.data?.today ?? [];
  const [lead, ...rest] = today;

  return (
    <section aria-labelledby="today-heading">
      <Heading id="today-heading">{greeting()}.</Heading>
      <Muted className="mt-2">Here is what Reckon expects. Every claim is locked before it happens, and reality checks each one.</Muted>

      {brief.isPending && <Muted className="mt-10">Fetching your brief…</Muted>}
      {brief.isError && <Alert>{brief.error.message}</Alert>}

      {brief.data && (
        <>
          {lead ? (
            <section aria-label="Today's claims" className="mt-6">
              <BriefItem item={lead} lead />
              <Items items={rest} />
            </section>
          ) : (
            <>
              <Muted className="mt-6 max-w-prose">
                No claims are locked for today yet: Reckon writes tomorrow's questions each morning, so your first locked items are for tomorrow. Below is a
                live preview for today. It is not stored or scored.
              </Muted>
              <TodayPreview todayOnly />
            </>
          )}
          {brief.data.tomorrow.length > 0 && (
            <>
              <SectionTitle>Tomorrow</SectionTitle>
              <Items items={brief.data.tomorrow} />
            </>
          )}
          {brief.data.later.length > 0 && <Later items={brief.data.later} />}
          {brief.data.world.length > 0 && (
            <section aria-labelledby="world-heading">
              <h2 id="world-heading" className="mt-10 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">
                World pulse
              </h2>
              <Muted className="mt-2 text-sm">Money, tech, space and the news. Each claim is judged by a public source named on its page.</Muted>
              <Items items={brief.data.world} />
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** The Phase 0 live preview: used when nothing is locked for today, or before Reckon is configured. */
export function TodayPreview({ standalone = false, todayOnly = false }: { standalone?: boolean; todayOnly?: boolean }) {
  const me = useMe();
  const primary = me.data?.locations[0];
  const [place, setPlace] = useState<Place | null>(() => (primary ? { lat: primary.lat, lon: primary.lon, tz: primary.tz, label: primary.name } : loadPlace()));
  const [note, setNote] = useState<string | null>(null);
  const preview = useQuery({ queryKey: ['preview', place], queryFn: () => api.previewBrief(place), staleTime: 600_000 });

  const useMyLocation = async () => {
    try {
      const p = await locateMe();
      savePlace(p);
      setPlace(p);
      setNote(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-4">
      {standalone && (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
          <Button onClick={useMyLocation}>Use my location</Button>
          {note && <span className="text-[var(--color-muted)]">{note}</span>}
        </div>
      )}
      {preview.isPending && <Muted>Fetching today's forecasts…</Muted>}
      {preview.isError && <Alert>{preview.error.message}</Alert>}
      {preview.data?.items
        // Next to the locked brief, only today's preview adds anything; tomorrow is already locked below.
        .filter((item) => !todayOnly || item.id.endsWith('-today'))
        .map((item) => (
          <PreviewItem key={item.id} item={item} />
        ))}
      {preview.data?.warnings.map((w) => (
        <Muted key={w} className="mt-4 text-sm">
          {w}
        </Muted>
      ))}
    </div>
  );
}

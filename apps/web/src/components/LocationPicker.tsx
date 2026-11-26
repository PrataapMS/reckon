import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../api';
import { locateMe } from '../place';
import { Button, inputClass, Muted } from './ui';

export interface PickedPlace {
  name: string;
  lat: number;
  lon: number;
  tz: string;
}

/**
 * Spec §1.5: the one input Reckon cannot run without. Use the device location, or pick a city if
 * permission is refused. Coordinates are rounded to ~1 km before they leave the device.
 */
export function LocationPicker({ defaultName, onPick, busy }: { defaultName: string; onPick: (p: PickedPlace) => void; busy?: boolean }) {
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const id = useId();
  const search = useQuery({ queryKey: ['geocode', query], queryFn: () => api.geocode(query), enabled: query.trim().length >= 2, staleTime: 86_400_000 });

  const onUseDevice = async () => {
    try {
      const p = await locateMe();
      onPick({ name: name.trim() || defaultName, lat: p.lat, lon: p.lon, tz: p.tz });
    } catch (e) {
      setNote(`${e instanceof Error ? e.message : String(e)} Search for your city instead.`);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${id}-name`} className="text-sm text-[var(--color-muted)]">
          Call this place
        </label>
        <input id={`${id}-name`} className={`${inputClass} mt-1`} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </div>
      <Button onClick={onUseDevice} disabled={busy}>
        Use my location
      </Button>
      {note && <Muted className="text-sm">{note}</Muted>}
      <div>
        <label htmlFor={`${id}-city`} className="text-sm text-[var(--color-muted)]">
          Or search for a city
        </label>
        <input
          id={`${id}-city`}
          className={`${inputClass} mt-1`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Bengaluru"
          autoComplete="off"
        />
        {search.isError && <p className="mt-2 text-sm text-[var(--color-miss)]">{search.error.message}</p>}
        {search.data && (
          <ul className="mt-2 divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
            {search.data.results.length === 0 && <li className="px-3 py-3 text-sm text-[var(--color-muted)]">No matches.</li>}
            {search.data.results.map((r) => (
              <li key={`${r.lat},${r.lon}`}>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)]"
                  onClick={() => onPick({ name: name.trim() || r.name, lat: Math.round(r.lat * 100) / 100, lon: Math.round(r.lon * 100) / 100, tz: r.tz })}
                >
                  {r.name}
                  <span className="text-[var(--color-muted)]">
                    {[r.region, r.country].filter(Boolean).join(', ') ? `, ${[r.region, r.country].filter(Boolean).join(', ')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

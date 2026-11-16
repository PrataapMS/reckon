import type { Place } from './api';

const KEY = 'reckon.place';

export function loadPlace(): Place | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Place) : null;
  } catch {
    return null;
  }
}

export function savePlace(p: Place): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage can be unavailable (private mode). The brief still works with the server default.
  }
}

export function locateMe(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share a location.'));
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          // Rounded to ~1 km, which is finer than the weather grid (spec §17, Privacy).
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          label: 'Your location',
        }),
      () => reject(new Error('Location permission was refused. Reckon is using the default city.')),
      { maximumAge: 3_600_000, timeout: 10_000 },
    );
  });
}

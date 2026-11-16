import { humanDate } from '../domain/dates';
import { clipProbability, displayPercent, provisionalProbability, type VerbalLabel, verbalLabel } from '../domain/probability';
import type { AirQualityPort, Clock, LocationQuery, WeatherPort } from '../ports';

/**
 * Phase 0 "preview brief": live provider forecasts for a location, shown honestly as
 * "Learning" because nothing has been scored yet. Phase 1 replaces this with stored,
 * locked questions and champion forecasters.
 */
export interface PreviewBriefItem {
  readonly id: string;
  readonly domain: 'weather' | 'air';
  readonly title: string;
  readonly p: number;
  readonly percent: number;
  readonly label: VerbalLabel;
  readonly action: string;
  readonly forecaster: string;
  readonly basis: string;
  readonly sourceUrl: string;
}

export interface PreviewBrief {
  readonly generatedAt: string;
  readonly location: { readonly lat: number; readonly lon: number; readonly tz: string };
  readonly items: readonly PreviewBriefItem[];
  readonly warnings: readonly string[];
}

const RAIN_ACTION_AT = 0.5;
const AQI_LIMIT = 150;
const HEAT_LIMIT_C = 35;

export function buildPreviewBrief(deps: { weather: WeatherPort; air: AirQualityPort; clock: Clock }) {
  return async (q: Omit<LocationQuery, 'days'>): Promise<PreviewBrief> => {
    const query = { ...q, days: 3 };
    const [wx, aq] = await Promise.all([deps.weather.dailyForecast(query), deps.air.dailyForecast(query)]);
    const items: PreviewBriefItem[] = [];
    const warnings: string[] = [];

    if (wx.ok) {
      const [today, tomorrow] = wx.value.parsed;
      const url = wx.value.requestUrl;
      for (const [day, when] of [
        [today, 'today'],
        [tomorrow, 'tomorrow'],
      ] as const) {
        if (day?.precipProbabilityMax != null) {
          const p = clipProbability(day.precipProbabilityMax / 100);
          items.push({
            id: `rain-${when}`,
            domain: 'weather',
            title: `Rain ${when}`,
            p,
            percent: displayPercent(p),
            label: verbalLabel(p),
            action: p >= RAIN_ACTION_AT ? 'Take an umbrella' : 'No umbrella needed',
            forecaster: 'Open-Meteo provider',
            basis: `Highest hourly chance of rain on ${humanDate(day.date)}`,
            sourceUrl: url,
          });
        }
      }
      if (tomorrow?.tempMaxC != null) {
        const p = provisionalProbability(tomorrow.tempMaxC, HEAT_LIMIT_C, 1.5);
        items.push({
          id: 'heat-tomorrow',
          domain: 'weather',
          title: `${HEAT_LIMIT_C} °C or hotter tomorrow`,
          p,
          percent: displayPercent(p),
          label: verbalLabel(p),
          action: p >= 0.5 ? 'Plan shade and water' : 'No heat precautions needed',
          forecaster: 'Open-Meteo provider (provisional mapping)',
          basis: `Forecast high of ${tomorrow.tempMaxC.toFixed(1)} °C on ${humanDate(tomorrow.date)}`,
          sourceUrl: url,
        });
      }
    } else {
      warnings.push(`Weather unavailable (${wx.error.code}). Showing what we have.`);
    }

    if (aq.ok) {
      const tomorrow = aq.value.parsed[1];
      if (tomorrow?.usAqiMax != null) {
        const p = provisionalProbability(tomorrow.usAqiMax, AQI_LIMIT, 15);
        items.push({
          id: 'aqi-tomorrow',
          domain: 'air',
          title: `Air quality worse than US AQI ${AQI_LIMIT} tomorrow`,
          p,
          percent: displayPercent(p),
          label: verbalLabel(p),
          action: p >= 0.5 ? 'Consider a mask outdoors' : 'Air looks fine for outdoor plans',
          forecaster: 'Open-Meteo air quality (provisional mapping)',
          basis: `Forecast US AQI peak of ${Math.round(tomorrow.usAqiMax)} on ${humanDate(tomorrow.date)}`,
          sourceUrl: aq.value.requestUrl,
        });
      }
    } else {
      warnings.push(`Air quality unavailable (${aq.error.code}).`);
    }

    return { generatedAt: deps.clock.now().toISOString(), location: { lat: q.lat, lon: q.lon, tz: q.tz }, items, warnings };
  };
}

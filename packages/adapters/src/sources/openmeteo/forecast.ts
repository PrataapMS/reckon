import {
  type AirQualityPort,
  type DailyAirQuality,
  type DailyWeather,
  type LocationQuery,
  ok,
  type Result,
  type SourceError,
  type SourceSnapshot,
  type WeatherPort,
} from '@reckon/core';
import { z } from 'zod';
import { httpGetText } from '../http';
import { hourlyToDailyMax, nums, type OpenMeteoOptions, parse } from './shared';

const ForecastResponse = z.object({
  timezone: z.string(),
  daily: z.object({
    time: z.array(z.string()),
    precipitation_probability_max: nums,
    precipitation_sum: nums,
    temperature_2m_max: nums,
  }),
});

const AirResponse = z.object({
  timezone: z.string(),
  hourly: z.object({ time: z.array(z.string()), us_aqi: nums }),
});

export class OpenMeteoForecastAdapter implements WeatherPort {
  static readonly id = 'openmeteo.forecast';
  constructor(private readonly o: OpenMeteoOptions) {}

  url(q: LocationQuery): string {
    const u = new URL(this.o.forecastBase ?? 'https://api.open-meteo.com/v1/forecast');
    u.searchParams.set('latitude', q.lat.toFixed(2));
    u.searchParams.set('longitude', q.lon.toFixed(2));
    u.searchParams.set('daily', 'precipitation_probability_max,precipitation_sum,temperature_2m_max');
    u.searchParams.set('timezone', q.tz);
    u.searchParams.set('forecast_days', String(q.days));
    if (q.pastDays) u.searchParams.set('past_days', String(q.pastDays));
    return u.toString();
  }

  async dailyForecast(q: LocationQuery): Promise<Result<SourceSnapshot<DailyWeather[]>, SourceError>> {
    const url = this.url(q);
    const raw = await httpGetText(url, {
      sourceId: OpenMeteoForecastAdapter.id,
      userAgent: this.o.userAgent,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = parse(ForecastResponse, raw.value, OpenMeteoForecastAdapter.id);
    if (!parsed.ok) return parsed;
    const d = parsed.value.daily;
    const days: DailyWeather[] = d.time.map((date, i) => ({
      date,
      precipProbabilityMax: d.precipitation_probability_max[i] ?? null,
      precipSumMm: d.precipitation_sum[i] ?? null,
      tempMaxC: d.temperature_2m_max[i] ?? null,
    }));
    return ok({
      sourceId: OpenMeteoForecastAdapter.id,
      fetchedAt: (this.o.now?.() ?? new Date()).toISOString(),
      requestUrl: url,
      raw: raw.value,
      parsed: days,
    });
  }
}

export class OpenMeteoAirQualityAdapter implements AirQualityPort {
  static readonly id = 'openmeteo.air_quality';
  constructor(private readonly o: OpenMeteoOptions) {}

  url(q: LocationQuery): string {
    const u = new URL(this.o.airBase ?? 'https://air-quality-api.open-meteo.com/v1/air-quality');
    u.searchParams.set('latitude', q.lat.toFixed(2));
    u.searchParams.set('longitude', q.lon.toFixed(2));
    u.searchParams.set('hourly', 'us_aqi');
    u.searchParams.set('timezone', q.tz);
    u.searchParams.set('forecast_days', String(Math.min(q.days, 7)));
    if (q.pastDays) u.searchParams.set('past_days', String(q.pastDays));
    return u.toString();
  }

  async dailyForecast(q: LocationQuery): Promise<Result<SourceSnapshot<DailyAirQuality[]>, SourceError>> {
    const url = this.url(q);
    const raw = await httpGetText(url, {
      sourceId: OpenMeteoAirQualityAdapter.id,
      userAgent: this.o.userAgent,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = parse(AirResponse, raw.value, OpenMeteoAirQualityAdapter.id);
    if (!parsed.ok) return parsed;
    const days: DailyAirQuality[] = hourlyToDailyMax(parsed.value.hourly.time, parsed.value.hourly.us_aqi).map(([date, usAqiMax]) => ({ date, usAqiMax }));
    return ok({
      sourceId: OpenMeteoAirQualityAdapter.id,
      fetchedAt: (this.o.now?.() ?? new Date()).toISOString(),
      requestUrl: url,
      raw: raw.value,
      parsed: days,
    });
  }
}

# 4. UX and design system

Reckon should feel like a bright, confident weather app crossed with a sports scoreboard: big numbers, vivid colour per topic, satisfying motion, and nothing that hides how the numbers were made.

## Visual direction

- **Dark-first** with a full light theme that follows the OS setting. Deep ink background (`#0B0D17`).
- **Colour carries topic, not meaning.** Each domain owns one gradient; outcomes use shape and words as well as colour.
- **One bold element:** the probability ring, filled in the topic gradient with a count-up. Everything around it stays quiet.
- **Type:** Space Grotesk for display numbers and headings; Inter for UI text; tabular figures everywhere.
- **Motion:** spring animations for card flips and count-ups (200–700 ms); all motion respects `prefers-reduced-motion`.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#F7F7FB` | `#0B0D17` | Background |
| `--color-surface` | `#FFFFFF` | `#151829` | Raised surfaces |
| `--color-line` | `#E3E4EF` | `#252A45` | Rules, ring track |
| `--color-text` | `#14162B` | `#F2F3FA` | Primary text |
| `--color-muted` | `#5B5F7A` | `#A3A7C2` | Secondary text |
| weather | `#0EA5E9 → #6366F1` | same | Weather gradient |
| air | `#F59E0B → #A855F7` | same | Air quality gradient |
| money | `#10B981 → #14B8A6` | same | FX gradient |
| tech | `#6366F1 → #EC4899` | same | Tech gradient |
| world | `#F97316 → #EF4444` | same | World and space |
| life | `#EC4899 → #F43F5E` | same | Personal |
| `--color-hit` / `--color-miss` | `#15803D` / `#DC2626` | `#4ADE80` / `#F87171` | Outcome, always with an icon (light hit darkened from `#16A34A`, which is 3.3:1 on white, to meet AA) |

Built in `apps/web/src/styles.css` and `apps/web/src/domain-style.ts`. All pairings must meet WCAG 2.2 AA.

## Probability display rules

- Large number ("72%") with a verbal label: < 10% Very unlikely, 10–35% Unlikely, 35–65% Toss-up, 65–90% Likely, > 90% Very likely (built: `verbalLabel`).
- A probability ring in the topic gradient; directly under it a trust badge naming the forecaster, sample size and status (Learning, Proven skill, No proven edge).
- Whole percentages only; never 0% or 100% (built: `displayPercent`).
- Lead with the **action** ("Take an umbrella"), then the probability context, then the basis and a "See the raw data" link.

## Screens

| Screen | Purpose | Key elements | Status |
| --- | --- | --- | --- |
| Today | Morning home screen | Greeting, lead item with large ring, other items with small rings, action tips, trust badges; World pulse section; live preview when nothing is locked for today | Built |
| Reveal | Evening ritual | Sealed countdown to the reveal time; card flips with observed values, outcomes and scores (static under reduced motion) | Built |
| Scoreboard | Is any of this working? | Progress to first trust label; reliability diagram (with table and text summary); Brier and trust per template and forecaster. Phase 3 adds BSS intervals, champions, horizon decay | Built (v1) |
| Onboarding (3 steps) | First brief in < 5 min | Location (or city), Telegram link or skip, brief and reveal times | Built |
| Question detail | Full transparency | How this is judged, Why we believe this (rationale and linked headlines), forecaster table, what happened, raw download | Built |
| Call it | Optional game | 3 cards per day with a probability slider; head-to-head after the reveal | Phase 3 |
| Weekly report | Sunday recap | Hits, misses, biggest surprise, newly proven templates | Phase 3 |
| Settings | Rarely needed | Locations, times, quiet hours, action thresholds, Telegram, Web Push on this device, news topics (built); integrations, export, delete (Phase 3–5) | Partly built |

## PWA and accessibility

- Installable (manifest + icon), service worker via vite-plugin-pwa; the brief is cached stale-while-revalidate for offline reading (built).
- Attribution footer "Weather data by Open-Meteo.com (CC BY 4.0)" wherever that data appears, plus ECB/Frankfurter, USGS, NOAA SWPC, GFZ Potsdam (CC BY 4.0) and GDELT; headlines always link to the publisher (built).
- Every chart has a text summary and a data-table toggle; keyboard reachable with visible focus; touch targets ≥ 44 × 44 px; probabilities announced as words.

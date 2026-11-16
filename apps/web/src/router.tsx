import { createRootRoute, createRoute, createRouter, Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { Alert, Heading, Muted } from './components/ui';
import { isPreviewOnly, useMe } from './hooks';
import { Login } from './screens/Login';
import { Onboarding } from './screens/Onboarding';
import { QuestionDetail } from './screens/QuestionDetail';
import { Reveal } from './screens/Reveal';
import { Scoreboard } from './screens/Scoreboard';
import { Settings } from './screens/Settings';
import { Today, TodayPreview } from './screens/Today';

const TABS = [
  { to: '/', label: 'Today' },
  { to: '/reveal', label: 'Reveal' },
  { to: '/score', label: 'Scoreboard' },
  { to: '/settings', label: 'Settings' },
] as const;

function Frame({ children, nav = true }: { children: ReactNode; nav?: boolean }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-5 pb-28 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <a href="#main" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <header className="flex items-baseline justify-between">
        <span className="font-[family-name:var(--font-display)] text-lg font-bold">Reckon</span>
        <span className="text-sm text-[var(--color-muted)]">Reality keeps score.</span>
      </header>

      <main id="main" className="mt-10 flex-1">
        {children}
      </main>

      <footer className="mt-12 space-y-1 text-xs text-[var(--color-muted)]">
        <p>
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline underline-offset-4">
            Weather data by Open-Meteo.com
          </a>{' '}
          (CC BY 4.0).
        </p>
        <p>
          Exchange rates: European Central Bank via Frankfurter. Earthquakes: USGS. Space weather: NOAA SWPC, and Kp history from{' '}
          <a href="https://kp.gfz.de/" target="_blank" rel="noreferrer" className="underline underline-offset-4">
            GFZ Potsdam
          </a>{' '}
          (CC BY 4.0). News coverage: GDELT. Headlines link to their publishers.
        </p>
      </footer>

      {nav && (
        <nav
          aria-label="Sections"
          className="fixed inset-x-0 bottom-0 border-t border-[var(--color-line)] bg-[var(--color-bg)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        >
          <ul className="mx-auto flex max-w-2xl">
            {TABS.map((t) => (
              <li key={t.to} className="flex-1">
                <Link
                  to={t.to}
                  activeOptions={{ exact: t.to === '/' }}
                  className="flex min-h-14 w-full items-center justify-center text-sm font-medium text-[var(--color-muted)] aria-[current=page]:text-[var(--color-text)]"
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

/** Before Postgres and a passphrase are configured, Reckon still shows the honest live preview (Phase 0). */
function PreviewMode({ reason }: { reason: string }) {
  return (
    <section aria-labelledby="preview-heading">
      <Heading id="preview-heading">Live preview</Heading>
      <Muted className="mt-2 max-w-prose">
        {reason} Until then this is a live, unscored preview. See docs/GETTING_STARTED.md to switch on the daily brief.
      </Muted>
      <TodayPreview standalone />
    </section>
  );
}

/** Sign-in and onboarding gate around every screen. */
function Shell() {
  const me = useMe();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (me.isPending)
    return (
      <Frame nav={false}>
        <Muted>Loading…</Muted>
      </Frame>
    );
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401)
      return (
        <Frame nav={false}>
          <Login />
        </Frame>
      );
    if (isPreviewOnly(me.error))
      return (
        <Frame nav={false}>
          <PreviewMode reason={me.error.message} />
        </Frame>
      );
    return (
      <Frame nav={false}>
        <Alert>{me.error.message}</Alert>
      </Frame>
    );
  }
  const needsOnboarding = !me.data.user.onboardedAt || me.data.locations.length === 0;
  if (needsOnboarding && path !== '/onboarding') return <Navigate to="/onboarding" />;
  return (
    <Frame nav={!needsOnboarding}>
      <Outlet />
    </Frame>
  );
}

const root = createRootRoute({ component: Shell });
const today = createRoute({ getParentRoute: () => root, path: '/', component: Today });
const reveal = createRoute({ getParentRoute: () => root, path: '/reveal', component: Reveal });
const score = createRoute({ getParentRoute: () => root, path: '/score', component: Scoreboard });
const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: Settings });
const onboarding = createRoute({ getParentRoute: () => root, path: '/onboarding', component: Onboarding });
const question = createRoute({
  getParentRoute: () => root,
  path: '/q/$id',
  component: function QuestionRoute() {
    const { id } = question.useParams();
    return <QuestionDetail id={id} />;
  },
});

export const router = createRouter({
  routeTree: root.addChildren([today, reveal, score, settings, onboarding, question]),
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

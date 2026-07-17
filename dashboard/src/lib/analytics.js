import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { init, trackEvent } from '@aptabase/web';

// Aptabase App Key. These are public by design (embedded in the client bundle) — the key only
// grants event ingestion, not read access. Override per-deployment with VITE_APTABASE_KEY.
const APP_KEY = import.meta.env.VITE_APTABASE_KEY || 'A-US-7383464783';

let started = false;

export function initAnalytics() {
  if (started || !APP_KEY) return;
  started = true;
  init(APP_KEY);
}

export function track(name, props) {
  if (started) trackEvent(name, props);
}

// Collapse dynamic segments (app/db/project names) into their route pattern so pageviews
// group by page instead of exploding into one path per resource.
function routePattern(pathname) {
  return pathname
    .replace(/^\/projects\/[^/]+\/[^/]+$/, '/projects/:project/:name')
    .replace(/^\/projects\/[^/]+$/, '/projects/:name')
    .replace(/^\/(apps|db)\/[^/]+$/, '/$1/:name');
}

// Mount once inside the router: fires a pageview on every client-side navigation.
export function RouteAnalytics() {
  const { pathname } = useLocation();
  useEffect(() => { track('pageview', { path: routePattern(pathname) }); }, [pathname]);
  return null;
}

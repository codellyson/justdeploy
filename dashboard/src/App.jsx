import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { api } from './api';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { NewProject } from './pages/NewProject';
import { Settings } from './pages/Settings';
import { Canvas } from './pages/Canvas';
import { ServiceDetail, LegacyServiceRedirect } from './pages/ServiceDetail';
import { ToastHost } from './components/toast';
import { Spinner } from './components/ui';
import { RouteAnalytics } from './lib/analytics';

export default function App() {
  const [session, setSession] = useState(null); // { authed, needsSetup } | null while loading

  const check = useCallback(() => {
    // /api/session returns 200 even when logged out, so a throw here means the server is
    // unreachable (restart / network blip) — retry rather than falsely showing the login.
    api.session().then(setSession).catch(() => setTimeout(check, 2000));
  }, []);
  useEffect(() => { check(); }, [check]);

  return (
    <>
      {!session ? (
        <div className="grid min-h-dvh place-items-center"><Spinner className="h-6 w-6" /></div>
      ) : !session.authed ? (
        <Login needsSetup={session.needsSetup} onAuthed={check} />
      ) : (
        <BrowserRouter>
          <RouteAnalytics />
          <Routes>
            <Route element={<Shell onSignedOut={() => setSession({ authed: false })} />}>
              <Route path="/" element={<Overview />} />
              <Route path="/new" element={<NewProject />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/canvas" element={<Canvas />} />
              <Route path="/projects/:name" element={<Canvas />} />
              <Route path="/projects/:project/:name" element={<ServiceDetail />} />
              {/* legacy flat routes → redirect to the project-scoped URL */}
              <Route path="/apps/:name" element={<LegacyServiceRedirect />} />
              <Route path="/db/:name" element={<LegacyServiceRedirect />} />
              <Route path="*" element={<Overview />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )}
      <ToastHost />
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { api } from './api';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { AppDetail } from './pages/AppDetail';
import { ToastHost } from './components/toast';
import { Spinner } from './components/ui';

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
          <Routes>
            <Route element={<Shell onSignedOut={() => setSession({ authed: false })} />}>
              <Route path="/" element={<Overview />} />
              <Route path="/apps/:name" element={<AppDetail />} />
              <Route path="*" element={<Overview />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )}
      <ToastHost />
    </>
  );
}

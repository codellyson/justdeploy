import { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { api } from '../api';
import { Spinner } from '../components/ui';
import { AppDetail } from './AppDetail';
import { DatabaseDetail } from './DatabaseDetail';

// A service's URL carries its project: /projects/:project/:name. This resolves that to the right
// detail view (app vs database). The navigating page passes the kind via router state so there's
// no flash; on a direct load / refresh we look it up in state. AppDetail / DatabaseDetail read the
// :name (and :project) params themselves.
export function ServiceDetail() {
  const { name } = useParams();
  const { state } = useLocation();
  const [kind, setKind] = useState(state?.kind); // 'app' | 'db' | undefined (loading) | null (missing)
  useEffect(() => {
    if (kind) return; // known from navigation state
    let live = true;
    api.state()
      .then((s) => {
        if (!live) return;
        if (s.apps.some((a) => a.name === name)) setKind('app');
        else if (s.resources.some((r) => r.name === name)) setKind('db');
        else setKind(null);
      })
      .catch(() => live && setKind(null));
    return () => { live = false; };
  }, [name, kind]);

  if (kind === undefined) return <Spinner className="mx-auto my-20 h-6 w-6" />;
  if (kind === null) return <Navigate to="/" replace />;
  return kind === 'app' ? <AppDetail /> : <DatabaseDetail />;
}

// Back-compat for the old flat routes (/apps/:name, /db/:name): look up the service's project and
// redirect to the canonical nested URL so bookmarks and in-flight links keep working.
export function LegacyServiceRedirect() {
  const { name } = useParams();
  const [to, setTo] = useState(undefined);
  useEffect(() => {
    let live = true;
    api.state()
      .then((s) => {
        if (!live) return;
        const svc = s.apps.find((a) => a.name === name) || s.resources.find((r) => r.name === name);
        const proj = svc?.project || 'default';
        setTo(svc ? `/projects/${proj}/${name}` : '/');
      })
      .catch(() => live && setTo('/'));
    return () => { live = false; };
  }, [name]);
  if (to === undefined) return <Spinner className="mx-auto my-20 h-6 w-6" />;
  return <Navigate to={to} replace />;
}

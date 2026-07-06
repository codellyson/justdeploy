import { useEffect, useState } from 'react';

// Trivial global invalidation signal — any mutation calls invalidate(); views re-fetch.
let version = 0;
const subs = new Set();

export function invalidate() {
  version += 1;
  subs.forEach((f) => f(version));
}

export function useVersion() {
  const [v, setV] = useState(version);
  useEffect(() => {
    const f = (n) => setV(n);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return v;
}

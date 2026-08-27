import { useEffect, useState } from 'react';

const COARSE_NO_HOVER = '(hover: none) and (pointer: coarse)';

/**
 * True when the primary pointer cannot hover and is coarse (finger/stylus).
 *
 * That is the same gap as hover-only tree actions: no hover, so Edit/Delete
 * must stay visible. A mouse (including one plugged into an iPad) reports
 * hover + fine pointer, so the tree goes back to hover-reveal.
 *
 * Not userAgent, not platform, not maxTouchPoints alone (Windows laptops
 * can report touch without being a coarse-primary device).
 */
function readCoarseNoHover(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(COARSE_NO_HOVER).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(readCoarseNoHover);

  useEffect(() => {
    const mql = window.matchMedia(COARSE_NO_HOVER);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

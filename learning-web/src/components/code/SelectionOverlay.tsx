import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface SelectionOverlayProps {
  /** The Range whose client rects we paint as a persistent selection ghost. */
  range?: Range;
  /**
   * Rects captured at selection time. Used as initial state (no mount flash)
   * and as fallback when `range.getClientRects()` returns empty due to DOM
   * mutation (e.g. useAnnotationHighlight replacing text nodes after a color apply).
   */
  initialRects?: DOMRect[];
}

function computeRects(range?: Range, fallback?: DOMRect[]): DOMRect[] {
  if (range) {
    try {
      const list = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (list.length > 0) return list;
    } catch {
      // Range may be detached after DOM mutation — fall through to fallback
    }
  }
  return fallback ?? [];
}

/**
 * Renders translucent Claude-orange rectangles over the live client rects of a
 * DOM Range. Persists the visual selection highlight even when the native
 * browser selection collapses (e.g. when a textarea autoFocuses inside a
 * portal'd popover). Recomputes on scroll / resize via rAF-throttled handlers.
 *
 * Uses lazy useState init so rects are available on the very first render
 * (no 1-frame mount flash). useLayoutEffect ensures scroll/resize updates
 * happen before paint.
 */
export function SelectionOverlay({ range, initialRects }: SelectionOverlayProps) {
  const [rects, setRects] = useState<DOMRect[]>(() => computeRects(range, initialRects));
  const rafRef = useRef<number | null>(null);
  // Keep initialRects in a ref so the layout effect can fall back to them
  // without rerunning when they change reference identity.
  const initialRectsRef = useRef(initialRects);
  initialRectsRef.current = initialRects;

  useLayoutEffect(() => {
    const compute = () => {
      rafRef.current = null;
      setRects(computeRects(range, initialRectsRef.current));
    };
    const schedule = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(compute);
    };

    // Recompute immediately whenever range prop changes
    compute();
    // capture = true: catch scrolls in any ancestor scroll container
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);

    return () => {
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [range]);

  return createPortal(
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 55,
        // Keep the portal div mounted so we don't thrash the portal on transient
        // empty-rect states (e.g. between a scroll rAF and a recompute).
        display: rects.length === 0 ? 'none' : undefined,
      }}
    >
      {rects.map((r, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            // NO fill — existing colored annotations (bg-yellow/red/blue/green)
            // underneath stay fully visible. Selection boundary is communicated
            // by the outline alone, which sits on the element's box edge
            // without covering content.
            outline: '2px solid oklch(0.65 0.14 30 / 0.75)',
            outlineOffset: '-2px',
            borderRadius: 2,
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

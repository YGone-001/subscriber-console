/*
 * Canvas zoom policy shared by every topology graph source.
 *
 * Two different questions get two different answers:
 *
 * - "show me this graph" (the initial view and a window resize) must stay
 *   legible, so it fills the canvas width and never drops below the legibility
 *   floor; whatever does not fit is reached by scrolling or panning inside the
 *   canvas;
 * - "show me the whole graph at once" (the explicit fit control) shrinks the
 *   entire content into the canvas, down to the manual zoom floor.
 *
 * Keeping both in one place is what stops the three sources from drifting into
 * three different default magnifications again.
 */

/* Below this, a node card stops being readable text and becomes a smudge. */
export const READABLE_MIN_ZOOM = 0.8;

export type TopologyFitMode = 'readable' | 'all';

export type TopologyCanvasBox = {
  availableWidth: number;
  availableHeight: number;
};

/**
 * Measure the usable content box of a scrollable canvas viewport.
 *
 * Returns null when the viewport is not laid out yet, so a caller can defer
 * rather than fit against a zero-size box.
 */
export function measureCanvasBox(viewport: HTMLElement | null): TopologyCanvasBox | null {
  if (!viewport) return null;
  const computed = window.getComputedStyle(viewport);
  const paddingX = (Number.parseFloat(computed.paddingLeft) || 0) + (Number.parseFloat(computed.paddingRight) || 0);
  const paddingY = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
  const declaredHeight = Number.parseFloat(computed.maxHeight);
  const boxHeight = Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight : viewport.clientHeight;
  const availableWidth = viewport.clientWidth - paddingX - 2;
  const availableHeight = boxHeight - paddingY - 2;
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  return { availableWidth, availableHeight };
}

/**
 * Resolve the zoom for one fit mode.
 *
 * `floor` is the mode's own minimum: the legibility floor for a readable fit and
 * the manual zoom minimum for fit-all, so an operator can always zoom further
 * out than the default view.
 */
export function resolveFitZoom(
  box: TopologyCanvasBox,
  content: { width: number; height: number },
  mode: TopologyFitMode,
  floor: number,
): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const candidates = mode === 'readable'
    ? [1, box.availableWidth / content.width]
    : [1, box.availableWidth / content.width, box.availableHeight / content.height];
  const scale = Math.min(...candidates);
  const bounded = Math.max(floor, Math.min(1, scale));
  return Number(bounded.toFixed(2));
}

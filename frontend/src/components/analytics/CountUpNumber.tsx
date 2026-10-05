/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/analytics/CountUpNumber.tsx
 * Adaptations: "use client" and the local analytics.css import dropped (the layer
 * is imported from app.css); Next.js Link replaced by react-router Link; @/ path
 * aliases rewritten to relative paths.
 */
import { useEffect, useRef, useState } from "react";

export default function CountUpNumber({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);

  useEffect(() => {
    const startValue = previousValue.current;
    const delta = value - startValue;
    let frame = 0;
    let raf = 0;
    const totalFrames = 32;

    const tick = () => {
      frame += 1;
      const progress = Math.min(frame / totalFrames, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(startValue + delta * eased);

      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        previousValue.current = value;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <>
      {displayValue.toFixed(decimals)}
      {suffix}
    </>
  );
}

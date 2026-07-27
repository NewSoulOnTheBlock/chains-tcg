// src/ShinyText.tsx
// Animated shimmer text from React Bits (motion + CSS variant), wrapped in
// TypeScript. The shimmer is a linear-gradient on the background, clipped to
// the text. A motion animation slides the gradient position from right to
// left (or vice-versa).
//
// BRAND palette helpers live at the bottom of the file — use them via the
// <ShinyBrand> / <ShinyGold> convenience wrappers so the look stays
// consistent and we don't sprinkle hex codes through the codebase.

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, useMotionValue, useAnimationFrame, useTransform } from 'motion/react';
import './ShinyText.css';

export interface ShinyTextProps {
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
  color?: string;
  shineColor?: string;
  spread?: number;
  yoyo?: boolean;
  pauseOnHover?: boolean;
  direction?: 'left' | 'right';
  delay?: number;
}

const ShinyText = ({
  text,
  disabled = false,
  speed = 2,
  className = '',
  color = '#b5b5b5',
  shineColor = '#ffffff',
  spread = 120,
  yoyo = false,
  pauseOnHover = false,
  direction = 'left',
  delay = 0,
}: ShinyTextProps) => {
  const [isPaused, setIsPaused] = useState(false);
  const progress = useMotionValue(0);
  const elapsedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const directionRef = useRef(direction === 'left' ? 1 : -1);

  const animationDuration = speed * 1000;
  const delayDuration = delay * 1000;

  useAnimationFrame((time: number) => {
    if (disabled || isPaused) {
      lastTimeRef.current = null;
      return;
    }
    if (lastTimeRef.current === null) {
      lastTimeRef.current = time;
      return;
    }
    const deltaTime = time - lastTimeRef.current;
    lastTimeRef.current = time;
    elapsedRef.current += deltaTime;

    if (yoyo) {
      const cycleDuration = animationDuration + delayDuration;
      const fullCycle = cycleDuration * 2;
      const cycleTime = elapsedRef.current % fullCycle;
      if (cycleTime < animationDuration) {
        const p = (cycleTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else if (cycleTime < cycleDuration) {
        progress.set(directionRef.current === 1 ? 100 : 0);
      } else if (cycleTime < cycleDuration + animationDuration) {
        const reverseTime = cycleTime - cycleDuration;
        const p = 100 - (reverseTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else {
        progress.set(directionRef.current === 1 ? 0 : 100);
      }
    } else {
      const cycleDuration = animationDuration + delayDuration;
      const cycleTime = elapsedRef.current % cycleDuration;
      if (cycleTime < animationDuration) {
        const p = (cycleTime / animationDuration) * 100;
        progress.set(directionRef.current === 1 ? p : 100 - p);
      } else {
        progress.set(directionRef.current === 1 ? 100 : 0);
      }
    }
  });

  useEffect(() => {
    directionRef.current = direction === 'left' ? 1 : -1;
    elapsedRef.current = 0;
    progress.set(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  const backgroundPosition = useTransform(progress, (p: number) => `${150 - p * 2}% center`);

  const handleMouseEnter = useCallback(() => { if (pauseOnHover) setIsPaused(true); }, [pauseOnHover]);
  const handleMouseLeave = useCallback(() => { if (pauseOnHover) setIsPaused(false); }, [pauseOnHover]);

  const gradientStyle = {
    backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
    backgroundSize: '200% auto',
    WebkitBackgroundClip: 'text' as const,
    backgroundClip: 'text' as const,
    WebkitTextFillColor: 'transparent' as const,
  };

  return (
    <motion.span
      className={`shiny-text ${className}`}
      style={{ ...gradientStyle, backgroundPosition }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {text}
    </motion.span>
  );
};

export default ShinyText;

// ── Brand-palette presets ──────────────────────────────────────────────────
// Use these instead of raw <ShinyText> wherever possible so the shimmer feels
// like one consistent brand effect rather than 12 random gradients.

/** Light-on-dark with the BnB gold shine. Good default for headlines on the
 *  dark site background (radial purple gradients, black overlays, etc.). */
export const ShinyBrand = (p: Omit<ShinyTextProps, 'color' | 'shineColor'> & { color?: string; shineColor?: string }) => (
  <ShinyText
    color={p.color ?? '#e8d8ff'}
    shineColor={p.shineColor ?? '#f3ba2f'}
    speed={p.speed ?? 2.6}
    spread={p.spread ?? 110}
    {...p}
  />
);

/** Solid white-ish base with the same gold shine — for use inside the
 *  primary purple/teal buttons where text is already near-white. */
export const ShinyButtonLabel = (p: Omit<ShinyTextProps, 'color' | 'shineColor'> & { color?: string; shineColor?: string }) => (
  <ShinyText
    color={p.color ?? '#ffffff'}
    shineColor={p.shineColor ?? '#ffe39a'}
    speed={p.speed ?? 3.4}
    spread={p.spread ?? 100}
    {...p}
  />
);

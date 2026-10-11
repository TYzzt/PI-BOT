import React, { useEffect, useRef } from "react";
import { BotEngine } from "./engine.js";
import { drawBot } from "./render.js";
import type { Avatar, Mood } from "./spec.js";

export interface PiBotProps {
  avatar: Avatar;
  mood: Mood;
  size: number;
  /** Eyes follow the pointer while it is over the character. */
  followPointer?: boolean;
  paused?: boolean;
  label?: string;
  className?: string;
  onClick?: () => void;
}
const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function PiBot({
  avatar,
  mood,
  size,
  followPointer = false,
  paused = false,
  label,
  className,
  onClick,
}: PiBotProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<BotEngine | null>(null);
  const look = useRef(avatar);
  look.current = avatar;
  engine.current ??= new BotEngine(mood, {
    seed: Math.floor(Math.random() * 1e9),
    reduceMotion: reduced(),
  });
  useEffect(() => {
    engine.current!.setMood(mood);
  }, [mood]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    el.width = Math.round(size * ratio);
    el.height = Math.round(size * ratio);
    let frame = 0,
      last = performance.now();
    const render = (now: number) => {
      const e = engine.current!;
      if (!paused) e.step((now - last) / 1000);
      last = now;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawBot(ctx, e.frame(), look.current, size);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [size, paused]);
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!followPointer) return;
    const r = event.currentTarget.getBoundingClientRect();
    engine.current!.look({
      x: ((event.clientX - r.left) / r.width) * 2 - 1,
      y: ((event.clientY - r.top) / r.height) * 2 - 1,
    });
  };
  return (
    <canvas
      ref={canvas}
      className={className}
      role="img"
      aria-label={label ?? "Pi Bot"}
      style={{ width: size, height: size, display: "block" }}
      onPointerMove={move}
      onPointerLeave={() => engine.current!.look(null)}
      onClick={() => {
        engine.current!.bounce();
        onClick?.();
      }}
    />
  );
}

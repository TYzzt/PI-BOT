import raw from "../spec.json" with { type: "json" };

export type Point = [number, number];
export type EyeStyle = "open" | "happy" | "wink" | "closed" | "focus" | "small";
export type MouthStyle = "smile" | "open" | "flat" | "o" | "frown";
export type ArmStyle = "down" | "wave" | "up" | "type" | "think" | "hidden";
export type EffectStyle =
  | "none"
  | "dots"
  | "question"
  | "confetti"
  | "alert"
  | "zzz"
  | "sparkle";
export interface ShapeSpec {
  label: string;
  points: Point[];
  face: { y: number; gap: number; eye: number };
}
export interface ColorSpec {
  label: string;
  light: [string, string];
  dark: [string, string];
  ink: string;
  cheek: string;
}
export interface MoodSpec {
  label: string;
  eyes: EyeStyle;
  mouth: MouthStyle;
  arms: ArmStyle;
  effect: EffectStyle;
}
export const SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "cloud",
  "drop",
  "bell",
] as const;
export const COLORS = [
  "orange",
  "coral",
  "pink",
  "grape",
  "sky",
  "mint",
  "lime",
  "lemon",
  "cocoa",
  "ink",
] as const;
export const MOODS = [
  "idle",
  "happy",
  "thinking",
  "working",
  "searching",
  "waiting",
  "celebrate",
  "error",
  "sleeping",
] as const;
export const SCHEMES = ["light", "dark"] as const;
export type Shape = (typeof SHAPES)[number];
export type Color = (typeof COLORS)[number];
export type Mood = (typeof MOODS)[number];
export type Scheme = (typeof SCHEMES)[number];
export interface Avatar {
  shape: Shape;
  color: Color;
  scheme: Scheme;
}
export interface Spec {
  version: number;
  defaults: Avatar & { mood: Mood };
  shapes: Record<Shape, ShapeSpec>;
  colors: Record<Color, ColorSpec>;
  moods: Record<Mood, MoodSpec>;
  confetti: string[];
}
export const spec = raw as unknown as Spec;
export const DEFAULT_AVATAR: Avatar = {
  shape: spec.defaults.shape,
  color: spec.defaults.color,
  scheme: spec.defaults.scheme,
};
export function isAvatar(value: unknown): value is Avatar {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    SHAPES.includes(v.shape as Shape) &&
    COLORS.includes(v.color as Color) &&
    SCHEMES.includes(v.scheme as Scheme)
  );
}
export function normalizeAvatar(value: unknown): Avatar {
  if (isAvatar(value))
    return { shape: value.shape, color: value.color, scheme: value.scheme };
  return { ...DEFAULT_AVATAR };
}
/** Deterministic look for a new bot so each one starts distinct. */
export function avatarFor(seed: string): Avatar {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return {
    shape: SHAPES[h % SHAPES.length],
    color: COLORS[(h >>> 8) % COLORS.length],
    scheme: "light",
  };
}

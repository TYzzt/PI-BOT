import test from "node:test";
import assert from "node:assert/strict";
import {
  avatarFor,
  BotEngine,
  COLORS,
  drawBot,
  isAvatar,
  moodFor,
  MOODS,
  normalizeAvatar,
  rng,
  SCHEMES,
  SHAPES,
  sleepLabel,
  smoothOutline,
  spec,
} from "../src/index.js";

/** Reference values shared with the Android port (PiBotEngineTest.kt). */
export const RNG_42 = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423];

test("spec covers every shape, color and mood with valid data", () => {
  assert.deepEqual(Object.keys(spec.shapes).sort(), [...SHAPES].sort());
  assert.deepEqual(Object.keys(spec.colors).sort(), [...COLORS].sort());
  assert.deepEqual(Object.keys(spec.moods).sort(), [...MOODS].sort());
  const hex = /^#[0-9a-f]{6}$/i;
  for (const [name, s] of Object.entries(spec.shapes)) {
    assert.ok(s.points.length >= 6, `${name} needs a closed outline`);
    for (const [x, y] of s.points) assert.ok(Math.abs(x) <= 1.3 && Math.abs(y) <= 1.3, `${name} stays in unit space`);
    assert.ok(s.face.eye > 0 && s.face.gap > 0);
  }
  for (const [name, c] of Object.entries(spec.colors))
    for (const value of [...c.light, ...c.dark, c.ink, c.cheek]) assert.match(value, hex, `${name} ${value}`);
  for (const value of spec.confetti) assert.match(value, hex);
  assert.equal(spec.defaults.shape, "blob");
  assert.equal(spec.defaults.color, "orange");
});

test("avatars validate, normalize and vary deterministically by seed", () => {
  assert.equal(isAvatar({ shape: "blob", color: "orange", scheme: "light" }), true);
  assert.equal(isAvatar({ shape: "triangle", color: "orange", scheme: "light" }), false);
  assert.deepEqual(normalizeAvatar(null), { shape: "blob", color: "orange", scheme: "light" });
  assert.deepEqual(avatarFor("abc"), avatarFor("abc"));
  const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(avatarFor(`bot-${i}`))));
  assert.ok(looks.size > 15, "new bots should rarely look alike");
  for (const scheme of SCHEMES) assert.ok(isAvatar({ ...avatarFor("x"), scheme }));
});

test("rng matches the shared reference sequence", () => {
  const r = rng(42);
  for (const expected of RNG_42) assert.ok(Math.abs(r() - expected) < 1e-12);
});

test("engine is deterministic for the same seed and settles after a hop", () => {
  const run = () => {
    const e = new BotEngine("idle", { seed: 7 });
    const frames = [];
    for (let i = 0; i < 300; i++) {
      if (i === 30) e.setMood("celebrate");
      if (i === 150) e.setMood("idle");
      e.step(1 / 60);
      frames.push(e.frame());
    }
    return frames.map((f) => [f.blink, f.gazeX, f.offsetY, f.scaleX, f.particles.length].map((v) => v.toFixed(6)).join());
  };
  assert.deepEqual(run(), run());
  const e = new BotEngine("idle", { seed: 1 });
  e.bounce();
  for (let i = 0; i < 600; i++) e.step(1 / 60);
  assert.ok(Math.abs(e.frame().offsetY) < 0.02, "hop spring returns to rest");
});

test("celebrate throws confetti, reduce-motion stays still", () => {
  const e = new BotEngine("idle", { seed: 3 });
  e.setMood("celebrate");
  e.step(0.016);
  assert.ok(e.frame().particles.length >= 20);
  for (let i = 0; i < 400; i++) e.step(0.05);
  assert.ok(e.frame().particles.length <= 80, "particle pool is bounded");
  const calm = new BotEngine("idle", { seed: 3, reduceMotion: true });
  calm.setMood("celebrate");
  for (let i = 0; i < 100; i++) calm.step(0.05);
  const f = calm.frame();
  assert.equal(f.particles.length, 0);
  assert.equal(f.blink, 0);
  assert.equal(f.scaleX, 1);
});

test("eyes track the pointer except while busy", () => {
  const e = new BotEngine("idle", { seed: 1 });
  e.look({ x: 1, y: -1 });
  for (let i = 0; i < 120; i++) e.step(1 / 60);
  assert.ok(e.frame().gazeX > 0.9 && e.frame().gazeY < -0.9);
  e.setMood("working");
  for (let i = 0; i < 120; i++) e.step(1 / 60);
  assert.ok(Math.abs(e.frame().gazeX) < 0.1, "working looks at the desk");
});

test("run status maps to moods", () => {
  const now = 1_000_000_000;
  assert.equal(moodFor({ status: null, now }), "idle");
  assert.equal(moodFor({ status: "queued", now }), "thinking");
  assert.equal(moodFor({ status: "running", now }), "thinking");
  assert.equal(moodFor({ status: "running", tool: "web_search", now }), "searching");
  assert.equal(moodFor({ status: "running", tool: "run_command", now }), "working");
  assert.equal(moodFor({ status: "running", tool: "ask_agent", now }), "waiting");
  assert.equal(moodFor({ status: "waiting_approval", now }), "waiting");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 1000, now }), "celebrate");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 60000, now }), "idle");
  assert.equal(moodFor({ status: "failed", finishedAt: now - 1000, now }), "error");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 8 * 86400_000, lastActiveAt: now - 7 * 86400_000, now }), "sleeping");
  assert.equal(sleepLabel(now - 7 * 86400_000, now), "7 天");
  assert.equal(sleepLabel(now - 3600_000, now), null);
});

test("renderer draws every shape, color and mood without a real canvas", () => {
  const calls: string[] = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
      return (...args: unknown[]) => {
        calls.push(key);
        for (const a of args) if (typeof a === "number") assert.ok(Number.isFinite(a), `${key} got ${a}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  for (const shape of SHAPES)
    for (const mood of MOODS) {
      const e = new BotEngine(mood, { seed: 2 });
      e.setMood(mood);
      e.step(0.05);
      for (const color of COLORS.slice(0, 3)) drawBot(ctx, e.frame(), { shape, color, scheme: "dark" }, 120);
    }
  assert.ok(calls.includes("bezierCurveTo"));
  assert.ok(calls.includes("fill"));
});

test("outline smoothing produces one cubic per point", () => {
  const pts: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const outline = smoothOutline(pts, 1);
  assert.equal(outline.segments.length, pts.length);
  assert.deepEqual(outline.segments.at(-1)![2], pts[0], "outline closes on the first anchor");
});

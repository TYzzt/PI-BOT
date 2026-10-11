import type { Point } from "./spec.js";

export interface Bezier {
  start: Point;
  segments: [Point, Point, Point][];
}
/**
 * Closed Catmull-Rom spline through the shape anchors, as cubic Bezier
 * segments. Shared by every renderer so outlines match across platforms.
 */
export function smoothOutline(points: Point[], tension = 1): Bezier {
  const n = points.length;
  const segments: [Point, Point, Point][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n],
      p1 = points[i],
      p2 = points[(i + 1) % n],
      p3 = points[(i + 2) % n];
    const c1: Point = [
      p1[0] + ((p2[0] - p0[0]) / 6) * tension,
      p1[1] + ((p2[1] - p0[1]) / 6) * tension,
    ];
    const c2: Point = [
      p2[0] - ((p3[0] - p1[0]) / 6) * tension,
      p2[1] - ((p3[1] - p1[1]) / 6) * tension,
    ];
    segments.push([c1, c2, p2]);
  }
  return { start: points[0], segments };
}
export function bounds(points: Point[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Directions relative to where the player looks. Models handle "4 ahead, 2 to the left, 1 up" far
 * better than raw world coordinates, which they routinely mix up (benchmarks such as MineAnyBuild
 * report the same). Minecraft yaw: 0 faces south (+z), 90 west (-x), 180 north, -90 east.
 */
import type { Pos } from "./format.js";

export interface Relative {
  ahead: number;
  right: number;
  up: number;
  /** Horizontal bearing as a clock hour, 12 = straight ahead. */
  clock: number;
  distance: number;
}

const COMPASS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

/** The compass direction of a yaw. */
export function facing(yaw: number): string {
  const i = Math.round((((yaw % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i]!;
}

export function relative(from: Pos & { yaw: number }, to: Pos): Relative {
  const rad = (from.yaw * Math.PI) / 180;
  const fx = -Math.sin(rad);
  const fz = Math.cos(rad);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const ahead = dx * fx + dz * fz;
  // The player's right hand: facing south (+z), it points west (-x).
  const right = dx * -fz + dz * fx;
  const up = to.y - from.y;
  const angle = Math.atan2(right, ahead); // 0 ahead, +pi/2 right
  let clock = Math.round((angle / (2 * Math.PI)) * 12);
  if (clock <= 0) clock += 12;
  return { ahead, right, up, clock, distance: Math.hypot(dx, to.y - from.y, dz) };
}

const n = (v: number) => Math.round(Math.abs(v));

/** "4 ahead, 2 left, 1 up · 4.6 m (11 o'clock)". */
export function describe(r: Relative): string {
  const parts: string[] = [];
  if (n(r.ahead) > 0) parts.push(`${n(r.ahead)} ${r.ahead > 0 ? "ahead" : "behind"}`);
  if (n(r.right) > 0) parts.push(`${n(r.right)} ${r.right > 0 ? "right" : "left"}`);
  if (n(r.up) > 0) parts.push(`${n(r.up)} ${r.up > 0 ? "up" : "down"}`);
  const where = parts.length ? parts.join(", ") : "right here";
  return `${where} · ${r.distance.toFixed(1)} m (${r.clock} o'clock)`;
}

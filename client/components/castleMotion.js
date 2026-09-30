/**
 * Where the Castle's units stand and how they walk (#161). Pure: no DOM and no
 * React, so the geometry and the walking rules live here and CastleStage only
 * plays what this returns. The spec's rules it implements:
 *
 *   - Walk, never teleport, along fixed corridors, about 1 s a hop.
 *   - Queue, don't blur: every room a unit worked in is walked through, in
 *     order; with n hops queued each takes 1/n of a second, never under
 *     0.25 s, so it catches up without skipping one.
 *   - Rooms on the way are passed through at their centre; the last one is
 *     reached at the unit's own spot there.
 *
 * The corridors: one under each row of rooms (under the last row, the strip
 * inside the wall), one in each gap between columns, the gate in the south
 * wall, and small gates in the west wall (to the Wilds) and the east wall (to
 * the Citadel, where files outside the project go). Every room's door opens
 * onto the corridor below it.
 * A route is always the same path: out of the door onto that corridor, along
 * it to the nearest column gap, up or down the gap to the other room's
 * corridor, along, and in at that room's door.
 */

export const W = 1000;
export const BAND = 70; // the Wilds, all round the wall
const GAP = 24;
const ROOM_H = 190;
export const DOT = 15;
/** Space below the wall: the gate, and beyond it where Scouts go. */
const BELOW = 120;
const WALL_INSET = 22;

export const HOP_MS = 1000;
export const MIN_HOP_MS = 250;
/** A unit moving to another spot in the room it is in (someone arrived or left). */
export const SLIDE_MS = 300;
export const FADE_MS = 300;

export function layout(floor) {
  const cols = floor?.cols || 3;
  const rows = floor?.rows || 4;
  const roomW = (W - 2 * BAND - (cols - 1) * GAP) / cols;
  const gridBottom = BAND + rows * ROOM_H + (rows - 1) * GAP;
  const wallBottom = gridBottom + WALL_INSET;
  const H = gridBottom + BELOW;
  const cell = (col, row) => ({ x: BAND + col * (roomW + GAP), y: BAND + row * (ROOM_H + GAP), w: roomW, h: ROOM_H });
  const gateCol = floor?.gate?.col ?? 1;
  const gateX = BAND + gateCol * (roomW + GAP) + roomW / 2;
  const wallX = BAND - WALL_INSET;
  const wallY = BAND - WALL_INSET;
  const corridorY = (row) => (row < rows - 1 ? BAND + (row + 1) * ROOM_H + row * GAP + GAP / 2 : gridBottom + WALL_INSET / 2);
  const gaps = Array.from({ length: cols - 1 }, (_, i) => BAND + (i + 1) * roomW + i * GAP + GAP / 2);
  return {
    cols,
    rows,
    roomW,
    H,
    cell,
    wallBottom,
    wallX,
    wallY,
    corridorY,
    gaps,
    gate: { x: gateX, outer: { x: gateX, y: wallBottom + 70 } },
    // The side gates sit on the first corridor, clear of the bands' labels.
    sideGates: { wilds: { x: wallX, y: corridorY(0) }, outside: { x: W - wallX, y: corridorY(0) } },
    // At the gate: just outside the wall's opening. Beyond it: further out, in the Wilds.
    gateBox: { x: gateX - 80, y: wallBottom + 4, w: 160, h: 40 },
    beyondBox: { x: gateX - 120, y: wallBottom + 50, w: 240, h: 40 },
    wildsBox: { x: 6, y: BAND, w: BAND - 30, h: H - 2 * BAND },
    outsideBox: { x: W - BAND + 24, y: BAND, w: BAND - 30, h: H - 2 * BAND },
  };
}

export function slots(box, count, { row = 'bottom' } = {}) {
  const perRow = Math.max(1, Math.floor((box.w - 16) / (DOT * 2 + 8)));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x = box.x + 8 + DOT + c * (DOT * 2 + 8);
    const y = row === 'bottom' ? box.y + box.h - 8 - DOT - r * (DOT * 2 + 6) : box.y + 8 + DOT + r * (DOT * 2 + 6);
    out.push({ x, y });
  }
  return out;
}

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The spots `n` units take at one place. `perch` is the room Ravens wait above (the map's), or null. */
function spots(L, rooms, place, n, perch) {
  const room = rooms.get(place);
  if (room) return slots(L.cell(room.col, room.row), n);
  if (place === 'perch') {
    // Ravens wait on the wall above the first Integrations room, else above the gate.
    const r = perch ? rooms.get(perch) : null;
    const x = r ? centre(L.cell(r.col, r.row)).x : L.gate.x;
    return Array.from({ length: n }, (_, i) => ({ x: x + (i - (n - 1) / 2) * (DOT * 2 + 8), y: L.wallY }));
  }
  if (place === 'wilds') {
    const box = L.wildsBox;
    return Array.from({ length: n }, (_, i) => ({ x: box.x + box.w / 2 + 6, y: box.y + 40 + i * (DOT * 2 + 8) }));
  }
  if (place === 'outside') {
    // Below the road to the Citadel, whose tower stands above it.
    const box = L.outsideBox;
    return Array.from({ length: n }, (_, i) => ({ x: box.x + box.w / 2 - 2, y: L.sideGates.outside.y + 36 + i * (DOT * 2 + 8) }));
  }
  return slots(place === 'beyond-gate' ? L.beyondBox : L.gateBox, n);
}

/**
 * Where every unit stands: key -> { place, point }. A Wizard whose caller is
 * on the castle rides with it and is not placed; a Raven's place is its perch.
 * A place not on this floor plan stands at the gate.
 */
export function placeUnits(L, rooms, units, perch = null) {
  const keys = new Set(units.map((u) => u.key));
  const at = new Map();
  for (const u of units) {
    if (u.kind === 'wizard' && keys.has(u.caller)) continue;
    let place = u.kind === 'raven' ? 'perch' : u.room || 'gate';
    if (!rooms.has(place) && !['perch', 'wilds', 'outside', 'gate', 'beyond-gate'].includes(place)) place = 'gate';
    if (!at.has(place)) at.set(place, []);
    at.get(place).push(u);
  }
  const out = new Map();
  for (const [place, list] of at) {
    const pts = spots(L, rooms, place, list.length, perch);
    list.forEach((u, i) => out.set(u.key, { place, point: pts[i] }));
  }
  return out;
}

/** A room's centre, where a unit passes through it on the way somewhere else; elsewhere, the place's first spot. */
export function waypoint(L, rooms, place) {
  const room = rooms.get(place);
  return room ? centre(L.cell(room.col, room.row)) : spots(L, rooms, place, 1)[0];
}

const beyondWall = (place) => place === 'gate' || place === 'beyond-gate';

/** A place's door, and the corridor it opens onto (row, and x along it). */
function door(L, rooms, place) {
  const room = rooms.get(place);
  if (room) {
    const b = L.cell(room.col, room.row);
    const x = b.x + b.w / 2;
    return { at: { x, y: b.y + b.h }, row: room.row, x };
  }
  if (place === 'wilds' || place === 'outside') {
    const g = L.sideGates[place];
    return { at: g, row: 0, x: g.x };
  }
  return { at: { x: L.gate.x, y: L.wallBottom }, row: L.rows - 1, x: L.gate.x };
}

/** The column gap to change rows by: the nearest to where the unit is, among those on its way. */
function nearestGap(L, from, to) {
  if (!L.gaps.length) return L.wallX + WALL_INSET / 2;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const between = L.gaps.filter((g) => g >= lo && g <= hi);
  const pool = between.length ? between : L.gaps;
  return pool.reduce((best, g) => (Math.abs(g - from) < Math.abs(best - from) ? g : best));
}

function dedupe(pts) {
  return pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) > 0.01 || Math.abs(p.y - pts[i - 1].y) > 0.01);
}

/** The corridor path between two places, as points from `from.point` to `to.point`. */
export function route(L, rooms, from, to) {
  if (from.place === to.place || (beyondWall(from.place) && beyondWall(to.place))) return dedupe([from.point, to.point]);
  const a = door(L, rooms, from.place);
  const b = door(L, rooms, to.place);
  const ya = L.corridorY(a.row);
  const yb = L.corridorY(b.row);
  const pts = [from.point, a.at, { x: a.x, y: ya }];
  if (a.row !== b.row) {
    const g = nearestGap(L, a.x, b.x);
    pts.push({ x: g, y: ya }, { x: g, y: yb });
  }
  pts.push({ x: b.x, y: yb }, b.at, to.point);
  return dedupe(pts);
}

/** One hop's time with `n` queued: 1/n of a second, never under 0.25 s. */
export function hopMs(n) {
  return Math.max(MIN_HOP_MS, HOP_MS / Math.max(1, n));
}

/**
 * The rooms of a trail this unit has not walked yet: those after the last
 * entry it saw. An entry it saw that is no longer in the trail (more room
 * changes than the server keeps, between two frames) means all of them.
 */
export function newPlaces(trail, lastKey) {
  if (!Array.isArray(trail) || !trail.length) return [];
  const i = lastKey ? trail.findIndex((t) => t.key === lastKey) : -1;
  return trail.slice(i + 1).map((t) => t.room);
}

export const lastTrailKey = (trail) => (Array.isArray(trail) && trail.length ? trail[trail.length - 1].key : null);

/**
 * A walk from `from` ({ place, point }) through `places`, in order: one leg
 * per place, { place, pts, ms }, every leg the same time.
 */
export function planWalk(L, rooms, from, places, final) {
  const legs = [];
  let at = from;
  places.forEach((place, i) => {
    const to = { place, point: i === places.length - 1 ? final : waypoint(L, rooms, place) };
    legs.push({ place, pts: route(L, rooms, at, to) });
    at = to;
  });
  const ms = hopMs(legs.length);
  for (const leg of legs) leg.ms = ms;
  return legs;
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function lengthOf(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i += 1) n += dist(pts[i - 1], pts[i]);
  return n;
}

export const totalMs = (legs) => legs.reduce((n, l) => n + l.ms, 0);

/** Web Animations keyframes for a walk: steady speed within each leg. */
export function keyframes(legs) {
  const total = totalMs(legs) || 1;
  const frames = [];
  let t = 0;
  legs.forEach((leg, li) => {
    const len = lengthOf(leg.pts);
    let d = 0;
    leg.pts.forEach((p, pi) => {
      if (pi > 0) d += dist(leg.pts[pi - 1], p);
      // A leg's first point is the previous leg's last.
      if (li > 0 && pi === 0) return;
      const within = len ? (d / len) * leg.ms : pi === 0 ? 0 : leg.ms;
      frames.push({ transform: `translate(${p.x}px, ${p.y}px)`, offset: Math.min(1, (t + within) / total) });
    });
    t += leg.ms;
  });
  if (!frames.length) return frames;
  if (frames.length === 1) frames.push({ ...frames[0], offset: 1 });
  frames[frames.length - 1].offset = 1;
  return frames;
}

/**
 * Where a walk is at `t` ms: the leg it is on, the point, and what is left of
 * that leg (the point first, the leg's destination last). Null once it is over.
 */
export function positionAt(legs, t) {
  let start = 0;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (t < start + leg.ms) {
      const len = lengthOf(leg.pts);
      let want = (Math.max(0, t - start) / leg.ms) * len;
      for (let s = 1; s < leg.pts.length; s += 1) {
        const a = leg.pts[s - 1];
        const b = leg.pts[s];
        const seg = dist(a, b);
        if (want <= seg || s === leg.pts.length - 1) {
          const f = seg ? Math.min(1, want / seg) : 1;
          const point = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
          const rest = dedupe([point, ...leg.pts.slice(s)]);
          return { index: i, point, rest: rest.length > 1 ? rest : [point, leg.pts[leg.pts.length - 1]], left: len ? Math.max(0, 1 - (Math.max(0, t - start) / leg.ms)) : 0 };
        }
        want -= seg;
      }
    }
    start += leg.ms;
  }
  return null;
}

/**
 * A walk already under way when more places arrive, or its last spot moves:
 * the leg it is on is finished (its destination is still a room it worked
 * in), then every place still ahead, then the new ones. The pace is set again
 * for the whole queue, so a unit that falls behind speeds up.
 */
export function replan(L, rooms, legs, t, places, final) {
  const at = positionAt(legs, t);
  if (!at) return null;
  const ahead = [...legs.slice(at.index).map((l) => l.place), ...places];
  const ms = hopMs(ahead.length);
  const firstTo = { place: ahead[0], point: ahead.length === 1 ? final : waypoint(L, rooms, ahead[0]) };
  const first = { place: ahead[0], pts: dedupe([...at.rest.slice(0, -1), firstTo.point]), ms: Math.max(1, ms * at.left) };
  return [first, ...planWalk(L, rooms, firstTo, ahead.slice(1), final).map((l) => ({ ...l, ms }))];
}

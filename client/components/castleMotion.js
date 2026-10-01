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
 * wall, and a small gate in the east wall to the Citadel, where files outside
 * the project go. Hollowmere, the village for files no room claims, is reached
 * through the south gate (#172). The keep's north wall is the Frostwall, with
 * the Wilds beyond it. Every room's door opens onto the corridor below it.
 * A route is always the same path: out of the door onto that corridor, along
 * it to the nearest column gap, up or down the gap to the other room's
 * corridor, along, and in at that room's door.
 */

export const W = 1000;
/** Beside the wall: open ground west, the Citadel's band east. */
export const BAND = 70;
/** The Wilds, north of the Frostwall (#172): the forest Raiders come out of. */
export const WILDS_H = 100;
/** The Frostwall: the keep's north wall, the whole width (#172). */
export const FROST_H = 34;
/** The top of the rooms: under the Frostwall and the wall's inset. */
const TOP = WILDS_H + FROST_H + 22;
const GAP = 24;
const ROOM_H = 190;
export const DOT = 15;
/** Space below the wall: the gate, the road where Scouts go, and Hollowmere beside it. */
const BELOW = 240;
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
  const gridBottom = TOP + rows * ROOM_H + (rows - 1) * GAP;
  const wallBottom = gridBottom + WALL_INSET;
  const H = gridBottom + BELOW;
  const cell = (col, row) => ({ x: BAND + col * (roomW + GAP), y: TOP + row * (ROOM_H + GAP), w: roomW, h: ROOM_H });
  const gateCol = floor?.gate?.col ?? 1;
  const gateX = BAND + gateCol * (roomW + GAP) + roomW / 2;
  const wallX = BAND - WALL_INSET;
  const wallY = TOP - WALL_INSET;
  const corridorY = (row) => (row < rows - 1 ? TOP + (row + 1) * ROOM_H + row * GAP + GAP / 2 : gridBottom + WALL_INSET / 2);
  // Hollowmere takes the wider side of the road, clear of the gate and the Citadel's band.
  const leftRoom = gateX - 90 - 16;
  const rightRoom = W - BAND - (gateX + 90);
  const villageW = Math.min(280, Math.max(leftRoom, rightRoom));
  const villageX = leftRoom >= rightRoom ? gateX - 90 - villageW : gateX + 90;
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
    // Ravens wait on the Frostwall.
    perchY: WILDS_H + FROST_H / 2,
    corridorY,
    gaps,
    gate: { x: gateX, outer: { x: gateX, y: wallBottom + 70 } },
    // The Citadel's side gate sits on the first corridor, clear of its band's label.
    sideGates: { outside: { x: W - wallX, y: corridorY(0) } },
    // At the gate: just outside the wall's opening. Beyond it: down the road.
    gateBox: { x: gateX - 80, y: wallBottom + 4, w: 160, h: 40 },
    beyondBox: { x: gateX - 60, y: wallBottom + 110, w: 120, h: 110 },
    villageBox: { x: villageX, y: wallBottom + 40, w: villageW, h: BELOW - 56 },
    wildsBox: { x: BAND, y: 12, w: W - 2 * BAND, h: WILDS_H - 24 },
    outsideBox: { x: W - BAND + 24, y: TOP, w: BAND - 30, h: H - TOP - BAND },
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
    return Array.from({ length: n }, (_, i) => ({ x: x + (i - (n - 1) / 2) * (DOT * 2 + 8), y: L.perchY }));
  }
  if (place === 'village') return slots(L.villageBox, n);
  if (place === 'wilds') return slots(L.wildsBox, n);
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
    // Raiders and cranes are not walked: runSpot places them.
    if (RUN_KINDS.has(u.kind)) continue;
    let place = u.kind === 'raven' ? 'perch' : u.room || 'gate';
    if (!rooms.has(place) && !['perch', 'village', 'wilds', 'outside', 'gate', 'beyond-gate'].includes(place)) place = 'gate';
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

/** Units that stand outside the walls for a run and are not walked: Raiders for a test (#172), a crane for a build (#173). */
export const RUN_KINDS = new Set(['raiders', 'crane']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where Raiders stand or a crane sits, and the point in each target room
 * their arrows land on or its stones are lowered onto. Raiders come out of
 * the Wilds when their targets lie in the back half of the keep, else they
 * shoot from the front, out past Hollowmere; either way over the wall nearer
 * the targets (#172). A crane sits before the gate, on the side away from
 * Hollowmere, and lowers its stones onto the centre of each room (#173).
 */
export function runSpot(L, rooms, u) {
  const targets = (u.targets || []).map((id) => rooms.get(id)).filter(Boolean);
  const cells = targets.map((r) => L.cell(r.col, r.row));
  const cx = cells.length ? cells.reduce((n, b) => n + b.x + b.w / 2, 0) / cells.length : L.gate.x;
  let at;
  let north = false;
  if (u.kind === 'crane') {
    const side = L.villageBox.x > L.gate.x ? -1 : 1;
    at = { x: L.gate.x + side * 130, y: L.wallBottom + 50 };
    // The cable meets each room at its centre (owner, 2026-10-01).
    return { at, north, hits: cells.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })) };
  } else {
    const meanRow = targets.length ? targets.reduce((n, r) => n + r.row, 0) / targets.length : 0;
    north = meanRow <= (L.rows - 1) / 2;
    if (north) at = { x: clamp(cx, BAND + 50, W - BAND - 50), y: WILDS_H - 24 };
    else {
      // Clear of the road, where Scouts ride.
      const x = Math.abs(cx - L.gate.x) < 90 ? L.gate.x + (cx >= L.gate.x ? 90 : -90) : cx;
      at = { x: clamp(x, BAND + 30, W - BAND - 30), y: L.H - 34 };
    }
  }
  // Arrows land in the half of a room facing the side they come from.
  const hits = cells.map((b) => ({ x: b.x + b.w / 2, y: north ? b.y + b.h * 0.34 : b.y + b.h * 0.66 }));
  return { at, north, hits };
}

/** A room's centre, where a unit passes through it on the way somewhere else; elsewhere, the place's first spot. */
export function waypoint(L, rooms, place) {
  const room = rooms.get(place);
  return room ? centre(L.cell(room.col, room.row)) : spots(L, rooms, place, 1)[0];
}

/** Places outside the south wall: a walk between two of them does not go through the keep. */
const beyondWall = (place) => place === 'gate' || place === 'beyond-gate' || place === 'village';

/** A place's door, and the corridor it opens onto (row, and x along it). */
function door(L, rooms, place) {
  const room = rooms.get(place);
  if (room) {
    const b = L.cell(room.col, room.row);
    const x = b.x + b.w / 2;
    return { at: { x, y: b.y + b.h }, row: room.row, x };
  }
  if (place === 'outside') {
    const g = L.sideGates.outside;
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

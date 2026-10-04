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
 * inside the wall), one in each gap between columns, and the gate in the
 * south wall, the keep's only way in or out. Hollowmere, the village for
 * files no room claims, stands west of the keep, and the Citadel, where files
 * outside the project go, east of it (#183, owner's picks 2026-10-02); both
 * are reached through the gate, along a road that forks west and east in
 * front of it. The keep's north wall is the Frostwall, with the Wilds beyond
 * it. Every room's door opens onto the corridor below it. A route is always
 * the same path: out of the door onto that corridor, along it to the nearest
 * column gap, up or down the gap to the other room's corridor, along, and in
 * at that room's door; to Hollowmere or the Citadel, out of the gate and
 * along the road.
 */

/** The castle's width: two bands and a floor of rooms the same size as before #183, when it was 1000 with 70-wide bands. */
export const W = 1380;
/** Beside the wall, each side (#183): Hollowmere's band west, the Citadel's east. */
export const BAND = 260;
/** The Wilds, north of the Frostwall (#172): the forest Raiders come out of. */
export const WILDS_H = 100;
/** The Frostwall: the keep's north wall, the whole width (#172). */
export const FROST_H = 34;
/** The top of the rooms: under the Frostwall and the wall's inset. */
const TOP = WILDS_H + FROST_H + 22;
const GAP = 24;
const ROOM_H = 190;
export const DOT = 15;
/** Space below the last row of rooms: the wall, units at the gate, the fork's road, and the road south where Scouts go. */
const BELOW = 170;
const WALL_INSET = 22;
/** The fork's road: its middle this far below the wall (#183). */
const ROAD_DY = 62;
/** Hollowmere's, the Sept's and the Citadel's drawings: a box this wide in their band, above the road. */
const PLACE_W = BAND - 62;
/** The Citadel's drawing, at most this tall. */
const PLACE_H = 520;
/**
 * The west band (#186, owner decisions 2026-10-02), top to bottom:
 * Hollowmere's name, its drawing, the stand where its units wait, a gap, the
 * Sept's name and its drawing; the Sept's own stand is below it, above the
 * road. On a floor too short for all of it, everything in it scales (#184).
 */
const HOLLOW_H = 230;
const SEPT_H = 350;
const WEST_STACK = 40 + HOLLOW_H + 70 + 20 + 40 + SEPT_H;
/**
 * A walk to or from Hollowmere or the Citadel is timed by its length, at about
 * a room-to-room walk's pace (three of those measure 325 to 1,195), up to 3 s
 * (#183, owner decision 2026-10-02): through the gate and along the road it can
 * be 1,600 long, a sprint in the 1 s every other walk takes.
 */
const PLACE_PACE = 800;
const PLACE_MAX_MS = 3000;

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
  // Hollowmere and the Citadel (#183): each drawn in its band, standing on
  // the ground above the road, as tall as the floor allows (the drawing
  // scales down on a short one), with the units at it on its spur of road,
  // south of the drawing.
  const westX = 18;
  const eastX = W - BAND + 44;
  const placeBottom = wallBottom - 100;
  const placeTop = Math.max(WILDS_H + FROST_H + 50, placeBottom - PLACE_H);
  const placeBox = (x) => ({ x, y: placeTop, w: PLACE_W, h: Math.max(60, placeBottom - placeTop) });
  // The west band: Hollowmere above, the Sept at its foot (#186).
  const westTop = WILDS_H + FROST_H + 36;
  const septBase = wallBottom - 80;
  const ws = Math.max(0.1, Math.min(1, (septBase - westTop) / WEST_STACK));
  const hollowY = westTop + 40 * ws;
  const septY = septBase - SEPT_H * ws;
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
    // At the gate: just outside the wall's opening. Beyond it: down the road south of the fork.
    gateBox: { x: gateX - 80, y: wallBottom + 4, w: 160, h: 40 },
    beyondBox: { x: gateX - 60, y: wallBottom + ROAD_DY + 20, w: 120, h: H - wallBottom - ROAD_DY - 22 },
    // The fork's road (#183): along the front of the wall; Hollowmere's spur
    // leaves it at the band's outer edge, the Sept's into its door, and the
    // Citadel's in the east (#186: partly separate paths, owner's pick).
    road: { y: wallBottom + ROAD_DY, west: westX + 4, sept: westX + PLACE_W / 2, east: eastX + PLACE_W / 2 },
    // Where units at each stand: Hollowmere's below its drawing, the Sept's before its door, the Citadel's below its rock.
    villageBox: { x: westX, y: hollowY + HOLLOW_H * ws, w: PLACE_W, h: Math.max(46, 70 * ws) },
    septStand: { x: westX + PLACE_W / 2 - 60, y: septBase + 8, w: 120, h: 64 },
    outsideBox: { x: eastX, y: placeBottom + 8, w: PLACE_W, h: 70 },
    // Where each is drawn.
    hollowmereBox: { x: westX, y: hollowY, w: PLACE_W, h: HOLLOW_H * ws },
    septBox: { x: westX, y: septY, w: PLACE_W, h: SEPT_H * ws },
    citadelBox: placeBox(eastX),
    wildsBox: { x: BAND, y: 12, w: W - 2 * BAND, h: WILDS_H - 24 },
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

/**
 * A Raven's disc (#182, owner's pick 2026-10-01: larger, on a disc ringed in
 * its session's colour, like every other unit): bigger than a Mason's, since
 * a bird on the wall is otherwise hard to see.
 */
export const RAVEN_R = 30;

/** Where on the wall Ravens wait: above the first Integrations room, else above the gate. */
export function perchX(L, rooms, perch) {
  const r = perch ? rooms.get(perch) : null;
  return r ? centre(L.cell(r.col, r.row)).x : L.gate.x;
}

/** The spots `n` units take at one place. `perch` is the room Ravens wait above (the map's), or null. */
function spots(L, rooms, place, n, perch) {
  const room = rooms.get(place);
  if (room) return slots(L.cell(room.col, room.row), n);
  if (place === 'perch') {
    const x = perchX(L, rooms, perch);
    return Array.from({ length: n }, (_, i) => ({ x: x + (i - (n - 1) / 2) * (RAVEN_R * 2 + 6), y: L.perchY }));
  }
  if (place === 'village') return slots(L.villageBox, n);
  if (place === 'wilds') return slots(L.wildsBox, n);
  if (place === 'outside') return slots(L.outsideBox, n);
  if (place === 'sept') return slots(L.septStand, n);
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
    if (!rooms.has(place) && !['perch', 'village', 'wilds', 'outside', 'sept', 'gate', 'beyond-gate'].includes(place)) place = 'gate';
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
 * shoot from the front, south of the fork's road; either way over the wall
 * nearer the targets (#172). A crane sits before the gate, south of the
 * fork's road and east of the road south, and lowers its stones onto the
 * centre of each room (#173). Front Raiders keep clear of both roads and of
 * the crane's place.
 */
const CRANE_DX = 130;
export function runSpot(L, rooms, u) {
  const targets = (u.targets || []).map((id) => rooms.get(id)).filter(Boolean);
  const cells = targets.map((r) => L.cell(r.col, r.row));
  const cx = cells.length ? cells.reduce((n, b) => n + b.x + b.w / 2, 0) / cells.length : L.gate.x;
  const frontY = L.H - 34;
  let at;
  let north = false;
  if (u.kind === 'crane') {
    at = { x: L.gate.x + CRANE_DX, y: frontY };
    // The cable meets each room at its centre (owner, 2026-10-01).
    return { at, north, hits: cells.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })) };
  } else {
    const meanRow = targets.length ? targets.reduce((n, r) => n + r.row, 0) / targets.length : 0;
    north = meanRow <= (L.rows - 1) / 2;
    if (north) at = { x: clamp(cx, BAND + 50, W - BAND - 50), y: WILDS_H - 24 };
    else {
      // Clear of the road south, where Scouts ride, and of the crane's place.
      let x = Math.abs(cx - L.gate.x) < 90 ? L.gate.x + (cx >= L.gate.x ? 90 : -90) : cx;
      const crane = L.gate.x + CRANE_DX;
      if (Math.abs(x - crane) < 90) x = x >= crane ? crane + 90 : L.gate.x - 90;
      at = { x: clamp(x, BAND + 30, W - BAND - 30), y: frontY };
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

/** Places outside the keep: a walk between two of them goes along the road, not through the keep. */
const beyondWall = (place) => place === 'gate' || place === 'beyond-gate' || place === 'village' || place === 'outside' || place === 'sept';
/** The places reached by the fork's road (#183, #186). */
const roadPlace = (place) => place === 'village' || place === 'outside' || place === 'sept';

/**
 * The way from the road in front of the gate to a place outside the keep, as
 * points: where its spur leaves the road, and up the spur to the row its
 * units stand in, so a walk keeps to the road and steps off only there.
 * Hollowmere's spur runs up the band's outer edge; the Sept's and the
 * Citadel's straight up from the road. The fork itself for the gate and the
 * road south.
 */
const standRow = (box) => box.y + box.h - 8 - DOT;
function roadLeg(L, place) {
  if (place === 'village') return [{ x: L.road.west, y: L.road.y }, { x: L.road.west, y: standRow(L.villageBox) }];
  if (place === 'outside') return [{ x: L.road.east, y: L.road.y }, { x: L.road.east, y: standRow(L.outsideBox) }];
  if (place === 'sept') return [{ x: L.road.sept, y: L.road.y }, { x: L.road.sept, y: standRow(L.septStand) }];
  return [{ x: L.gate.x, y: L.road.y }];
}

/** A place's door, and the corridor it opens onto (row, and x along it). Outside the keep, the gate. */
function door(L, rooms, place) {
  const room = rooms.get(place);
  if (room) {
    const b = L.cell(room.col, room.row);
    const x = b.x + b.w / 2;
    return { at: { x, y: b.y + b.h }, row: room.row, x };
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
  if (from.place === to.place) return dedupe([from.point, to.point]);
  // Outside the keep: down to the road, along it, and up the other's spur.
  if (beyondWall(from.place) && beyondWall(to.place)) {
    if (!roadPlace(from.place) && !roadPlace(to.place)) return dedupe([from.point, to.point]);
    return dedupe([from.point, ...roadLeg(L, from.place).reverse(), ...roadLeg(L, to.place), to.point]);
  }
  const a = door(L, rooms, from.place);
  const b = door(L, rooms, to.place);
  const ya = L.corridorY(a.row);
  const yb = L.corridorY(b.row);
  // From a place outside: down its spur, along the road to the fork, and in at the gate.
  const pts = roadPlace(from.place) ? [from.point, ...roadLeg(L, from.place).reverse(), ...roadLeg(L, 'gate'), a.at] : [from.point, a.at];
  pts.push({ x: a.x, y: ya });
  if (a.row !== b.row) {
    const g = nearestGap(L, a.x, b.x);
    pts.push({ x: g, y: ya }, { x: g, y: yb });
  }
  pts.push({ x: b.x, y: yb }, b.at);
  // To one: out of the gate to the fork, along the road, and up its spur.
  if (roadPlace(to.place)) pts.push(...roadLeg(L, 'gate'), ...roadLeg(L, to.place));
  pts.push(to.point);
  return dedupe(pts);
}

/**
 * How long a leg takes: `ms`, the queue's pace, except a leg to or from
 * Hollowmere or the Citadel, which takes its length at PLACE_PACE a second
 * when that is longer, up to PLACE_MAX_MS, sped up with the queue like the
 * rest (#183).
 */
function legMs(leg, from, ms, least = ms) {
  if (!roadPlace(leg.place) && !roadPlace(from)) return least;
  const byLength = (lengthOf(leg.pts) / PLACE_PACE) * 1000 * (ms / HOP_MS);
  return Math.max(least, Math.min(PLACE_MAX_MS, byLength));
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
 * per place, { place, from, pts, ms }, every leg the queue's pace (`ms`),
 * except one to or from Hollowmere or the Citadel, timed by its length.
 */
export function planWalk(L, rooms, from, places, final, ms = hopMs(places.length)) {
  const legs = [];
  let at = from;
  places.forEach((place, i) => {
    const to = { place, point: i === places.length - 1 ? final : waypoint(L, rooms, place) };
    const leg = { place, from: at.place, pts: route(L, rooms, at, to) };
    leg.ms = legMs(leg, at.place, ms);
    legs.push(leg);
    at = to;
  });
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
  // What is left of the leg it is on, at the new pace (by what is left of its length, on a road leg).
  const from = legs[at.index].from;
  const pts = dedupe([...at.rest.slice(0, -1), firstTo.point]);
  const first = { place: ahead[0], from, pts, ms: Math.max(1, legMs({ place: ahead[0], pts }, from, ms, ms * at.left)) };
  return [first, ...planWalk(L, rooms, firstTo, ahead.slice(1), final, ms)];
}

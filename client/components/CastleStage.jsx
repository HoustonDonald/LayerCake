import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BAND, DOT, FADE_MS, HOP_MS, SLIDE_MS, W, keyframes, lastTrailKey, layout, newPlaces, placeUnits, planWalk, positionAt, replan, totalMs, waypoint } from './castleMotion.js';

/**
 * The castle itself (#160): one SVG with a fixed viewBox width, so full screen
 * only scales it. The rooms are the project's own sections (#167), each at the
 * grid cell its map gives it (spec: "The map never moves"); an empty cell stays
 * empty ground. The floor is as big as the rooms placed on it.
 *
 * What a room shows comes from the server (state, cause, heat, scaffolding).
 * This file adds only presentation: the 3 s hold against flicker, the heat
 * decay between frames, and the units walking between the places the server
 * puts them (#161; the geometry and the walking rules are in castleMotion.js).
 */

/** Session colours: hues no room state uses (red, orange, amber, gold and blue are reserved). */
export const SESSION_COLOURS = ['#2ec4b6', '#9b7bf7', '#9ccc3c', '#e86fb2', '#4dd0e1', '#c3a6ff'];

/** A Knight's banner: a hue from its id, outside the bands the room states use. */
function knightColour(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bands = [
    [75, 175],
    [250, 330],
  ];
  const span = bands.reduce((n, [a, b]) => n + (b - a), 0);
  let pick = h % span;
  for (const [a, b] of bands) {
    if (pick < b - a) return `hsl(${a + pick}, 65%, 62%)`;
    pick -= b - a;
  }
  return 'hsl(120, 65%, 62%)';
}

const HOLD_MS = 3000;

/**
 * Anti-flicker (spec): a room holds what it shows for 3 s before changing,
 * except to Alarm, which shows at once. The shown state is worked out during
 * render from a ref, and the ref is updated in an effect (React may render
 * twice); one timer, set for the earliest pending release, re-renders when a
 * held change is due, so a change is never stuck behind a frame that never
 * comes. A new connection (`generation`) shows everything at once.
 */
function useHeldStates(rooms, generation) {
  const held = useRef(new Map());
  const [, tick] = useState(0);
  const now = Date.now();
  const shown = {};
  let nextRelease = Infinity;
  for (const [id, r] of Object.entries(rooms || {})) {
    const h = held.current.get(id);
    if (!h || h.generation !== generation || h.state === r.state || r.state === 'alarm' || now - h.since >= HOLD_MS) {
      shown[id] = r.state;
    } else {
      shown[id] = h.state;
      nextRelease = Math.min(nextRelease, h.since + HOLD_MS);
    }
  }
  useEffect(() => {
    const at = Date.now();
    for (const [id, state] of Object.entries(shown)) {
      const h = held.current.get(id);
      if (!h || h.state !== state || h.generation !== generation) held.current.set(id, { state, since: at, generation });
    }
    if (!Number.isFinite(nextRelease)) return undefined;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, nextRelease - Date.now()) + 30);
    return () => clearTimeout(timer);
  });
  return shown;
}

/** Heat now, from the value and time the server sent: it halves every half-life. */
function heatNow(heat, halfLife, now) {
  if (!heat || !heat.v) return 0;
  return heat.v * 0.5 ** Math.max(0, (now - heat.t) / halfLife);
}

/** The viewer's reduced-motion setting, followed live. */
function useReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!q) return undefined;
    const onChange = () => setReduce(q.matches);
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

/**
 * The Alarm's slow pulse and the Herald's ring, as a class toggled every
 * 1.2 s rather than a CSS animation. An SVG stroke animation is not
 * composited: a smooth one repainted the whole castle every frame, 16% of a
 * core for as long as an Alarm stood, and even a stepped one ticked every
 * frame (5.6%; ui-idle.mjs, headless Edge, 2026-09-29). A toggle is two
 * repaints a cycle. Off entirely with reduced motion.
 */
function usePulse(active, reduce) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active || reduce) {
      setOn(false);
      return undefined;
    }
    const timer = setInterval(() => setOn((v) => !v), 1200);
    return () => clearInterval(timer);
  }, [active, reduce]);
  return on;
}

/**
 * Re-renders every 10 s while anything is still cooling, and not at all once
 * all is cold (#165). Each render fades every warm room's glow over 1.5 s
 * (light never snaps, spec), and SVG is not composited, so what the cooling
 * costs is the share of time a fade runs. Every 2 s, that was about 75%: six
 * rooms cooling in Embers cost 0.64% of a core against 0.05% quiet. Every
 * 10 s, 0.16% and 0.19% in two runs. Stepping the glow as well measured 0.17%,
 * so it was left out (ui-cooling.mjs, headless Edge, 2026-09-30).
 */
const COOL_MS = 10_000;
function useCooling(rooms, halfLife) {
  const [, tick] = useState(0);
  const warm = Object.values(rooms || {}).some((r) => heatNow(r.heat, halfLife, Date.now()) > 0.05);
  useEffect(() => {
    if (!warm) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), COOL_MS);
    return () => clearInterval(timer);
  }, [warm]);
}

function unitColour(u, sessionIndex) {
  if (u.kind === 'knight') return knightColour(u.agentId);
  if (u.kind === 'herald') return '#f4f6fa';
  if (u.kind === 'raven') return '#8a93a3';
  return SESSION_COLOURS[sessionIndex % SESSION_COLOURS.length];
}

const LETTER = { mason: 'M', knight: 'K', wizard: 'W', raven: 'R', scout: 'S', herald: 'H' };

function Unit({ u, x, y, colour, kinds, riders = [], colourOf, onClick }) {
  const label = kinds?.find((k) => k.kind === u.kind)?.label || u.kind;
  const title = [label, u.agentType, u.label, u.resting ? 'resting' : null].filter(Boolean).join(' · ');
  return (
    <g className={`castle-unit unit-${u.kind}${u.resting ? ' resting' : ''}`} data-unit={x === undefined ? undefined : u.key} transform={x === undefined ? undefined : `translate(${x} ${y})`} onClick={onClick}>
      <title>{title}</title>
      {u.kind === 'herald' && <circle className="herald-ring" r={DOT + 6} />}
      <circle r={DOT} fill={colour} />
      <text className="unit-letter" dy="5">
        {LETTER[u.kind] || '?'}
      </text>
      {u.resting && (
        <text className="unit-rest" x={DOT - 2} y={-DOT + 2}>
          z
        </text>
      )}
      {/* A Wizard stands beside the unit that called it and goes where it goes. */}
      {riders.map((w, i) => (
        <g key={w.key} className="castle-rider" transform={`translate(${(i + 1) * (DOT * 2 + 4)} ${-(DOT + 6)})`}>
          <Unit u={w} colour={colourOf(w)} kinds={kinds} colourOf={colourOf} />
        </g>
      ))}
    </g>
  );
}

/** Room names are the project's own (#167), up to 40 characters: two lines at most, then an ellipsis. */
const NAME_CHAR_W = 10; // about 0.5 em at the name's 20 px (measured in the rendered castle)
const NAME_LINE = 22;
function wrapName(name, first, rest) {
  const fit = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`);
  if (name.length <= first) return [name];
  const words = name.split(' ');
  let line = '';
  while (words.length && (line ? `${line} ${words[0]}` : words[0]).length <= first) line = line ? `${line} ${words.shift()}` : words.shift();
  if (!line) return [fit(name, first)];
  return words.length ? [line, fit(words.join(' '), rest)] : [line];
}

const WALKERS = new Set(['mason', 'knight']);
/** Kinds that walk in and out; the rest (Herald, a Wizard on its own) appear and go. */
const COMERS = new Set(['mason', 'knight', 'raven', 'scout']);

/**
 * How to treat a frame. The first state of a connection is a picture, not a
 * story: every unit is placed where it stands and nothing walks, because a
 * walk nobody saw would be invented. Until that state arrives (the map comes
 * first, and the last connection's state is still on screen) nothing moves
 * either. A new map is a picture too: the server refolds every trail under the
 * new rooms, and nobody walked.
 */
function frameMode(f, generation, state) {
  if (f.generation === generation && !f.awaiting) return state && state.mapVersion !== f.mapVersion ? 'place' : 'move';
  return state && state !== f.state ? 'place' : 'hold';
}

const samePoint = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/**
 * The units, in one layer above the rooms, so a unit walking from room to room
 * is one element moving (#161). React puts each unit on its spot; the walk
 * there is a Web Animations API animation of its transform that ends on that
 * spot. Nothing runs between walks (no requestAnimationFrame loop), so an idle
 * castle costs nothing.
 *
 * After the first frame of a connection: a Mason or Knight walks the rooms of
 * its trail it has not walked yet, in order; one first seen walks in from the
 * gate to where it is (what it did before the castle saw it is not walked: a
 * resumed session's trail is yesterday's), and one that goes walks out through
 * it, kept on screen (a ghost) until it is out. A Raven flies from the Rookery to the wall above it and back; a
 * Scout walks out of the gate and back. With reduced motion nothing walks: a
 * unit that moves fades in at its new spot.
 */
function UnitLayer({ L, rooms, perch, units, generation, state, reduce, colourOf, kinds, onSelect }) {
  // key -> { key, unit, place, point, lastKey, legs, anim, fade, leaving, exit }
  const motion = useRef(new Map());
  const frame = useRef({ generation: null, state: undefined, awaiting: false, mapVersion: undefined });
  const layerRef = useRef(null);
  const [, rerender] = useState(0);

  const placed = placeUnits(L, rooms, units, perch);
  const mode = frameMode(frame.current, generation, state);
  const riders = new Map();
  for (const u of units) {
    if (u.kind !== 'wizard' || placed.has(u.key)) continue;
    if (!riders.has(u.caller)) riders.set(u.caller, []);
    riders.get(u.caller).push(u);
  }
  const shown = [];
  for (const u of units) {
    const p = placed.get(u.key);
    if (p) shown.push({ u, p });
  }
  if (mode === 'move') {
    // Gone from the frame, still walking out (a unit back in the frame is drawn as itself).
    for (const rec of motion.current.values()) {
      if (!placed.has(rec.key) && COMERS.has(rec.unit.kind)) shown.push({ u: rec.unit, p: rec, ghost: true });
    }
  }

  useEffect(
    () => () => {
      for (const rec of motion.current.values()) {
        rec.anim?.cancel();
        rec.fade?.cancel();
      }
    },
    []
  );

  useLayoutEffect(() => {
    const els = new Map();
    for (const el of layerRef.current?.children || []) if (el.dataset.unit) els.set(el.dataset.unit, el);
    const gateOpening = { x: L.gate.x, y: L.wallBottom };
    // Where a Raven flies up from, and back down to: the room it waits above, else the gate.
    const ravenHome = perch && rooms.has(perch) ? waypoint(L, rooms, perch) : gateOpening;

    const stop = (rec) => {
      rec.anim?.cancel();
      rec.fade?.cancel();
      rec.anim = rec.fade = rec.legs = null;
    };
    // A walk out holds its last step (fill) until the unit is removed: React
    // last drew it where it stood, and that is where it would show otherwise.
    const play = (rec, el, legs, fill = 'none') => {
      // A new walk replaces whatever the unit was doing, a held walk out
      // included: left attached, that would win again once this walk ends.
      for (const a of el.getAnimations()) if (a !== rec.fade) a.cancel();
      const anim = el.animate(keyframes(legs), { duration: totalMs(legs), easing: 'linear', fill });
      rec.anim = anim;
      rec.legs = legs;
      anim.onfinish = () => {
        if (rec.anim === anim) rec.anim = rec.legs = null;
      };
    };
    const fadeIn = (rec, el) => {
      rec.fade?.cancel();
      rec.fade = el.animate([{ opacity: 0, offset: 0 }], { duration: FADE_MS, easing: 'ease-out' });
    };
    const here = (rec) => (rec.anim && rec.legs ? positionAt(rec.legs, rec.anim.currentTime ?? 0)?.point : null) || rec.point;

    const m = frameMode(frame.current, generation, state);
    if (m !== 'move') {
      for (const rec of motion.current.values()) stop(rec);
      motion.current.clear();
      for (const u of units) {
        const p = placed.get(u.key);
        if (p) motion.current.set(u.key, { key: u.key, unit: u, place: p.place, point: p.point, lastKey: lastTrailKey(u.trail), legs: null, anim: null, fade: null, leaving: false });
      }
      frame.current = { generation, state, awaiting: m === 'hold', mapVersion: state?.mapVersion };
      return;
    }
    // A re-render for something else (a held room, cooling, a ghost gone): nothing new to walk.
    if (frame.current.state === state) return;
    frame.current.state = state;

    for (const u of units) {
      const p = placed.get(u.key);
      if (!p) continue;
      const el = els.get(u.key);
      let rec = motion.current.get(u.key);
      if (rec?.leaving) {
        // Back before it was out: it finishes the walk out it started, then
        // walks back in (a liveness flap within about a second).
        rec.leaving = false;
        rec.exit = null;
        rec.fade?.cancel();
        rec.fade = null;
      }
      if (!rec) {
        rec = { key: u.key, unit: u, place: p.place, point: p.point, lastKey: lastTrailKey(u.trail), legs: null, anim: null, fade: null, leaving: false };
        motion.current.set(u.key, rec);
        if (el && COMERS.has(u.kind)) {
          if (!reduce) {
            let legs;
            if (WALKERS.has(u.kind)) legs = planWalk(L, rooms, { place: 'gate', point: L.gate.outer }, [p.place], p.point);
            else if (u.kind === 'raven') legs = [{ place: p.place, pts: [ravenHome, p.point], ms: HOP_MS }];
            else legs = [{ place: p.place, pts: [gateOpening, p.point], ms: HOP_MS }];
            play(rec, el, legs);
          }
          fadeIn(rec, el);
        }
        continue;
      }
      rec.unit = u;
      const places = newPlaces(u.trail, rec.lastKey);
      rec.lastKey = lastTrailKey(u.trail) ?? rec.lastKey;
      if (places.length && places[places.length - 1] !== p.place) places.push(p.place);
      if (!places.length && p.place !== rec.place) places.push(p.place);
      if (!places.length && samePoint(p.point, rec.point)) continue;
      if (!el || reduce) {
        stop(rec);
        if (el && places.length) fadeIn(rec, el);
      } else {
        const legs =
          (rec.anim && rec.legs && replan(L, rooms, rec.legs, rec.anim.currentTime ?? 0, places, p.point)) ||
          (places.length ? planWalk(L, rooms, { place: rec.place, point: rec.point }, places, p.point) : [{ place: p.place, pts: [rec.point, p.point], ms: SLIDE_MS }]);
        play(rec, el, legs);
      }
      rec.place = p.place;
      rec.point = p.point;
    }

    for (const rec of [...motion.current.values()]) {
      if (placed.has(rec.key) || rec.leaving) continue;
      const el = els.get(rec.key);
      if (!el || !COMERS.has(rec.unit.kind)) {
        stop(rec);
        motion.current.delete(rec.key);
        continue;
      }
      rec.leaving = true;
      let legs = null;
      if (!reduce) {
        if (WALKERS.has(rec.unit.kind)) {
          // Out through the gate, after any room it was still walking to.
          legs = (rec.anim && rec.legs && replan(L, rooms, rec.legs, rec.anim.currentTime ?? 0, ['gate'], L.gate.outer)) || planWalk(L, rooms, { place: rec.place, point: rec.point }, ['gate'], L.gate.outer);
        } else {
          legs = [{ place: rec.place, pts: [here(rec), rec.unit.kind === 'raven' ? ravenHome : gateOpening], ms: HOP_MS }];
        }
        play(rec, el, legs, 'forwards');
        const end = legs[legs.length - 1];
        rec.point = end.pts[end.pts.length - 1];
        if (WALKERS.has(rec.unit.kind)) rec.place = 'gate';
      } else {
        rec.anim?.cancel();
        rec.anim = rec.legs = null;
      }
      // Gone at the end of the walk out: it fades over the last steps, then is removed.
      const ms = legs ? totalMs(legs) : FADE_MS;
      rec.fade?.cancel();
      const fade = el.animate([{ opacity: 0, offset: 1 }], { delay: Math.max(0, ms - FADE_MS), duration: Math.min(FADE_MS, ms), fill: 'forwards' });
      rec.fade = fade;
      const exit = {};
      rec.exit = exit;
      fade.onfinish = () => {
        if (rec.exit !== exit || !rec.leaving) return;
        // No cancel here: that would show it at its old spot until React
        // removes it; removing the element ends its animations.
        motion.current.delete(rec.key);
        rerender((n) => n + 1);
      };
    }
  });

  return (
    <g className="castle-units" ref={layerRef}>
      {shown.map(({ u, p, ghost }) => {
        const selectable = !ghost && (rooms.has(p.place) || p.place === 'wilds' || p.place === 'outside');
        return (
          <Unit
            key={u.key}
            u={u}
            x={p.point.x}
            y={p.point.y}
            colour={colourOf(u)}
            kinds={kinds}
            riders={ghost ? [] : riders.get(u.key)}
            colourOf={colourOf}
            onClick={selectable ? () => onSelect(p.place) : undefined}
          />
        );
      })}
    </g>
  );
}

export default function CastleStage({ map, state, generation, selected, onSelect }) {
  const L = layout(map?.floor);
  const halfLife = map?.windows?.heatHalfLifeMs || 45_000;
  const shown = useHeldStates(state?.rooms, generation);
  useCooling(state?.rooms, halfLife);
  const reduce = useReducedMotion();
  const pulse = usePulse(Object.values(shown).includes('alarm') || (state?.units || []).some((u) => u.kind === 'herald'), reduce);
  const now = Date.now();
  const byState = new Map((map?.states || []).map((s) => [s.state, s]));
  const sessionIndex = new Map((state?.sessions || []).map((s) => [s.sessionId, s.index]));
  const colourOf = (u) => unitColour(u, sessionIndex.get(u.sessionId) ?? 0);
  const rooms = new Map((map?.rooms || []).map((r) => [r.id, r]));
  const types = new Map((map?.types || []).map((t) => [t.type, t]));

  const select = (id) => onSelect(selected === id ? null : id);
  const keySelect = (id) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(id);
    }
  };

  const wallW = W - 2 * L.wallX;
  const wallH = L.wallBottom - L.wallY;
  const gateW = 96;
  const sideGate = 48;

  return (
    <svg className={`castle-svg${pulse ? ' pulse-on' : ''}`} viewBox={`0 0 ${W} ${L.H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="The castle: rooms by what Claude is doing in them">
      <defs>
        <pattern id="castle-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="12" className="hatch-line" />
        </pattern>
      </defs>

      {/* The Wilds and outside: bands beyond the wall, clickable for their lists. */}
      <g
        className={`castle-band${selected === 'wilds' ? ' selected' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`The Wilds: ${state?.wilds?.count ?? 0} files no room claims`}
        onClick={() => select('wilds')}
        onKeyDown={keySelect('wilds')}
      >
        <rect x={0} y={0} width={BAND - 26} height={L.H} className="band-fill" />
        <text className="band-label" transform={`translate(${(BAND - 26) / 2 + 5} ${L.H / 2}) rotate(-90)`}>
          The Wilds · {state?.wilds?.count ?? 0} unmapped
        </text>
      </g>
      <g
        className={`castle-band${selected === 'outside' ? ' selected' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`Outside the project: ${state?.outside?.count ?? 0} files`}
        onClick={() => select('outside')}
        onKeyDown={keySelect('outside')}
      >
        <rect x={W - BAND + 26} y={0} width={BAND - 26} height={L.H} className="band-fill" />
        <text className="band-label" transform={`translate(${W - (BAND - 26) / 2 + 5} ${L.H / 2}) rotate(90)`}>
          Outside the project · {state?.outside?.count ?? 0}
        </text>
      </g>

      <rect className="castle-wall" x={L.wallX} y={L.wallY} width={wallW} height={wallH} rx={10} />
      <rect className="castle-gate" x={L.gate.x - gateW / 2} y={L.wallBottom - 6} width={gateW} height={12} />
      {/* The small gates units take to the Wilds (west) and outside the project (east). */}
      <rect className="castle-gate" x={L.sideGates.wilds.x - 6} y={L.sideGates.wilds.y - sideGate / 2} width={12} height={sideGate} />
      <rect className="castle-gate" x={L.sideGates.outside.x - 6} y={L.sideGates.outside.y - sideGate / 2} width={12} height={sideGate} />
      <text className="gate-label" x={L.gate.x + gateW / 2 + 10} y={L.wallBottom + 20}>
        Gate
      </text>

      {(map?.rooms || []).map((room) => {
        const box = L.cell(room.col, room.row);
        const r = state?.rooms?.[room.id];
        const st = shown[room.id] || r?.state || 'dark';
        const def = byState.get(st);
        const type = types.get(room.type);
        const typeLabel = type?.label || room.type;
        const heat = heatNow(r?.heat, halfLife, now);
        const glow = Math.min(0.55, 1 - Math.exp(-heat / 4));
        const perLine = Math.floor((box.w - 28) / NAME_CHAR_W);
        const lines = wrapName(room.name, perLine, perLine);
        const stateY = box.y + 46 + NAME_LINE * (lines.length - 1) + 24;
        return (
          <g
            key={room.id}
            className={`castle-room st-${st}${selected === room.id ? ' selected' : ''}`}
            tabIndex={0}
            role="button"
            aria-label={`${room.name} (${typeLabel}): ${def?.label || st}${r?.scaffolding ? ', unproven changes' : ''}`}
            onClick={() => select(room.id)}
            onKeyDown={keySelect(room.id)}
          >
            <title>{`${room.name} (${typeLabel}: ${type?.job || room.type})\n${def?.label || st}: ${def?.rule || ''}`}</title>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-fill" />
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-heat" style={{ opacity: glow }} />
            {r?.scaffolding && <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-scaffold" />}
            {/* The type over the name, the whole width to itself: the project names the room, the type says what kind of part it is. */}
            <text className="room-type" x={box.x + 14} y={box.y + 22}>
              {typeLabel}
            </text>
            <text className="room-name" x={box.x + 14} y={box.y + 46}>
              {lines.map((line, i) => (
                <tspan key={i} x={box.x + 14} dy={i ? NAME_LINE : 0}>
                  {line}
                </tspan>
              ))}
            </text>
            <text className="room-state" x={box.x + 14} y={stateY}>
              {def?.glyph ? `${def.glyph} ` : ''}
              {def?.label || st}
            </text>
            {r?.scaffolding && (
              <text className="room-unproven" x={box.x + 14} y={stateY + 18}>
                unproven
              </text>
            )}
          </g>
        );
      })}

      <UnitLayer L={L} rooms={rooms} perch={map?.perch || null} units={state?.units || []} generation={generation} state={state} reduce={reduce} colourOf={colourOf} kinds={map?.units} onSelect={select} />
    </svg>
  );
}

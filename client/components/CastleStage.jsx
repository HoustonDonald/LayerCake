import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ArtDefs, Citadel, Figure, FigureIcon, Hollowmere, RoomLight, TypeIcon, WildsForest } from './castleArt.jsx';
import { describeUnit } from './castleDescribe.js';
import { HeraldPose, KNIGHT_WORK_BANNER, POSE_VERBS, RavenPose, ScoutPose, WizardPose, WorkerPose } from './castlePoses.jsx';
import { BAND, DOT, FADE_MS, FROST_H, HOP_MS, RUN_KINDS, SLIDE_MS, W, WILDS_H, keyframes, runSpot, lastTrailKey, layout, newPlaces, placeUnits, planWalk, positionAt, replan, totalMs, waypoint } from './castleMotion.js';

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
 * 1.2 s rather than a CSS animation; the Herald's bell swings side to side on
 * the same toggle (#163), not on the flip-book, because a Herald can stand
 * for hours while Claude waits for you. An SVG stroke animation is not
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
 * all is cold (#165). Each render sets every warm room's glow, and the step
 * snaps (#171, owner decision 2026-09-30): SVG is not composited, so a fade
 * per step repainted the castle at the display's rate for minutes after work.
 * With a 1.5 s fade per step, six rooms cooling cost 4.7% of a core, renderer
 * and GPU process (ui-cost.mjs, headful; #165's 0.16% to 0.19% counted the
 * main thread only, #169). Entering and leaving Embers still fades.
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

/**
 * One shared flip-book timer (#163's budget, #172): 8 frames a second, running
 * only while something subscribed is active. The Raiders' arrows, the crane's
 * stones and every unit's pose step on the same tick (React renders them in
 * one pass), so the castle repaints once a frame however much moves. SVG is
 * not composited, so each frame repaints the castle; a 6 fps flip-book
 * measured 3.7% to 5.9% of a core, flat in how much moves, against 28% to 38%
 * for smooth animation (#169). With nothing active no timer runs.
 */
const FLIP_MS = 125;
const flip = { frame: 0, timer: null, listeners: new Set() };
function onFlip(listener) {
  flip.listeners.add(listener);
  if (!flip.timer) {
    flip.timer = setInterval(() => {
      flip.frame += 1;
      for (const l of flip.listeners) l();
    }, FLIP_MS);
  }
  return () => {
    flip.listeners.delete(listener);
    if (!flip.listeners.size) {
      clearInterval(flip.timer);
      flip.timer = null;
    }
  };
}
const offFlip = () => () => {};
function useFlipbook(active) {
  return useSyncExternalStore(active ? onFlip : offFlip, () => (active ? flip.frame : 0));
}

/**
 * Re-renders once at `at` (ms since the epoch): when a pose that waited for its
 * unit's walk begins, and when one ends. The flip-book only steps frames; with
 * reduced motion it never runs, and this is what still ends the pose.
 */
function useWakeAt(at) {
  const [, wake] = useState(0);
  useEffect(() => {
    if (at === null || !Number.isFinite(at)) return undefined;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, at - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [at]);
}

/**
 * The verb a Mason or Knight acts out now (#163; owner decision 2026-10-01: at
 * least `min` ms, longer while the call runs). `pose` is UnitLayer's note of
 * the unit's latest call: its id, verb, and `from`, when the page saw it, or
 * when the unit's walk to it ends. Null while it walks there, and after.
 */
function poseVerb(pose, u, now, min) {
  if (!pose || !POSE_VERBS.has(pose.verb) || now < pose.from) return null;
  return poseRunning(pose, u) || now < pose.from + min ? pose.verb : null;
}
const poseRunning = (pose, u) => u.last?.id === pose.key && u.last.endAt === null;

/**
 * A unit (#162): its figure on a dark disc ringed in its colour, so a session
 * or a Knight's banner reads at a glance and the figure says what it is. A
 * Raven is a bird on the wall, with no disc (the disc stays, unseen, as its
 * hit area). The disc is the unit's first circle: the page checks find units
 * by it.
 *
 * Poses (#163): a Mason or Knight acts out its call (`pose`, `poseMin`); a
 * Raven or Scout is animated for as long as it is on screen, since it exists
 * only while its call runs; a Wizard sparkles while its caller works
 * (`sparkle`); the Herald swings its bell on the ring's pulse (`swing`).
 * Frames come from the shared flip-book; with reduced motion a pose holds its
 * first frame.
 */
function Unit({ u, x, y, colour, kinds, riders = [], colourOf, onClick, small = false, hover = true, pose = null, poseMin = 0, swing = 0, sparkle = false, reduce = false }) {
  const bird = u.kind === 'raven';
  const now = Date.now();
  const verb = poseVerb(pose, u, now, poseMin);
  const waiting = Boolean(pose && POSE_VERBS.has(pose.verb) && now < pose.from);
  useWakeAt(waiting ? pose.from : verb && !poseRunning(pose, u) ? pose.from + poseMin : null);
  const animated = verb !== null || bird || u.kind === 'scout' || (u.kind === 'wizard' && sparkle);
  const tick = useFlipbook(animated && !reduce);
  const frame = reduce ? 0 : tick;
  const size = bird ? 32 : small ? 18 : 24;
  let art = null;
  if (verb) art = <WorkerPose kind={u.kind} verb={verb} frame={frame} />;
  else if (bird) art = <RavenPose frame={frame} />;
  else if (u.kind === 'scout') art = <ScoutPose frame={frame} />;
  else if (u.kind === 'herald' && swing) art = <HeraldPose swing={swing} />;
  else if (u.kind === 'wizard' && sparkle) art = <WizardPose frame={frame} />;
  return (
    <g className={`castle-unit unit-${u.kind}${u.resting ? ' resting' : ''}`} data-unit={x === undefined ? undefined : u.key} data-hover={hover ? u.key : undefined} data-pose={verb || undefined} transform={x === undefined ? undefined : `translate(${x} ${y})`} onClick={onClick}>
      {u.kind === 'herald' && <circle className="herald-ring" r={DOT + 9} />}
      <circle className={`unit-disc${bird ? ' bare' : ''}`} r={small ? DOT - 3 : DOT + 2} style={bird ? undefined : { stroke: colour }} />
      <g className="unit-figure">{art ? <g transform={`translate(${-size / 2} ${-size / 2}) scale(${size / 24})`}>{art}</g> : <Figure kind={u.kind} size={size} />}</g>
      {u.kind === 'knight' && <path className="unit-banner" d={verb ? KNIGHT_WORK_BANNER : 'M5.6 -10.6 L16 -6.8 L5.6 -3 Z'} style={{ fill: colour }} />}
      {u.resting && (
        <text className="unit-rest" x={DOT} y={-DOT + 1}>
          z
        </text>
      )}
      {/* A Wizard stands beside the unit that called it and goes where it goes. */}
      {riders.map((w, i) => (
        <g key={w.key} className="castle-rider" transform={`translate(${(i + 1) * (DOT * 2 + 4)} ${-(DOT + 6)})`}>
          <Unit u={w} colour={colourOf(w)} kinds={kinds} colourOf={colourOf} small sparkle={verb !== null} reduce={reduce} />
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
 *
 * A Mason or Knight then acts out its latest call (#163) once it is there:
 * `poses` notes, per unit, the call it last saw and when its pose may start.
 * A call first seen in a running castle starts on arrival, after any walk; a
 * call already there when the castle opened (or reconnected) plays only if it
 * is still running, since a pose nobody saw start would be invented too.
 */
function UnitLayer({ L, rooms, perch, units, generation, state, reduce, colourOf, kinds, poseMin, swing, onSelect, onHover }) {
  // key -> { key, unit, place, point, lastKey, legs, anim, fade, leaving, exit }
  const motion = useRef(new Map());
  // key -> { key: the call's id, verb, from }
  const poses = useRef(new Map());
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
    // What is left of a unit's walk, in ms: its pose waits for it.
    const walkLeft = (rec) => (rec?.anim && rec.legs ? Math.max(0, totalMs(rec.legs) - (rec.anim.currentTime ?? 0)) : 0);
    // A unit's latest call, noted once per call; a re-render only when one is new.
    const notePoses = (placing) => {
      const now = Date.now();
      let changed = false;
      for (const u of units) {
        const id = u.last?.id ?? null;
        if ((poses.current.get(u.key)?.key ?? null) === id) continue;
        changed = true;
        if (id === null) poses.current.delete(u.key);
        else poses.current.set(u.key, { key: id, verb: u.last.verb || null, from: placing ? (u.last.endAt === null ? now : -Infinity) : now + walkLeft(motion.current.get(u.key)) });
      }
      const present = new Set(units.map((u) => u.key));
      for (const key of [...poses.current.keys()]) {
        if (!present.has(key)) {
          poses.current.delete(key);
          changed = true;
        }
      }
      // A layout effect's update renders again before paint; that render's effect returns early.
      if (changed) rerender((n) => n + 1);
    };

    const m = frameMode(frame.current, generation, state);
    if (m !== 'move') {
      for (const rec of motion.current.values()) stop(rec);
      motion.current.clear();
      for (const u of units) {
        const p = placed.get(u.key);
        if (p) motion.current.set(u.key, { key: u.key, unit: u, place: p.place, point: p.point, lastKey: lastTrailKey(u.trail), legs: null, anim: null, fade: null, leaving: false });
      }
      frame.current = { generation, state, awaiting: m === 'hold', mapVersion: state?.mapVersion };
      notePoses(true);
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

    notePoses(false);
  });

  return (
    <g className="castle-units" ref={layerRef} onMouseOver={(e) => onHover(hoverAt(e.target))} onMouseLeave={() => onHover(null)}>
      {shown.map(({ u, p, ghost }) => {
        const selectable = !ghost && (rooms.has(p.place) || p.place === 'village' || p.place === 'outside');
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
            hover={!ghost}
            pose={ghost ? null : poses.current.get(u.key) || null}
            poseMin={poseMin}
            swing={u.kind === 'herald' ? swing : 0}
            reduce={reduce}
          />
        );
      })}
    </g>
  );
}

/** Where along a volley's arc projectile `k` of `n` is at `frame`: one flight a second, spaced along it. */
function volleyPoint(from, to, frame, k, n) {
  const t = ((frame * FLIP_MS) / 1000 + k / n) % 1;
  const peak = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 70 };
  const at = (a, c, b) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
  const dx = 2 * (1 - t) * (peak.x - from.x) + 2 * t * (to.x - peak.x);
  const dy = 2 * (1 - t) * (peak.y - from.y) + 2 * t * (to.y - peak.y);
  return { x: at(from.x, peak.x, to.x), y: at(from.y, peak.y, to.y), deg: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** Where a crane's stone is at `frame`: along the cable to above the room, then lowered onto it; one trip every 2 s. */
function hoistPoint(tip, hit, frame, offset) {
  const t = ((frame * FLIP_MS) / 2000 + offset) % 1;
  const above = { x: hit.x, y: hit.y - 28 };
  if (t < 0.8) return { x: tip.x + ((above.x - tip.x) * t) / 0.8, y: tip.y + ((above.y - tip.y) * t) / 0.8 };
  return { x: above.x, y: above.y + ((hit.y - above.y) * (t - 0.8)) / 0.2 };
}

/**
 * The units a run brings, while it runs, aimed at the rooms it will judge:
 * Raiders for a test, loosing arrows over the wall (#172); a crane for a build,
 * hoisting stones along a cable onto those rooms (#173: a build builds, it does
 * not attack). They stand still (they are not walked), and their arrows and
 * stones are a flip-book on the one shared timer. With reduced motion they
 * hold still, mid-way.
 */
function RunLayer({ L, rooms, units, reduce, onHover }) {
  const list = units.filter((u) => RUN_KINDS.has(u.kind));
  const frame = useFlipbook(list.length > 0 && !reduce);
  if (!list.length) return null;
  const f = reduce ? 3 : frame;
  return (
    <g className="castle-runs" onMouseOver={(e) => onHover(hoverAt(e.target))} onMouseLeave={() => onHover(null)}>
      {list.map((u) => {
        const { at, hits } = runSpot(L, rooms, u);
        if (u.kind === 'raiders') {
          const arrows = hits.flatMap((hit, i) => [0, 1, 2].map((k) => ({ key: `${i}-${k}`, p: volleyPoint(at, hit, f, k + i * 0.37, 3) })));
          return (
            <g key={u.key} className="castle-raiders">
              {arrows.map(({ key, p }) => (
                <g key={key} className="volley-arrow" transform={`translate(${p.x} ${p.y}) rotate(${p.deg}) scale(1.6)`}>
                  <line x1={-10} y1={0} x2={7} y2={0} />
                  <path d="M8 0 l-5 -3 v6 Z" />
                </g>
              ))}
              {/* Like every unit: a figure on a dark disc, here ringed in ice. */}
              <g className="run-unit" data-hover={u.key} transform={`translate(${at.x} ${at.y})`}>
                {[-38, 0, 38].map((dx, i) => (
                  <g key={dx} className="raider-figure" transform={`translate(${dx} ${i === 1 ? -6 : 4})`}>
                    <circle className="unit-disc raider-disc" r={DOT + 2} />
                    <Figure kind="raiders" size={26} />
                  </g>
                ))}
              </g>
            </g>
          );
        }
        // The jib's tip, where the figure (42 across, drawn in a 24 box) hangs its stone.
        const tip = { x: at.x + 16, y: at.y - 16 };
        return (
          <g key={u.key} className="castle-crane">
            {hits.map((hit, i) => {
              const p = hoistPoint(tip, hit, f, i * 0.37);
              return (
                <g key={i}>
                  <path className="crane-cable" d={`M${tip.x} ${tip.y} L${hit.x} ${hit.y - 28}`} />
                  <line className="crane-rope" x1={p.x} y1={p.y - 12} x2={p.x} y2={p.y} />
                  <rect className="crane-stone" x={p.x - 8} y={p.y} width={16} height={13} rx={2} />
                </g>
              );
            })}
            {/* Like every unit: a figure on a dark disc, here ringed in wood. */}
            <g className="run-unit" data-hover={u.key} transform={`translate(${at.x} ${at.y})`}>
              <g className="crane-figure">
                <circle className="unit-disc crane-disc" r={DOT + 14} />
                <Figure kind="crane" size={42} />
              </g>
            </g>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Where the hover card goes for the unit under the pointer: beside the unit's
 * figure, inside the stage, flipped to its left near the right edge.
 */
function hoverAt(target) {
  const el = target?.closest?.('[data-hover]');
  const stage = el?.closest('.castle-stage');
  if (!el || !stage) return null;
  const r = el.querySelector('.unit-disc')?.getBoundingClientRect() || el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const right = r.right - s.left + 10;
  const flip = right + CARD_W > s.width - 8;
  return { key: el.dataset.hover, x: flip ? r.left - s.left - CARD_W - 10 : right, y: Math.max(8, Math.min(r.top - s.top - 12, s.height - 200)) };
}

const CARD_W = 300;

/** What the unit under the pointer stands for, and what it is working on (castleDescribe). */
function UnitCard({ card, state, map }) {
  const u = (state?.units || []).find((x) => x.key === card.key);
  if (!u) return null;
  const d = describeUnit(u, { state, map });
  return (
    <div className="castle-unit-card" role="tooltip" style={{ left: card.x, top: card.y, width: CARD_W }}>
      <div className="unit-card-head">
        <span className="legend-figure">
          <FigureIcon kind={u.kind} size={14} />
        </span>
        <strong>{d.title}</strong>
        {d.tags.map((t) => (
          <span key={t} className="unit-card-tag">
            {t}
          </span>
        ))}
      </div>
      <dl>
        {d.rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

export default function CastleStage({ map, state, generation, selected, onSelect }) {
  const [card, setCard] = useState(null);
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
    <>
    <svg className={`castle-svg${pulse ? ' pulse-on' : ''}`} viewBox={`0 0 ${W} ${L.H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="The castle: rooms by what Claude is doing in them">
      <ArtDefs />

      {/* The ground outside the wall, and the road south out of the gate. */}
      <rect className="castle-ground" x={0} y={L.wallBottom} width={W} height={L.H - L.wallBottom} />
      <path className="castle-road" d={`M${L.gate.x - 34} ${L.wallBottom} L${L.gate.x - 46} ${L.H} L${L.gate.x + 46} ${L.H} L${L.gate.x + 34} ${L.wallBottom} Z`} />

      {/* The Wilds (#172): the forest north of the Frostwall, where Raiders come from. */}
      <g className="castle-wilds" aria-label="The Wilds, beyond the Frostwall">
        <rect x={0} y={0} width={W} height={WILDS_H} className="wilds-fill" />
        <WildsForest width={W} height={WILDS_H} />
        <text className="band-label wilds-label" x={BAND - 40} y={24}>
          The Wilds
        </text>
      </g>

      {/* Hollowmere (#172): the village by the road, clickable for the files no room claims. */}
      <g
        className={`castle-band castle-village${selected === 'village' ? ' selected' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`Hollowmere: ${state?.village?.count ?? 0} files no room claims`}
        onClick={() => select('village')}
        onKeyDown={keySelect('village')}
      >
        <rect x={L.villageBox.x - 8} y={L.villageBox.y - 34} width={L.villageBox.w + 16} height={L.villageBox.h + 30} rx={10} className="band-fill" />
        <Hollowmere box={L.villageBox} lit={(state?.village?.count ?? 0) > 0} />
        <text className="band-label village-label" x={L.villageBox.x} y={L.villageBox.y - 14}>
          Hollowmere · {state?.village?.count ?? 0} unclaimed
        </text>
      </g>

      <g
        className={`castle-band${selected === 'outside' ? ' selected' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`The Citadel: ${state?.outside?.count ?? 0} files outside the project`}
        onClick={() => select('outside')}
        onKeyDown={keySelect('outside')}
      >
        <rect x={W - BAND + 26} y={WILDS_H + FROST_H} width={BAND - 26} height={L.H - WILDS_H - FROST_H} className="band-fill" />
        {/* Files outside the project (home, Claude's configuration, other projects) are the Citadel's. */}
        <Citadel cx={W - (BAND - 26) / 2} gateX={L.sideGates.outside.x} gy={L.sideGates.outside.y} lit={(state?.outside?.count ?? 0) > 0} />
        <text className="band-label" transform={`translate(${W - (BAND - 26) / 2 + 5} ${L.H / 2 + 80}) rotate(90)`}>
          The Citadel · {state?.outside?.count ?? 0}
        </text>
      </g>

      <rect className="castle-wall" x={L.wallX} y={L.wallY} width={wallW} height={wallH} rx={10} />
      {/* The Frostwall (#172): the keep's north wall, run the whole width, crenellated towards the Wilds. */}
      <g className="frostwall" aria-hidden="true">
        <rect className="frostwall-face" x={0} y={WILDS_H} width={W} height={FROST_H} />
        <rect className="frostwall-rime" x={0} y={WILDS_H} width={W} height={4} />
        {Array.from({ length: Math.floor(W / 28) + 1 }, (_, i) => (
          <rect key={i} className="frostwall-face" x={6 + i * 28} y={WILDS_H - 10} width={14} height={10} />
        ))}
        <text className="frostwall-label" x={W - 16} y={WILDS_H + FROST_H / 2 + 5}>
          The Frostwall
        </text>
      </g>
      <rect className="castle-gate" x={L.gate.x - gateW / 2} y={L.wallBottom - 6} width={gateW} height={12} />
      <path className="castle-gate-arch" d={`M${L.gate.x - gateW / 2} ${L.wallBottom - 6} V${L.wallBottom - 14} Q${L.gate.x} ${L.wallBottom - 38} ${L.gate.x + gateW / 2} ${L.wallBottom - 14} V${L.wallBottom - 6}`} />
      {/* The small gate units take to the Citadel (east). */}
      <rect className="castle-gate" x={L.sideGates.outside.x - 6} y={L.sideGates.outside.y - sideGate / 2} width={12} height={sideGate} />
      {/* The keep's name, on the road below its gate (#172): clear of the units waiting there and of Hollowmere either side. */}
      <text className="keep-name" x={L.gate.x} y={L.wallBottom + 74}>
        Duskhold
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
            {/* Floor, the type's icon, then the light over them; the edge last so light never dims it. */}
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-fill" />
            <TypeIcon type={room.type} x={box.x + box.w - 74} y={box.y + 78} size={56} className="room-icon" />
            {/* A cooling step snaps (#171); the group fades the heat in and out with Embers. */}
            <g className="room-heat-fade">
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-heat" style={{ opacity: glow }} />
            </g>
            <RoomLight id={room.id} box={box} state={st} scaffolding={Boolean(r?.scaffolding)} />
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-edge" />
            {/* The type over the name, the whole width to itself: the project names the room, the type says what kind of part it is. */}
            <TypeIcon type={room.type} x={box.x + 14} y={box.y + 11} size={13} className="room-type-icon" />
            <text className="room-type" x={box.x + 32} y={box.y + 22}>
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

      <RunLayer L={L} rooms={rooms} units={state?.units || []} reduce={reduce} onHover={setCard} />
      <UnitLayer L={L} rooms={rooms} perch={map?.perch || null} units={(state?.units || []).filter((u) => !RUN_KINDS.has(u.kind))} generation={generation} state={state} reduce={reduce} colourOf={colourOf} kinds={map?.units} poseMin={map?.windows?.poseMinMs ?? 0} swing={reduce ? 0 : pulse ? 1 : -1} onSelect={select} onHover={setCard} />
    </svg>
    {card && <UnitCard card={card} state={state} map={map} />}
    </>
  );
}

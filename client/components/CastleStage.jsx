import React, { useEffect, useRef, useState } from 'react';

/**
 * The castle itself (#160): one SVG with a fixed viewBox, so full screen only
 * scales it. Rooms keep the grid cell the server's floor plan gives them for
 * the life of the project (spec: "The map never moves"); a dropped room stays
 * as empty ground rather than letting its neighbours shift.
 *
 * What a room shows comes from the server (state, cause, heat, scaffolding).
 * This file adds only presentation: the 3 s hold against flicker, the heat
 * decay between frames, and where the dots stand.
 */

const W = 1000;
const BAND = 70; // the Wilds, all round the wall
const GAP = 24;
const ROOM_H = 190;
const DOT = 15;

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

/** Space below the wall: the gate, and beyond it where Scouts go. */
const BELOW = 120;
const WALL_INSET = 22;

function layout(floor) {
  const cols = floor?.cols || 3;
  const rows = floor?.rows || 4;
  const roomW = (W - 2 * BAND - (cols - 1) * GAP) / cols;
  const gridBottom = BAND + rows * ROOM_H + (rows - 1) * GAP;
  const wallBottom = gridBottom + WALL_INSET;
  const H = gridBottom + BELOW;
  const cell = (col, row) => ({ x: BAND + col * (roomW + GAP), y: BAND + row * (ROOM_H + GAP), w: roomW, h: ROOM_H });
  const gateCol = floor?.gate?.col ?? 1;
  const gateX = BAND + gateCol * (roomW + GAP) + roomW / 2;
  return { cols, rows, roomW, H, cell, wallBottom, gate: { x: gateX } };
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

/**
 * The Alarm's slow pulse and the Herald's ring, as a class toggled every
 * 1.2 s rather than a CSS animation. An SVG stroke animation is not
 * composited: a smooth one repainted the whole castle every frame, 16% of a
 * core for as long as an Alarm stood, and even a stepped one ticked every
 * frame (5.6%; ui-idle.mjs, headless Edge, 2026-09-29). A toggle is two
 * repaints a cycle. Off entirely with reduced motion.
 */
function usePulse(active) {
  const [on, setOn] = useState(false);
  const [reduce, setReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!q) return undefined;
    const onChange = () => setReduce(q.matches);
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, []);
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

/** Re-renders every 2 s while anything is still cooling, and not at all once all is cold. */
function useCooling(rooms, halfLife) {
  const [, tick] = useState(0);
  const warm = Object.values(rooms || {}).some((r) => heatNow(r.heat, halfLife, Date.now()) > 0.05);
  useEffect(() => {
    if (!warm) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, [warm]);
}

function slots(box, count, { row = 'bottom' } = {}) {
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

function unitColour(u, sessionIndex) {
  if (u.kind === 'knight') return knightColour(u.agentId);
  if (u.kind === 'herald') return '#f4f6fa';
  if (u.kind === 'raven') return '#8a93a3';
  return SESSION_COLOURS[sessionIndex % SESSION_COLOURS.length];
}

const LETTER = { mason: 'M', knight: 'K', wizard: 'W', raven: 'R', scout: 'S', herald: 'H' };

function Unit({ u, x, y, colour, kinds }) {
  const label = kinds?.find((k) => k.kind === u.kind)?.label || u.kind;
  const title = [label, u.agentType, u.label, u.resting ? 'resting' : null].filter(Boolean).join(' · ');
  return (
    <g className={`castle-unit unit-${u.kind}${u.resting ? ' resting' : ''}`} transform={`translate(${x} ${y})`}>
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
    </g>
  );
}

export default function CastleStage({ map, state, generation, selected, onSelect }) {
  const L = layout(map?.floor);
  const halfLife = map?.windows?.heatHalfLifeMs || 45_000;
  const shown = useHeldStates(state?.rooms, generation);
  useCooling(state?.rooms, halfLife);
  const pulse = usePulse(Object.values(shown).includes('alarm') || (state?.units || []).some((u) => u.kind === 'herald'));
  const now = Date.now();
  const byState = new Map((map?.states || []).map((s) => [s.state, s]));
  const sessionIndex = new Map((state?.sessions || []).map((s) => [s.sessionId, s.index]));
  const colourOf = (u) => unitColour(u, sessionIndex.get(u.sessionId) ?? 0);

  // Dots grouped by where they stand.
  const at = new Map();
  for (const u of state?.units || []) {
    const where = u.room || 'gate';
    if (!at.has(where)) at.set(where, []);
    at.get(where).push(u);
  }

  const select = (id) => onSelect(selected === id ? null : id);
  const keySelect = (id) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(id);
    }
  };

  const wallX = BAND - WALL_INSET;
  const wallY = BAND - WALL_INSET;
  const wallW = W - 2 * wallX;
  const wallH = L.wallBottom - wallY;
  const gateW = 96;

  const wildsBox = { x: 6, y: BAND, w: BAND - 30, h: L.H - 2 * BAND };
  const outsideBox = { x: W - BAND + 24, y: BAND, w: BAND - 30, h: L.H - 2 * BAND };
  // At the gate: just outside the wall's opening. Beyond it: further out, in the Wilds.
  const gateBox = { x: L.gate.x - 80, y: L.wallBottom + 4, w: 160, h: 40 };
  const beyondBox = { x: L.gate.x - 120, y: L.wallBottom + 50, w: 240, h: 40 };

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

      <rect className="castle-wall" x={wallX} y={wallY} width={wallW} height={wallH} rx={10} />
      <rect className="castle-gate" x={L.gate.x - gateW / 2} y={L.wallBottom - 6} width={gateW} height={12} />
      <text className="gate-label" x={L.gate.x + gateW / 2 + 10} y={L.wallBottom + 20}>
        Gate
      </text>

      {(map?.rooms || []).map((room) => {
        const box = L.cell(room.col, room.row);
        const r = state?.rooms?.[room.id];
        if (room.dropped) {
          const dots = at.get(room.id) || [];
          const pos = slots(box, dots.length);
          return (
            <g key={room.id} className="castle-room dropped">
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-fill" />
              <text className="room-name" x={box.x + 14} y={box.y + 30}>
                {room.name}
              </text>
              <text className="room-state" x={box.x + 14} y={box.y + 54}>
                not used here (castle.json)
              </text>
              {dots.map((u, i) => (
                <Unit key={u.key} u={u} x={pos[i].x} y={pos[i].y} colour={colourOf(u)} kinds={map?.units} />
              ))}
            </g>
          );
        }
        const st = shown[room.id] || r?.state || 'dark';
        const def = byState.get(st);
        const heat = heatNow(r?.heat, halfLife, now);
        const glow = Math.min(0.55, 1 - Math.exp(-heat / 4));
        const dots = at.get(room.id) || [];
        const pos = slots(box, dots.length);
        return (
          <g
            key={room.id}
            className={`castle-room st-${st}${selected === room.id ? ' selected' : ''}`}
            tabIndex={0}
            role="button"
            aria-label={`${room.name}: ${def?.label || st}${r?.scaffolding ? ', unproven changes' : ''}`}
            onClick={() => select(room.id)}
            onKeyDown={keySelect(room.id)}
          >
            <title>{`${room.name} (${room.job})\n${def?.label || st}: ${def?.rule || ''}`}</title>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-fill" />
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-heat" style={{ opacity: glow }} />
            {r?.scaffolding && <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} className="room-scaffold" />}
            <text className="room-name" x={box.x + 14} y={box.y + 30}>
              {room.name}
            </text>
            <text className="room-state" x={box.x + 14} y={box.y + 56}>
              {def?.glyph ? `${def.glyph} ` : ''}
              {def?.label || st}
            </text>
            {r?.scaffolding && (
              <text className="room-tag" x={box.x + box.w - 12} y={box.y + 24}>
                unproven
              </text>
            )}
            {dots.map((u, i) => (
              <Unit key={u.key} u={u} x={pos[i].x} y={pos[i].y} colour={colourOf(u)} kinds={map?.units} />
            ))}
          </g>
        );
      })}

      {/* Where units stand when they are not in a room. */}
      {[
        ['gate', gateBox, 'bottom'],
        ['beyond-gate', beyondBox, 'bottom'],
      ].map(([where, box, row]) => {
        const dots = at.get(where) || [];
        const pos = slots(box, dots.length, { row });
        return dots.map((u, i) => <Unit key={u.key} u={u} x={pos[i].x} y={pos[i].y} colour={colourOf(u)} kinds={map?.units} />);
      })}
      {[
        ['wilds', wildsBox],
        ['outside', outsideBox],
      ].map(([where, box]) =>
        (at.get(where) || []).map((u, i) => (
          <Unit key={u.key} u={u} x={box.x + box.w / 2 + 6} y={box.y + 40 + i * (DOT * 2 + 8)} colour={colourOf(u)} kinds={map?.units} />
        ))
      )}
    </svg>
  );
}

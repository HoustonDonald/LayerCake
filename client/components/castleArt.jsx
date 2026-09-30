import React from 'react';

/**
 * The Castle's drawing (#162; owner decision 2026-09-30: art direction A,
 * "Night keep"). Flat vector on the dark ground. A room is a stone floor
 * showing its function type's icon (#167: rooms are the project's own
 * sections, so no castle furniture); its state is a pool of coloured light
 * and a mark in its corner (the colours are in styles.css, by state class, so
 * a change fades); units are silhouettes on a dark disc ringed in their
 * session colour. Original art, drawn here; nothing is fetched. This file only
 * draws: every behaviour lives in CastleStage and castleMotion.
 *
 * Everything here is static. SVG is not composited, so a continuous animation
 * repaints the castle every frame (see usePulse in CastleStage).
 */

/** Unit figures, drawn in a 24 by 24 box and filled with currentColor. */
const FIGURES = {
  mason: (
    <>
      <circle cx="10" cy="5.5" r="3.2" />
      <path d="M5 22 L7 11.5 Q10 9.8 13 11.5 L15 22 Z" />
      <path d="M14.2 17.5 L18.6 8.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <rect x="15.4" y="4.2" width="6.6" height="3.4" rx="0.8" transform="rotate(25 18.7 5.9)" />
    </>
  ),
  knight: (
    <>
      <path d="M6.6 3.2 h6.8 v5.4 q0 2.4 -3.4 2.4 q-3.4 0 -3.4 -2.4 Z" />
      <path d="M4.8 22 L6.6 12 Q10 10.4 13.4 12 L15.2 22 Z" />
      <path d="M17.6 2 V22" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  wizard: (
    <>
      <path d="M12 0.8 L16.4 9 L7.6 9 Z" />
      <ellipse cx="12" cy="9.2" rx="6" ry="1.4" />
      <circle cx="12" cy="11.6" r="2.3" />
      <path d="M6.8 22.5 L9.4 13.2 L14.6 13.2 L17.2 22.5 Z" />
    </>
  ),
  raven: <path d="M2.4 14.2 C5.6 10.2 9.6 9.2 12.8 10 L17.4 6.8 L16.8 10 C19.6 11 21.6 12.6 21.8 13.8 C18.2 13.8 15.2 14.8 12.2 17 L10.4 21 L9.4 17.2 C6.4 16.4 4.4 15.4 2.4 14.2 Z" />,
  scout: <path d="M6.4 22 L7.6 14.6 C6.6 11.6 7.6 7.6 10.8 5.6 L11.8 2.2 L13.4 5.2 C16 6.2 18.2 9.2 18.8 12.4 L16.8 13.6 L15.2 11.4 C14.2 13.6 13.8 16.8 14.2 22 Z" />,
  herald: (
    <>
      <path d="M12 3.6 C8 3.6 6.8 7.6 6.8 12.6 L4.8 16.8 L19.2 16.8 L17.2 12.6 C17.2 7.6 16 3.6 12 3.6 Z" />
      <circle cx="12" cy="19.2" r="1.8" />
      <rect x="11" y="1.4" width="2" height="2.6" rx="1" />
    </>
  ),
};

/**
 * Room type icons (#167's ROOM_TYPES), line drawings in a 24 by 24 box,
 * stroked with currentColor. A type the page does not know draws nothing.
 */
const TYPE_ICONS = {
  api: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  routing: (
    <>
      <path d="M12 3v18" />
      <path d="M5 5.5h11l3 2.5-3 2.5H5z" />
      <path d="M19 12.5H8l-3 2.5 3 2.5h11z" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  storage: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </>
  ),
  ui: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <circle cx="9.5" cy="13.5" r="1.3" />
      <circle cx="14.5" cy="13.5" r="1.3" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.8" r="1.2" />
    </>
  ),
  auth: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <path d="M12 14.5v2.5" />
    </>
  ),
  services: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6.6" />
      <path d="M12 2.4v2.8M12 18.8v2.8M2.4 12h2.8M18.8 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M5.2 18.8l2-2M16.8 7.2l2-2" />
    </>
  ),
  core: (
    <>
      <path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  jobs: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  integrations: (
    <>
      <path d="M10 14a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7l-1.2 1.2" />
      <path d="M14 10a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7l1.2-1.2" />
    </>
  ),
  cli: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 10l3 2.5L7 15M12.5 15.5h4.5" />
    </>
  ),
  build: <path d="M20.5 7.5a4.5 4.5 0 0 1-6.1 4.2L6.6 19.5a1.9 1.9 0 0 1-2.7-2.7l7.8-7.8A4.5 4.5 0 0 1 16.5 3l-2.8 2.8 1 2.5 2.5 1z" />,
  config: (
    <>
      <path d="M6 4v16M12 4v16M18 4v16" />
      <circle cx="6" cy="9" r="2" className="icon-knob" />
      <circle cx="12" cy="15" r="2" className="icon-knob" />
      <circle cx="18" cy="7" r="2" className="icon-knob" />
    </>
  ),
  tests: (
    <>
      <path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  docs: (
    <>
      <path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z" />
      <path d="M12 6.5v13" />
    </>
  ),
  logs: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 11h7M9 14.5h7M9 18h5" />
    </>
  ),
};

/** A unit's figure as a standalone icon (the legend uses it). */
export function FigureIcon({ kind, size = 16 }) {
  return (
    <svg className={`figure-icon figure-${kind}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {FIGURES[kind] || null}
    </svg>
  );
}

/** Symbols, patterns and gradients the castle's SVG uses. */
export function ArtDefs() {
  return (
    <defs>
      {Object.entries(FIGURES).map(([kind, body]) => (
        <symbol key={kind} id={`figure-${kind}`} viewBox="0 0 24 24">
          {body}
        </symbol>
      ))}
      {Object.entries(TYPE_ICONS).map(([type, body]) => (
        <symbol key={type} id={`type-${type}`} viewBox="0 0 24 24" className="type-icon">
          {body}
        </symbol>
      ))}
      <pattern id="castle-floor" width="28" height="28" patternUnits="userSpaceOnUse">
        <rect width="28" height="28" className="floor-stone" />
        <path d="M0 0 H28 M0 0 V28" className="floor-joint" />
        <path d="M14 0 V14 M0 14 H28" className="floor-joint-fine" />
      </pattern>
      <pattern id="castle-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="12" className="hatch-line" />
      </pattern>
      {/* The Embers pool: its opacity follows heat (CastleStage). */}
      <radialGradient id="castle-heat" cx="50%" cy="62%" r="68%">
        <stop offset="0" className="heat-core" />
        <stop offset="1" className="heat-edge" />
      </radialGradient>
      {/* Moonlight on a Dark room, from the top. */}
      <linearGradient id="castle-moon" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" className="moon-core" />
        <stop offset="1" className="moon-edge" />
      </linearGradient>
    </defs>
  );
}

/** A figure centred on 0,0, `size` across. */
export function Figure({ kind, size = 24 }) {
  return <use href={`#figure-${kind}`} x={-size / 2} y={-size / 2} width={size} height={size} />;
}

/** A room type's icon with its top-left at x,y. */
export function TypeIcon({ type, x, y, size, className }) {
  if (!TYPE_ICONS[type]) return null;
  return <use href={`#type-${type}`} x={x} y={y} width={size} height={size} className={className} />;
}

function star(x, y, r) {
  const k = r * 0.3;
  return `M${x} ${y - r} L${x + k} ${y - k} L${x + r} ${y} L${x + k} ${y + k} L${x} ${y + r} L${x - k} ${y + k} L${x - r} ${y} L${x - k} ${y - k} Z`;
}

/**
 * A room's light: the pool (its colour from the room's state class), the
 * moonlight a Dark room gets, its scaffolding, and the mark in its top right
 * corner that each state leaves. `state` is the state the room shows (after
 * the 3 s hold).
 */
export function RoomLight({ id, box, state, scaffolding }) {
  const { x, y, w, h } = box;
  const cx = x + w - 24;
  const cy = y + 22;
  return (
    <g className="room-light" aria-hidden="true">
      <radialGradient id={`castle-glow-${id}`} cx="50%" cy="62%" r="68%">
        <stop offset="0" className="glow-core" />
        <stop offset="1" className="glow-edge" />
      </radialGradient>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={`url(#castle-glow-${id})`} className="room-glow" />
      <rect x={x} y={y} width={w} height={h} rx={6} className="room-moon" />
      {scaffolding && (
        <g className="room-scaffolding">
          <rect x={x} y={y} width={w} height={h} rx={6} className="room-scaffold" />
          {[x + 8, x + w - 14].map((px) => (
            <rect key={px} x={px} y={y + 4} width={6} height={h - 8} className="scaffold-pole" />
          ))}
          {/* Below the name, state and "unproven" lines; units stand over the lower plank. */}
          {[y + h * 0.58, y + h - 14].map((py) => (
            <rect key={py} x={x + 6} y={py} width={w - 12} height={4} className="scaffold-plank" />
          ))}
        </g>
      )}
      {state === 'construction' && (
        <g className="mark mark-sparks">
          <path d={star(cx, cy - 2, 5)} />
          <path d={star(cx + 8, cy + 6, 3.5)} />
          <path d={star(cx - 7, cy + 7, 3)} />
        </g>
      )}
      {state === 'survey' && (
        <g className="mark mark-lantern" transform={`translate(${cx} ${cy})`}>
          <circle r="14" className="lantern-halo" />
          <rect x="-5" y="-6" width="10" height="13" rx="2" className="lantern-glass" />
          <rect x="-6" y="-9" width="12" height="3" className="lantern-cap" />
        </g>
      )}
      {state === 'proven' && (
        <g className="mark mark-pennant">
          <path d={`M${cx - 6} ${y + 10} V${y + 52}`} className="pennant-pole" />
          <path d={`M${cx - 6} ${y + 12} L${cx + 16} ${y + 21} L${cx - 6} ${y + 30} Z`} className="pennant-flag" />
        </g>
      )}
      {state === 'alarm' && (
        <g className="mark mark-alarm" transform={`translate(${cx} ${cy})`}>
          <circle r="13" />
          <text y="5.5">!</text>
        </g>
      )}
      {state === 'embers' && (
        <g className="mark mark-coals">
          {[
            [-5, 2],
            [1, -1],
            [6, 3],
            [0, 5],
          ].map(([dx, dy]) => (
            <circle key={`${dx},${dy}`} cx={cx + dx} cy={cy + dy} r="2.4" />
          ))}
        </g>
      )}
      {state === 'dark' && <path className="mark mark-moon" d={`M${cx + 2} ${cy - 11} a11 11 0 1 0 9 17 a8.5 8.5 0 1 1 -9 -17 Z`} />}
    </g>
  );
}

/**
 * The Citadel (owner's idea, 2026-09-30): where files outside the project are
 * kept track of, such as the home folder, Claude's configuration and other
 * projects. A tower beyond the east wall, with lit windows, reached by a road
 * from the east gate at (gateX, gy); `cx` is the middle of its band.
 */
export function Citadel({ cx, gateX, gy, lit }) {
  const base = gy - 16;
  const top = base - 96;
  return (
    <g className={`citadel${lit ? ' lit' : ''}`} aria-hidden="true">
      <path className="citadel-road" d={`M${gateX} ${gy} H${cx} V${base}`} />
      <path className="citadel-spire" d={`M${cx - 15} ${top} L${cx} ${top - 30} L${cx + 15} ${top} Z`} />
      <rect className="citadel-tower" x={cx - 12} y={top} width={24} height={base - top} />
      {[-9, -1, 7].map((dx) => (
        <rect key={dx} className="citadel-tower" x={cx + dx - 3} y={top - 5} width={4} height={6} />
      ))}
      {[top + 18, top + 44].map((wy) => (
        <rect key={wy} className="citadel-window" x={cx - 3} y={wy} width={6} height={10} rx={3} />
      ))}
      <path className="citadel-door" d={`M${cx - 5} ${base} V${base - 10} A5 5 0 0 1 ${cx + 5} ${base - 10} V${base} Z`} />
    </g>
  );
}

/**
 * The Wilds (#172): the dark forest north of the Frostwall, snow on the tops,
 * where Raiders come out of when a test run starts.
 */
export function WildsForest({ width, height }) {
  const trees = [];
  for (let i = 0, x = 4; x < width - 24; i += 1, x += 31) {
    const h = 26 + (i % 3) * 9;
    const y = height - 6 - (i % 2) * 22;
    trees.push(
      <g key={i}>
        <path className="tree-crown" d={`M${x} ${y} L${x + h * 0.42} ${y - h} L${x + h * 0.84} ${y} Z`} />
        <path className="tree-snow" d={`M${x + h * 0.42} ${y - h} l${h * 0.13} ${h * 0.3} h-${h * 0.26} Z`} />
      </g>
    );
  }
  return (
    <g className="wilds-trees" aria-hidden="true">
      {trees}
    </g>
  );
}

/**
 * Hollowmere (#172): the village south of the gate, where files in the project
 * that no room claims are kept. Its windows light once a file lands there.
 */
export function Hollowmere({ box, lit }) {
  const n = Math.max(3, Math.min(6, Math.floor(box.w / 46)));
  const houses = [];
  for (let i = 0; i < n; i += 1) {
    const w = 30 + (i % 3) * 5;
    const x = box.x + 6 + (i * (box.w - 12 - w)) / Math.max(1, n - 1);
    const y = box.y + 20 + (i % 2) * 22;
    houses.push(
      <g key={i}>
        <path className="house-roof" d={`M${x - 3} ${y} L${x + w / 2} ${y - w * 0.45} L${x + w + 3} ${y} Z`} />
        <rect className="house-wall" x={x} y={y} width={w} height={w * 0.66} />
        <rect className="house-window" x={x + w * 0.37} y={y + w * 0.2} width={w * 0.26} height={w * 0.22} />
      </g>
    );
  }
  return (
    <g className={`hollowmere${lit ? ' lit' : ''}`} aria-hidden="true">
      {houses}
    </g>
  );
}

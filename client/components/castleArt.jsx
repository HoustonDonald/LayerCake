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
  // #163: a compaction is a hooded Scribe writing at a lectern.
  scribe: (
    <>
      <path d="M10 1.8 C6.6 1.8 5.6 5 5.8 8.2 L7.2 11 Q10 9.8 12.8 11 L14.2 8.2 C14.4 5 13.4 1.8 10 1.8 Z" />
      <ellipse cx="10.6" cy="6.6" rx="2" ry="2.4" fill="#0f1319" />
      <path d="M4.6 22 L7 11 Q10 9.6 13 11 L15.4 22 Z" />
      <path d="M18.6 13.8 V22 M16.2 22 H21" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M14.2 14.8 L22.6 12.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M14.6 13.9 L22 11.8 L21.6 10.4 L14.2 12.5 Z" />
      <path d="M12.4 12.6 L14 9.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M15.4 12.9 L13.4 7.1" stroke="currentColor" strokeWidth="0.7" />
    </>
  ),
  // #172: a raider, hooded, a bow drawn; three make a band.
  raiders: (
    <>
      <path d="M6.6 22 L8.2 11.8 Q10.8 9.8 13.4 11.8 L15 22 Z" />
      <path d="M8.2 11 Q10.8 1.8 13.4 11 Z" />
      <path d="M16.6 3.6 Q22.2 12 16.6 20.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16.6 3.6 V20.4" stroke="currentColor" strokeWidth="0.7" />
    </>
  ),
  // #173: a build is a treadwheel crane, a stone hanging from its jib.
  crane: (
    <>
      <path d="M3 21.2 H20.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="7.6" cy="15.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 15.6 H12.2 M7.6 11 V20.2" stroke="currentColor" strokeWidth="1" />
      <path d="M12.6 21.2 L14.6 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M10.8 9.4 L21.4 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M21.4 3 V10.4" stroke="currentColor" strokeWidth="0.9" />
      <rect x="19.6" y="10.4" width="3.6" height="3.1" rx="0.4" />
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
      {/* A torch's light on the wall and its pool on the ground (#163). */}
      <radialGradient id="castle-torch-glow">
        <stop offset="0" className="torch-glow-core" />
        <stop offset="0.45" className="torch-glow-mid" />
        <stop offset="1" className="torch-glow-edge" />
      </radialGradient>
      <radialGradient id="castle-torch-pool">
        <stop offset="0" className="torch-pool-core" />
        <stop offset="1" className="torch-glow-edge" />
      </radialGradient>
      {/* The Citadel's beacon (#183). */}
      <radialGradient id="castle-beacon-glow">
        <stop offset="0" className="torch-glow-core" />
        <stop offset="1" className="torch-glow-edge" />
      </radialGradient>
      {/* Light through the open gate, from the road up. */}
      <linearGradient id="castle-gate-light" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" className="gate-light-low" />
        <stop offset="1" className="gate-light-high" />
      </linearGradient>
    </defs>
  );
}

/** A flame's four shapes, [sway, height], for the flicker (#163). */
const FLAMES = [
  [0, 10],
  [0.9, 11.2],
  [-0.7, 9.4],
  [0.4, 10.6],
];

/**
 * A torch on the front wall (#163, owner's picks 2026-10-02: torches along
 * the front wall, flickering while Claude works). Its bracket stands on the
 * wall at x,y. Lit: a flame in one of four shapes (`frame`, from the shared
 * flip-book), its light on the wall and a pool on the ground. Out: a dark head.
 */
export function Torch({ x, y, lit, frame = 0 }) {
  const top = y - 4;
  const [dx, h] = FLAMES[frame & 3];
  const r = (v) => Math.round(v * 100) / 100;
  return (
    <g className={`castle-torch${lit ? ' lit' : ''}`}>
      {lit && <circle className="torch-glow" cx={x} cy={y - 8} r="34" />}
      {lit && <ellipse className="torch-glow torch-pool" cx={x} cy={y + 20} rx="34" ry="10" />}
      <path className="torch-bracket" d={`M${x} ${y + 5} V${y - 1}`} />
      <path className="torch-cup" d={`M${x - 3.4} ${top} L${x + 3.4} ${top} L${x + 1.9} ${y} L${x - 1.9} ${y} Z`} />
      {lit ? (
        <>
          <path className="torch-flame" d={`M${x - 3} ${top} Q${x - 3.6} ${r(top - h * 0.55)} ${r(x + dx)} ${r(top - h)} Q${x + 3.6} ${r(top - h * 0.55)} ${x + 3} ${top} Z`} />
          <path className="torch-core" d={`M${x - 1.5} ${top} Q${x - 1.8} ${r(top - h * 0.4)} ${r(x + dx * 0.6)} ${r(top - h * 0.68)} Q${x + 1.8} ${r(top - h * 0.4)} ${x + 1.5} ${top} Z`} />
        </>
      ) : (
        <ellipse className="torch-out" cx={x} cy={top - 0.2} rx="2.8" ry="1" />
      )}
    </g>
  );
}

/**
 * The gate (#163, owner's pick 2026-10-02: a portcullis): the passage under
 * the arch, lit from the road while `lit`, an iron grille `raised` 0 (down)
 * to 1 (up, its spikes hanging under the arch), the sill and the arch. The
 * gate's centre is at x on the wall's outer edge y; the arch is the one the
 * castle has always drawn.
 */
export function Gatehouse({ x, y, raised, lit }) {
  const half = 48;
  const arch = `M${x - half} ${y + 6} V${y - 14} Q${x} ${y - 38} ${x + half} ${y - 14} V${y + 6} Z`;
  const bars = [];
  for (let i = 0; i < 8; i += 1) {
    const bx = x - 42 + i * 12;
    bars.push(<path key={`b${i}`} className="portcullis-bar" d={`M${bx} ${y - 36} V${y + 2}`} />);
    bars.push(<path key={`s${i}`} className="portcullis-spike" d={`M${bx - 2.2} ${y + 2} L${bx} ${y + 6.5} L${bx + 2.2} ${y + 2} Z`} />);
  }
  return (
    <g className="castle-gatehouse" data-raised={Math.round(raised * 100) / 100}>
      <defs>
        <clipPath id="castle-gate-clip">
          <path d={arch} />
        </clipPath>
      </defs>
      <path className="gate-passage" d={arch} />
      {lit && <path className="gate-light" d={arch} style={{ opacity: raised }} />}
      <g clipPath="url(#castle-gate-clip)">
        <g transform={`translate(0 ${Math.round(-24 * raised * 100) / 100})`}>
          {bars}
          <path className="portcullis-rail" d={`M${x - half} ${y - 22} H${x + half} M${x - half} ${y - 9} H${x + half}`} />
        </g>
      </g>
      <rect className="castle-gate-sill" x={x - half} y={y - 6} width={half * 2} height={12} />
      <path className="castle-gate-arch" d={`M${x - half} ${y - 6} V${y - 14} Q${x} ${y - 38} ${x + half} ${y - 14} V${y - 6}`} />
    </g>
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
 * Hollowmere, the Sept and the Citadel are drawn in boxes 198 wide (#183,
 * #186, owner's picks 2026-10-02 from style boards): Hollowmere 230 tall, the
 * Sept 350, the Citadel 520. Each is fitted to the box the layout gives,
 * standing on its bottom edge: a floor too short for the full height gets a
 * smaller drawing, never a cut one.
 */
const PLACE_W = 198;
const PLACE_H = 520;
const HOLLOW_H = 230;
const SEPT_H = 350;
function placeFit(box, h = PLACE_H) {
  const s = Math.min(box.w / PLACE_W, box.h / h);
  return `translate(${n(box.x + (box.w - PLACE_W * s) / 2)} ${n(box.y + box.h - h * s)}) scale(${n(s)})`;
}
/** Where a height in a drawing `h` tall lands in the castle, for a label over it. */
export function placeY(box, y, h = PLACE_H) {
  const s = Math.min(box.w / PLACE_W, box.h / h);
  return n(box.y + box.h - h * s + y * s);
}
/** Hollowmere's drawing height, and the ridge of its highest roof in it (house 0's, 4.2). */
export const HOLLOWMERE_H = HOLLOW_H;
export const HOLLOWMERE_TOP = 4;
export const SEPT_DRAWING_H = SEPT_H;
const n = (v) => Math.round(v * 100) / 100;

/** How many windows a file count lights (#183, owner's pick: a window per file, up to the windows drawn). */
const lights = (count) => Math.max(0, Number(count) || 0);

/**
 * The Citadel (owner's idea, 2026-09-30): where files outside the project are
 * kept track of, such as the home folder, Claude's configuration and other
 * projects. A beacon tower on a rock east of the keep (#183): its fire is lit
 * once any such file has been touched, and one of its six windows for each
 * file. Drawn still, like everything here.
 */
export function Citadel({ box, count }) {
  const lit = lights(count);
  const cx = 99;
  const base = 510;
  const tw = 68;
  const th = 330;
  const top = base - 70 - th;
  return (
    <g className={`citadel${lit ? ' lit' : ''}`} transform={placeFit(box)} aria-hidden="true">
      {lit > 0 && <circle className="beacon-glow" cx={cx} cy={top - 52} r="70" />}
      <path className="citadel-rock" d={`M${cx - 83} ${base} L${cx - 59} ${base - 50} L${cx - 24} ${base - 76} L${cx + 32} ${base - 70} L${cx + 65} ${base - 44} L${cx + 83} ${base} Z`} />
      <path className="citadel-tower" d={`M${cx - tw / 2} ${base - 64} L${n(cx - tw * 0.4)} ${top} L${n(cx + tw * 0.4)} ${top} L${cx + tw / 2} ${base - 64} Z`} />
      <rect className="citadel-crown" x={n(cx - tw * 0.55)} y={top - 16} width={n(tw * 1.1)} height="16" />
      {[0, 1, 2, 3].map((k) => (
        <rect key={k} className="citadel-crown" x={n(cx - tw * 0.55 + k * tw * 0.31)} y={top - 28} width={n(tw * 0.17)} height="13" />
      ))}
      <path className="citadel-brazier" d={`M${cx - 20} ${top - 30} L${cx + 20} ${top - 30} L${cx + 12} ${top - 18} L${cx - 12} ${top - 18} Z`} />
      {lit > 0 && (
        <>
          <path className="beacon-flame" d={`M${cx - 17} ${top - 30} Q${cx - 20} ${top - 62} ${cx + 2} ${top - 92} Q${cx + 22} ${top - 60} ${cx + 17} ${top - 30} Z`} />
          <path className="beacon-core" d={`M${cx - 8} ${top - 30} Q${cx - 9} ${top - 50} ${cx + 2} ${top - 70} Q${cx + 10} ${top - 50} ${cx + 8} ${top - 30} Z`} />
        </>
      )}
      {[0, 1, 2, 3, 4, 5].map((k) => (
        <rect key={k} className={`citadel-window${k < lit ? ' on' : ''}`} x={cx - 5} y={n(top + 34 + (k * (th - 80)) / 6)} width="10" height="28" rx="5" />
      ))}
      <path className="citadel-door" d={`M${cx - 12} ${base - 64} V${base - 86} A12 12 0 0 1 ${cx + 12} ${base - 86} V${base - 64} Z`} />
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
 * Hollowmere (#172): the village where files in the project that no room
 * claims are kept. Eight houses round a mere with a jetty, west of the keep
 * (#183): one window lights for each file that has landed there.
 */
export function Hollowmere({ box, count }) {
  const lit = lights(count);
  const cx = 99;
  const cy = 115;
  const rx = 60;
  const ry = 43;
  const w = 44;
  const houses = [];
  for (let k = 0; k < 8; k += 1) {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / 8 + 0.2;
    const x = n(Math.max(4, Math.min(PLACE_W - w - 4, cx + Math.cos(a) * (rx + w * 0.9) - w / 2)));
    const y = n(Math.max(24, cy + Math.sin(a) * (ry + w * 0.95) - w * 0.33));
    houses.push(
      <g key={k}>
        <path className="house-roof" d={`M${n(x - 4)} ${y} L${n(x + w / 2)} ${n(y - w * 0.45)} L${n(x + w + 4)} ${y} Z`} />
        <rect className="house-wall" x={x} y={y} width={w} height={n(w * 0.66)} />
        <rect className={`house-window${k < lit ? ' on' : ''}`} x={n(x + w * 0.37)} y={n(y + w * 0.2)} width={n(w * 0.26)} height={n(w * 0.22)} />
      </g>
    );
  }
  return (
    <g className={`hollowmere${lit ? ' lit' : ''}`} transform={placeFit(box, HOLLOW_H)} aria-hidden="true">
      <ellipse className="mere-water" cx={cx} cy={cy} rx={rx} ry={ry} />
      <path className="mere-glint" d={`M${cx - 30} ${n(cy - ry * 0.2)} h24 M${cx + 3} ${n(cy + ry * 0.25)} h21`} />
      <rect className="mere-jetty" x={n(cx + rx * 0.55)} y={cy - 6} width={n(rx * 0.55)} height="12" />
      {houses}
    </g>
  );
}

/** Where the Sept's seven windows sit: [x, side?] (the side faces' two each, the front's three). */
const SEPT_WINDOWS = [
  [-78, true],
  [-66, true],
  [-42, false],
  [-9, false],
  [24, false],
  [58, true],
  [70, true],
];

/**
 * The Sept (#186, owner's picks 2026-10-02 from a style board): a hall of
 * seven faces under a low dome, a bell tower rising from its middle, west of
 * the keep below Hollowmere, where git and GitHub work is done. `git` is the
 * frame's state for it: with a repository, its branch on a banner over the
 * door (or the short commit when HEAD is detached) and one of its seven
 * windows lit for each commit not yet on the branch's remote (one when that
 * cannot be told); with none, or one that cannot be read, it stands unlit.
 * Its Alarm is a red glow and a mark. The bell swings while `ringing`
 * (a push running), on the shared flip-book's `frame`.
 */
export function Sept({ box, git, ringing = false, frame = 0 }) {
  const cx = 99;
  const base = 344;
  const repo = Boolean(git?.repo);
  const ahead = repo ? (typeof git.ahead === 'number' ? git.ahead : 1) : 0;
  const label = repo ? git.branch || (git.detached ? `@${git.detached}` : null) : null;
  const alarm = Boolean(git?.alarm);
  const swing = ringing ? [-16, 0, 16, 0][frame & 3] : 0;
  const bw = label ? Math.max(54, label.length * 8 + 20) : 0;
  return (
    <g className={`sept${repo ? '' : ' unlit'}${alarm ? ' alarm' : ''}`} transform={placeFit(box, SEPT_H)} aria-hidden="true">
      {alarm && <ellipse className="sept-alarm-glow" cx={cx} cy={base - 120} rx="122" ry="150" />}
      <path className="sept-side" d={`M${cx - 90} ${base} V${base - 112} L${cx - 54} ${base - 124} V${base} Z`} />
      <path className="sept-side" d={`M${cx + 90} ${base} V${base - 112} L${cx + 54} ${base - 124} V${base} Z`} />
      <rect className="sept-face" x={cx - 54} y={base - 124} width="108" height="124" />
      <path className="sept-roof" d={`M${cx - 96} ${base - 112} Q${cx} ${base - 214} ${cx + 96} ${base - 112} L${cx + 54} ${base - 124} L${cx - 54} ${base - 124} Z`} />
      <rect className="sept-tower" x={cx - 17} y={base - 296} width="34" height="120" />
      <path className="sept-belfry" d={`M${cx - 12} ${base - 236} V${base - 262} A12 12 0 0 1 ${cx + 12} ${base - 262} V${base - 236} Z`} />
      <g transform={`rotate(${swing} ${cx} ${base - 262})`}>
        <path className="sept-bell" d={`M${cx - 10} ${base - 244} C${cx - 10} ${base - 258} ${cx - 7} ${base - 264} ${cx} ${base - 264} C${cx + 7} ${base - 264} ${cx + 10} ${base - 258} ${cx + 10} ${base - 244} L${cx + 13} ${base - 240} L${cx - 13} ${base - 240} Z`} />
        <circle className="sept-bell" cx={cx} cy={base - 237} r="3" />
      </g>
      <path className="sept-spire" d={`M${cx - 22} ${base - 296} L${cx} ${base - 336} L${cx + 22} ${base - 296} Z`} />
      {SEPT_WINDOWS.map(([dx, side], k) => {
        const w = side ? 9 : 18;
        const h = side ? 46 : 60;
        const y = base - (side ? 92 : 104);
        const x = cx + dx;
        return <path key={k} className={`sept-window${k < ahead ? ' on' : ''}`} d={`M${x} ${y + h} V${y + w / 2} A${w / 2} ${w / 2} 0 0 1 ${x + w} ${y + w / 2} V${y + h} Z`} />;
      })}
      <path className="sept-door" d={`M${cx - 15} ${base} V${base - 26} A15 15 0 0 1 ${cx + 15} ${base - 26} V${base} Z`} />
      {label && (
        <g className="sept-banner">
          <path d={`M${n(cx - bw / 2)} ${base - 166} H${n(cx + bw / 2)} V${base - 144} L${cx} ${base - 136} L${n(cx - bw / 2)} ${base - 144} Z`} />
          <text x={cx} y={base - 150}>
            {label}
          </text>
        </g>
      )}
      {alarm && (
        <g className="sept-alarm-mark">
          <circle cx={PLACE_W - 22} cy={30} r="15" />
          <text x={PLACE_W - 22} y={36}>
            !
          </text>
        </g>
      )}
    </g>
  );
}

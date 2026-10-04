import React from 'react';

/**
 * The verb poses (#163; owner's picks 2026-10-01 from a style board: the whole
 * figure acts, with the room's light in the act). Each pose is a short cycle of
 * frames drawn in the figures' 24 by 24 box (castleArt.jsx) and stepped by the
 * one shared 8 fps timer in CastleStage: a Mason or Knight hammers on a stone
 * for an edit, lays a stone for a write, reads a scroll, swings a lantern to
 * search and turns a crank for a shell command. A Raven beats its wings, a
 * Scout trots, a Wizard sparkles, and the Herald swings its bell. Colours are
 * classes in styles.css. This file only draws; when a pose plays is decided
 * in CastleStage.
 */

const rad = (d) => (d * Math.PI) / 180;
const n = (v) => Math.round(v * 100) / 100;

/**
 * Verbs a Mason or Knight acts out. A call a helper carries (subagent, skill,
 * MCP, web) has none: the helper is at work. At the Sept (#186) a commit and a
 * push have their own; a git read reads, and the rest turn the crank.
 */
export const POSE_VERBS = new Set(['edit', 'create', 'read', 'search', 'shell', 'commit', 'push']);

const KNIGHT_HELM = 'M6.6 3.2 h6.8 v5.4 q0 2.4 -3.4 2.4 q-3.4 0 -3.4 -2.4 Z';

const Arm = ({ d, x, y }) => <path className="pose-line" strokeWidth="2.2" d={`M12.2 ${n(12.8 + d)} L${n(x)} ${n(y)}`} />;

function Hammer({ x, y, ang }) {
  const ux = Math.cos(rad(ang));
  const uy = Math.sin(rad(ang));
  return (
    <>
      <path className="pose-line" strokeWidth="1.9" d={`M${n(x - ux)} ${n(y - uy)} L${n(x + 6.2 * ux)} ${n(y + 6.2 * uy)}`} />
      <rect x="-3.3" y="-1.7" width="6.6" height="3.4" rx="0.8" transform={`translate(${n(x + 7.6 * ux)} ${n(y + 7.6 * uy)}) rotate(${ang + 90})`} />
    </>
  );
}

function Sparks({ x, y, off, len }) {
  return [-160, -122, -78, -34].map((a) => {
    const ux = Math.cos(rad(a));
    const uy = Math.sin(rad(a));
    return <path key={a} className="pose-spark" d={`M${n(x + off * ux)} ${n(y + off * uy)} l${n(len * ux)} ${n(len * uy)}`} />;
  });
}

function Stone({ x, y }) {
  return (
    <>
      <rect className="pose-stone" x={x} y={y} width="5.2" height="3.8" rx="0.5" />
      <path className="pose-stone-line" d={`M${n(x + 1.1)} ${n(y + 1.5)} h2.4`} />
    </>
  );
}

/** A point fixed to the ground, in the frame of a figure leaning `lean` degrees about its feet. */
function unlean(x, y, lean) {
  const a = rad(-lean);
  const dx = x - 10;
  const dy = y - 22;
  return [10 + dx * Math.cos(a) - dy * Math.sin(a), 22 + dx * Math.sin(a) + dy * Math.cos(a)];
}

/**
 * Each verb: `n` frames, and frame `k` as { lean (degrees, about the feet), d
 * (a crouch), hx / hd (the head turned / bowed), held (leans with the body),
 * ground (stays put), back and front (light behind and over the figure) }.
 */
const POSES = {
  // A commit (#186): a taper to a candle on its stand, which catches and steadies.
  commit: {
    n: 8,
    frame(k) {
      const h = [0, 0, 0, 2.6, 3.4, 2.8, 3.2, 3][k];
      return {
        lean: 3,
        held: (
          <>
            <Arm d={0} x={17.6} y={10.8} />
            <path className="pose-taper" d="M17.6 10.8 L19.4 9.2" />
          </>
        ),
        ground: (
          <>
            <path className="pose-line" strokeWidth="1.2" d="M20 22 V15.6 M17.4 22 H22.6" />
            <rect className="pose-candle" x="18.7" y="11.4" width="2.6" height="4.4" />
          </>
        ),
        front: h ? (
          <>
            <circle className="pose-glow-flame" cx="20" cy="9" r="4.2" />
            <ellipse className="pose-flame" cx="20" cy={n(10.2 - h / 3)} rx="1.2" ry={n(h / 2 + 0.6)} />
          </>
        ) : null,
      };
    },
  },
  // A push (#186): hauls the bell rope, hands high then low, the bell above swinging.
  push: {
    n: 4,
    frame(k) {
      const down = [0, 1, 1, 0][k];
      const hy = down ? 13 : 7;
      const sw = [-14, 0, 14, 0][k];
      return {
        lean: down ? 4 : -2,
        held: <Arm d={0} x={17} y={hy} />,
        back: (
          <>
            <path className="pose-rope" d={`M17 -1 V${hy}`} />
            <g transform={`rotate(${sw} 17 -7)`}>
              <path className="pose-bell" d="M14.6 -3 C14.6 -6 15.6 -7.4 17 -7.4 C18.4 -7.4 19.4 -6 19.4 -3 L20.2 -1.8 H13.8 Z" />
              <circle className="pose-bell" cx="17" cy="-1.1" r="0.8" />
            </g>
          </>
        ),
      };
    },
  },
  // Raise, swing, strike (sparks), rebound: two strikes in about 1.5 s.
  edit: {
    n: 6,
    frame(k) {
      const [lean, d, hx, hy, ang] = [
        [-3, 0, 15.4, 8.6, -80],
        [-3, 0, 15.4, 8.6, -80],
        [1, 0, 17.4, 11.2, -25],
        [5, 0.6, 17.2, 14.8, 25],
        [5, 0.6, 17.2, 14.8, 25],
        [2, 0.2, 17.4, 12.6, -5],
      ][k];
      return {
        lean,
        d,
        held: (
          <>
            <Arm d={d} x={hx} y={hy} />
            <Hammer x={hx} y={hy} ang={ang} />
          </>
        ),
        ground: <rect className="pose-stone" x="19.6" y="20.4" width="5.4" height="2.2" rx="0.5" />,
        front: k === 3 ? <Sparks x={23} y={20.2} off={1.2} len={2.2} /> : k === 4 ? <Sparks x={23} y={20.2} off={2.8} len={1.4} /> : null,
      };
    },
  },
  // Carry a stone, crouch, set it down (dust), stand.
  create: {
    n: 8,
    frame(k) {
      const [lean, d, sx, sy, hx, hy] = [
        [0, 0, 12.8, 10.8, 16.4, 13.2],
        [0, 0, 12.8, 10.8, 16.4, 13.2],
        [4, 1.2, 13.8, 13.8, 17.4, 16],
        [6, 2.2, 0, 0, 18.4, 18.6],
        [6, 2.2, 0, 0, 18.4, 18.6],
        [2, 1, 0, 0, 16.2, 17.4],
        [0, 0, 0, 0, 14.4, 18.2],
        [0, 0, 0, 0, 14.4, 18.2],
      ][k];
      const dust =
        k === 3 ? (
          <>
            <circle className="pose-dust" cx="13.6" cy="21.2" r="1.1" opacity="0.7" />
            <circle className="pose-dust" cx="21.6" cy="21.2" r="1.1" opacity="0.7" />
          </>
        ) : k === 4 ? (
          <>
            <circle className="pose-dust" cx="12.3" cy="20.3" r="1.5" opacity="0.4" />
            <circle className="pose-dust" cx="22.9" cy="20.3" r="1.5" opacity="0.4" />
          </>
        ) : null;
      return {
        lean,
        d,
        held: (
          <>
            <Arm d={d} x={hx} y={hy} />
            {k < 3 && <Stone x={sx} y={sy} />}
          </>
        ),
        ground: k >= 3 ? <Stone x={15} y={18.2} /> : null,
        front: dust,
      };
    },
  },
  // A scroll held open, head bowed, eyes along the lines; the line being read is lit.
  read: {
    n: 8,
    frame(k) {
      const ys = [13.9, 15.1, 16.3];
      const on = [0, 0, 1, 1, 2, 2, 2, 2][k];
      return {
        hd: 0.9,
        hx: [-0.6, -0.3, 0, 0.3, 0.6, 0.6, -0.6, -0.6][k],
        back: <ellipse className="pose-glow-survey" cx="14" cy="14.8" rx="9" ry="6" />,
        held: (
          <>
            <Arm d={0} x={19.6} y={14.8} />
            <rect className="pose-parchment" x="8.8" y="12.4" width="10.4" height="4.8" />
            <rect className="pose-reading" x="9.8" y={n(ys[on] - 0.6)} width="8.4" height="1.2" />
            <path className="pose-ink" d="M10.2 13.9 H17.6 M10.2 15.1 H17.6 M10.2 16.3 H15.4" />
            <rect className="pose-roller" x="8" y="11.5" width="1.5" height="6.6" rx="0.6" />
            <rect className="pose-roller" x="18.6" y="11.5" width="1.5" height="6.6" rx="0.6" />
          </>
        ),
      };
    },
  },
  // A lantern held up and swinging, its light swinging with it.
  search: {
    n: 8,
    frame(k) {
      const th = [-16, -9, 0, 9, 16, 9, 0, -9][k];
      const hx = 17.6;
      const hy = 8;
      const lx = hx - 5.5 * Math.sin(rad(th));
      const ly = hy + 5.5 * Math.cos(rad(th));
      return {
        lean: [-1.5, -1, 0, 1, 1.5, 1, 0, -1][k],
        hx: [-0.5, -0.3, 0, 0.3, 0.5, 0.3, 0, -0.3][k],
        held: (
          <>
            <Arm d={0} x={hx} y={hy} />
            <g transform={`rotate(${th} ${hx} ${hy})`}>
              <path className="pose-line" strokeWidth="0.8" d={`M${hx} ${hy} v2.2`} />
              <path d={`M${n(hx - 1.7)} ${n(hy + 3.2)} L${hx} ${n(hy + 1.8)} L${n(hx + 1.7)} ${n(hy + 3.2)} Z`} />
              <rect x={n(hx - 1.7)} y={n(hy + 3.2)} width="3.4" height="4.6" rx="0.5" />
              <rect className="pose-flame" x={n(hx - 1)} y={n(hy + 3.9)} width="2" height="3.2" />
              <rect x={n(hx - 2)} y={n(hy + 7.8)} width="4" height="0.8" />
            </g>
            <circle className="pose-glow-survey" cx={n(lx)} cy={n(ly)} r={[6.2, 6.8, 7.4, 6.8][k % 4]} />
            <circle className="pose-glow-flame" cx={n(lx)} cy={n(ly)} r="2.8" />
          </>
        ),
      };
    },
  },
  // A crank turned once a second, the body rocking with it, steam rising.
  shell: {
    n: 8,
    frame(k) {
      const th = rad(k * 45);
      const cx = 18;
      const cy = 16;
      const R = 3;
      const kx = cx + R * Math.cos(th);
      const ky = cy + R * Math.sin(th);
      const qx = -R * Math.sin(th);
      const qy = R * Math.cos(th);
      const lean = n(1.5 + 1.5 * Math.cos(th));
      const d = n(0.3 * (1 - Math.cos(th)));
      const [ax, ay] = unlean(kx, ky, lean);
      return {
        lean,
        d,
        held: <Arm d={d} x={ax} y={ay} />,
        ground: (
          <>
            <path className="pose-line" strokeWidth="1.3" d={`M${cx} ${cy} L15.8 22 M${cx} ${cy} L20.2 22`} />
            <circle className="pose-line" strokeWidth="1.3" cx={cx} cy={cy} r={R} />
            <path className="pose-line" strokeWidth="0.8" d={`M${n(kx)} ${n(ky)} L${n(2 * cx - kx)} ${n(2 * cy - ky)} M${n(cx + qx)} ${n(cy + qy)} L${n(cx - qx)} ${n(cy - qy)}`} />
            <circle cx={cx} cy={cy} r="0.9" />
            <circle cx={n(kx)} cy={n(ky)} r="1.1" />
          </>
        ),
        front: [0, 2].map((o) => {
          const s = (k + o) % 4;
          return <circle key={o} className="pose-puff" cx={n(21.4 + s * 0.6)} cy={n(11.6 - s * 1.7)} r={n(0.9 + s * 0.4)} opacity={n(0.55 - s * 0.12)} />;
        }),
      };
    },
  },
};

/**
 * A Mason or Knight acting out `verb` at flip-book `frame`, in the 24 box. A
 * working Knight holds its banner pole in its other hand (the flag is drawn by
 * the unit, in its colour). Null for a verb with no pose.
 */
export function WorkerPose({ kind, verb, frame }) {
  const P = POSES[verb];
  if (!P) return null;
  const p = P.frame(((frame % P.n) + P.n) % P.n);
  const lean = p.lean || 0;
  const d = p.d || 0;
  const hx = p.hx || 0;
  const hd = p.hd || 0;
  const knight = kind === 'knight';
  return (
    <>
      {p.back}
      {p.ground}
      {knight && <path className="pose-line" strokeWidth="1.6" d="M2.4 2 V22" />}
      <g transform={`rotate(${lean} 10 22)`}>
        {knight ? <path transform={`translate(${n(hx)} ${n(d + hd)})`} d={KNIGHT_HELM} /> : <circle cx={n(10 + hx)} cy={n(5.5 + d + hd)} r="3.2" />}
        {knight ? (
          <path d={`M4.8 22 L6.6 ${n(12 + d)} Q10 ${n(10.4 + d)} 13.4 ${n(12 + d)} L15.2 22 Z`} />
        ) : (
          <path d={`M5 22 L7 ${n(11.5 + d)} Q10 ${n(9.8 + d)} 13 ${n(11.5 + d)} L15 22 Z`} />
        )}
        {p.held}
      </g>
      {p.front}
    </>
  );
}

/** Where a working Knight's flag flies: from the pole in its other hand (unit coordinates, like the idle one). */
export const KNIGHT_WORK_BANNER = 'M-9.6 -10.6 L-20 -6.8 L-9.6 -3 Z';

const RAVEN_BODY = 'M3.4 13.4 L8.2 12.2 C10.4 10.8 14.2 10.6 16.6 11.4 C17.4 10.4 19.4 10.2 20.4 11.2 L23 12 L20.4 12.6 C19.8 14.4 17.4 15.6 14.2 15.8 C10.8 16 7.8 15 3.4 13.4 Z';
const RAVEN_WINGS = ['M9.6 12.4 Q9.4 6.6 6.8 2.8 Q12.6 6 14.6 12 Z', 'M9.6 12.6 Q6 10 1.8 9.6 Q8 8.6 14.6 12.2 Z', 'M9.8 13.6 Q9.6 18 7 21.4 Q12.4 18.6 14.6 13.4 Z'];

/** A Raven beating its wings: up, level, down, level. */
export function RavenPose({ frame }) {
  return (
    <>
      <path d={RAVEN_BODY} />
      <path d={RAVEN_WINGS[[0, 1, 2, 1][frame & 3]]} />
      <circle className="pose-eye" cx="18.8" cy="11.6" r="0.5" />
    </>
  );
}

const SCOUT = 'M6.4 22 L7.6 14.6 C6.6 11.6 7.6 7.6 10.8 5.6 L11.8 2.2 L13.4 5.2 C16 6.2 18.2 9.2 18.8 12.4 L16.8 13.6 L15.2 11.4 C14.2 13.6 13.8 16.8 14.2 22 Z';

/** A Scout at a trot: a bob and a rock, dust at alternate hooves. */
export function ScoutPose({ frame }) {
  const k = frame & 3;
  return (
    <>
      <g transform={`translate(0 ${[0, -1.4, 0, -0.7][k]}) rotate(${[-4, 3, -4, 2][k]} 12 22)`}>
        <path d={SCOUT} />
      </g>
      <circle className="pose-dust" cx={k % 2 ? 15.4 : 6} cy="22.2" r="1.3" opacity="0.6" />
    </>
  );
}

const HERALD_BELL = 'M12 3.6 C8 3.6 6.8 7.6 6.8 12.6 L4.8 16.8 L19.2 16.8 L17.2 12.6 C17.2 7.6 16 3.6 12 3.6 Z';

/**
 * The Herald's bell swung to one side (`swing` -1 or 1), the clapper the other
 * way, the sound on the side its mouth faces. It swings on the ring's slow
 * pulse, not the flip-book: a Herald can stand for hours.
 */
export function HeraldPose({ swing }) {
  const r = swing * 18;
  return (
    <>
      <g transform={`rotate(${r} 12 2.6)`}>
        <path d={HERALD_BELL} />
        <circle cx={12 + swing * 1.6} cy="19.2" r="1.8" />
        <rect x="11" y="1.4" width="2" height="2.6" rx="1" />
      </g>
      <path className="pose-sound" d={swing > 0 ? 'M3.4 8.8 q-2 3.2 0 6.4 M0.8 7.2 q-3.4 4.8 0 9.6' : 'M20.6 8.8 q2 3.2 0 6.4 M23.2 7.2 q3.4 4.8 0 9.6'} />
    </>
  );
}

const SCRIBE_HOOD = 'M10 1.8 C6.6 1.8 5.6 5 5.8 8.2 L7.2 11 Q10 9.8 12.8 11 L14.2 8.2 C14.4 5 13.4 1.8 10 1.8 Z';
const SCRIBE_ROBE = 'M4.6 22 L7 11 Q10 9.6 13 11 L15.4 22 Z';
const QUILL_AT = [
  [15.4, 12.9],
  [16.6, 12.6],
  [17.8, 12.3],
  [19, 11.2],
];

/**
 * The Scribe (#163, owner's pick 2026-10-02): hooded, at a lectern by
 * candlelight, its quill moving along the line and lifting at the end.
 */
export function ScribePose({ frame }) {
  const [tx, ty] = QUILL_AT[frame & 3];
  const hx = n(tx - 1.4);
  const hy = n(ty - 3.2);
  return (
    <>
      <ellipse className="pose-glow-flame" cx="18" cy="12.4" rx="7.4" ry="5.4" />
      <path d={SCRIBE_HOOD} />
      <ellipse className="pose-eye" cx="10.6" cy="6.6" rx="2" ry="2.4" />
      <path d={SCRIBE_ROBE} />
      <path className="pose-line" strokeWidth="1.4" d="M18.6 13.8 V22 M16.2 22 H21" />
      <path className="pose-line" strokeWidth="1.5" d="M14.2 14.8 L22.6 12.4" />
      <path className="pose-parchment" d="M14.6 13.9 L22 11.8 L21.6 10.4 L14.2 12.5 Z" />
      <path className="pose-ink" d="M16 12.9 l4.4 -1.25" />
      <path className="pose-line" strokeWidth="2" d={`M12.4 12.6 L${hx} ${hy}`} />
      <path className="pose-line" strokeWidth="0.7" d={`M${tx} ${ty} L${n(hx - 0.6)} ${n(hy - 2.6)}`} />
      <path className="pose-quill" d={`M${n(hx - 0.6)} ${n(hy - 2.6)} q-1.6 1.2 -0.4 3.4 q1.2 -1.4 0.4 -3.4 Z`} />
    </>
  );
}

function star(x, y, r) {
  const k = r * 0.3;
  return `M${n(x)} ${n(y - r)} L${n(x + k)} ${n(y - k)} L${n(x + r)} ${n(y)} L${n(x + k)} ${n(y + k)} L${n(x)} ${n(y + r)} L${n(x - k)} ${n(y + k)} L${n(x - r)} ${n(y)} L${n(x - k)} ${n(y - k)} Z`;
}
const SPARKLE_AT = [
  [17.4, 2.6],
  [19.2, 5.6],
  [16.2, 6.8],
  [18.8, 1],
];

/** A Wizard with sparkles around its hat, while the unit it stands beside is at work. */
export function WizardPose({ frame }) {
  const k = frame & 3;
  const [ax, ay] = SPARKLE_AT[k];
  const [bx, by] = SPARKLE_AT[(k + 2) % 4];
  return (
    <>
      <path d="M12 0.8 L16.4 9 L7.6 9 Z" />
      <ellipse cx="12" cy="9.2" rx="6" ry="1.4" />
      <circle cx="12" cy="11.6" r="2.3" />
      <path d="M6.8 22.5 L9.4 13.2 L14.6 13.2 L17.2 22.5 Z" />
      <path className="pose-sparkle" d={star(ax, ay, 1.6)} />
      <path className="pose-sparkle" d={star(bx - 10.4, by + 1.6, 0.9)} />
    </>
  );
}

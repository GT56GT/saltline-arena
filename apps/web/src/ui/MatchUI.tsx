import { useEffect, useRef, useState } from "react";
import { client, TEAM_COLORS, TEAM_NAMES, type ClientEvent, type JoinRequest } from "../client";
import type { PlayerId } from "../protocol";

// ============================================================================ matchmaking
const TIPS = [
  "Jump facing a container to climb onto it. Double stacks are too tall.",
  "Crouch-walking is heard only within 5 m. Sprinting carries about 32 m.",
  "Landings are loud: drop off a container and anyone within about 24 m knows.",
  "Health comes back after four seconds out of the fight.",
  "Damage drops off past 25 metres: close the distance or aim for the head.",
  "Tab shows the scoreboard. Esc opens the menu and settings.",
];

/** Full-screen "finding match" card shown while the renderer loads and the server places us. */
export function Matchmaking({ join, progress, onCancel }: { join: JoinRequest; progress: number; onCancel: () => void }) {
  const [t0] = useState(() => performance.now());
  const [, tick] = useState(0);
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  useEffect(() => {
    const iv = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(iv);
  }, []);
  const secs = Math.floor((performance.now() - t0) / 1000);
  const c = client;
  const loaded = progress >= 1;
  const connecting = loaded && c.status === "connecting";
  const found = c.status === "playing" && c.hasSelf;
  const mode = join.kind === "quick" ? "Quick play" : join.kind === "create" ? "Private room" : `Room ${join.code}`;
  const sub = join.kind === "quick" ? "Free for all · up to 8 players" : join.kind === "create" ? "You are the host" : "Joining your friend's room";
  const step = found ? "Match found" : connecting ? (secs > 8 ? "Waking the server (about a minute after a quiet spell)" : "Connecting to the match server") : loaded ? "Joining" : "Loading the harbour";
  return (
    <div className={`mm ${found ? "found" : ""}`}>
      <div className="mm-art" />
      <div className="mm-panel">
        <p className="mm-k">{mode}</p>
        <h2 className="mm-title">{found ? "Match found" : "Finding match"}</h2>
        <p className="mm-sub">{sub}</p>
        <div className="mm-map">
          <span className="k">Map</span>
          <b>Harbour</b>
          <span>Saltline container terminal</span>
        </div>
        <div className="mm-status">
          <span className={`mm-dot ${found ? "ok" : ""}`} />
          <span>{step}</span>
          <span className="mm-time">{String(Math.floor(secs / 60)).padStart(1, "0")}:{String(secs % 60).padStart(2, "0")}</span>
        </div>
        <div className="mm-bar"><i style={{ width: `${Math.round((found ? 1 : loaded ? 0.92 : progress * 0.9) * 100)}%` }} /></div>
        <p className="mm-tip"><span className="k">Tip</span>{tip}</p>
        {!found && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

// ============================================================================ in-match events
interface Popup { id: number; label: string; pts: number; medal?: boolean; t: number }
interface Killed { name: string; head: boolean; dist: number | null; t: number }
interface EndState { title: string; sub: string; win: boolean | null; rows: { id: PlayerId; name: string; k: number; d: number; me: boolean; team: number | null }[]; teamScores: [number, number] | null; t: number }

const MEDALS: Record<number, string> = { 3: "Killstreak", 5: "Rampage", 7: "Unstoppable", 10: "Harbour master" };
const MULTI: Record<number, string> = { 2: "Double kill", 3: "Triple kill", 4: "Fury kill", 5: "Frenzy kill" };

/** Score popups, medals, killed-by card, match intro and end screen, driven by server events. */
export function MatchEvents() {
  const [popups, setPopups] = useState<Popup[]>([]);
  const [killed, setKilled] = useState<Killed | null>(null);
  const [end, setEnd] = useState<EndState | null>(null);
  const [intro, setIntro] = useState<{ title: string; sub: string; color?: string; t: number } | null>(null);
  const [, tick] = useState(0);
  const st = useRef({ id: 1, streak: 0, recent: [] as number[], lastKiller: -1 as PlayerId, kills: 0, spawn: -1, live: null as boolean | null });

  useEffect(() => {
    const push = (label: string, pts: number, medal = false) => {
      const p = { id: st.current.id++, label, pts, medal, t: performance.now() };
      setPopups((v) => [...v.slice(-5), p]);
    };
    const off = client.listen((e: ClientEvent) => {
      const s = st.current;
      const now = performance.now();
      if (e.t === "kill") {
        if (e.killer === client.id && e.victim !== client.id) {
          s.streak++;
          s.recent = [...s.recent.filter((t) => now - t < 4000), now];
          push(e.head ? "Headshot kill" : "Enemy killed", e.head ? 150 : 100);
          if (e.victim === s.lastKiller) { push("Payback", 50); s.lastKiller = -1; }
          const multi = MULTI[Math.min(5, s.recent.length)];
          if (s.recent.length >= 2 && multi) push(multi, 50 * s.recent.length, true);
          if (MEDALS[s.streak]) push(MEDALS[s.streak], 25 * s.streak, true);
        }
        if (e.victim === client.id) {
          s.streak = 0;
          s.recent = [];
          s.lastKiller = e.killer;
          let dist: number | null = null;
          const r = client.remotes.get(e.killer);
          const pose = r ? client.remotePose(r, now) : null;
          if (pose) dist = Math.round(Math.hypot(pose.pos[0] - client.curr[0], pose.pos[2] - client.curr[2]));
          setKilled({ name: e.killer === client.id ? "yourself" : e.killerName, head: e.head, dist, t: now });
        }
      }
      if (e.t === "match_end") {
        const names = new Map<PlayerId, { name: string; team: number | null }>([[client.id, { name: client.name, team: client.me.team }]]);
        for (const r of client.remotes.values()) names.set(r.id, { name: r.name, team: r.team });
        const rows = e.scores
          .map(([id, k, d]) => ({ id, k, d, name: names.get(id)?.name ?? "—", team: names.get(id)?.team ?? null, me: id === client.id }))
          .sort((a, b) => b.k - a.k || a.d - b.d);
        const myTeam = client.me.team;
        const win = e.teamScores ? (e.winnerTeam == null ? null : e.winnerTeam === myTeam) : e.winner == null ? null : e.winner === client.id;
        setEnd({
          title: win === true ? "Victory" : win === false ? "Defeat" : "Match over",
          sub: e.text,
          win,
          rows,
          teamScores: e.teamScores,
          t: now,
        });
        s.streak = 0;
        s.recent = [];
      }
    });
    const iv = window.setInterval(() => {
      tick((n) => n + 1);
      const now = performance.now();
      setPopups((v) => (v.some((p) => now - p.t > 2600) ? v.filter((p) => now - p.t <= 2600) : v));
      // Match intro: first spawn, and whenever a private room goes live.
      const s = st.current;
      const room = client.room;
      const live = room ? room.live : true;
      if (client.hasSelf && (s.spawn < 0 || (live && s.live === false))) {
        const teams = room?.config.teams;
        const target = room ? room.config.kill_target : client.killTarget;
        const team = client.me.team;
        if (room && !room.live) setIntro({ title: "Warm-up", sub: client.isHost ? "Pick teams, then start the match from the menu (Esc)" : "Waiting for the host to start", t: now });
        else if (teams && team != null) setIntro({ title: "Team deathmatch", sub: `You are ${TEAM_NAMES[team]} · first team to ${target} kills`, color: TEAM_COLORS[team], t: now });
        else setIntro({ title: "Free for all", sub: `First to ${target} kills wins`, t: now });
        s.spawn = client.spawnSeq;
      }
      s.live = live;
    }, 200);
    return () => {
      off();
      window.clearInterval(iv);
    };
  }, []);

  const now = performance.now();
  const dead = client.status === "playing" && !client.me.alive && killed && now - killed.t < 6000;
  const respawnIn = killed ? Math.max(0, 3 - (now - killed.t) / 1000) : 0;
  const showIntro = intro && now - intro.t < 3600;
  const showEnd = end && now - end.t < 12000;
  const score = (k: number) => k * 100;

  return (
    <>
      {showIntro && !showEnd && (
        <div className="intro" key={intro!.t}>
          <b style={intro!.color ? { color: intro!.color } : undefined}>{intro!.title}</b>
          <span>{intro!.sub}</span>
        </div>
      )}
      {!showEnd && <div className="popups">
        {popups.filter((p) => !p.medal).map((p) => (
          <div key={p.id} className="pop"><b>+{p.pts}</b><span>{p.label}</span></div>
        ))}
      </div>}
      {!showEnd && <div className="medals">
        {popups.filter((p) => p.medal).slice(-1).map((p) => (
          <div key={p.id} className="medal"><i /><b>{p.label}</b><span>+{p.pts}</span></div>
        ))}
      </div>}
      {dead && (
        <div className="killed">
          <span className="k">Killed by</span>
          <b>{killed!.name}</b>
          <span className="kd">PAC-9 rifle{killed!.head ? " · headshot" : ""}{killed!.dist != null ? ` · ${killed!.dist} m` : ""}</span>
          <span className="respawn">Respawning in {Math.ceil(respawnIn)}</span>
        </div>
      )}
      {showEnd && (
        <div className={`endscreen ${end!.win === true ? "win" : end!.win === false ? "lose" : ""}`}>
          <div className="es-inner">
            <h2>{end!.title}</h2>
            <p>{end!.sub}</p>
            {end!.teamScores && (
              <div className="es-teams">
                {[0, 1].map((t) => (
                  <div key={t} style={{ borderColor: TEAM_COLORS[t] }}><span>{TEAM_NAMES[t]}</span><b>{end!.teamScores![t]}</b></div>
                ))}
              </div>
            )}
            <table>
              <thead><tr><th>#</th><th>Player</th><th>Score</th><th>K</th><th>D</th></tr></thead>
              <tbody>
                {end!.rows.map((r, i) => (
                  <tr key={r.id} className={r.me ? "me" : ""}>
                    <td>{i + 1}</td>
                    <td>{r.team != null && end!.teamScores && <i className="dot" style={{ background: TEAM_COLORS[r.team] }} />}{r.name}</td>
                    <td>{score(r.k)}</td><td>{r.k}</td><td>{r.d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn ghost" onClick={() => setEnd(null)}>Continue</button>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================ pause menu
/** Esc menu (the mouse is free): resume, settings, room, leave. */
export function PauseMenu({ onSettings, onLeave, roomOpen, onRoom }: { onSettings: () => void; onLeave: () => void; roomOpen: boolean; onRoom: (() => void) | null }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <nav className="pause" aria-label="Match menu">
      <p className="k">Menu</p>
      <button className="pm-item" onClick={() => (document.querySelector(".game-frame") as HTMLIFrameElement | null)?.focus()}>
        Resume<small>Click the game to take aim</small>
      </button>
      {onRoom && <button className="pm-item" aria-pressed={roomOpen} onClick={onRoom}>Room{client.room ? <small>Code {client.room.code}</small> : null}</button>}
      <button className="pm-item" onClick={onSettings}>Settings<small>Sensitivity, FOV, audio, quality</small></button>
      {confirm ? (
        <div className="pm-confirm">
          <span>Leave this match?</span>
          <button className="btn ghost small" onClick={onLeave}>Leave</button>
          <button className="btn link" onClick={() => setConfirm(false)}>Stay</button>
        </div>
      ) : (
        <button className="pm-item danger" onClick={() => setConfirm(true)}>Leave match</button>
      )}
      <p className="pm-keys"><kbd>Tab</kbd> scoreboard · <kbd>Space</kbd> jump / climb · <kbd>C</kbd> crouch · <kbd>Shift</kbd> sprint</p>
    </nav>
  );
}

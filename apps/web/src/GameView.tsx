import { useEffect, useReducer, useRef, useState } from "react";
import { client, TEAM_COLORS, TEAM_NAMES, type JoinRequest } from "./client";
import type { RoomConfig } from "./protocol";
import { Matchmaking, MatchEvents, PauseMenu } from "./ui/MatchUI";
import { SettingsPanel } from "./ui/SettingsPanel";
import { attachRenderer } from "./game/bridge";

/**
 * The match: the original Saltline renderer (public/saltline/play.html, built from the original
 * game by game/build.mjs) in a same-origin frame, plus a thin overlay for Arena-only things.
 * The renderer finishes booting before we join, so nobody spawns while their textures load.
 */
export function GameView({ url, name, join, onLeave }: { url: string; name: string; join: JoinRequest; onLeave: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [inMatch, setInMatch] = useState(false);
  // Renderer options pass straight through (?q=low|medium|high for quality, ?noaudio=1).
  const [src] = useState(() => {
    const qs = new URLSearchParams(location.search);
    const extra = ["q", "noaudio"].filter((k) => qs.has(k)).map((k) => `&${k}=${encodeURIComponent(qs.get(k)!)}`).join("");
    return `/saltline/play.html?arena=1${extra}`;
  });

  useEffect(() => {
    const f = frame.current!;
    let detach: (() => void) | null = null;
    const iv = window.setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = f.contentWindow as any;
      // Loading progress from the renderer's own boot bar (shown on our matchmaking card).
      try {
        const fill = w && w.document && w.document.getElementById("boot-fill");
        if (fill) setProgress(Math.min(1, (parseFloat(fill.style.width) || 0) / 100));
      } catch { /* */ }
      if (!w || !w.__ready || !w.__G || !w.__G.game) return;
      setProgress(1);
      window.clearInterval(iv);
      detach = attachRenderer(w, client);
      setReady(true);
      try { f.focus(); } catch { /* */ }
      void client.connect(url, name, join);
    }, 100);
    return () => {
      window.clearInterval(iv);
      detach?.();
      client.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, name]);

  // The matchmaking card stays up until we are placed in the match, then shows "Match found".
  const c = useClient();
  const placed = c.status === "playing" && c.hasSelf;
  useEffect(() => {
    if (!placed) return;
    const t = window.setTimeout(() => setInMatch(true), 1300);
    return () => window.clearTimeout(t);
  }, [placed]);
  return (
    <>
      <iframe ref={frame} className="game-frame" src={src} title="Saltline Arena" allow="fullscreen; autoplay; gamepad" />
      {ready && inMatch && <Overlay onLeave={onLeave} />}
      {!inMatch && c.status !== "closed" && <Matchmaking join={join} progress={progress} onCancel={onLeave} />}
      {!inMatch && c.status === "closed" && <Overlay onLeave={onLeave} />}
    </>
  );
}

function useClient() {
  // Re-render on client events, plus a 10 Hz pulse for timers (banner, result card).
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = client.subscribe(bump);
    const iv = window.setInterval(bump, 100);
    return () => {
      off();
      window.clearInterval(iv);
    };
  }, []);
  return client;
}

/** Arena-only overlay. Health, ammo, crosshair, hit markers and the kill feed are the original HUD. */
function Overlay({ onLeave }: { onLeave: () => void }) {
  const c = useClient();
  // Keep the room in the address bar, so the page itself is the invite link.
  const code = c.room?.code;
  useEffect(() => {
    const u = new URL(location.href);
    if (code) u.searchParams.set("room", code);
    else u.searchParams.delete("room");
    history.replaceState(null, "", u);
    return () => {
      const v = new URL(location.href);
      v.searchParams.delete("room");
      history.replaceState(null, "", v);
    };
  }, [code]);
  const now = performance.now();
  const result = c.result && now - c.result.t < 9000 ? c.result : null;
  const [settings, setSettings] = useState(false);
  const [roomOpen, setRoomOpen] = useState(true);
  // Until the player has clicked into the game once, show "click to play" rather than the menu.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    if (c.locked && !engaged) setEngaged(true);
  }, [c.locked, engaged]);

  if (c.status === "closed" || c.status === "idle") {
    return (
      <div className="hud">
        <div className="gone">
          <b>{c.error ? "No connection" : "Disconnected"}</b>
          <span>{c.error || "The match server closed the connection."}</span>
          <button className="btn primary" onClick={onLeave}>Back to lobby</button>
        </div>
      </div>
    );
  }
  return (
    <div className="hud">
      <MatchEvents />
      {result && (
        <div className="result">
          <span className="k">Match recorded · signed by the server</span>
          <b className={result.me.stats.rating >= result.before ? "up" : "down"}>
            {result.me.stats.rating >= result.before ? "+" : ""}{Math.round(result.me.stats.rating - result.before)}
          </b>
          <span>Rating {Math.round(result.me.stats.rating)}</span>
        </div>
      )}
      {c.room && !c.room.live && c.locked && <div className="warmup-tag">Warm-up · Esc for the menu</div>}
      {!c.locked && c.status === "playing" && !engaged && (
        <div className="click-to-play">
          <b>Click to play</b>
          <span>Esc opens the menu · Tab shows the scoreboard</span>
        </div>
      )}
      {!c.locked && c.status === "playing" && engaged && (
        <>
          <div className="pause-dim" />
          <PauseMenu
            onSettings={() => setSettings(true)}
            onLeave={onLeave}
            roomOpen={roomOpen}
            onRoom={c.room ? () => setRoomOpen((v) => !v) : null}
          />
          {c.room && roomOpen && <RoomPanel />}
        </>
      )}
      {settings && <SettingsPanel onClose={() => setSettings(false)} />}
      {c.keys.has("Tab") && (
        <div className="scores">
          <p className="k">Scoreboard · first to {c.killTarget}{c.rtt ? ` · ${c.rtt} ms` : ""}</p>
          <table>
            <thead><tr><th>Breacher</th><th>K</th><th>D</th></tr></thead>
            <tbody>
              {c.scoreboard()
                .sort((a, b) => (a.team ?? 0) - (b.team ?? 0))
                .map((r) => (
                  <tr key={r.id} className={r.me ? "me" : ""}>
                    <td>
                      {r.team != null && c.room?.config.teams && <i className="dot" style={{ background: TEAM_COLORS[r.team] }} />}
                      {r.name}{r.bot ? <em className="bot">bot</em> : null}
                    </td>
                    <td>{r.kills}</td><td>{r.deaths}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Private room: code + invite, teams, and (for the host) settings and the Start button. */
function RoomPanel() {
  const c = client;
  const room = c.room!;
  const cfg = room.config;
  const [copied, setCopied] = useState(false);
  const host = c.isHost;
  const warm = !room.live;
  const set = (patch: Partial<RoomConfig>) => c.configure({ ...cfg, ...patch });
  const people = [
    { id: c.id, name: c.name, team: c.me.team, bot: false, me: true },
    ...[...c.remotes.values()].map((r) => ({ id: r.id, name: r.name, team: r.team, bot: r.bot, me: false })),
  ];
  const hostName = people.find((p) => p.id === room.host)?.name ?? "the host";
  const invite = () => {
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set("room", room.code);
    void navigator.clipboard?.writeText(u.toString()).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); });
  };
  const notice = performance.now() - c.notice.t < 5000 ? c.notice.text : "";
  const row = (p: (typeof people)[number]) => (
    <li key={p.id} className={p.me ? "me" : ""}>
      {p.name}
      {p.id === room.host && <em className="tagx">host</em>}
      {p.bot && <em className="bot">bot</em>}
    </li>
  );
  return (
    <div className="room-panel">
      <div className="rp-head">
        <span className="k">Room</span>
        <b className="code">{room.code}</b>
        <button className="btn ghost sm" onClick={invite}>{copied ? "Link copied" : "Copy invite link"}</button>
      </div>
      <p className="rp-state">{warm ? "Warm-up · nobody can be hurt yet" : `Match live · ${cfg.teams ? "teams" : "free for all"} · first to ${cfg.kill_target}`}</p>

      {cfg.teams ? (
        <div className="rp-teams">
          {[0, 1].map((t) => (
            <div key={t} className="rp-team" style={{ borderTopColor: TEAM_COLORS[t] }}>
              <div className="rp-team-h">
                <b style={{ color: TEAM_COLORS[t] }}>{TEAM_NAMES[t]}</b>
                <span>{people.filter((p) => p.team === t).length}{c.teamScores && room.live ? ` · ${c.teamScores[t]} kills` : ""}</span>
              </div>
              <ul>{people.filter((p) => p.team === t).map(row)}</ul>
              {warm && c.me.team !== t && <button className="btn ghost sm" onClick={() => c.setTeam(t)}>Join {TEAM_NAMES[t]}</button>}
            </div>
          ))}
        </div>
      ) : (
        <ul className="rp-list">{people.map(row)}</ul>
      )}

      {host && warm && (
        <div className="rp-settings">
          <div className="seg">
            <button aria-pressed={cfg.teams} onClick={() => set({ teams: true })}>Teams</button>
            <button aria-pressed={!cfg.teams} onClick={() => set({ teams: false })}>Free for all</button>
          </div>
          {cfg.teams ? (
            <label className="chk"><input type="checkbox" checked={cfg.balance_bots} onChange={(e) => set({ balance_bots: e.target.checked })} /> Fill the smaller team with bots when I start</label>
          ) : (
            <label className="sel">Bots joining on start
              <select value={cfg.bots} onChange={(e) => set({ bots: +e.target.value })}>
                {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? "None" : n}</option>)}
              </select>
            </label>
          )}
          <label className="chk"><input type="checkbox" checked={cfg.replace_leavers} onChange={(e) => set({ replace_leavers: e.target.checked })} /> A bot takes over if someone leaves mid-match</label>
          {cfg.teams && <label className="chk"><input type="checkbox" checked={cfg.friendly_fire} onChange={(e) => set({ friendly_fire: e.target.checked })} /> Friendly fire</label>}
          <div className="sels">
            <label className="sel">Kills to win
              <select value={cfg.kill_target} onChange={(e) => set({ kill_target: +e.target.value })}>
                {[10, 20, 30, 50, 75].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="sel">Damage
              <select value={cfg.damage ?? 100} onChange={(e) => set({ damage: +e.target.value })}>
                {[[60, "Low"], [80, "Reduced"], [100, "Normal"], [125, "High"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="sel">Time limit
              <select value={cfg.minutes} onChange={(e) => set({ minutes: +e.target.value })}>
                {[5, 8, 12, 20].map((n) => <option key={n} value={n}>{n} min</option>)}
              </select>
            </label>
          </div>
          <button className="btn primary" onClick={() => c.startMatch()}>Start match</button>
          <p className="hint">Uneven teams are fine. Bots only join if you switch them on above.</p>
        </div>
      )}
      {!host && warm && <p className="hint">Waiting for {hostName} to start the match. Pick your team meanwhile.</p>}
      {notice && <p className="err">{notice}</p>}
    </div>
  );
}

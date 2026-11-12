import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { client } from "./client";
import { Scene } from "./Scene";

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || `ws://${location.hostname || "localhost"}:8790/ws`;

function useClient() {
  // Re-render on client events, plus a 10 Hz pulse for timers (hit marker, feed fade).
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

export function App() {
  const status = useSyncExternalStore(
    (fn) => client.subscribe(fn),
    () => client.status,
  );
  return status === "playing" ? (
    <>
      <Scene />
      <Hud />
    </>
  ) : (
    <Lobby />
  );
}

function Lobby() {
  const c = useClient();
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(() => localStorage.getItem("arena.name") || "");
  const [server, setServer] = useState(params.get("server") || DEFAULT_SERVER);
  const busy = c.status === "connecting";
  const join = () => {
    const n = name.trim().slice(0, 16) || "Breacher";
    try { localStorage.setItem("arena.name", n); } catch { /* private mode */ }
    void c.connect(server, n);
  };
  return (
    <main className="lobby">
      <div className="lobby-main">
        <p className="eyebrow"><span className="tag-b">B4</span>Port Authority Breach Unit · Arena</p>
        <h1 className="word">SALTLINE<br />ARENA</h1>
        <p className="premise">Free-for-all in the container yard. First to {c.killTarget} kills. The server referees every shot.</p>
        <form className="join" onSubmit={(e) => { e.preventDefault(); join(); }}>
          <label htmlFor="name">Callsign</label>
          <input id="name" maxLength={16} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <details>
            <summary>Server</summary>
            <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} />
          </details>
          <button className="btn primary" disabled={busy}>{busy ? "Connecting…" : "Deploy"}</button>
          {c.error && <p className="err">{c.error} Is the Rust server running at {server}?</p>}
        </form>
      </div>
      <aside className="legend">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</div>
        <div><kbd>Mouse</kbd> Aim · <kbd>LMB</kbd> Fire</div>
        <div><kbd>Shift</kbd> Sprint · <kbd>Space</kbd> Jump · <kbd>C</kbd> Crouch</div>
        <div><kbd>R</kbd> Reload · <kbd>Tab</kbd> Scores</div>
      </aside>
    </main>
  );
}

function Hud() {
  const c = useClient();
  const now = performance.now();
  const showScores = c.keys.has("Tab");
  const hm = now - c.hitMarker.t < 220 ? c.hitMarker : null;
  const hurt = now - c.hurt.t < 400;
  const banner = now - c.banner.t < 5000 ? c.banner.text : "";
  const me = c.me;
  return (
    <div className="hud">
      {hurt && <div className="hurt" />}
      <div className={`cross ${me.alive ? "" : "off"}`}><i /><i /><i /><i /></div>
      {hm && <div className={`hitmark ${hm.kill ? "kill" : hm.head ? "head" : ""}`}><i /><i /><i /><i /></div>}

      <div className="score-top">
        <b>{me.kills}</b><span>/ {c.killTarget}</span>
        <em>{c.rtt ? `${c.rtt} ms` : ""}</em>
      </div>

      <div className="feed">
        {c.feed.filter((f) => now - f.t < 6000).map((f) => (
          <div key={f.id} className={f.mine ? "mine" : ""}>{f.text}</div>
        ))}
      </div>

      <div className={`health ${me.hp < 30 ? "crit" : ""}`}>
        <span className="k">Health</span>
        <b>{Math.ceil(me.hp)}</b>
        <div className="bar"><i style={{ width: `${me.hp}%` }} /></div>
      </div>

      <div className={`ammo ${me.ammo <= 6 ? "low" : ""}`}>
        <span className="k">{me.reloading ? "Reloading" : "FAC-9 Longbore"}</span>
        <b>{me.reloading ? "··" : me.ammo}</b><span className="r">/ 30</span>
      </div>

      {!me.alive && (
        <div className="dead">
          <b>Down</b>
          <span>Redeploying in 3 seconds</span>
        </div>
      )}
      {banner && <div className="banner">{banner}</div>}
      {!c.locked && me.alive && (
        <div className="clickto">Click to aim · Esc to release the mouse</div>
      )}
      {showScores && (
        <div className="scores">
          <p className="k">Scoreboard · first to {c.killTarget}</p>
          <table>
            <thead><tr><th>Breacher</th><th>K</th><th>D</th></tr></thead>
            <tbody>
              {c.scoreboard().map((r) => (
                <tr key={r.id} className={r.me ? "me" : ""}><td>{r.name}</td><td>{r.kills}</td><td>{r.deaths}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

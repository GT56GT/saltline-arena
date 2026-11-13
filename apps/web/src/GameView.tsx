import { useEffect, useReducer, useRef, useState } from "react";
import { client } from "./client";
import { attachRenderer } from "./game/bridge";

/**
 * The match: the original Saltline renderer (public/saltline/play.html, built from the original
 * game by game/build.mjs) in a same-origin frame, plus a thin overlay for Arena-only things.
 * The renderer finishes booting before we join, so nobody spawns while their textures load.
 */
export function GameView({ url, name, onLeave }: { url: string; name: string; onLeave: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
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
      if (!w || !w.__ready || !w.__G || !w.__G.game) return;
      window.clearInterval(iv);
      detach = attachRenderer(w, client);
      setReady(true);
      try { f.focus(); } catch { /* */ }
      void client.connect(url, name);
    }, 100);
    return () => {
      window.clearInterval(iv);
      detach?.();
      client.disconnect();
    };
  }, [url, name]);

  return (
    <>
      <iframe ref={frame} className="game-frame" src={src} title="Saltline Arena" allow="fullscreen; autoplay; gamepad" />
      {ready && <Overlay onLeave={onLeave} />}
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
  const now = performance.now();
  const banner = now - c.banner.t < 5000 ? c.banner.text : "";
  const result = c.result && now - c.result.t < 9000 ? c.result : null;
  const me = c.me;

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
      {c.status === "connecting" && <div className="joining">Joining the match…</div>}
      {c.status === "playing" && !me.alive && (
        <div className="dead">
          <b>Down</b>
          <span>Redeploying in 3 seconds</span>
        </div>
      )}
      {banner && <div className="banner">{banner}</div>}
      {result && (
        <div className="result">
          <span className="k">Match recorded · signed by the server</span>
          <b className={result.me.stats.rating >= result.before ? "up" : "down"}>
            {result.me.stats.rating >= result.before ? "+" : ""}{Math.round(result.me.stats.rating - result.before)}
          </b>
          <span>Rating {Math.round(result.me.stats.rating)}</span>
        </div>
      )}
      {!c.locked && c.status === "playing" && (
        <div className="leave">
          <span>Tab · scoreboard</span>
          <button className="btn ghost" onClick={onLeave}>Leave match</button>
        </div>
      )}
      {c.keys.has("Tab") && (
        <div className="scores">
          <p className="k">Scoreboard · first to {c.killTarget}{c.rtt ? ` · ${c.rtt} ms` : ""}</p>
          <table>
            <thead><tr><th>Breacher</th><th>K</th><th>D</th></tr></thead>
            <tbody>
              {c.scoreboard().map((r) => (
                <tr key={r.id} className={r.me ? "me" : ""}><td>{r.name}{r.bot ? <em className="bot">bot</em> : null}</td><td>{r.kills}</td><td>{r.deaths}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

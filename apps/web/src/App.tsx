import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { client } from "./client";
import { Scene } from "./Scene";
import { api, hasWallet, httpBase, mintOnChain, serverUrl, session, shortAddr, signInWithWallet, type BoardRow, type ChainInfo, type Item, type Me } from "./api";

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
  const status = useSyncExternalStore((fn) => client.subscribe(fn), () => client.status);
  return status === "playing" ? (
    <>
      <Scene />
      <Hud />
    </>
  ) : (
    <Lobby />
  );
}

// =============================================================== lobby

type Tab = "profile" | "leaderboard" | "cosmetics" | "how";

function Lobby() {
  const c = useClient();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [guestName, setGuestName] = useState(() => localStorage.getItem("arena.name") || "");
  const [server, setServer] = useState(serverUrl());

  const refresh = useCallback(async () => {
    if (!session.token) return setMe(null);
    try {
      setMe(await api.me());
    } catch {
      session.token = null;
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Open the profile once, at the moment of signing in — not on every profile refresh.
  const signedIn = !!me;
  useEffect(() => {
    if (signedIn) setTab("profile");
  }, [signedIn]);

  const signIn = async () => {
    setErr("");
    setBusy("Check your wallet to sign the message…");
    try {
      await signInWithWallet();
      await refresh();
    } catch (e) {
      setErr((e as Error).message.split("\n")[0]);
    } finally {
      setBusy("");
    }
  };
  const deploy = () => {
    const name = (me?.account.callsign || guestName.trim() || "Breacher").slice(0, 16);
    try {
      localStorage.setItem("arena.name", guestName);
      localStorage.setItem("arena.server", server);
    } catch { /* private mode */ }
    void c.connect(server, name);
  };

  return (
    <main className="lobby">
      <section className="lobby-main">
        <p className="eyebrow"><span className="tag-b">B4</span>Port Authority Breach Unit · Arena</p>
        <h1 className="word">SALTLINE<br />ARENA</h1>
        <p className="premise">Free-for-all in the container yard, up to 8 breachers. First to {c.killTarget} kills. The server referees every shot; your rank lives on-chain.</p>

        <div className="join">
          {me ? (
            <div className="who">
              <span className="k">Signed in</span>
              <b>{me.account.callsign || shortAddr(me.account.wallet)}</b>
              <span className="dim">{Math.round(me.stats.rating)} rating · {me.stats.matches} matches</span>
            </div>
          ) : (
            <>
              <label htmlFor="name">Callsign</label>
              <input id="name" maxLength={16} placeholder="Play as a guest" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
            </>
          )}
          <button className="btn primary" onClick={deploy} disabled={c.status === "connecting"}>
            {c.status === "connecting" ? "Connecting…" : "Deploy"}
          </button>
          {!me && (
            <button className="btn ghost" onClick={signIn} disabled={!!busy}>
              {busy ? "Waiting for wallet…" : hasWallet() ? "Sign in with wallet" : "Sign in with wallet (none found)"}
            </button>
          )}
          {!me && <p className="hint">Guests can play right away. Sign in to keep a rating, earn badges and claim cosmetics. Signing is free and sends no transaction.</p>}
          {busy && <p className="hint">{busy}</p>}
          {(err || c.error) && <p className="err">{err || `${c.error} Is the server running at ${server}?`}</p>}
          <details>
            <summary>Server</summary>
            <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} />
          </details>
        </div>
      </section>

      <aside className="panel">
        <nav className="tabs">
          {me && <button aria-pressed={tab === "profile"} onClick={() => setTab("profile")}>Profile</button>}
          <button aria-pressed={tab === "leaderboard"} onClick={() => setTab("leaderboard")}>Leaderboard</button>
          {me && <button aria-pressed={tab === "cosmetics"} onClick={() => setTab("cosmetics")}>Cosmetics</button>}
          <button aria-pressed={tab === "how"} onClick={() => setTab("how")}>How to play</button>
        </nav>
        <div className="panel-body">
          {tab === "profile" && me && <Profile me={me} onChange={refresh} />}
          {tab === "leaderboard" && <Leaderboard me={me} />}
          {tab === "cosmetics" && me && <Cosmetics me={me} onChange={refresh} />}
          {tab === "how" && <HowTo />}
        </div>
      </aside>
    </main>
  );
}

function Profile({ me, onChange }: { me: Me; onChange: () => void }) {
  const [cs, setCs] = useState(me.account.callsign || "");
  const [msg, setMsg] = useState("");
  const s = me.stats;
  const kd = s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills.toFixed(2);
  const save = async () => {
    try {
      await api.setCallsign(cs);
      setMsg("Saved");
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div>
      <p className="k">Season {me.season} · {shortAddr(me.account.wallet)}</p>
      <div className="stat-row">
        <div><b>{Math.round(s.rating)}</b><span>Rating ±{Math.round(s.rd)}</span></div>
        <div><b>{s.matches}</b><span>Matches</span></div>
        <div><b>{s.wins}</b><span>Wins</span></div>
        <div><b>{kd}</b><span>K/D</span></div>
      </div>
      <label className="k" htmlFor="cs">Callsign</label>
      <div className="row">
        <input id="cs" className="in" maxLength={16} value={cs} onChange={(e) => setCs(e.target.value)} placeholder="3–16 letters or digits" />
        <button className="btn small" onClick={save}>Save</button>
      </div>
      {msg && <p className="hint">{msg}</p>}

      <h3>Badges</h3>
      {me.achievements.length ? (
        <ul className="badges">{me.achievements.map((a) => <li key={a.code}><b>{a.title}</b><span>{new Date(a.awarded_at * 1000).toLocaleDateString()}</span></li>)}</ul>
      ) : <p className="hint">None yet. Your first kill earns one.</p>}

      <h3>Recent matches</h3>
      {me.recent.length ? (
        <table className="tbl">
          <thead><tr><th>When</th><th>Place</th><th>K</th><th>D</th><th>Rating</th></tr></thead>
          <tbody>
            {me.recent.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.ended_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td>{(m.placing ?? 0) + 1} / {m.players}</td>
                <td>{m.kills}</td><td>{m.deaths}</td>
                <td className={(m.rating_delta ?? 0) >= 0 ? "up" : "down"}>{(m.rating_delta ?? 0) >= 0 ? "+" : ""}{m.rating_delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="hint">Finish a match to see it here.</p>}
      <button className="btn small ghost" onClick={() => api.logout().then(onChange)}>Sign out</button>
    </div>
  );
}

function Leaderboard({ me }: { me: Me | null }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.leaderboard().then((r) => setRows(r.players)).catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <p className="err">Leaderboard unavailable: {err}</p>;
  if (!rows) return <p className="hint">Loading…</p>;
  if (!rows.length) return <p className="hint">No rated matches yet this season. Sign in and play to claim the top spot.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>#</th><th>Breacher</th><th>Rating</th><th>W</th><th>K/D</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.wallet} className={me && r.wallet === me.account.wallet ? "me" : ""}>
            <td>{r.rank}</td><td>{r.callsign || shortAddr(r.wallet)}</td><td>{r.rating}</td><td>{r.wins}</td>
            <td>{r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cosmetics({ me, onChange }: { me: Me; onChange: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [equipped, setEquipped] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainInfo | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    api.cosmetics().then((r) => { setItems(r.items); setEquipped(r.equipped); }).catch((e) => setMsg((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    api.chain().then(setChain).catch(() => {});
  }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      load();
      onChange();
    } catch (e) {
      setMsg((e as Error).message.split("\n")[0]);
    }
  };
  const cosmeticsAddr = chain?.contracts.cosmetics;
  if (!items) return <p className="hint">Loading…</p>;
  return (
    <div>
      <p className="hint">Visual only: no item changes speed, damage or visibility. Claim unlocks, equip one, and mint it to your wallet when you like.</p>
      <ul className="items">
        {items.map((it) => (
          <li key={it.id} className={it.owned ? "owned" : it.eligible ? "ready" : "locked"}>
            <i style={{ background: it.color }} />
            <div><b>{it.name}</b><span>{it.slot} · {it.how}</span></div>
            {it.owned ? (
              <span className="acts">
                <button className="btn small" onClick={() => act(() => api.equip(equipped === it.id ? null : it.id), equipped === it.id ? "Unequipped" : `Equipped ${it.name}`)}>
                  {equipped === it.id ? "Unequip" : "Equip"}
                </button>
                {cosmeticsAddr && (
                  <button className="btn small ghost" onClick={() => act(async () => {
                    const c = await api.claim(it.id);
                    const tx = await mintOnChain(cosmeticsAddr, c.token_id, c.voucher);
                    setMsg(`Mint sent: ${tx.slice(0, 10)}…`);
                  }, "Mint sent to your wallet")}>Mint</button>
                )}
              </span>
            ) : it.eligible ? (
              <button className="btn small" onClick={() => act(() => api.claim(it.id), `Claimed ${it.name}`)}>Claim</button>
            ) : (
              <span className="lock">Locked</span>
            )}
          </li>
        ))}
      </ul>
      {!cosmeticsAddr && <p className="hint">On-chain minting opens once the contracts are deployed to Base Sepolia.</p>}
      {msg && <p className="hint">{msg}</p>}
      <p className="hint">Signed in as {shortAddr(me.account.wallet)} · server {httpBase()}</p>
    </div>
  );
}

function HowTo() {
  return (
    <div className="how">
      <dl>
        <div><dt>Move</dt><dd><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dd></div>
        <div><dt>Aim / fire</dt><dd><kbd>Mouse</kbd> · <kbd>LMB</kbd></dd></div>
        <div><dt>Sprint · Jump · Crouch</dt><dd><kbd>Shift</kbd> <kbd>Space</kbd> <kbd>C</kbd></dd></div>
        <div><dt>Reload · Scores</dt><dd><kbd>R</kbd> <kbd>Tab</kbd></dd></div>
      </dl>
      <h3>Fair play</h3>
      <p className="hint">Your browser only sends what you press. The server moves everyone, decides every hit, and signs each result; signed results are written to the ArenaRegistry contract so anyone can audit them.</p>
      <h3>No money, ever</h3>
      <p className="hint">Saltline Arena is free. Nothing costs money to play, nothing pays out money, and earned badges cannot be sold.</p>
    </div>
  );
}

// =============================================================== in-game HUD

function Hud() {
  const c = useClient();
  const now = performance.now();
  const showScores = c.keys.has("Tab");
  const hm = now - c.hitMarker.t < 220 ? c.hitMarker : null;
  const hurt = now - c.hurt.t < 400;
  const banner = now - c.banner.t < 5000 ? c.banner.text : "";
  const result = c.result && now - c.result.t < 9000 ? c.result : null;
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
      {result && (
        <div className="result">
          <span className="k">Match recorded · signed by the server</span>
          <b className={result.me.stats.rating >= result.before ? "up" : "down"}>
            {result.me.stats.rating >= result.before ? "+" : ""}{Math.round(result.me.stats.rating - result.before)}
          </b>
          <span>Rating {Math.round(result.me.stats.rating)}</span>
        </div>
      )}
      {!c.locked && me.alive && <div className="clickto">Click to aim · Esc to release the mouse</div>}
      {showScores && (
        <div className="scores">
          <p className="k">Scoreboard · first to {c.killTarget}</p>
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

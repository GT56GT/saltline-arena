import { useCallback, useEffect, useReducer, useState } from "react";
import { client, type JoinRequest } from "./client";
import { DEFAULT_ROOM } from "./protocol";
import { GameView } from "./GameView";
import { SettingsPanel } from "./ui/SettingsPanel";
import { api, hasWallet, mintOnChain, serverUrl, session, shortAddr, signInWithWallet, type BoardRow, type ChainInfo, type Item, type Me } from "./api";

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
  const [play, setPlay] = useState<{ url: string; name: string; join: JoinRequest } | null>(null);
  return play ? (
    <GameView url={play.url} name={play.name} join={play.join} onLeave={() => setPlay(null)} />
  ) : (
    <Lobby onDeploy={(url, name, join) => setPlay({ url, name, join })} />
  );
}

// =============================================================== lobby

type Tab = "profile" | "leaderboard" | "cosmetics" | "how";

function Lobby({ onDeploy }: { onDeploy: (url: string, name: string, join: JoinRequest) => void }) {
  // An invite link (?room=CODE) opens the lobby ready to join that room.
  const invited = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const [code, setCode] = useState(invited);
  const c = useClient();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [guestName, setGuestName] = useState(() => localStorage.getItem("arena.name") || "");
  const server = serverUrl();

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
    if (!hasWallet()) {
      setErr("No wallet found in this browser. Install MetaMask (or another Ethereum wallet) to sign in — guests can play without one.");
      return;
    }
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
  const go = (join: JoinRequest) => {
    const name = (me?.account.callsign || guestName.trim() || "Breacher").slice(0, 16);
    try {
      localStorage.setItem("arena.name", guestName);
    } catch { /* private mode */ }
    onDeploy(server, name, join);
  };
  const deploy = () => go({ kind: "quick" });

  const [showSettings, setShowSettings] = useState(false);
  const joinCode = () => code.length === 5 && go({ kind: "code", code });
  const errorText = err || (c.error ? "Couldn't reach the match server. If nobody has played for a while it needs about a minute to wake up — try again shortly." : "");

  return (
    <main className="lobby">
      <header className="lobby-top">
        <p className="eyebrow"><span className="tag-b">B4</span>Port Authority Breach Unit</p>
        <div className="account">
          <button className="btn ghost small" onClick={() => setShowSettings(true)}>Settings</button>
          {me ? (
            <div className="who">
              <b>{me.account.callsign || shortAddr(me.account.wallet)}</b>
              <span>{Math.round(me.stats.rating)} rating · {me.stats.matches} matches</span>
            </div>
          ) : (
            <button className="btn ghost small" onClick={signIn} disabled={!!busy} title="Keep a rating, earn badges and claim cosmetics. Free; sends no transaction.">
              {busy ? "Check your wallet…" : "Sign in with wallet"}
            </button>
          )}
        </div>
      </header>

      <div className="lobby-body">
        <section className="hero">
          <h1 className="word">HUSH<br /><span className="word-accent">LINE</span></h1>
          <p className="premise">Squad fights and free-for-all in the Saltline container terminal, where every footstep can give you away. Up to eight players, every shot judged by the server.</p>

          <div className="play">
            {!me && (
              <label className="field">
                <span className="k">Callsign</span>
                <input id="name" maxLength={16} placeholder="Guest" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
              </label>
            )}
            {invited ? (
              <button className="btn primary" onClick={() => go({ kind: "code", code: invited })}>Join room {invited}</button>
            ) : (
              <button className="btn primary" onClick={deploy}>Quick play</button>
            )}

            <div className="divider"><span>Play with friends</span></div>
            <div className="friends-row">
              <button className="btn ghost" onClick={() => go({ kind: "create", config: DEFAULT_ROOM })}>Create room</button>
              <div className="code-group">
                <input
                  aria-label="Room code" placeholder="Room code" maxLength={5} value={code} spellCheck={false} autoCapitalize="characters"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") joinCode(); }}
                />
                <button className="btn ghost" disabled={code.length !== 5} onClick={joinCode}>Join</button>
              </div>
            </div>
            {invited && <button className="btn link" onClick={deploy}>Quick play instead</button>}
            {errorText && <p className="err" role="alert">{errorText}</p>}
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
      </div>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
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
      <p className="hint">Signed in as {shortAddr(me.account.wallet)}</p>
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
      <p className="hint">Hushline is free. Nothing costs money to play, nothing pays out money, and earned badges cannot be sold.</p>
    </div>
  );
}

// REST client for the Rust server + wallet sign-in (EIP-4361) + on-chain claims (viem).

import { createWalletClient, custom, getAddress, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

export const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL || `ws://${location.hostname || "localhost"}:8790/ws`;

export function serverUrl(): string {
  const p = new URLSearchParams(location.search).get("server");
  // ?server=wss://… points this page at another match server (development and testing only).
  return p || DEFAULT_SERVER;
}
/** ws://host:port/ws -> http://host:port */
export function httpBase(ws = serverUrl()): string {
  return ws.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
}

export interface Account { id: number; wallet: string; callsign: string | null; cosmetic: string | null }
export interface Stats { rating: number; rd: number; matches: number; wins: number; kills: number; deaths: number; headshots: number }
export interface Achievement { code: string; id: number; title: string; awarded_at: number; voucher: Hex }
export interface RecentMatch { id: string; ended_at: number; duration_s: number; kills: number | null; deaths: number | null; placing: number | null; rating_delta: number | null; players: number }
export interface Me { account: Account; stats: Stats; achievements: Achievement[]; recent: RecentMatch[]; season: number }
export interface Item { id: string; token_id: number; name: string; slot: "visor" | "plates"; color: string; how: string; owned: boolean; eligible: boolean }
export interface BoardRow { rank: number; wallet: string; callsign: string | null; cosmetic: string | null; rating: number; matches: number; wins: number; kills: number; deaths: number }
export interface ChainInfo { chain_id: number; signer: string; contracts: { registry?: Address; cosmetics?: Address; achievements?: Address; ranks?: Address }; season: number }

const TOKEN_KEY = "arena.token";
export const session = {
  get token(): string | null {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(t: string | null) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  },
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(httpBase() + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  me: () => call<Me>("/me"),
  leaderboard: () => call<{ season: number; players: BoardRow[] }>("/leaderboard"),
  cosmetics: () => call<{ items: Item[]; equipped: string | null }>("/cosmetics"),
  claim: (item: string) => call<{ item: string; token_id: number; to: string; voucher: Hex }>("/cosmetics/claim", { method: "POST", body: JSON.stringify({ item }) }),
  equip: (item: string | null) => call<{ equipped: string | null }>("/cosmetics/equip", { method: "POST", body: JSON.stringify({ item }) }),
  setCallsign: (callsign: string) => call<{ callsign: string }>("/me/callsign", { method: "POST", body: JSON.stringify({ callsign }) }),
  chain: () => call<ChainInfo>("/chain"),
  logout: () => call("/auth/logout", { method: "POST" }).finally(() => { session.token = null; }),
};

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
function eth(): Eth | null {
  return (window as unknown as { ethereum?: Eth }).ethereum ?? null;
}
export const hasWallet = () => !!eth();

/** Sign-In With Ethereum: the wallet signs a one-time message; the server checks it locally. */
export async function signInWithWallet(): Promise<Account> {
  const provider = eth();
  if (!provider) throw new Error("No wallet found. Install MetaMask, Rabby or Coinbase Wallet, or play as a guest.");
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  const { nonce } = await call<{ nonce: string }>("/auth/nonce");
  const message = [
    `${location.host} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    "",
    "Sign in to Saltline Arena. This costs nothing and sends no transaction.",
    "",
    `URI: ${location.origin}`,
    "Version: 1",
    `Chain ID: ${baseSepolia.id}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await wallet.signMessage({ account: address, message });
  const res = await call<{ token: string; account: Account }>("/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
  session.token = res.token;
  return res.account;
}

const CLAIM_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "voucher", type: "bytes" }], outputs: [] },
] as const;

/** Mint a claimed cosmetic or achievement on-chain with its server voucher (player pays gas). */
export async function mintOnChain(contract: Address, tokenId: number, voucher: Hex): Promise<Hex> {
  const provider = eth();
  if (!provider) throw new Error("No wallet found");
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: baseSepolia.id });
  } catch {
    await wallet.addChain({ chain: baseSepolia });
  }
  return wallet.writeContract({ account, address: contract, abi: CLAIM_ABI, functionName: "claim", args: [BigInt(tokenId), voucher] });
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

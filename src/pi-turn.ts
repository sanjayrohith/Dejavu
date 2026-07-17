import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface PiTurnDelivery {
  ok: boolean;
  path?: string;
  reason?: string;
}

const PI_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function piTurnsDir(): string {
  return process.env.DEJAVU_PI_TURNS_DIR ?? join(homedir(), ".dejavu", "pi-turns");
}

function isPiLikeTarget(to: string): boolean {
  return to.startsWith("pi/session/") || to.startsWith("pi:") || PI_UUID_RE.test(to) || to.endsWith(".jsonl");
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (trimmed.startsWith("pi/session/")) return trimmed.slice("pi/session/".length);
  if (trimmed.startsWith("pi:")) return trimmed.slice("pi:".length);
  return basename(trimmed).replace(/\.jsonl$/, "");
}

function candidatesFor(to: string, dir: string): string[] {
  const target = normalizeTarget(to);
  const exact = join(dir, `${target}.txt`);
  const out = [exact];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    if (name.includes(target) && name !== `${target}.txt`) out.push(join(dir, name));
  }
  return [...new Set(out)];
}

export function deliverPiTurn(to: string, body: string): PiTurnDelivery {
  if (!isPiLikeTarget(to)) return { ok: false, reason: "not-pi-target" };
  const dir = piTurnsDir();
  mkdirSync(dir, { recursive: true });
  const candidates = candidatesFor(to, dir);
  const existing = candidates.find((p) => existsSync(p));
  if (!existing) {
    return { ok: false, reason: `no pi turn trigger file found in ${dir}` };
  }
  writeFileSync(existing, body.trimEnd() + "\n");
  return { ok: true, path: existing };
}

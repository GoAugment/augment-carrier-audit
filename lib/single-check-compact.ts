import fs from "node:fs";
import zlib from "node:zlib";

import {
  getCompactMcPath,
  getCompactPhonePath,
} from "./parquet-source";

type CompactTable = [string[], unknown[][]];

const keyTableCache = new Map<string, Promise<Map<string, number[]>>>();

async function readCompactTable(file: string): Promise<CompactTable> {
  const gz = await fs.promises.readFile(file);
  const json = zlib.gunzipSync(gz).toString("utf8");
  const table = JSON.parse(json) as CompactTable;
  if (!Array.isArray(table) || !Array.isArray(table[0]) || !Array.isArray(table[1])) {
    throw new Error(`Invalid compact table: ${file}`);
  }
  return table;
}

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, max = 200): V {
  if (cache.size >= max) {
    const first = cache.keys().next().value as K | undefined;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, value);
  return value;
}

function loadKeyTable(file: string, keyColumn: string): Promise<Map<string, number[]>> {
  const cacheKey = `${file}#${keyColumn}`;
  const cached = keyTableCache.get(cacheKey);
  if (cached) return cached;
  const job = (async () => {
    const [columns, rows] = await readCompactTable(file);
    const keyIdx = columns.indexOf(keyColumn);
    const dotIdx = columns.indexOf("DOT_NUMBER");
    if (keyIdx < 0 || dotIdx < 0) {
      throw new Error(`Compact index missing ${keyColumn}/DOT_NUMBER: ${file}`);
    }
    const out = new Map<string, number[]>();
    for (const row of rows) {
      const key = String(row[keyIdx] ?? "");
      const dot = Number(row[dotIdx]);
      if (!key || !Number.isFinite(dot)) continue;
      const group = out.get(key) ?? [];
      group.push(dot);
      out.set(key, group);
    }
    return out;
  })();
  job.catch(() => keyTableCache.delete(cacheKey));
  return cacheSet(keyTableCache, cacheKey, job);
}

export function normalizeMcDigits(mc: string): string {
  return mc.replace(/\D/g, "").replace(/^0+/, "");
}

export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function fetchDotByMcCompact(mc: string): Promise<number | null | undefined> {
  const digits = normalizeMcDigits(mc);
  if (!digits) return null;
  const file = await getCompactMcPath(digits);
  if (!file) return undefined;
  const index = await loadKeyTable(file, "mc");
  const dots = index.get(digits);
  return dots?.[0] ?? null;
}

export async function findDotsByPhoneCompact(phone: string): Promise<number[] | null> {
  const digits = normalizePhoneDigits(phone);
  if (digits.length < 7) return [];
  const file = await getCompactPhonePath(digits);
  if (!file) return null;
  const index = await loadKeyTable(file, "ph");
  return index.get(digits) ?? [];
}

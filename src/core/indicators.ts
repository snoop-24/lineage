// Deterministic indicator extraction. Indicators are the concrete values (emails, URLs, numbers, ...)
// that fact-poisoning plants, and that content classifiers miss.

const FILE_EXT_TLDS = new Set([
  "md", "js", "ts", "tsx", "jsx", "mjs", "cjs", "py", "json", "txt", "yaml", "yml", "sh", "html", "css",
  "lock", "toml", "rs", "go", "rb", "java", "c", "h", "cpp", "log", "csv", "xml", "ini", "cfg", "env",
]);

// Generic TLDs accepted for DOMAIN indicators; other TLDs must be 2-letter country codes. Keeps "Object.keys" out.
const KNOWN_GTLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "dev", "ai", "app", "co", "me", "info", "biz", "xyz", "tech",
  "cloud", "site", "online", "store", "blog", "page", "link", "live", "news", "example", "test", "local", "internal",
]);

function isDomainTld(tld: string): boolean {
  return KNOWN_GTLDS.has(tld) || (tld.length === 2 && !FILE_EXT_TLDS.has(tld));
}

const MAX_TOKEN = 512;
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z]{2,24}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const HANDLE = /(?<![\w.@])@[a-z0-9_]{2,39}\b/gi;
const NUMBER = /\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g;

export function extractIndicators(text: string): Set<string> {
  const out = new Set<string>();

  // Process EMAIL, URL_RE, and DOMAIN per whitespace-separated token to avoid quadratic rescanning
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    if (token.length > MAX_TOKEN) continue;
    for (const m of token.matchAll(EMAIL)) out.add(`email:${m[0].toLowerCase()}`);
    for (const m of token.matchAll(URL_RE)) out.add(`url:${m[0].replace(/[.,;:!?)\]}]+$/, "").toLowerCase()}`);
    for (const m of token.matchAll(DOMAIN)) {
      const d = m[0].toLowerCase();
      if (isDomainTld(d.slice(d.lastIndexOf(".") + 1))) out.add(`domain:${d}`);
    }
  }

  // IPV4, PHONE, HANDLE, NUMBER run on full text (they need whitespace between groups)
  for (const m of text.matchAll(IPV4)) {
    if (m[0].split(".").every((o) => Number(o) <= 255)) out.add(`ip:${m[0]}`);
  }
  for (const m of text.matchAll(PHONE)) out.add(`phone:${m[0].replace(/\D/g, "")}`);
  for (const m of text.matchAll(HANDLE)) out.add(`handle:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(NUMBER)) {
    const n = m[0].replace(/,/g, "");
    const v = Number(n);
    if (n.length === 4 && v >= 1900 && v <= 2100) continue;
    out.add(`number:${n}`);
  }
  return out;
}

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function shingles(words: string[], n = 8): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function firstSharedShingle(a: Set<string>, b: Set<string>): string | null {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (big.has(s)) return s;
  return null;
}

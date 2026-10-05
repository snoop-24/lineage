// Make untrusted text safe to print: C0 controls (except tab), DEL and C1 controls become visible \xNN escapes.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

export function safe(s: string): string {
  return s.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

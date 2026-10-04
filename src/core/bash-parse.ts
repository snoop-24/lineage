// Best-effort detection of content entering the session through shell commands.
export interface NetworkSource {
  sourceId: string;
  tool: string;
}

const NET_TOOLS = new Set(["curl", "wget", "http", "https", "xh", "gh"]);
const GIT_NET = new Set(["clone", "fetch", "pull"]);
const PREFIX_WORDS = new Set(["sudo", "env", "command", "time", "nohup", "exec", "if", "then", "else", "elif", "do", "while", "until", "!", "xargs"]);
const URL_RE = /https?:\/\/[^\s'"`<>|;)]+/g;

export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\$\(|[;|&\n`(){}]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function commandWord(segment: string): { name: string; rest: string[] } | null {
  const words = segment.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(w) || /^-/.test(w)) i += 1;
    else break;
  }
  const first = words[i];
  if (!first) return null;
  return { name: first.split("/").pop() ?? first, rest: words.slice(i + 1) };
}

export function detectNetworkSources(command: string): NetworkSource[] {
  const out: NetworkSource[] = [];
  const seen = new Set<string>();
  for (const seg of splitSegments(command)) {
    const cw = commandWord(seg);
    if (!cw) continue;

    let subcommand = cw.rest[0] ?? "";
    // For git, skip global flags
    if (cw.name === "git") {
      let j = 0;
      while (j < cw.rest.length) {
        const arg = cw.rest[j] ?? "";
        if (arg === "-C" || arg === "-c") {
          j += 2; // Skip flag and its value
        } else if (/^-/.test(arg)) {
          j += 1; // Skip other flags
        } else {
          subcommand = arg;
          break;
        }
      }
    }

    const isNet = NET_TOOLS.has(cw.name) || (cw.name === "git" && GIT_NET.has(subcommand));
    if (!isNet) continue;
    const urls = [...seg.matchAll(URL_RE)].map((m) => m[0]);
    const fallback =
      cw.name === "gh" || cw.name === "git" ? `network:${cw.name} ${subcommand}`.trim() : `network:${cw.name}`;
    for (const id of urls.length > 0 ? urls : [fallback]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ sourceId: id, tool: cw.name });
    }
  }
  return out;
}

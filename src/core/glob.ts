// Minimal glob → RegExp: `**` (any depth, including zero dirs when followed by `/`), `*` (one segment), `?`.
export function globToRegExp(glob: string): RegExp {
  // Collapse runs of consecutive **/ into a single **/
  glob = glob.replace(/(?:\*\*\/){2,}/g, "**/");
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

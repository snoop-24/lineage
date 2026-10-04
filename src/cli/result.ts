export interface CmdResult {
  code: number;
  out: string;
  err: string;
}

export const ok = (lines: string[]): CmdResult => ({ code: 0, out: lines.length > 0 ? `${lines.join("\n")}\n` : "", err: "" });

export const usage = (msg: string): CmdResult => ({ code: 2, out: "", err: `${msg}\n` });

export async function emit(r: CmdResult): Promise<number> {
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  return r.code;
}

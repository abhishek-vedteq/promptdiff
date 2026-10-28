import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** Finds an executable on PATH (honoring PATHEXT on Windows). Returns its full path, or undefined. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RunOptions {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Quotes one argument for cmd.exe. Only used on Windows, where .cmd shims can't be run without a shell. */
function quoteWindowsArg(arg: string): string {
  if (/[\r\n"%^]/.test(arg)) {
    throw new Error(`argument can't be passed safely on Windows: ${JSON.stringify(arg.slice(0, 40))}`);
  }
  return `"${arg}"`;
}

/**
 * Runs a program and collects its output. Never uses a shell, except to launch
 * .cmd/.bat shims on Windows, where every argument is quoted and checked.
 */
export function runProgram(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const child = needsShell
      ? spawn(quoteWindowsArg(file), args.map(quoteWindowsArg), { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true })
      : spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(() => reject(new Error(`${path.basename(file)} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`)));
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("aborted")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.on("error", () => {}); // the program may exit before reading stdin
    child.stdin.end(opts.stdin ?? "");
  });
}

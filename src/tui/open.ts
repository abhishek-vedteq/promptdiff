import { spawn } from "node:child_process";

/** Opens a file with the OS's default app, without a shell. */
export function openWithDefaultApp(file: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["explorer.exe", [file]] : ["xdg-open", [file]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

import { Chalk } from "chalk";
import { accentWith, spinnerFrames } from "./theme.js";

type Out = { write(s: string): unknown; isTTY?: boolean };

/**
 * A one-line animated status on stderr, e.g. "⠋ Running prompts… 12/40 · 3 cached · $0.0123 · 14s".
 * Does nothing when stderr isn't a terminal, so logs stay clean in CI.
 */
export class Progress {
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private text = "";
  private readonly started = Date.now();
  private readonly c;
  private readonly accent;

  constructor(private readonly out: Out, colorLevel: 0 | 1 | 2 | 3) {
    this.c = new Chalk({ level: colorLevel });
    this.accent = accentWith(this.c);
  }

  get active(): boolean {
    return this.out.isTTY === true;
  }

  start(text: string): void {
    if (!this.active) return;
    this.text = text;
    this.render();
    this.timer = setInterval(() => this.render(), 120);
    this.timer.unref();
  }

  update(text: string): void {
    this.text = text;
  }

  /** Prints a line above the spinner (e.g. a retry notice) without breaking it. */
  log(line: string): void {
    if (this.active) this.out.write(`\r\x1b[2K${line}\n`);
    else this.out.write(`${line}\n`);
    if (this.timer) this.render();
  }

  stop(): void {
    if (!this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.out.write("\r\x1b[2K");
  }

  private render(): void {
    const glyph = spinnerFrames[this.frame++ % spinnerFrames.length]!;
    const secs = Math.round((Date.now() - this.started) / 1000);
    this.out.write(`\r\x1b[2K${this.accent(glyph)} ${this.text} ${this.c.dim(`· ${secs}s · ctrl+c to stop`)}`);
  }
}

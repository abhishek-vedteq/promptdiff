"""
Records docs/demo.gif: drives the real promptdiff app in a pseudo-terminal and renders the screens.

Requirements (install in a virtualenv): pip install pillow pyte
Usage:
    npm run build
    python scripts/demo/make_demo.py --model claude-code:default --out docs/demo.gif

It creates a throwaway demo repo, edits its prompt, opens `promptdiff`, presses Enter to compare,
then browses the results. Real model answers are used (results are cached, so re-renders are free).
macOS/Linux only (uses a pty).
"""

import argparse
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time

import fcntl
import pyte
import termios
from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 100, 30
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

PROMPT_V1 = """You are the customer support assistant for Acme Cloud Storage.

Guidelines:
- Be concise: answer in at most 4 sentences.
- Be warm, and acknowledge frustration when the customer is upset.
- For billing problems (double charges, refunds), explain that refunds are processed within 5 business days.
- For login problems, suggest checking the spam folder and offer a manual reset link.
- If the question is unrelated to Acme, politely say you can only help with Acme Cloud Storage.
"""
PROMPT_V2 = PROMPT_V1.replace(
    "explain that refunds are processed within 5 business days.",
    "always ask for the order number before promising anything. Refunds take 5 business days.",
).replace("at most 4 sentences", "at most 2 sentences")

CASES = [
    '{"id": "refund", "input": "I was charged twice this month. I want my money back."}',
    '{"id": "password-reset", "input": "I can\'t log in. The password reset email never arrives."}',
    '{"id": "angry", "input": "This is the third time I\'m writing. Your app deleted my files!!"}',
    '{"id": "off-topic", "input": "What\'s a good recipe for banana bread?"}',
]

# ── Terminal colors (dark theme) ────────────────────────────────────────────

BG = (13, 17, 23)
FG = (230, 237, 243)
PALETTE = {
    "black": (72, 79, 88), "red": (255, 123, 114), "green": (63, 185, 80), "brown": (210, 153, 34),
    "yellow": (210, 153, 34), "blue": (88, 166, 255), "magenta": (188, 140, 255), "cyan": (57, 197, 207),
    "white": (230, 237, 243), "default": FG,
    "brightblack": (110, 118, 129), "brightred": (255, 161, 152), "brightgreen": (86, 211, 100),
    "brightyellow": (227, 179, 65), "brightblue": (121, 192, 255), "brightmagenta": (210, 168, 255),
    "brightcyan": (86, 212, 221), "brightwhite": (255, 255, 255),
}


def color(name, default):
    if name in ("default", None):
        return default
    if isinstance(name, str) and len(name) == 6:
        try:
            return tuple(int(name[i : i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return PALETTE.get(name, default)


def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


class DimScreen(pyte.Screen):
    """pyte ignores SGR 2 (dim); track it in the unused 'blink' attribute."""

    def select_graphic_rendition(self, *attrs, **kwargs):
        rest = []
        i = 0
        attrs = attrs or (0,)
        while i < len(attrs):
            a = attrs[i]
            if a in (38, 48):
                # Extended color: 38;5;n or 38;2;r;g;b. Its parameters aren't attributes (2 here isn't "dim").
                width = 3 if i + 1 < len(attrs) and attrs[i + 1] == 5 else 5
                rest.extend(attrs[i : i + width])
                i += width
                continue
            if a == 2:
                self.cursor.attrs = self.cursor.attrs._replace(blink=True)
            elif a == 22:
                self.cursor.attrs = self.cursor.attrs._replace(blink=False, bold=False)
            else:
                rest.append(a)
            i += 1
        if rest:
            super().select_graphic_rendition(*rest, **kwargs)


# ── Rendering ───────────────────────────────────────────────────────────────

def load_fonts(size):
    for path in ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=0), ImageFont.truetype(path, size, index=1)
            except OSError:
                font = ImageFont.truetype(path, size)
                return font, font
    sys.exit("No monospace font found (Menlo or DejaVu Sans Mono).")


FONT, BOLD = load_fonts(15)


def load_fallback(size):
    """Menlo has no braille (the spinner); fall back to a font that does."""
    for path in ["/System/Library/Fonts/Apple Braille.ttf", "/System/Library/Fonts/Apple Symbols.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return None


FALLBACK = load_fallback(15)


def font_for(ch, bold):
    if FALLBACK is not None and 0x2800 <= ord(ch[0]) <= 0x28FF:
        return FALLBACK
    return BOLD if bold else FONT
CW = int(round(FONT.getlength("M")))
CH = 20
PAD, BAR = 18, 34


def render(snapshot):
    """snapshot: list of rows, each a list of pyte Chars."""
    w, h = COLS * CW + PAD * 2, ROWS * CH + PAD * 2 + BAR
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # Window chrome
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=12, outline=(48, 54, 61), width=1)
    d.rectangle([1, 1, w - 2, BAR], fill=(22, 27, 34))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 20, BAR // 2 - 6, 28 + i * 20, BAR // 2 + 6], fill=c)
    title = "~/acme-support — promptdiff"
    d.text(((w - FONT.getlength(title)) / 2, BAR // 2 - 9), title, font=FONT, fill=(139, 148, 158))
    top = BAR + PAD
    for y, row in enumerate(snapshot):
        for x, ch in enumerate(row):
            fg, bg = color(ch.fg, FG), color(ch.bg, BG)
            if ch.reverse:
                fg, bg = bg, fg
            if ch.blink:  # dim
                fg = mix(fg, BG, 0.45)
            px, py = PAD + x * CW, top + y * CH
            if bg != BG:
                d.rectangle([px, py, px + CW, py + CH], fill=bg)
            if ch.data.strip():
                d.text((px, py + 1), ch.data, font=font_for(ch.data, ch.bold), fill=fg)
            if ch.strikethrough:
                d.line([px, py + CH // 2, px + CW, py + CH // 2], fill=fg)
    return img


# ── Recording ───────────────────────────────────────────────────────────────

def make_repo(model):
    repo = tempfile.mkdtemp(prefix="promptdiff-demo-")
    env = {**os.environ, "GIT_AUTHOR_NAME": "Demo", "GIT_AUTHOR_EMAIL": "demo@example.com", "GIT_COMMITTER_NAME": "Demo", "GIT_COMMITTER_EMAIL": "demo@example.com"}
    os.makedirs(os.path.join(repo, "prompts"))
    with open(os.path.join(repo, "prompts", "support.md"), "w") as f:
        f.write(PROMPT_V1)
    with open(os.path.join(repo, "cases.jsonl"), "w") as f:
        f.write("\n".join(CASES) + "\n")
    with open(os.path.join(repo, "promptdiff.config.yaml"), "w") as f:
        f.write(f"model: {model}\n")
    with open(os.path.join(repo, ".gitignore"), "w") as f:
        f.write(".promptdiff/\n")
    for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "Support prompt v1"]):
        subprocess.run(["git", *args], cwd=repo, env=env, check=True)
    with open(os.path.join(repo, "prompts", "support.md"), "w") as f:
        f.write(PROMPT_V2)
    return repo


class Session:
    def __init__(self, cli, cwd):
        self.screen = DimScreen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.environ.update({"FORCE_COLOR": "3", "COLORTERM": "truecolor", "TERM": "xterm-256color"})
            os.execvp("node", ["node", cli])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.frames = []

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.03)
            if r:
                try:
                    self.stream.feed(os.read(self.fd, 65536))
                except OSError:
                    return

    def text(self):
        return "\n".join(self.screen.display)

    def snap(self, ms):
        rows = [[self.screen.buffer[y][x] for x in range(COLS)] for y in range(ROWS)]
        self.frames.append(([self.tidy(row) for row in rows], ms))

    def tidy(self, row):
        """Shows the throwaway repo's temp path as ~/acme-support, keeping the layout."""
        text = "".join(ch.data for ch in row)
        for marker in ("/private/", "/var/", "/tmp/"):
            start = text.find(marker)
            if start < 0:
                continue
            end = text.find("  ", start)  # the path and branch end where the gap before the model starts
            if end < 0:
                continue
            branch = text[start:end].split(" · ")[1] if " · " in text[start:end] else ""
            new = (f"~/acme-support · {branch}" if branch else "~/acme-support").ljust(end - start)
            return [row[i]._replace(data=new[i - start]) if start <= i < end else row[i] for i in range(len(row))]
        return row

    def wait_for(self, needle, timeout=180, every_ms=None):
        """Waits for text on screen; with every_ms, records frames while waiting."""
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.12)
            if every_ms:
                self.snap(every_ms)
            if needle in self.text():
                return
        sys.exit(f"Timed out waiting for {needle!r}. Screen:\n{self.text()}")

    def key(self, data, settle=0.6):
        os.write(self.fd, data.encode())
        self.pump(settle)

    def close(self):
        try:
            os.write(self.fd, b"q")
            time.sleep(0.5)
            os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="claude-code:default")
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "demo.gif"))
    ap.add_argument("--cli", default=os.path.join(ROOT, "dist", "cli.js"))
    ap.add_argument("--repo", help="keep the demo repo here between recordings")
    ap.add_argument("--cached", action="store_true", help="reuse cached answers (fast and free, but no progress bar in the GIF)")
    args = ap.parse_args()

    if args.repo and os.path.isdir(os.path.join(args.repo, ".git")):
        repo = args.repo
    else:
        repo = make_repo(args.model)
        if args.repo:
            shutil.rmtree(args.repo, ignore_errors=True)
            shutil.move(repo, args.repo)
            repo = args.repo
    if not args.cached:
        shutil.rmtree(os.path.join(repo, ".promptdiff"), ignore_errors=True)  # so the GIF shows real progress
    s = Session(args.cli, repo)
    try:
        s.wait_for("Next step", timeout=60)
        s.pump(0.5)
        s.snap(3200)  # prompts screen: the changed prompt, and what Enter will do
        s.key("\r", settle=0.2)
        s.wait_for("changed", timeout=240, every_ms=140)  # progress bar while the model answers
        s.pump(0.6)
        s.snap(3800)  # results: first changed case
        for _ in range(2):
            s.key("\x1b[B")  # next case
            s.snap(2600)
        s.key("?")
        s.snap(3400)  # help
        s.key("x")
        s.snap(1600)
    finally:
        s.close()
        if not args.repo:
            shutil.rmtree(repo, ignore_errors=True)

    # Keep the progress section short: at most ~14 frames of it.
    frames = s.frames
    progress = [i for i, (_, ms) in enumerate(frames) if ms == 140]
    if len(progress) > 14:
        keep = set(progress[:: max(1, len(progress) // 14)][:14])
        frames = [f for i, f in enumerate(frames) if i not in progress or i in keep]

    images = [render(snapshot) for snapshot, _ in frames]
    durations = [ms for _, ms in frames]
    palette_src = images[len(images) // 2].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    gif = [img.quantize(palette=palette_src, dither=Image.Dither.NONE) for img in images]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    gif[0].save(args.out, save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"Wrote {args.out}: {len(gif)} frames, {sum(durations) / 1000:.1f}s, {os.path.getsize(args.out) // 1024} KB")


if __name__ == "__main__":
    main()

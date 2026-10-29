import os from "node:os";
import { Chalk } from "chalk";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CaseStatus } from "../analysis.js";
import { PromptdiffError } from "../errors.js";
import { formatCost, formatPercentChange } from "../report/format.js";
import { renderPlan } from "../report/plan.js";
import { renderCase } from "../report/terminal.js";
import { ACCENT, glyph, nest, spinnerFrames } from "../ui/theme.js";
import type { Controller, ModelOption, SetupStep } from "./controller.js";

type View =
  | { name: "home" }
  | { name: "running"; file: string; done: number; total: number; logs: string[]; started: number }
  | { name: "results"; index: number; scroll: number }
  | { name: "model"; options: ModelOption[]; index: number; typing?: string }
  | { name: "base"; value: string }
  | { name: "help"; back: View };

interface Message {
  tone: "info" | "success" | "error";
  lines: string[];
}

interface Question {
  text: string;
  resolve: (yes: boolean) => void;
}

export interface AppProps {
  controller: Controller;
  /** Runs the login wizard; the app hands it the terminal while it runs. */
  login: (provider?: string) => Promise<void>;
}

const STATUS: Record<CaseStatus, { label: string; color: string }> = {
  changed: { label: "CHANGED", color: "yellow" },
  noise: { label: "NOISE", color: "cyan" },
  identical: { label: "SAME", color: "green" },
  error: { label: "ERROR", color: "red" },
};

const RUN_CHOICES = [1, 3, 5];

const home = os.homedir();
const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
/** Shortens from the left, keeping the end (the file name) visible. */
const clipStart = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);
/** "file.ts#NAME" shows as NAME; plain files show their path. */
const displayName = (spec: string) => (spec.includes("#") ? spec.slice(spec.lastIndexOf("#") + 1) : spec);
/** Where a prompt in code lives (shown dim next to its name). */
const location = (spec: string) => (spec.includes("#") ? spec.slice(0, spec.lastIndexOf("#")) : "");

function errorMessage(err: unknown): Message {
  if (err instanceof PromptdiffError) return { tone: "error", lines: [err.message, ...(err.hint ? err.hint.split("\n") : [])] };
  return { tone: "error", lines: [err instanceof Error ? err.message : String(err)] };
}

/** Bottom bar of key hints. */
function Keys({ items }: { items: [string, string][] }) {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {items.map(([key, label]) => (
        <Text key={key + label}>
          <Text color={ACCENT} bold>
            {key}
          </Text>
          <Text dimColor> {label}</Text>
        </Text>
      ))}
    </Box>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Box width={14} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

function MessageBox({ message }: { message: Message }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={message.tone === "error" ? "red" : message.tone === "success" ? "green" : ACCENT}
      paddingLeft={1}
    >
      {message.lines.map((l, i) => (
        <Text key={i} dimColor={i > 0 && message.tone === "error"}>
          {l}
        </Text>
      ))}
    </Box>
  );
}

/** Tells the user exactly what to do next, based on where they are. */
function NextStep({ controller: c, file }: { controller: Controller; file?: string }) {
  const runs = c.settings.runs;
  // Installed CLIs skip conversation cases, so don't count them.
  const viaCli = !!c.settings.model && /^(claude-code|codex):/.test(c.settings.model);
  const info = c.casesFor(file);
  const cases = (info?.count ?? 0) - (viaCli ? (info?.conversations ?? 0) : 0);
  const calls = cases * runs * 2;
  const changed = c.prompts.find((p) => p.path === file)?.changed;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold color={ACCENT}>
        Next step
      </Text>
      {changed && info?.error ? (
        <>
          <Text>This prompt has no test cases yet ({info.file}).</Text>
          <Text>
            Press <Text bold color={ACCENT}>g</Text> to have {c.settings.model} write some from the prompt, then review them.
          </Text>
          <Text dimColor>Or create {info.file} yourself: one JSON object per line, e.g. {'{"input": "a message your users send"}'}.</Text>
        </>
      ) : changed ? (
        <>
          <Text>
            Press <Text bold color={ACCENT}>enter</Text> to compare {displayName(file!)} with {c.settings.base}.
          </Text>
          <Text dimColor>
            Your {cases} test case{cases === 1 ? "" : "s"} run through the old and new prompt ({calls} call{calls === 1 ? "" : "s"}{runs > 1 ? `, ${runs} runs each` : ""}).
          </Text>
        </>
      ) : c.changedCount > 0 ? (
        <Text>
          Select a changed prompt (<Text color="yellow">{glyph.bullet}</Text>) with ↑↓, then press <Text bold color={ACCENT}>enter</Text>.
        </Text>
      ) : (
        <>
          <Text>
            {file && location(file)
              ? `Open ${location(file)} in your editor, change ${displayName(file)}, and save.`
              : `Open ${file ?? "a prompt file"} in your editor, change something, and save.`}
          </Text>
          <Text dimColor>It shows up here as changed within a few seconds. Then press enter to compare.</Text>
          <Text dimColor>Or press b to compare with an older version from git instead.</Text>
        </>
      )}
    </Box>
  );
}

export function App({ controller: c, login }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const columns = (stdout as NodeJS.WriteStream).columns || 100;
  const rows = (stdout as NodeJS.WriteStream).rows || 32;

  const [view, setView] = useState<View>({ name: "home" });
  const [selected, setSelected] = useState(0);
  const [stepIndex, setStepIndex] = useState(() => Math.max(0, c.setupSteps().findIndex((st) => !st.done)));
  const [message, setMessage] = useState<Message | undefined>();
  const [question, setQuestion] = useState<Question | undefined>();
  const [frame, setFrame] = useState(0);
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);
  const abort = useRef<AbortController | undefined>(undefined);

  // Notice prompt and test-case edits while on the prompts screen.
  useEffect(() => {
    if (view.name !== "home") return;
    const timer = setInterval(() => {
      const before = JSON.stringify([c.prompts, c.cases]);
      void c.refresh().then(
        () => {
          if (JSON.stringify([c.prompts, c.cases]) !== before) {
          // Files changed, so the next step changed too: drop the old message to show it.
          setMessage(undefined);
          setTick((t) => t + 1);
        }
        },
        () => {},
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [view.name, c]);

  useEffect(() => {
    if (view.name !== "running") return;
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, [view.name]);

  const current = c.prompts[Math.min(selected, c.prompts.length - 1)];

  const startCompare = useCallback(
    async (dryRun: boolean) => {
      if (!current) return;
      if (c.modelProblem) {
        setMessage({ tone: "error", lines: [`The model isn't ready: ${c.modelProblem}.`, "Press m to choose a model, or l to log in."] });
        return;
      }
      setMessage(undefined);
      const ac = new AbortController();
      abort.current = ac;
      setView({ name: "running", file: current.path, done: 0, total: 0, logs: [], started: Date.now() });
      try {
        const { report, plan } = await c.compare(
          current.path,
          {
            signal: ac.signal,
            progress: (done, total) => setView((v) => (v.name === "running" ? { ...v, done, total } : v)),
            log: (line) => setView((v) => (v.name === "running" ? { ...v, logs: [...v.logs, line].slice(-6) } : v)),
            confirm: () => {
              const cost = c.plan?.cost !== undefined ? `This run is estimated at ~${formatCost(c.plan.cost)}.` : "This is a large run.";
              return new Promise<boolean>((resolve) => setQuestion({ text: cost, resolve }));
            },
          },
          dryRun,
        );
        if (dryRun && plan) {
          setMessage({ tone: "info", lines: renderPlan(plan, c.settings.model ?? "", c.settings.judge, c.deps.colorLevel).split("\n") });
          setView({ name: "home" });
        } else if (report) {
          const interesting = report.cases.findIndex((cr) => cr.status === "changed" || cr.status === "error" || cr.checks?.regression);
          setView({ name: "results", index: Math.max(0, interesting), scroll: 0 });
        } else {
          setView({ name: "home" });
        }
      } catch (err) {
        setMessage(
          ac.signal.aborted
            ? { tone: "info", lines: ["Stopped. Finished results are saved, so comparing again picks up where it stopped."] }
            : errorMessage(err),
        );
        setView({ name: "home" });
      } finally {
        abort.current = undefined;
        setQuestion(undefined);
      }
    },
    [c, current],
  );

  const openModelPicker = async () => {
    setView({ name: "model", options: await c.modelOptions(), index: 0 });
  };

  const chooseModel = async (model: string) => {
    c.setModel(model, "chosen in promptdiff");
    await c.checkModel();
    setMessage(
      c.modelProblem
        ? { tone: "error", lines: [`${model} isn't ready: ${c.modelProblem}.`, "Press l to log in, or m to choose another."] }
        : { tone: "success", lines: [`Using ${model} for this session.`, "To keep it, set `model:` in promptdiff.config.yaml."] },
    );
    setView({ name: "home" });
  };

  const fixStep = async (step: SetupStep) => {
    if (step.done) return;
    try {
      if (step.id === "model" && !c.alternative) {
        const options = await c.modelOptions();
        if (options.some((o) => o.ready)) setView({ name: "model", options, index: 0 });
        else {
          await suspendTerminal(() => login());
          await c.checkModel();
        }
        rerender();
        return;
      }
      if (step.id === "cases") setMessage({ tone: "info", lines: [`Working on it: ${step.action}…`] });
      const done = await c.fixStep(step.id);
      const steps = c.setupSteps();
      const next = steps.findIndex((st) => !st.done);
      if (next >= 0) {
        setStepIndex(next);
        setMessage({ tone: "success", lines: [done] });
      } else {
        const first = c.prompts[0]?.path ?? "your prompt file";
        setSelected(0);
        setMessage({
          tone: "success",
          lines: [done, `You're all set. Next: open ${first} in your editor, change something, and save. It will show up here as changed.`],
        });
      }
    } catch (err) {
      setMessage(errorMessage(err));
    }
  };

  useInput((input, key) => {
    if (question) {
      if (input === "y" || input === "Y") {
        question.resolve(true);
        setQuestion(undefined);
      } else if (input === "n" || input === "N" || key.escape || key.return) {
        question.resolve(false);
        setQuestion(undefined);
      }
      return;
    }
    if (key.ctrl && input === "c") {
      if (abort.current) abort.current.abort();
      else exit();
      return;
    }

    if (input === "?" && (view.name === "home" || view.name === "results")) {
      setView({ name: "help", back: view });
      return;
    }

    switch (view.name) {
      case "help":
        setView(view.back);
        return;

      case "running":
        if (key.escape || input === "q") abort.current?.abort();
        return;

      case "results": {
        const n = c.report?.cases.length ?? 0;
        if (key.escape || key.leftArrow || input === "q") setView({ name: "home" });
        else if (key.upArrow && n) setView({ ...view, index: (view.index + n - 1) % n, scroll: 0 });
        else if (key.downArrow && n) setView({ ...view, index: (view.index + 1) % n, scroll: 0 });
        else if (input === "j" || key.pageDown) setView({ ...view, scroll: view.scroll + (key.pageDown ? 10 : 1) });
        else if (input === "k" || key.pageUp) setView({ ...view, scroll: Math.max(0, view.scroll - (key.pageUp ? 10 : 1)) });
        else if (input === "o" && c.lastReport) c.deps.openFile(c.lastReport);
        else if (input === "c") void startCompare(false);
        else if (input === "a") {
          void c.approve().then(
            (msg) => {
              setMessage({ tone: "success", lines: [msg] });
              setView({ name: "home" });
            },
            (err: unknown) => setMessage(errorMessage(err)),
          );
        }
        return;
      }

      case "model": {
        if (view.typing !== undefined) {
          if (key.escape) setView({ ...view, typing: undefined });
          return; // the text input handles typing
        }
        const n = view.options.length;
        if (key.escape || input === "q") setView({ name: "home" });
        else if (key.upArrow && n) setView({ ...view, index: (view.index + n - 1) % n });
        else if (key.downArrow && n) setView({ ...view, index: (view.index + 1) % n });
        else if (key.return && n) {
          const opt = view.options[view.index]!;
          if (opt.needsId) setView({ ...view, typing: opt.model });
          else void chooseModel(opt.model);
        }
        return;
      }

      case "base":
        if (key.escape) setView({ name: "home" });
        return;

      case "home": {
        if (!c.setupComplete) {
          const steps = c.setupSteps();
          if (input === "q") exit();
          else if (key.upArrow) setStepIndex((i) => (i + steps.length - 1) % steps.length);
          else if (key.downArrow) setStepIndex((i) => (i + 1) % steps.length);
          else if (key.return) void fixStep(steps[stepIndex]!);
          else if (input === "m") void openModelPicker();
          else if (input === "l") {
            void suspendTerminal(() => login()).then(async () => {
              await c.checkModel();
              rerender();
            });
          }
          return;
        }
        const n = c.prompts.length;
        if (input === "q") exit();
        else if ((key.upArrow || input === "k") && n) setSelected((i) => (i + n - 1) % n);
        else if ((key.downArrow || input === "j") && n) setSelected((i) => (i + 1) % n);
        else if (key.return) void startCompare(false);
        else if (input === "p") void startCompare(true);
        else if (input === "g" && current) {
          const info = c.casesFor(current.path);
          if (info && !info.error) {
            setMessage({ tone: "info", lines: [`${current.path} already has ${info.count} test cases in ${info.file}.`, `To add more: promptdiff cases generate ${current.path} --append`] });
          } else {
            setMessage({ tone: "info", lines: [`Writing test cases for ${displayName(current.path)} with ${c.settings.model}…`] });
            void c.generateFor(current.path).then(
              (msg) => setMessage({ tone: "success", lines: [msg] }),
              (err: unknown) => setMessage(errorMessage(err)),
            );
          }
        }
        else if (input === "m") void openModelPicker();
        else if (input === "b") setView({ name: "base", value: c.settings.base });
        else if (input === "r") {
          const next = RUN_CHOICES[(RUN_CHOICES.indexOf(c.settings.runs) + 1) % RUN_CHOICES.length]!;
          c.settings.runs = next;
          setMessage({ tone: "info", lines: [`Each test case now runs ${next} time${next === 1 ? "" : "s"} per version${next > 1 ? ", to tell real changes from randomness" : ""}.`] });
        } else if (input === "s") {
          c.settings.compare = c.settings.compare === "words" ? "semantic" : "words";
          setMessage({
            tone: "info",
            lines: [
              c.settings.compare === "semantic"
                ? "Outputs are now compared by meaning: an LLM judge decides what really changed (one extra call per changed case)."
                : "Outputs are now compared by word overlap (free).",
            ],
          });
        } else if (input === "v" && c.report) setView({ name: "results", index: 0, scroll: 0 });
        else if (input === "o" && c.lastReport) {
          c.deps.openFile(c.lastReport);
          setMessage({ tone: "success", lines: ["Opened the last report in your browser."] });
        } else if (input === "l") {
          void suspendTerminal(() => login()).then(async () => {
            await c.checkModel();
            if (c.modelProblem && c.alternative) await chooseModel(c.alternative.model);
            rerender();
          });
        } else if (input === "i") {
          let out = "";
          void c.deps.init({ write: (s: string) => (out += s) }).then(
            async () => {
              await c.refresh();
              setMessage({ tone: "success", lines: out.trim().split("\n").filter((l) => l.trim()) });
            },
            (err: unknown) => setMessage(errorMessage(err)),
          );
        }
        return;
      }
    }
  });

  // ── Layout ────────────────────────────────────────────────────────────────

  const header = (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text color="green" bold>
            {glyph.mark}
          </Text>
          <Text bold> promptdiff</Text>
          <Text dimColor>
            {"   "}
            {clip(tilde(c.deps.cwd), Math.max(10, columns - 50))}
            {c.branch ? ` ${glyph.sep} ${c.branch}` : ""}
          </Text>
        </Text>
        <Text dimColor>{c.settings.model ? clip(c.settings.model, 34) : "no model"}</Text>
      </Box>
      <Text dimColor>{glyph.rule.repeat(Math.max(0, columns - 2))}</Text>
      {(view.name === "home" || view.name === "help") && (
        <Text dimColor>See how editing a prompt changes your model's answers, before you ship it. Press ? for help.</Text>
      )}
    </Box>
  );

  let body: ReactNode = null;
  let keys: [string, string][] = [];

  if (view.name === "home" && !c.setupComplete) {
    const steps = c.setupSteps();
    const doneCount = steps.filter((st) => st.done).length;
    const sel = steps[stepIndex];
    keys = [["↑↓", "select step"], ["enter", sel && !sel.done ? "do this step" : "—"], ["m", "model"], ["l", "log in"], ["?", "help"], ["q", "quit"]];
    body = (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          <Text bold>Let's get you set up</Text>
          <Text dimColor>
            {"  "}
            {doneCount} of {steps.length} done
          </Text>
        </Text>
        <Box flexDirection="column">
          {steps.map((st, i) => {
            const isSel = i === stepIndex;
            return (
              <Box key={st.id} flexDirection="column" marginBottom={i < steps.length - 1 ? 1 : 0}>
                <Text>
                  <Text color={ACCENT}>{isSel ? `${glyph.pointer} ` : "  "}</Text>
                  {st.done ? <Text color="green">{glyph.ok}</Text> : <Text color="yellow">{glyph.hollow}</Text>}
                  <Text bold={isSel} color={isSel ? ACCENT : undefined}>
                    {" "}
                    {i + 1}. {st.title}
                  </Text>
                </Text>
                <Text dimColor wrap="wrap">
                  {"     "}
                  {st.detail}
                </Text>
                {isSel && !st.done && st.action && (
                  <Text>
                    {"     "}
                    <Text color={ACCENT} bold>
                      enter
                    </Text>{" "}
                    to {st.action}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
        {message && <MessageBox message={message} />}
      </Box>
    );
  } else if (view.name === "home") {
    const ready = c.inRepo && c.prompts.length > 0;
    keys = ready
      ? [
          ["enter", "compare"],
          ["↑↓", "select"],
          ["m", "model"],
          ["b", "base"],
          ["r", "runs"],
          ["s", "semantic"],
          ["p", "cost"],
          ["g", "write test cases"],
          ...(c.report ? [["v", "last results"] as [string, string]] : []),
          ...(c.lastReport ? [["o", "open report"] as [string, string]] : []),
          ["l", "log in"],
          ["?", "help"],
          ["q", "quit"],
        ]
      : [["m", "model"], ["l", "log in"], ["q", "quit"]];
    if (c.cases?.error) keys.splice(keys.length - 1, 0, ["i", "create sample files"]);
    // Leave room for the header, the details rows, the next-step box, and the key bar.
    const listHeight = Math.max(3, rows - 24);
    const start = Math.max(0, Math.min(selected - Math.floor(listHeight / 2), c.prompts.length - listHeight));
    const visible = c.prompts.slice(start, start + listHeight);
    const nameWidth = Math.min(Math.max(10, ...c.prompts.map((p) => displayName(p.path).length)), Math.floor(columns * 0.5));
    const viaCli = !!c.settings.model && /^(claude-code|codex):/.test(c.settings.model);
    const currentCases = c.casesFor(current?.path);

    body = (
      <Box flexDirection="column" rowGap={1}>
        {!c.inRepo ? (
          <Box flexDirection="column">
            <Text color="yellow">This folder isn't a git repository.</Text>
            <Text dimColor>promptdiff compares your prompt files with their earlier versions in git.</Text>
            <Text dimColor>Open it inside your project, or run `git init` and commit your prompts first.</Text>
          </Box>
        ) : c.prompts.length === 0 ? (
          <Box flexDirection="column">
            <Text color="yellow">No prompt files found here.</Text>
            <Text dimColor>promptdiff lists .md, .txt, .prompt (and similar) files that are committed to git.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text bold>Prompt files</Text>
              <Text dimColor>
                {"  "}
                {c.changedCount
                  ? `${c.changedCount} changed since ${c.settings.base}`
                  : `none changed since ${c.settings.base} (edit one and it shows up here)`}
              </Text>
            </Text>
            {visible.map((p, i) => {
              const isSel = start + i === selected;
              const name = displayName(p.path);
              const where = location(p.path);
              const status = p.error ? "can't read" : p.changed ? `+${p.added ?? "?"} −${p.removed ?? "?"}` : "unchanged";
              return (
                <Text key={p.path} wrap="truncate-end">
                  <Text color={ACCENT}>{isSel ? `${glyph.pointer} ` : "  "}</Text>
                  <Text color={p.changed ? "yellow" : undefined} dimColor={!p.changed}>
                    {p.changed ? glyph.bullet : glyph.hollow}{" "}
                  </Text>
                  {p.error ? (
                    <Text color="red">{status.padEnd(11)}</Text>
                  ) : p.changed ? (
                    <Text>
                      <Text color="green">+{p.added ?? "?"}</Text> <Text color="red">−{p.removed ?? "?"}</Text>
                      {" ".repeat(Math.max(1, 11 - status.length))}
                    </Text>
                  ) : (
                    <Text dimColor>{status.padEnd(11)}</Text>
                  )}
                  <Text bold={isSel} color={isSel ? ACCENT : undefined}>
                    {clip(name, nameWidth).padEnd(nameWidth)}
                  </Text>
                  {where ? <Text dimColor>  {clipStart(where, Math.max(10, columns - nameWidth - 22))}</Text> : null}
                </Text>
              );
            })}
            {c.prompts.length > listHeight && (
              <Text dimColor>
                {"  "}
                {start + 1}–{Math.min(start + listHeight, c.prompts.length)} of {c.prompts.length} prompts, ↑↓ to scroll
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column">
          <Row label="Compare with">
            <Text>
              {c.settings.base} <Text dimColor>(b to change)</Text>
            </Text>
          </Row>
          <Row label="Test cases">
            {currentCases?.error ? (
              <Text color="yellow" wrap="truncate-end">
                {currentCases.error}
              </Text>
            ) : (
              <Text>
                {currentCases?.count} in {clipStart(tilde(currentCases?.file ?? ""), Math.max(20, columns - 50))}
                {viaCli && currentCases?.conversations ? (
                  <Text dimColor>
                    {" "}
                    ({currentCases.conversations} conversation case{currentCases.conversations === 1 ? "" : "s"} skipped with this model)
                  </Text>
                ) : null}
              </Text>
            )}
          </Row>
          <Row label="Model">
            {c.modelProblem ? (
              <>
                <Text>
                  {c.settings.model ?? "none"}{" "}
                  <Text color="red">
                    {glyph.fail} {c.modelProblem}
                  </Text>
                </Text>
                <Text dimColor>
                  {c.alternative ? `${c.alternative.model} is ready (${c.alternative.reason}). ` : ""}Press m to choose a model, or l to log in.
                </Text>
              </>
            ) : (
              <Text>
                {c.settings.model} <Text color="green">{glyph.ok} ready</Text>
                {c.settings.modelSource ? (
                  <Text dimColor>
                    {" "}
                    {glyph.sep} {c.settings.modelSource}
                  </Text>
                ) : null}
              </Text>
            )}
          </Row>
          <Row label="Settings">
            <Text>
              {c.settings.runs} run{c.settings.runs === 1 ? "" : "s"} per case <Text dimColor>(r)</Text>
              {"   "}compared by {c.settings.compare === "semantic" ? "meaning" : "words"} <Text dimColor>(s)</Text>
            </Text>
          </Row>
        </Box>

        {message ? <MessageBox message={message} /> : <NextStep controller={c} file={current?.path} />}
      </Box>
    );
  } else if (view.name === "running") {
    keys = question ? [["y", "yes, run it"], ["n", "no"]] : [["esc", "stop"]];
    const width = Math.max(10, Math.min(40, columns - 40));
    const filled = view.total ? Math.round((view.done / view.total) * width) : 0;
    const secs = Math.floor((Date.now() - view.started) / 1000);
    body = (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          Comparing <Text bold>{displayName(view.file)}</Text>
          <Text dimColor>
            {"  "}
            {c.settings.base} {glyph.arrow} working copy {glyph.sep} {c.settings.model}
          </Text>
        </Text>
        <Text>
          <Text color={ACCENT}>{spinnerFrames[frame % spinnerFrames.length]} </Text>
          <Text color={ACCENT}>{"━".repeat(filled)}</Text>
          <Text dimColor>{"━".repeat(width - filled)}</Text>
          <Text>
            {"  "}
            {view.total ? `${view.done} of ${view.total} calls` : "preparing"}
          </Text>
          <Text dimColor>
            {" "}
            {glyph.sep} {secs}s
          </Text>
        </Text>
        {view.logs.length > 0 && (
          <Box flexDirection="column">
            {view.logs.map((l, i) => (
              <Text key={i} dimColor>
                {l}
              </Text>
            ))}
          </Box>
        )}
        {question && (
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text>
              {question.text} <Text bold>Continue?</Text> <Text dimColor>(y/n)</Text>
            </Text>
          </Box>
        )}
      </Box>
    );
  } else if (view.name === "results" && c.report) {
    keys = [["↑↓", "case"], ["j k", "scroll"], ["o", "open full report"], ["a", "approve these answers"], ["c", "compare again"], ["?", "help"], ["esc", "back"]];
    const report = c.report;
    const s = report.summary;
    const listWidth = Math.min(34, Math.floor(columns / 3));
    const paneWidth = columns - listWidth - 5;
    const paneHeight = Math.max(5, rows - 11);
    const cr = report.cases[Math.min(view.index, report.cases.length - 1)];
    const gutter = nest([""], new Chalk({ level: c.deps.colorLevel }))[0]!;
    // The list already names the case, so the pane shows the input, then the details without their gutter.
    const lines = cr
      ? [
          `input: ${cr.input.replace(/\s+/g, " ").trim()}`,
          "",
          ...renderCase(cr, report, { colorLevel: c.deps.colorLevel, width: paneWidth - 2, sideBySide: paneWidth >= 92, stacked: true, verbose: true })
            .split("\n")
            .slice(1)
            .map((l) => (l.startsWith(gutter) ? l.slice(gutter.length) : l)),
        ]
      : ["No test cases ran."];
    const scroll = Math.min(view.scroll, Math.max(0, lines.length - paneHeight));
    const listStart = Math.max(0, Math.min(view.index - Math.floor(paneHeight / 2), report.cases.length - paneHeight));
    const delta = (a?: number, b?: number) => formatPercentChange(a, b) || "±0%";

    body = (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text>
            <Text bold>{report.meta.file}</Text>
            <Text dimColor>
              {"  "}
              {report.meta.baseRef} {glyph.arrow} {report.meta.headRef}
            </Text>
          </Text>
          <Text>
            <Text color="yellow">{s.changed} changed</Text>
            <Text dimColor> {glyph.sep} </Text>
            <Text color="cyan">{s.noise} noise</Text>
            <Text dimColor> {glyph.sep} </Text>
            <Text color="green">{s.identical} same</Text>
            {s.errors ? (
              <Text>
                <Text dimColor> {glyph.sep} </Text>
                <Text color="red">{s.errors} errors</Text>
              </Text>
            ) : null}
          </Text>
        </Box>
        <Text dimColor>
          output tokens {delta(s.base.outputTokens, s.head.outputTokens)} {glyph.sep} latency {delta(s.base.avgLatencyMs, s.head.avgLatencyMs)} {glyph.sep} cost{" "}
          {s.totalCost !== undefined ? formatCost(s.totalCost) : "n/a"}
          {s.checks ? ` ${glyph.sep} checks ${s.checks.head.passed}/${s.checks.head.total}${s.checks.regressions ? `, ${s.checks.regressions} regressed` : ""}` : ""}
        </Text>
        <Text dimColor>
          <Text color="yellow">CHANGED</Text> answer changed {glyph.sep} <Text color="cyan">NOISE</Text> only reworded, like a rerun {glyph.sep}{" "}
          <Text color="green">SAME</Text> identical
        </Text>
        <Box marginTop={1}>
          <Box flexDirection="column" width={listWidth} flexShrink={0}>
            {report.cases.slice(listStart, listStart + paneHeight).map((item, i) => {
              const idx = listStart + i;
              const st = STATUS[item.status];
              const isSel = idx === view.index;
              return (
                <Text key={item.id} wrap="truncate-end">
                  <Text color={ACCENT}>{isSel ? glyph.pointer : " "} </Text>
                  <Text color={st.color}>{st.label.padEnd(8)}</Text>
                  <Text bold={isSel} color={isSel ? ACCENT : undefined}>
                    {item.id}
                  </Text>
                  {item.checks?.regression ? <Text color="red"> {glyph.fail}</Text> : null}
                </Text>
              );
            })}
          </Box>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderDimColor
            paddingLeft={1}
            flexGrow={1}
          >
            {lines.slice(scroll, scroll + paneHeight).map((l, i) => (
              <Text key={i} wrap="wrap" dimColor={i === 0 && scroll === 0}>
                {l || " "}
              </Text>
            ))}
            {lines.length > scroll + paneHeight && <Text dimColor>↓ {lines.length - scroll - paneHeight} more lines (j to scroll)</Text>}
          </Box>
        </Box>
      </Box>
    );
  } else if (view.name === "model") {
    keys = view.typing !== undefined ? [["enter", "use this model"], ["esc", "back"]] : [["↑↓", "choose"], ["enter", "select"], ["esc", "cancel"]];
    body = (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>Choose a model</Text>
        {view.typing !== undefined ? (
          <Box flexDirection="column">
            <Text dimColor>Type the model id after the provider name (any model your provider offers):</Text>
            <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
              <TextInput
                value={view.typing}
                onChange={(v) => setView({ ...view, typing: v })}
                onSubmit={(v) => {
                  if (/^[\w-]+:.+/.test(v.trim())) void chooseModel(v.trim());
                }}
              />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {view.options.map((o, i) => (
              <Text key={o.label}>
                <Text color={ACCENT}>{i === view.index ? `${glyph.pointer} ` : "  "}</Text>
                <Text color={i === view.index ? ACCENT : undefined} bold={i === view.index} dimColor={!o.ready && i !== view.index}>
                  {o.label.padEnd(28)}
                </Text>
                {o.ready ? <Text color="green">{glyph.ok} </Text> : <Text dimColor>– </Text>}
                <Text dimColor>{o.detail}</Text>
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>Not set up yet? Press esc, then l to log in.</Text>
      </Box>
    );
  } else if (view.name === "help") {
    keys = [["any key", "back"]];
    body = (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>How promptdiff works</Text>
        <Box flexDirection="column">
          <Text>
            <Text color={ACCENT}>1.</Text> Your <Text bold>prompt</Text> (the system prompt your app sends) lives in a file in git, e.g. prompts/support.md.
          </Text>
          <Text>
            <Text color={ACCENT}>2.</Text> Your <Text bold>test cases</Text> are example user messages, one per line in cases.jsonl.
          </Text>
          <Text>
            <Text color={ACCENT}>3.</Text> You edit the prompt. promptdiff sends every test case to the model twice: with the old prompt (from git) and with your edit.
          </Text>
          <Text>
            <Text color={ACCENT}>4.</Text> You see, case by case, how the answers changed, and what it did to length, speed, and cost.
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>What the results mean</Text>
          <Text>
            <Text color="yellow">CHANGED</Text>  the answer is different in a way that matters
          </Text>
          <Text>
            <Text color="cyan">NOISE  </Text>  the answer is worded differently, but no more than re-running the same prompt would
          </Text>
          <Text>
            <Text color="green">SAME   </Text>  the answer didn't change
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Good to know</Text>
          <Text dimColor>• Results are saved, so comparing the same thing again is instant and free.</Text>
          <Text dimColor>• Press r for more runs per case (tells real changes from randomness), s to compare by meaning.</Text>
          <Text dimColor>• To compare against another branch or an older commit, press b.</Text>
          <Text dimColor>• Full documentation: docs/ in the promptdiff repository.</Text>
        </Box>
      </Box>
    );
  } else if (view.name === "base") {
    keys = [["enter", "apply"], ["esc", "cancel"]];
    body = (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>Compare with which version?</Text>
        <Text dimColor>A branch, tag, or commit, e.g. main, v1.2, or HEAD~3. Your working copy is compared against it.</Text>
        <Text dimColor>Or type approved to compare with the answers you approved (a on the results screen).</Text>
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <TextInput
            value={view.value}
            onChange={(v) => setView({ name: "base", value: v })}
            onSubmit={(v) => {
              const ref = v.trim() || "HEAD";
              c.settings.base = ref;
              setView({ name: "home" });
              setMessage({ tone: "info", lines: [`Comparing against ${ref}.`] });
              void c.refresh().then(rerender);
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      {header}
      <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
        {body}
      </Box>
      <Text dimColor>{glyph.rule.repeat(Math.max(0, columns - 2))}</Text>
      <Keys items={keys} />
    </Box>
  );
}

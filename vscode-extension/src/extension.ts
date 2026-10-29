import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

/** File types whose prompts live inside the file and need a name: file.ts#SYSTEM_PROMPT. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|ya?ml|json)$/i;

function command(): string[] {
  const configured = vscode.workspace.getConfiguration("promptdiff").get<string>("command") ?? "npx --yes promptdiff";
  return configured.split(/\s+/).filter(Boolean);
}

function workspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
}

/** promptdiff: Open → the interactive app in a terminal. */
function openApp(): void {
  const folder = workspaceFolder(vscode.window.activeTextEditor?.document.uri);
  const terminal = vscode.window.createTerminal({ name: "promptdiff", cwd: folder?.uri.fsPath });
  terminal.show();
  terminal.sendText(command().join(" "));
}

/** The prompt name for a code file: the identifier under the cursor, or one the user types. */
async function promptName(editor: vscode.TextEditor): Promise<string | undefined> {
  const doc = editor.document;
  const range = doc.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][\w$.\-[\]]*/);
  const word = range ? doc.getText(range) : "";
  return vscode.window.showInputBox({
    title: "Which prompt in this file?",
    prompt: doc.fileName.match(/\.ya?ml$|\.json$/i) ? "Key path, e.g. support.system" : "Name of the constant holding the prompt, e.g. SYSTEM_PROMPT",
    value: word,
  });
}

/** promptdiff: Compare this prompt… → runs a comparison and shows the HTML report. */
async function compare(uri?: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const fileUri = uri ?? editor?.document.uri;
  if (!fileUri) {
    vscode.window.showWarningMessage("Open a prompt file first.");
    return;
  }
  const folder = workspaceFolder(fileUri);
  if (!folder) {
    vscode.window.showWarningMessage("Open the project folder first, so promptdiff can find its git history.");
    return;
  }
  let spec = path.relative(folder.uri.fsPath, fileUri.fsPath).split(path.sep).join("/");
  if (CODE_FILE.test(spec)) {
    if (!editor) return;
    const name = await promptName(editor);
    if (!name) return;
    spec = `${spec}#${name}`;
  }

  const base = await vscode.window.showQuickPick(
    [
      { label: "HEAD", description: "the last commit" },
      { label: "main", description: "the main branch" },
      { label: "approved", description: "the answers you approved (--snapshot)" },
      { label: "Other…", description: "a branch, tag, or commit" },
    ],
    { title: `Compare ${spec} with…` },
  );
  if (!base) return;
  let ref = base.label;
  if (ref === "Other…") {
    ref = (await vscode.window.showInputBox({ title: "Git ref to compare with", value: "HEAD~1" })) ?? "";
    if (!ref) return;
  }

  const report = path.join(os.tmpdir(), `promptdiff-${Date.now()}.html`);
  const [cmd, ...pre] = command();
  const args = [...pre, spec, "--yes", "--html", report, "--no-color", ...(ref === "approved" ? ["--snapshot"] : ["--base", ref])];

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `promptdiff: comparing ${spec}…`, cancellable: true },
    (_progress, token) =>
      new Promise<{ code: number; output: string }>((resolve) => {
        const child = execFile(cmd!, args, { cwd: folder.uri.fsPath, shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
          resolve({ code, output: `${stdout}\n${stderr}` });
        });
        token.onCancellationRequested(() => child.kill());
      }),
  );

  if (result.code === 1) {
    const channel = vscode.window.createOutputChannel("promptdiff");
    channel.append(result.output);
    channel.show();
    vscode.window.showErrorMessage("promptdiff couldn't compare this prompt. See the output for details.");
    return;
  }
  const panel = vscode.window.createWebviewPanel("promptdiff", `promptdiff: ${path.basename(spec)}`, vscode.ViewColumn.Beside, { enableScripts: true });
  try {
    panel.webview.html = readFileSync(report, "utf8");
  } catch {
    panel.webview.html = `<pre>${result.output.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("promptdiff.open", openApp),
    vscode.commands.registerCommand("promptdiff.compare", compare),
  );
}

export function deactivate(): void {}

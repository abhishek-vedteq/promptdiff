/**
 * Reads prompts that live in code, e.g. `export const SYSTEM_PROMPT = \`...\``.
 *
 * promptdiff never runs your code. It parses the file and interprets a small, safe subset of
 * JavaScript: strings, template literals, numbers, arrays, objects, constants from the same
 * file or from relative imports (including re-exports), and common string/array methods.
 * Anything else (function calls, runtime values) is reported with the exact location.
 */
import path from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { PromptdiffError } from "./errors.js";

/** File extensions treated as code that may export prompt constants. */
export const CODE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);

export const isCodeFile = (file: string) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());

/** Export names that look like prompts: anything containing "prompt" or "instruction". */
export const PROMPT_NAME = /prompt|instruction/i;

/** Reads a file by repo-relative POSIX path at some version; undefined if it doesn't exist there. */
export type SourceReader = (repoPath: string) => Promise<string | undefined>;

export interface EvaluatorOptions {
  /** Every file in the repo at this version (repo paths). Enables imports from workspace packages. */
  listFiles?: () => Promise<string[]>;
}

type Fn = { kind: "fn"; params: string[]; body: t.Expression | t.BlockStatement; scope: Scope; module: Module };
type Value = string | number | boolean | null | undefined | Value[] | { [key: string]: Value } | Fn;
type Scope = Map<string, Value>;

interface ImportBinding {
  from: string;
  /** "default", "*" (namespace), or a named export. */
  imported: string;
}

interface Module {
  path: string;
  source: string;
  /** Top-level `const`/`let`/`var` initializers by name. */
  bindings: Map<string, t.Expression>;
  /** Function and class declarations (can't be evaluated, but give better errors). */
  functions: Set<string>;
  imports: Map<string, ImportBinding>;
  /** exported name → local name */
  exports: Map<string, string>;
  /** `export { a as b } from "./x"` and `export * from "./x"` */
  reexports: { from: string; names?: Map<string, string> }[];
}

const isFn = (v: Value): v is Fn => typeof v === "object" && v !== null && !Array.isArray(v) && (v as Fn).kind === "fn";

const PARSER_PLUGINS = ["typescript", "jsx", "decorators", "explicitResourceManagement", "importAttributes"] as const;

function parseModule(repoPath: string, source: string): Module {
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: [...PARSER_PLUGINS] as never,
      errorRecovery: true,
      createParenthesizedExpressions: false,
    }) as unknown as t.File;
  } catch (err) {
    throw new PromptdiffError(`${repoPath}: couldn't parse this file (${(err as Error).message})`);
  }
  const mod: Module = { path: repoPath, source, bindings: new Map(), functions: new Set(), imports: new Map(), exports: new Map(), reexports: [] };

  const addDeclaration = (decl: t.Statement | t.Declaration, exported: boolean) => {
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        mod.bindings.set(d.id.name, d.init);
        if (exported) mod.exports.set(d.id.name, d.id.name);
      }
    } else if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
      mod.functions.add(decl.id.name);
      if (exported) mod.exports.set(decl.id.name, decl.id.name);
    }
  };

  for (const stmt of ast.program.body) {
    switch (stmt.type) {
      case "ImportDeclaration":
        if (stmt.importKind === "type") break;
        for (const s of stmt.specifiers) {
          if (s.type === "ImportSpecifier") {
            if (s.importKind === "type") continue;
            const imported = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
            mod.imports.set(s.local.name, { from: stmt.source.value, imported });
          } else if (s.type === "ImportDefaultSpecifier") {
            mod.imports.set(s.local.name, { from: stmt.source.value, imported: "default" });
          } else {
            mod.imports.set(s.local.name, { from: stmt.source.value, imported: "*" });
          }
        }
        break;
      case "ExportNamedDeclaration":
        if (stmt.exportKind === "type") break;
        if (stmt.declaration) {
          addDeclaration(stmt.declaration, true);
        } else if (stmt.source) {
          const names = new Map<string, string>();
          for (const s of stmt.specifiers) {
            if (s.type !== "ExportSpecifier") continue;
            const exported = s.exported.type === "Identifier" ? s.exported.name : s.exported.value;
            names.set(exported, s.local.type === "Identifier" ? s.local.name : s.local.value);
          }
          mod.reexports.push({ from: stmt.source.value, names });
        } else {
          for (const s of stmt.specifiers) {
            if (s.type !== "ExportSpecifier") continue;
            const exported = s.exported.type === "Identifier" ? s.exported.name : s.exported.value;
            mod.exports.set(exported, s.local.type === "Identifier" ? s.local.name : s.local.value);
          }
        }
        break;
      case "ExportAllDeclaration":
        if (stmt.exportKind !== "type") mod.reexports.push({ from: stmt.source.value });
        break;
      case "ExportDefaultDeclaration": {
        const d = stmt.declaration;
        if (d.type === "Identifier") mod.exports.set("default", d.name);
        else if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") {
          mod.functions.add("default");
          mod.exports.set("default", "default");
        }
        else if (d.type !== "TSInterfaceDeclaration" && d.type !== "TSDeclareFunction") {
          mod.bindings.set("default", d as t.Expression);
          mod.exports.set("default", "default");
        }
        break;
      }
      default:
        addDeclaration(stmt, false);
    }
  }
  return mod;
}

/** Names of exported constants in a file that look like prompts. Cheap: parses only. */
export function listPromptExports(repoPath: string, source: string): string[] {
  const mod = parseModule(repoPath, source);
  return [...mod.exports.keys()].filter((name) => {
    const local = mod.exports.get(name)!;
    const init = mod.bindings.get(local);
    if (!init || mod.functions.has(local) || !PROMPT_NAME.test(name)) return false;
    let e: t.Node = init;
    while (e.type === "TSAsExpression" || e.type === "TSSatisfiesExpression" || e.type === "ParenthesizedExpression") e = e.expression;
    if (["ArrowFunctionExpression", "FunctionExpression", "ClassExpression", "ObjectExpression", "NewExpression", "ArrayExpression"].includes(e.type)) return false;
    // `create(...)`, `buildPrompt(...)`: made by calling a function (hooks, stores, builders), not text.
    // Method calls like `[...].join("\n")` or `` `...`.trim() `` are fine.
    if (e.type === "CallExpression" && e.callee.type !== "MemberExpression") return false;
    return true;
  });
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Evaluates exported constants across a set of files read at one version. */
export class PromptEvaluator {
  private modules = new Map<string, Module>();
  /** Every file read while evaluating (so callers know what a prompt depends on). */
  readonly files = new Set<string>();
  private evaluating = new Set<string>();

  private packages?: Promise<Map<string, { dir: string; manifest: PackageManifest }>>;
  private tsconfigs = new Map<string, Promise<TsconfigPaths | undefined>>();

  constructor(
    private readonly read: SourceReader,
    private readonly options: EvaluatorOptions = {},
  ) {}

  /** Tries "base" as a file, with extensions, and as a directory with an index file. */
  private async tryFile(base: string): Promise<Module | undefined> {
    const ext = path.posix.extname(base);
    const stem = [".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? base.slice(0, -ext.length) : base;
    const candidates = [
      ...(RESOLVE_EXTENSIONS.includes(ext) ? [base] : []),
      ...RESOLVE_EXTENSIONS.map((e) => stem + e),
      ...RESOLVE_EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    for (const candidate of candidates) {
      const mod = await this.module(candidate);
      if (mod) return mod;
    }
    return undefined;
  }

  /** Workspace packages in the repo, by package name. */
  private workspacePackages() {
    this.packages ??= (async () => {
      const map = new Map<string, { dir: string; manifest: PackageManifest }>();
      const files = (await this.options.listFiles?.()) ?? [];
      for (const f of files) {
        if (!f.endsWith("package.json") || f.includes("node_modules/")) continue;
        try {
          const manifest = JSON.parse((await this.read(f)) ?? "{}") as PackageManifest;
          if (manifest.name) map.set(manifest.name, { dir: path.posix.dirname(f), manifest });
        } catch {
          // ignore unreadable manifests
        }
      }
      return map;
    })();
    return this.packages;
  }

  /** "paths" from the nearest tsconfig.json above a file (e.g. "@/*": ["./src/*"]). */
  private nearestTsconfig(fromDir: string): Promise<TsconfigPaths | undefined> {
    let cached = this.tsconfigs.get(fromDir);
    if (!cached) {
      cached = (async () => {
        const file = fromDir === "." || fromDir === "" ? "tsconfig.json" : `${fromDir}/tsconfig.json`;
        const text = await this.read(file);
        if (text !== undefined) {
          try {
            const json = JSON.parse(stripJsonComments(text)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
            const opts = json.compilerOptions ?? {};
            if (opts.paths) return { dir: path.posix.join(fromDir, opts.baseUrl ?? "."), paths: opts.paths };
          } catch {
            // keep looking upward
          }
        }
        if (fromDir === "." || fromDir === "") return undefined;
        const parent = path.posix.dirname(fromDir);
        return this.nearestTsconfig(parent === fromDir ? "." : parent);
      })();
      this.tsconfigs.set(fromDir, cached);
    }
    return cached;
  }

  /** Resolves a non-relative import: tsconfig path aliases first, then workspace packages. */
  private async resolveBare(from: Module, spec: string): Promise<Module | undefined> {
    const ts = await this.nearestTsconfig(path.posix.dirname(from.path));
    if (ts) {
      for (const [pattern, targets] of Object.entries(ts.paths)) {
        const star = pattern.indexOf("*");
        const matches = star >= 0 ? spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) : spec === pattern;
        if (!matches) continue;
        const captured = star >= 0 ? spec.slice(star, spec.length - (pattern.length - star - 1)) : "";
        for (const target of targets) {
          const mod = await this.tryFile(path.posix.normalize(path.posix.join(ts.dir, target.replace("*", captured))));
          if (mod) return mod;
        }
      }
    }
    const packages = await this.workspacePackages();
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    const pkg = packages.get(name);
    if (!pkg) return undefined;
    const subpath = spec.slice(name.length) || ".";
    const exportKey = subpath === "." ? "." : `.${subpath}`;
    const entries = [...entryPoints(pkg.manifest, exportKey), ...(subpath === "." ? ["src/index", "index"] : [`src${subpath}`, subpath.slice(1)])];
    for (const entry of entries) {
      const mod = await this.tryFile(path.posix.normalize(path.posix.join(pkg.dir, entry)));
      if (mod) return mod;
    }
    return undefined;
  }

  async module(repoPath: string): Promise<Module | undefined> {
    const cached = this.modules.get(repoPath);
    if (cached) return cached;
    const source = await this.read(repoPath);
    if (source === undefined) return undefined;
    this.files.add(repoPath);
    const mod = parseModule(repoPath, source);
    this.modules.set(repoPath, mod);
    return mod;
  }

  /** Resolves an import ("./shared", "../../llm", "@/lib/x", "@acme/types") to a module in the repo. */
  private async resolveImport(from: Module, spec: string): Promise<Module> {
    const mod = spec.startsWith(".")
      ? await this.tryFile(path.posix.normalize(path.posix.join(path.posix.dirname(from.path), spec)))
      : await this.resolveBare(from, spec);
    if (mod) return mod;
    if (!spec.startsWith(".")) {
      throw new PromptdiffError(`${from.path}: the prompt uses something imported from "${spec}", which isn't a file in this repo`, {
        hint: "promptdiff follows relative imports, tsconfig path aliases, and packages in the same repo (workspaces), but not installed npm packages.",
      });
    }
    throw new PromptdiffError(`${from.path}: couldn't find the file for import "${spec}"`);
  }

  /** Evaluates an exported (or top-level) name of a module to a value. */
  async exported(mod: Module, name: string, seen = new Set<string>()): Promise<Value> {
    const key = `${mod.path}#${name}`;
    if (seen.has(key)) throw new PromptdiffError(`${mod.path}: "${name}" is re-exported in a loop`);
    seen.add(key);

    const local = mod.exports.get(name);
    if (local !== undefined) return this.binding(mod, local);
    for (const re of mod.reexports) {
      if (re.names && !re.names.has(name)) continue;
      const target = await this.resolveImport(mod, re.from);
      if (re.names) return this.exported(target, re.names.get(name)!, seen);
      if (target.exports.has(name) || target.reexports.length) {
        try {
          return await this.exported(target, name, seen);
        } catch (err) {
          if (!(err instanceof NotExported)) throw err;
        }
      }
    }
    throw new NotExported(mod.path, name);
  }

  /** Evaluates a top-level binding (local const, or an import) of a module. */
  private async binding(mod: Module, name: string): Promise<Value> {
    const init = mod.bindings.get(name);
    if (init) {
      const key = `${mod.path}#${name}`;
      if (this.evaluating.has(key)) throw new PromptdiffError(`${mod.path}: "${name}" refers to itself`);
      this.evaluating.add(key);
      try {
        return await this.eval(init, mod, new Map());
      } finally {
        this.evaluating.delete(key);
      }
    }
    const imp = mod.imports.get(name);
    if (imp) {
      const target = await this.resolveImport(mod, imp.from);
      if (imp.imported === "*") {
        const ns: { [key: string]: Value } = {};
        for (const exported of target.exports.keys()) ns[exported] = await this.exported(target, exported);
        return ns;
      }
      return this.exported(target, imp.imported);
    }
    if (mod.functions.has(name)) throw new CantEvaluate(mod, undefined, `"${name}" is a function or class, so its value is only known at runtime`);
    throw new CantEvaluate(mod, undefined, `"${name}" isn't defined at the top level of this file`);
  }

  private async eval(node: t.Node, mod: Module, scope: Scope): Promise<Value> {
    switch (node.type) {
      case "StringLiteral":
        return node.value;
      case "NumericLiteral":
        return node.value;
      case "BooleanLiteral":
        return node.value;
      case "NullLiteral":
        return null;
      case "TemplateLiteral": {
        let out = "";
        for (let i = 0; i < node.quasis.length; i++) {
          out += node.quasis[i]!.value.cooked ?? node.quasis[i]!.value.raw;
          const expr = node.expressions[i];
          if (expr) out += this.stringify(await this.eval(expr, mod, scope), expr, mod);
        }
        return out;
      }
      case "TaggedTemplateExpression": {
        const tag = node.tag.type === "Identifier" ? node.tag.name : node.tag.type === "MemberExpression" && node.tag.property.type === "Identifier" ? node.tag.property.name : "";
        const text = (await this.eval(node.quasi, mod, scope)) as string;
        if (["dedent", "outdent", "stripIndent", "stripIndents"].includes(tag)) return dedent(text);
        if (tag === "raw") return node.quasi.quasis.map((q) => q.value.raw).join("");
        throw new CantEvaluate(mod, node, `the template tag "${tag}" isn't supported (supported: dedent, outdent, stripIndent, String.raw)`);
      }
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "ParenthesizedExpression":
        return this.eval(node.expression, mod, scope);
      case "Identifier":
        if (scope.has(node.name)) return scope.get(node.name);
        if (node.name === "undefined") return undefined;
        return this.binding(mod, node.name);
      case "ArrayExpression": {
        const out: Value[] = [];
        for (const el of node.elements) {
          if (!el) continue;
          if (el.type === "SpreadElement") {
            const v = await this.eval(el.argument, mod, scope);
            if (!Array.isArray(v)) throw new CantEvaluate(mod, el, "only arrays can be spread into an array");
            out.push(...v);
          } else out.push(await this.eval(el, mod, scope));
        }
        return out;
      }
      case "ObjectExpression": {
        const out: { [key: string]: Value } = {};
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            Object.assign(out, await this.eval(p.argument, mod, scope));
          } else if (p.type === "ObjectProperty") {
            const key = p.computed ? String(await this.eval(p.key, mod, scope)) : p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" || p.key.type === "NumericLiteral" ? String(p.key.value) : undefined;
            if (key === undefined) throw new CantEvaluate(mod, p, "unsupported object key");
            out[key] = await this.eval(p.value, mod, scope);
          }
          // methods are skipped: they can't contribute text
        }
        return out;
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateName") throw new CantEvaluate(mod, node, "unsupported expression");
        const a = await this.eval(node.left, mod, scope);
        const b = await this.eval(node.right, mod, scope);
        if (node.operator === "in") {
          if (typeof b !== "object" || b === null || isFn(b)) throw new CantEvaluate(mod, node, '"in" needs an object');
          return String(a) in (b as object);
        }
        switch (node.operator) {
          case "+":
            if (typeof a === "number" && typeof b === "number") return a + b;
            return this.stringify(a, node.left, mod) + this.stringify(b, node.right, mod);
          case "-":
          case "*":
          case "/":
          case "%":
            if (typeof a !== "number" || typeof b !== "number") throw new CantEvaluate(mod, node, `"${node.operator}" needs numbers`);
            return node.operator === "-" ? a - b : node.operator === "*" ? a * b : node.operator === "/" ? a / b : a % b;
          case "===":
          case "==":
            return a === b;
          case "!==":
          case "!=":
            return a !== b;
          case ">":
            return (a as number) > (b as number);
          case "<":
            return (a as number) < (b as number);
          case ">=":
            return (a as number) >= (b as number);
          case "<=":
            return (a as number) <= (b as number);
          default:
            throw new CantEvaluate(mod, node, `the "${node.operator}" operator isn't supported`);
        }
      }
      case "LogicalExpression": {
        const a = await this.eval(node.left, mod, scope);
        if (node.operator === "??") return a ?? this.eval(node.right, mod, scope);
        if (node.operator === "||") return a || this.eval(node.right, mod, scope);
        return a && this.eval(node.right, mod, scope);
      }
      case "ConditionalExpression":
        return (await this.eval(node.test, mod, scope)) ? this.eval(node.consequent, mod, scope) : this.eval(node.alternate, mod, scope);
      case "UnaryExpression": {
        const v = await this.eval(node.argument, mod, scope);
        if (node.operator === "!") return !v;
        if (node.operator === "-" && typeof v === "number") return -v;
        if (node.operator === "+" && typeof v === "number") return v;
        throw new CantEvaluate(mod, node, `the "${node.operator}" operator isn't supported`);
      }
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const obj = await this.eval(node.object, mod, scope);
        const key = node.computed ? await this.eval(node.property, mod, scope) : node.property.type === "Identifier" ? node.property.name : undefined;
        if (key === undefined || isFn(obj)) throw new CantEvaluate(mod, node, "unsupported property access");
        if (obj === null || obj === undefined) {
          if (node.type === "OptionalMemberExpression" || (node as { optional?: boolean }).optional) return undefined;
          throw new CantEvaluate(mod, node, "reads a property of a missing value");
        }
        if (key === "length" && (typeof obj === "string" || Array.isArray(obj))) return obj.length;
        if (typeof obj === "string" && typeof key === "number") return obj[key];
        if (Array.isArray(obj) && typeof key === "number") return obj[key];
        if (typeof obj === "object" && !Array.isArray(obj)) return (obj as { [k: string]: Value })[String(key)];
        throw new CantEvaluate(mod, node, `"${String(key)}" can't be read here`);
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        const params = node.params.map((p) => (p.type === "Identifier" ? p.name : ""));
        if (params.includes("")) throw new CantEvaluate(mod, node, "only simple function parameters are supported");
        return { kind: "fn", params, body: node.body, scope, module: mod };
      }
      case "CallExpression":
      case "OptionalCallExpression":
        return this.call(node, mod, scope);
      default:
        throw new CantEvaluate(mod, node, "this kind of expression can't be read without running the code");
    }
  }

  private async apply(fn: Value, args: Value[], node: t.Node, mod: Module): Promise<Value> {
    if (!isFn(fn)) throw new CantEvaluate(mod, node, "expected a function here");
    const scope: Scope = new Map(fn.scope);
    fn.params.forEach((p, i) => scope.set(p, args[i]));
    if (fn.body.type !== "BlockStatement") return this.eval(fn.body, fn.module, scope);
    const result = await this.run(fn.body.body, fn.module, scope);
    return result?.value;
  }

  /**
   * Runs a callback body: `const`/`let` declarations, `if (…) return …`, and `return …`.
   * Returns { value } when a return statement is reached.
   */
  private async run(statements: t.Statement[], mod: Module, scope: Scope): Promise<{ value: Value } | undefined> {
    for (const st of statements) {
      switch (st.type) {
        case "VariableDeclaration":
          for (const d of st.declarations) {
            if (d.id.type !== "Identifier") throw new CantEvaluate(mod, d, "only simple variable names are supported");
            scope.set(d.id.name, d.init ? await this.eval(d.init, mod, scope) : undefined);
          }
          break;
        case "ReturnStatement":
          return { value: st.argument ? await this.eval(st.argument, mod, scope) : undefined };
        case "IfStatement": {
          const branch = (await this.eval(st.test, mod, scope)) ? st.consequent : st.alternate;
          if (branch) {
            const r = await this.run(branch.type === "BlockStatement" ? branch.body : [branch], mod, new Map(scope));
            if (r) return r;
          }
          break;
        }
        case "EmptyStatement":
          break;
        default:
          throw new CantEvaluate(mod, st, "only const declarations, if, and return are supported inside functions");
      }
    }
    return undefined;
  }

  private async call(node: t.CallExpression | t.OptionalCallExpression, mod: Module, scope: Scope): Promise<Value> {
    const args = async () => {
      const out: Value[] = [];
      for (const a of node.arguments) {
        if (a.type === "SpreadElement" || a.type === "ArgumentPlaceholder") throw new CantEvaluate(mod, a, "unsupported argument");
        out.push(await this.eval(a, mod, scope));
      }
      return out;
    };
    const callee = node.callee;

    // String(x), Number(x), JSON.stringify(x, null, 2), Object.keys/values/entries(x)
    if (callee.type === "Identifier" && (callee.name === "String" || callee.name === "Number") && !scope.has(callee.name)) {
      const [v] = await args();
      return callee.name === "String" ? this.stringify(v, node, mod) : Number(v);
    }
    if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && callee.object.type === "Identifier" && callee.property.type === "Identifier") {
      const ns = callee.object.name;
      const fnName = callee.property.name;
      if (ns === "JSON" && fnName === "stringify") {
        const [v, , indent] = await args();
        return JSON.stringify(v, null, indent as number | undefined);
      }
      if (ns === "Object" && (fnName === "keys" || fnName === "values" || fnName === "entries")) {
        const [v] = await args();
        const o = (v ?? {}) as { [k: string]: Value };
        return fnName === "keys" ? Object.keys(o) : fnName === "values" ? Object.values(o) : Object.entries(o);
      }
    }

    if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") {
      const name = callee.type === "Identifier" ? callee.name : "this function";
      throw new CantEvaluate(mod, node, `calls ${name}(), which promptdiff can't run`);
    }
    const method = callee.computed ? undefined : callee.property.type === "Identifier" ? callee.property.name : undefined;
    const target = await this.eval(callee.object, mod, scope);
    if (!method) throw new CantEvaluate(mod, node, "unsupported method call");

    if (typeof target === "string") {
      const a = await args();
      const s = (i: number) => (a[i] === undefined ? undefined : String(a[i]));
      switch (method) {
        case "trim": return target.trim();
        case "trimStart": return target.trimStart();
        case "trimEnd": return target.trimEnd();
        case "toUpperCase": return target.toUpperCase();
        case "toLowerCase": return target.toLowerCase();
        case "replace": return target.replace(s(0)!, s(1)!);
        case "replaceAll": return target.replaceAll(s(0)!, s(1)!);
        case "split": return target.split(s(0)!);
        case "slice": return target.slice(a[0] as number | undefined, a[1] as number | undefined);
        case "repeat": return target.repeat(a[0] as number);
        case "padStart": return target.padStart(a[0] as number, s(1));
        case "padEnd": return target.padEnd(a[0] as number, s(1));
        case "concat": return target.concat(...a.map((v) => this.stringify(v, node, mod)));
        case "includes": return target.includes(s(0)!);
        case "startsWith": return target.startsWith(s(0)!);
        case "endsWith": return target.endsWith(s(0)!);
      }
    }
    if (Array.isArray(target)) {
      switch (method) {
        case "join": {
          const [sep] = await args();
          return target.map((v) => (v === null || v === undefined ? "" : this.stringify(v, node, mod))).join(sep === undefined ? "," : String(sep));
        }
        case "map":
        case "filter":
        case "flatMap": {
          const [fn] = await args();
          const out: Value[] = [];
          for (let i = 0; i < target.length; i++) {
            const r = await this.apply(fn, [target[i], i], node, mod);
            if (method === "map") out.push(r);
            else if (method === "filter") {
              if (r) out.push(target[i]);
            } else out.push(...(Array.isArray(r) ? r : [r]));
          }
          return out;
        }
        case "slice": {
          const a = await args();
          return target.slice(a[0] as number | undefined, a[1] as number | undefined);
        }
        case "concat": {
          const a = await args();
          return target.concat(...a.flat());
        }
        case "flat": return target.flat() as Value[];
        case "includes": return target.includes((await args())[0]);
        case "reverse": return [...target].reverse();
        case "sort": return [...target].sort();
      }
    }
    throw new CantEvaluate(mod, node, `.${method}() isn't supported here`);
  }

  private stringify(v: Value, node: t.Node, mod: Module): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
    if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? "" : this.stringify(x, node, mod))).join(",");
    throw new CantEvaluate(mod, node, "an object or function can't be turned into text here");
  }
}

interface PackageManifest {
  name?: string;
  main?: string;
  module?: string;
  source?: string;
  exports?: unknown;
}

interface TsconfigPaths {
  /** Directory the paths are relative to (repo path). */
  dir: string;
  paths: Record<string, string[]>;
}

/** Candidate entry files for a package export, preferring source over built output and types. */
function entryPoints(manifest: PackageManifest, key: string): string[] {
  const out: string[] = [];
  const pick = (target: unknown) => {
    if (typeof target === "string") out.push(target);
    else if (target && typeof target === "object") {
      const t = target as Record<string, unknown>;
      for (const cond of ["source", "development", "import", "default", "require", "node", "types"]) if (cond in t) pick(t[cond]);
    }
  };
  const exp = manifest.exports;
  if (typeof exp === "string" && key === ".") pick(exp);
  else if (exp && typeof exp === "object") {
    const map = exp as Record<string, unknown>;
    if (key in map) pick(map[key]);
    else if (key === "." && !Object.keys(map).some((k) => k.startsWith("."))) pick(map);
  }
  if (key === ".") for (const f of [manifest.source, manifest.module, manifest.main]) if (f) out.push(f);
  return out.filter((f) => !f.endsWith(".d.ts"));
}

/** Removes // and /* *\/ comments and trailing commas from JSON (tsconfig files allow them). */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

class NotExported extends PromptdiffError {
  constructor(file: string, name: string) {
    super(`${file} doesn't export "${name}"`);
  }
}

class CantEvaluate extends PromptdiffError {
  constructor(mod: Module, node: t.Node | undefined, reason: string) {
    const line = node?.loc?.start.line;
    const snippet = node?.start != null && node.end != null ? mod.source.slice(node.start, node.end).replace(/\s+/g, " ").slice(0, 80) : "";
    super(`${mod.path}${line ? `:${line}` : ""}: can't read the prompt here${snippet ? ` (\`${snippet}\`)` : ""}: ${reason}.`, {
      hint: [
        "promptdiff reads prompts without running your code, so it can follow constants, relative imports,",
        "template literals, and simple string building (+, .join, .map, .trim…), but not values computed at runtime.",
        "Keep runtime values (user data, dates) out of the system prompt and put them in the test case input instead.",
      ].join("\n"),
    });
  }
}

/** Removes common leading indentation, plus a leading and trailing blank line (like the `dedent` package). */
export function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").replace(/\n[ \t]*$/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

export interface ExtractedPrompt {
  text: string;
  /** Repo paths of every file the prompt was built from. */
  files: string[];
}

/** Reads the exported constant `name` from `repoPath` at one version, as text. */
export async function extractPrompt(repoPath: string, name: string, read: SourceReader, options: EvaluatorOptions = {}): Promise<ExtractedPrompt> {
  const evaluator = new PromptEvaluator(read, options);
  const mod = await evaluator.module(repoPath);
  if (!mod) throw new PromptdiffError(`File not found: ${repoPath}`);
  let value: Value;
  try {
    value = await evaluator.exported(mod, name);
  } catch (err) {
    if (err instanceof NotExported && err.message.startsWith(`${repoPath} `)) {
      const candidates = listPromptExports(repoPath, mod.source);
      throw new PromptdiffError(`${repoPath} doesn't export "${name}".`, {
        hint: candidates.length ? `Prompt-like exports in this file: ${candidates.join(", ")}` : "Export the prompt, e.g. export const SYSTEM_PROMPT = `...`",
      });
    }
    throw err;
  }
  if (typeof value !== "string") {
    throw new PromptdiffError(`${repoPath}#${name} isn't text (it's ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}).`, {
      hint: "Point promptdiff at a string constant, e.g. a template literal holding the system prompt.",
    });
  }
  return { text: value, files: [...evaluator.files] };
}

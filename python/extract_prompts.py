"""
promptdiff's reader for prompts that live in Python code.

Never runs the project's code. It parses files with Python's own `ast` module and interprets a
small, safe subset: strings (including f-strings and triple quotes), numbers, lists, tuples, dicts,
constants from the same file or from imports inside the repo, comprehensions, and common string
methods. Anything else is reported with the file, line, and code.

Protocol: reads one JSON request on stdin, writes one JSON response on stdout.
  {"mode": "list", "files": [{"path": ..., "source": ...}]}
      -> {"names": {path: [name, ...]}, "errors": {path: message}}
  {"mode": "extract", "repoRoot": ..., "ref": <git ref or null for the working copy>,
   "items": [{"file": repo/path.py, "name": "NAME" or "Class.NAME"}]}
      -> {"results": [{"text": ..., "files": [...]} or {"error": ..., "hint": ...}]}
"""

import ast
import inspect
import json
import os
import re
import subprocess
import sys
import textwrap

PROMPT_NAME = re.compile(r"prompt|instruction", re.IGNORECASE)

# Calls that build text from text, and are safe to evaluate.
TEXT_FUNCTIONS = {"dedent", "cleandoc", "str", "len", "sorted", "list", "tuple", "int", "float", "repr", "reversed", "enumerate", "zip", "range"}
STR_METHODS = {
    "strip", "lstrip", "rstrip", "upper", "lower", "title", "capitalize", "casefold", "replace", "format",
    "join", "split", "splitlines", "removeprefix", "removesuffix", "startswith", "endswith", "zfill",
    "center", "ljust", "rjust", "expandtabs", "count", "find", "swapcase",
}
DICT_METHODS = {"get", "keys", "values", "items"}
LIST_METHODS = {"index", "count"}
SAFE_TYPES = (str, int, float, bool, type(None), list, tuple, dict, set, frozenset)

HINT = (
    "promptdiff reads prompts without running your code, so it can follow constants, imports inside the repo,\n"
    "f-strings, and simple string building (+, .join, .format, .strip, comprehensions...), but not values computed at runtime.\n"
    "Keep runtime values (user data, dates) out of the system prompt and put them in the test case input instead."
)


class CantRead(Exception):
    def __init__(self, path, node, reason, source=None):
        line = getattr(node, "lineno", None)
        snippet = ""
        if source is not None and node is not None:
            try:
                snippet = " ".join((ast.get_source_segment(source, node) or "").split())[:80]
            except Exception:
                snippet = ""
        where = f"{path}:{line}" if line else path
        super().__init__(f"{where}: can't read the prompt here{f' (`{snippet}`)' if snippet else ''}: {reason}.")


class Fn:
    """A lambda, usable only as a key/map callback."""

    def __init__(self, node, scope, module):
        self.node, self.scope, self.module = node, scope, module


class Repo:
    def __init__(self, root, ref):
        self.root, self.ref = root, ref
        self.cache = {}

    def read(self, path):
        if path in self.cache:
            return self.cache[path]
        text = None
        if self.ref:
            try:
                out = subprocess.run(["git", "show", f"{self.ref}:{path}"], cwd=self.root, capture_output=True)
                if out.returncode == 0:
                    text = out.stdout.decode("utf-8")
            except OSError:
                text = None
        else:
            try:
                with open(os.path.join(self.root, *path.split("/")), encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                text = None
        self.cache[path] = text
        return text


class Module:
    def __init__(self, path, source):
        self.path, self.source = path, source
        self.tree = ast.parse(source, filename=path)
        self.bindings = {}  # name -> value node
        self.classes = {}  # name -> ClassDef
        self.functions = set()
        self.imports = {}  # local name -> (module, level, imported name or None for "import x")
        self.star_imports = []  # (module, level)
        for st in self.tree.body:
            self._collect(st)

    def _collect(self, st):
        if isinstance(st, ast.Assign):
            for target in st.targets:
                if isinstance(target, ast.Name):
                    self.bindings[target.id] = st.value
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
            self.bindings[st.target.id] = st.value
        elif isinstance(st, ast.ClassDef):
            self.classes[st.name] = st
        elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.functions.add(st.name)
        elif isinstance(st, ast.ImportFrom):
            for alias in st.names:
                if alias.name == "*":
                    self.star_imports.append((st.module or "", st.level))
                else:
                    self.imports[alias.asname or alias.name] = (st.module or "", st.level, alias.name)
        elif isinstance(st, ast.Import):
            for alias in st.names:
                local = alias.asname or alias.name.split(".")[0]
                self.imports[local] = (alias.asname and alias.name or alias.name.split(".")[0], 0, None)
        elif isinstance(st, (ast.If, ast.Try)):
            # e.g. `if TYPE_CHECKING:` / try-except imports: collect from all branches
            for block in [getattr(st, "body", []), getattr(st, "orelse", []), getattr(st, "finalbody", [])]:
                for inner in block:
                    self._collect(inner)
            for handler in getattr(st, "handlers", []):
                for inner in handler.body:
                    self._collect(inner)


class Namespace:
    """An imported module (`import app.prompts as p`), for attribute access."""

    def __init__(self, module):
        self.module = module


class Evaluator:
    def __init__(self, repo):
        self.repo = repo
        self.modules = {}
        self.files = []
        self.active = set()

    def module(self, path):
        if path in self.modules:
            return self.modules[path]
        source = self.repo.read(path)
        if source is None:
            self.modules[path] = None
            return None
        try:
            mod = Module(path, source)
        except SyntaxError as e:
            raise CantRead(path, None, f"couldn't parse this file ({e.msg}, line {e.lineno})")
        self.modules[path] = mod
        self.files.append(path)
        return mod

    def resolve(self, from_mod, module_name, level, node):
        """Finds the file for `from <module_name> import ...` (level = number of leading dots)."""
        parts = [p for p in module_name.split(".") if p]
        here = from_mod.path.split("/")[:-1]
        if level:
            base = here[: len(here) - (level - 1)] if level > 1 else here
            roots = [base]
        else:
            # Absolute import: try the repo root, src/, and every folder above this file.
            roots = [[], ["src"]] + [here[:i] for i in range(len(here), 0, -1)]
        for root in roots:
            stem = "/".join(root + parts)
            for candidate in ([f"{stem}.py", f"{stem}/__init__.py"] if parts else [f"{stem}/__init__.py" if stem else "__init__.py"]):
                candidate = candidate.lstrip("/")
                mod = self.module(candidate)
                if mod is not None:
                    return mod
        dots = "." * level
        raise CantRead(
            from_mod.path,
            node,
            f'it uses something imported from "{dots}{module_name}", which isn\'t a file in this repo '
            "(promptdiff follows imports inside the repo, not installed packages)",
            from_mod.source,
        )

    # ── names ──────────────────────────────────────────────────────────────

    def lookup(self, mod, name, node, seen=None):
        """Value of a top-level name in a module (own assignment, import, or star import)."""
        seen = seen or set()
        key = (mod.path, name)
        if key in seen:
            raise CantRead(mod.path, node, f'"{name}" is imported in a loop', mod.source)
        seen.add(key)
        if name in mod.bindings:
            if key in self.active:
                raise CantRead(mod.path, node, f'"{name}" refers to itself', mod.source)
            self.active.add(key)
            try:
                return self.eval(mod.bindings[name], mod, {})
            finally:
                self.active.discard(key)
        if name in mod.imports:
            module_name, level, imported = mod.imports[name]
            if imported is None:
                return Namespace(self.resolve(mod, module_name, level, node))
            target = self.resolve_from(mod, module_name, level, imported, node)
            if isinstance(target, Namespace):
                return target
            return self.lookup(target, imported, node, seen)
        for module_name, level in mod.star_imports:
            target = self.resolve(mod, module_name, level, node)
            if name in target.bindings or name in target.imports or target.star_imports:
                try:
                    return self.lookup(target, name, node, seen)
                except CantRead:
                    continue
        if name in mod.classes:
            return ClassRef(mod, name)
        if name in mod.functions:
            raise CantRead(mod.path, node, f'"{name}" is a function, so its value is only known at runtime', mod.source)
        raise CantRead(mod.path, node, f'"{name}" isn\'t defined at the top level of this file', mod.source)

    def resolve_from(self, mod, module_name, level, imported, node):
        """`from pkg import name`: name may be a submodule (pkg/name.py) or a value in pkg."""
        target = self.resolve(mod, module_name, level, node)
        if imported not in target.bindings and imported not in target.imports:
            sub = self.try_submodule(target, imported)
            if sub is not None:
                return Namespace(sub)
        return target

    def try_submodule(self, package, name):
        if not package.path.endswith("__init__.py"):
            return None
        base = package.path[: -len("__init__.py")]
        for candidate in (f"{base}{name}.py", f"{base}{name}/__init__.py"):
            mod = self.module(candidate)
            if mod is not None:
                return mod
        return None

    def class_attr(self, mod, class_name, attr, node):
        cls = mod.classes.get(class_name)
        if cls is None:
            raise CantRead(mod.path, node, f'there\'s no class "{class_name}" here', mod.source)
        scope = {}
        for st in cls.body:
            targets = st.targets if isinstance(st, ast.Assign) else [st.target] if isinstance(st, ast.AnnAssign) and st.value is not None else []
            for t in targets:
                if isinstance(t, ast.Name):
                    scope[t.id] = st.value
        if attr not in scope:
            raise CantRead(mod.path, node, f'class "{class_name}" has no attribute "{attr}"', mod.source)
        values = {}
        for name, value_node in scope.items():
            if name == attr:
                return self.eval(value_node, mod, values)
            try:
                values[name] = self.eval(value_node, mod, values)
            except CantRead:
                pass
        raise CantRead(mod.path, node, f'"{attr}" couldn\'t be read', mod.source)

    # ── expressions ────────────────────────────────────────────────────────

    def fail(self, mod, node, reason):
        raise CantRead(mod.path, node, reason, mod.source)

    def eval(self, node, mod, scope):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (str, int, float, bool, type(None))):
                return node.value
            self.fail(mod, node, "only text, numbers, and booleans are supported")
        if isinstance(node, ast.JoinedStr):
            out = []
            for part in node.values:
                if isinstance(part, ast.Constant):
                    out.append(part.value)
                elif isinstance(part, ast.FormattedValue):
                    value = self.eval(part.value, mod, scope)
                    if part.conversion == ord("r"):
                        value = repr(value)
                    elif part.conversion == ord("s"):
                        value = str(value)
                    elif part.conversion == ord("a"):
                        value = ascii(value)
                    spec = self.eval(part.format_spec, mod, scope) if part.format_spec is not None else ""
                    out.append(format(value, spec))
            return "".join(out)
        if isinstance(node, ast.Name):
            if node.id in scope:
                return scope[node.id]
            if node.id in ("True", "False", "None"):
                return {"True": True, "False": False, "None": None}[node.id]
            return self.lookup(mod, node.id, node)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            items = []
            for el in node.elts:
                if isinstance(el, ast.Starred):
                    items.extend(self.eval(el.value, mod, scope))
                else:
                    items.append(self.eval(el, mod, scope))
            return items if isinstance(node, ast.List) else tuple(items) if isinstance(node, ast.Tuple) else set(items)
        if isinstance(node, ast.Dict):
            out = {}
            for k, v in zip(node.keys, node.values):
                if k is None:
                    out.update(self.eval(v, mod, scope))
                else:
                    out[self.eval(k, mod, scope)] = self.eval(v, mod, scope)
            return out
        if isinstance(node, ast.BinOp):
            a, b = self.eval(node.left, mod, scope), self.eval(node.right, mod, scope)
            self.check(a, mod, node)
            self.check(b, mod, node)
            ops = {ast.Add: lambda: a + b, ast.Sub: lambda: a - b, ast.Mult: lambda: a * b, ast.Mod: lambda: a % b, ast.Div: lambda: a / b, ast.FloorDiv: lambda: a // b}
            op = ops.get(type(node.op))
            if op is None:
                self.fail(mod, node, "this operator isn't supported")
            if isinstance(node.op, ast.Mult) and (isinstance(a, (str, list)) or isinstance(b, (str, list))) and max(len(a) if isinstance(a, (str, list)) else 0, len(b) if isinstance(b, (str, list)) else 0) * (b if isinstance(b, int) else a if isinstance(a, int) else 1) > 10_000_000:
                self.fail(mod, node, "the result would be too large")
            try:
                return op()
            except Exception as e:
                self.fail(mod, node, f"evaluating this failed ({e})")
        if isinstance(node, ast.UnaryOp):
            v = self.eval(node.operand, mod, scope)
            if isinstance(node.op, ast.Not):
                return not v
            if isinstance(node.op, ast.USub) and isinstance(v, (int, float)):
                return -v
            if isinstance(node.op, ast.UAdd) and isinstance(v, (int, float)):
                return v
            self.fail(mod, node, "this operator isn't supported")
        if isinstance(node, ast.BoolOp):
            value = None
            for v in node.values:
                value = self.eval(v, mod, scope)
                if isinstance(node.op, ast.And) and not value:
                    return value
                if isinstance(node.op, ast.Or) and value:
                    return value
            return value
        if isinstance(node, ast.Compare):
            left = self.eval(node.left, mod, scope)
            for op, right_node in zip(node.ops, node.comparators):
                right = self.eval(right_node, mod, scope)
                fns = {ast.Eq: lambda: left == right, ast.NotEq: lambda: left != right, ast.Lt: lambda: left < right, ast.LtE: lambda: left <= right,
                       ast.Gt: lambda: left > right, ast.GtE: lambda: left >= right, ast.In: lambda: left in right, ast.NotIn: lambda: left not in right,
                       ast.Is: lambda: left is right, ast.IsNot: lambda: left is not right}
                if type(op) not in fns or not fns[type(op)]():
                    return False
                left = right
            return True
        if isinstance(node, ast.IfExp):
            return self.eval(node.body if self.eval(node.test, mod, scope) else node.orelse, mod, scope)
        if isinstance(node, ast.Subscript):
            value = self.eval(node.value, mod, scope)
            if isinstance(node.slice, ast.Slice):
                lo = self.eval(node.slice.lower, mod, scope) if node.slice.lower else None
                hi = self.eval(node.slice.upper, mod, scope) if node.slice.upper else None
                step = self.eval(node.slice.step, mod, scope) if node.slice.step else None
                return value[lo:hi:step]
            key = self.eval(node.slice, mod, scope)
            try:
                return value[key]
            except Exception as e:
                self.fail(mod, node, f"this lookup failed ({e!r})")
        if isinstance(node, ast.Attribute):
            value = self.eval(node.value, mod, scope)
            if isinstance(value, Namespace):
                sub = self.try_submodule(value.module, node.attr)
                if sub is not None and node.attr not in value.module.bindings:
                    return Namespace(sub)
                return self.lookup(value.module, node.attr, node)
            if isinstance(value, ClassRef):
                return self.class_attr(value.module, value.name, node.attr, node)
            self.fail(mod, node, f'".{node.attr}" can\'t be read here')
        if isinstance(node, (ast.ListComp, ast.GeneratorExp, ast.SetComp)):
            items = self.comprehension(node.generators, mod, scope, lambda s: self.eval(node.elt, mod, s))
            return set(items) if isinstance(node, ast.SetComp) else items
        if isinstance(node, ast.DictComp):
            pairs = self.comprehension(node.generators, mod, scope, lambda s: (self.eval(node.key, mod, s), self.eval(node.value, mod, s)))
            return dict(pairs)
        if isinstance(node, ast.Lambda):
            return Fn(node, scope, mod)
        if isinstance(node, ast.Call):
            return self.call(node, mod, scope)
        self.fail(mod, node, "this kind of expression can't be read without running the code")

    def check(self, value, mod, node):
        if not isinstance(value, SAFE_TYPES):
            self.fail(mod, node, "this value can only be known at runtime")

    def comprehension(self, generators, mod, scope, produce):
        out = []

        def walk(i, s):
            if i == len(generators):
                out.append(produce(s))
                return
            gen = generators[i]
            for item in self.eval(gen.iter, mod, s):
                inner = dict(s)
                self.bind(gen.target, item, inner, mod)
                if all(self.eval(cond, mod, inner) for cond in gen.ifs):
                    walk(i + 1, inner)

        walk(0, dict(scope))
        return out

    def bind(self, target, value, scope, mod):
        if isinstance(target, ast.Name):
            scope[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            values = list(value)
            if len(values) != len(target.elts):
                self.fail(mod, target, "can't unpack this value")
            for t, v in zip(target.elts, values):
                self.bind(t, v, scope, mod)
        else:
            self.fail(mod, target, "only simple loop variables are supported")

    def apply(self, fn, args, mod, node):
        if not isinstance(fn, Fn):
            self.fail(mod, node, "expected a lambda here")
        scope = dict(fn.scope)
        for param, value in zip(fn.node.args.args, args):
            scope[param.arg] = value
        return self.eval(fn.node.body, fn.module, scope)

    def call(self, node, mod, scope):
        args = [self.eval(a, mod, scope) for a in node.args if not isinstance(a, ast.Starred)]
        if any(isinstance(a, ast.Starred) for a in node.args):
            for a in node.args:
                if isinstance(a, ast.Starred):
                    args.extend(self.eval(a.value, mod, scope))
        kwargs = {k.arg: self.eval(k.value, mod, scope) for k in node.keywords if k.arg}
        for a in args + list(kwargs.values()):
            if not isinstance(a, SAFE_TYPES + (Fn,)):
                self.fail(mod, node, "this value can only be known at runtime")
        func = node.func

        # textwrap.dedent(...), inspect.cleandoc(...), json.dumps(...)
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id not in scope:
            module_name = func.value.id
            imported = mod.imports.get(module_name)
            real = imported[0] if imported and imported[2] is None else module_name
            if real == "textwrap" and func.attr == "dedent":
                return textwrap.dedent(*args)
            if real == "textwrap" and func.attr == "indent":
                return textwrap.indent(*args)
            if real == "inspect" and func.attr == "cleandoc":
                return inspect.cleandoc(*args)
            if real == "json" and func.attr == "dumps":
                return json.dumps(*args, **{k: v for k, v in kwargs.items() if k in ("indent", "ensure_ascii", "sort_keys", "separators")})

        if isinstance(func, ast.Name) and func.id not in scope:
            name = func.id
            imported = mod.imports.get(name)
            origin = (imported[0], imported[2]) if imported else None
            if origin in (("textwrap", "dedent"),) or (name == "dedent" and not imported):
                return textwrap.dedent(*args)
            if origin == ("inspect", "cleandoc"):
                return inspect.cleandoc(*args)
            if name in mod.classes:
                return ClassRef(mod, name)
            if name in TEXT_FUNCTIONS and name not in mod.bindings and name not in mod.functions and not imported:
                if name == "sorted" and "key" in kwargs:
                    key = kwargs.pop("key")
                    return sorted(args[0], key=lambda x: self.apply(key, [x], mod, node), **kwargs)
                fn = {"str": str, "len": len, "sorted": sorted, "list": list, "tuple": tuple, "int": int, "float": float, "repr": repr,
                      "reversed": lambda x: list(reversed(x)), "enumerate": lambda *a: list(enumerate(*a)), "zip": lambda *a: list(zip(*a)),
                      "range": lambda *a: list(range(*a))}[name]
                return fn(*args, **kwargs)
            if name in ("dedent", "cleandoc") and imported:
                if imported[0] == "textwrap" or name == "dedent":
                    return textwrap.dedent(*args)
                return inspect.cleandoc(*args)
            self.fail(mod, node, f"it calls {name}(), which promptdiff can't run")

        if isinstance(func, ast.Attribute):
            target = self.eval(func.value, mod, scope)
            method = func.attr
            if isinstance(target, str) and method in STR_METHODS:
                if method == "format":
                    for v in list(args) + list(kwargs.values()):
                        self.check(v, mod, node)
                return getattr(target, method)(*args, **kwargs)
            if isinstance(target, dict) and method in DICT_METHODS:
                result = getattr(target, method)(*args)
                return list(result) if method in ("keys", "values", "items") else result
            if isinstance(target, (list, tuple)) and method in LIST_METHODS:
                return getattr(target, method)(*args)
            self.fail(mod, node, f".{method}() isn't supported here")
        self.fail(mod, node, "this call can't be read without running the code")


class ClassRef:
    def __init__(self, module, name):
        self.module, self.name = module, name


TYPING_MODULES = {"typing", "typing_extensions", "collections.abc", "collections"}


def looks_like_text(node, mod=None):
    """For listing: skip functions, containers, None/numbers, type hints, and values made by calling a function."""
    if isinstance(node, (ast.Lambda, ast.Dict, ast.List, ast.Set, ast.Tuple, ast.DictComp, ast.ListComp, ast.SetComp)):
        return False
    if isinstance(node, ast.Constant) and not isinstance(node.value, str):
        return False
    if isinstance(node, ast.Subscript) and isinstance(node.value, (ast.Name, ast.Attribute)) and mod is not None:
        base = node.value.id if isinstance(node.value, ast.Name) else getattr(node.value.value, "id", None)
        imported = mod.imports.get(base) if base else None
        if imported and imported[0] in TYPING_MODULES:
            return False  # e.g. Callable[[str], str]
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute):
            return True  # "\n".join(...), textwrap.dedent(...), "...".format(...)
        return isinstance(func, ast.Name) and func.id in ("dedent", "cleandoc", "str")
    return isinstance(node, (ast.Constant, ast.JoinedStr, ast.BinOp, ast.Name, ast.Attribute, ast.Subscript, ast.IfExp))


def list_prompts(path, source):
    mod = Module(path, source)
    names = [n for n, v in mod.bindings.items() if PROMPT_NAME.search(n) and looks_like_text(v, mod)]
    for cname, cls in mod.classes.items():
        for st in cls.body:
            targets = st.targets if isinstance(st, ast.Assign) else [st.target] if isinstance(st, ast.AnnAssign) and st.value is not None else []
            for t in targets:
                if isinstance(t, ast.Name) and (PROMPT_NAME.search(t.id) or PROMPT_NAME.search(cname)) and looks_like_text(st.value, mod):
                    names.append(f"{cname}.{t.id}")
    return names


def extract(repo, file, name):
    ev = Evaluator(repo)
    mod = ev.module(file)
    if mod is None:
        return {"error": f"File not found: {file}"}
    try:
        if "." in name:
            cls, attr = name.split(".", 1)
            value = ev.class_attr(mod, cls, attr, None)
        elif name not in mod.bindings and name not in mod.imports and not mod.star_imports:
            candidates = list_prompts(file, mod.source)
            return {
                "error": f'{file} has no top-level "{name}".',
                "hint": f"Prompt-like names in this file: {', '.join(candidates)}" if candidates else "Assign the prompt to a top-level name, e.g. SYSTEM_PROMPT = \"\"\"...\"\"\"",
            }
        else:
            value = ev.lookup(mod, name, None)
    except CantRead as e:
        return {"error": str(e), "hint": HINT}
    except RecursionError:
        return {"error": f"{file}#{name}: the prompt is nested too deeply to read."}
    if not isinstance(value, str):
        kind = "a list" if isinstance(value, list) else "a dict" if isinstance(value, dict) else type(value).__name__
        return {"error": f"{file}#{name} isn't text (it's {kind}).", "hint": "Point promptdiff at a string, e.g. the variable holding the system prompt."}
    return {"text": value, "files": ev.files}


def main():
    request = json.loads(sys.stdin.read())
    if request["mode"] == "list":
        names, errors = {}, {}
        for f in request["files"]:
            try:
                names[f["path"]] = list_prompts(f["path"], f["source"])
            except SyntaxError as e:
                errors[f["path"]] = f"couldn't parse ({e.msg}, line {e.lineno})"
        out = {"names": names, "errors": errors}
    else:
        repo = Repo(request["repoRoot"], request.get("ref"))
        out = {"results": [extract(repo, item["file"], item["name"]) for item in request["items"]]}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()

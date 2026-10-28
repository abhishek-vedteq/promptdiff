/** `{{ name }}` placeholders. Names are letters, digits, and underscores, not starting with a digit. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type TemplateVars = Record<string, string | number | boolean>;

/** Names of every placeholder in the template, in order of first appearance. */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) names.add(m[1]!);
  return [...names];
}

export function missingVariables(template: string, vars: TemplateVars): string[] {
  return templateVariables(template).filter((name) => !(name in vars));
}

/** Replaces placeholders with values. Callers should check missingVariables first; missing names are left as-is. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

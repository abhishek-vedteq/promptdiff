import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  // The shebang lives in src/cli.ts; tsup preserves it and marks the file executable.
});

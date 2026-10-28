import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 20000,
    // Assertions use the Unicode symbols; CI's Windows console would otherwise get the ASCII fallback.
    env: { PROMPTDIFF_UNICODE: "1" },
  },
});

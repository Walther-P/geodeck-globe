import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { watch: { ignored: ["**/.wrangler/**", "**/artifacts/**"] } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1600,
  },
});

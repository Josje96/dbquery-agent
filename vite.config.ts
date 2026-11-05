import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [vue()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});

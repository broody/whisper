import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { vocs } from "vocs/vite";

export default defineConfig({
  plugins: [react(), vocs()],
  optimizeDeps: {
    // Mermaid is loaded dynamically by Vocs, so Vite's initial dependency scan
    // misses several of Mermaid's CommonJS dependencies (including Day.js and
    // sanitize-url). Prebundle the package and its dependency tree together.
    include: ["mermaid"],
  },
});

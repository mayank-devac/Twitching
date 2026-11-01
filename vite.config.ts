import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // react-markdown and its unified/micromark/mdast/hast tree is the bulk of the
        // bundle; keep it in its own cacheable chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-[^\\/]+|unified|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|vfile[^\\/]*|devlop|decode-named-character-reference|character-entities[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|trim-lines|trough|bail|is-plain-obj|html-url-attributes|estree-util-[^\\/]+)[\\/]/.test(id))
            return "markdown";
          return undefined;
        },
      },
    },
  },
});

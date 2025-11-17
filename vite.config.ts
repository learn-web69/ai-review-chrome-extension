import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    server: {
      port: 3000,
      host: "0.0.0.0",
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          sidepanel: resolve(__dirname, "sidepanel.html"),
          permissions: resolve(__dirname, "permissions.html"),
          background: resolve(__dirname, "background.ts"),
          "content-script": resolve(__dirname, "content-script.ts"),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            return chunkInfo.name === "background"
              ? "background.js"
              : "[name].js";
          },
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: (assetInfo) => {
            if (assetInfo.name === "styles.css") {
              return "styles.css";
            }
            return "assets/[name]-[hash].[ext]";
          },
        },
      },
      outDir: "dist",
      emptyOutDir: true,
    },
    define: {
      "process.env.API_KEY": JSON.stringify(env.GEMINI_API_KEY),
      "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
  };
});

import { lingui as linguiSolidPlugin } from "@lingui/vite-plugin";
import devtools from "@solid-devtools/transform";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import babelMacrosPlugin from "vite-plugin-babel-macros";
import Inspect from "vite-plugin-inspect";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import solidSvg from "vite-plugin-solid-svg";

import codegenPlugin from "./codegen.plugin";
import { addFontPreload } from "./fontpreload.plugin";

const base = process.env.BASE_PATH ?? "/";

/** Identificador de esta compilación (también se publica en /version.json) */
const BUILD_ID = process.env.BUILD_ID || Date.now().toString(36);
const pwaScope = process.env.PWA_SCOPE || base;

export default defineConfig({
  base,
  define: {
    // Identificador de esta compilación: permite ver de un vistazo si todos los
    // clientes (web, escritorio) están en la misma versión.
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    // Baliza de versión: los clientes la consultan (sin caché) para saber al
    // instante si el servidor publicó una compilación nueva.
    {
      name: "starknet-version-beacon",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ build: BUILD_ID }),
        });
      },
    },
    Inspect(),
    devtools(),
    codegenPlugin(),
    babelMacrosPlugin(),
    solidPlugin({
      babel: {
        plugins: ["@lingui/babel-plugin-lingui-macro"],
      },
    }),
    linguiSolidPlugin(),
    solidSvg({
      defaultAsComponent: false,
    }),
    addFontPreload(),
    VitePWA({
      srcDir: "src",
      registerType: "prompt", // la actualización se aplica en un momento seguro (serviceWorkerInterface.ts)
      filename: "serviceWorker.ts",
      strategies: "injectManifest",
      injectManifest: {
        maximumFileSizeToCacheInBytes: 8000000,
        globPatterns: ["**/*.{js,css,html}", "**/material-symbols-*.woff2"],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
      manifest: {
        name: "StarknetChat",
        short_name: "StarknetChat",
        description: "Cliente de chat autoalojado para nuestra comunidad.",
        categories: ["communication", "chat", "messaging"],
        start_url: base,
        scope: pwaScope,
        display_override: ["window-controls-overlay"],
        display: "standalone",
        background_color: "#101823",
        theme_color: "#101823",
        icons: [
          {
            src: `${base}assets/web/android-chrome-192x192.png`,
            type: "image/png",
            sizes: "192x192",
          },
          {
            src: `${base}assets/web/android-chrome-512x512.png`,
            type: "image/png",
            sizes: "512x512",
          },
          {
            src: `${base}assets/web/monochrome.svg`,
            type: "image/svg+xml",
            sizes: "48x48 72x72 96x96 128x128 256x256",
            purpose: "monochrome",
          },
          {
            src: `${base}assets/web/masking-512x512.png`,
            type: "image/png",
            sizes: "512x512",
            purpose: "maskable",
          },
        ],
        // TODO: take advantage of shortcuts
      },
    }),
  ],
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["hast"],
      output: {
        manualChunks: {
          markdown: [
            "lowlight",
            "rehype-highlight",
            "rehype-katex",
            "remark-breaks",
            "remark-gfm",
            "remark-math",
            "remark-parse",
            "remark-rehype",
            "vfile",
          ],
        },
      },
    },
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ["hast"],
  },
  resolve: {
    alias: {
      "styled-system": resolve(__dirname, "styled-system"),
      ...readdirSync(resolve(__dirname, "components")).reduce(
        (p, f) => ({
          ...p,
          [`@revolt/${f}`]: resolve(__dirname, "components", f),
        }),
        {},
      ),
    },
  },
});

import { defineConfig } from "vite";
import type { Connect, ViteDevServer, PreviewServer } from "vite";
import react from "@vitejs/plugin-react";

const BASE = "/tools/mermaid-on-steroids/";

function redactGoogleApiKeys() {
  const googleApiKeyPattern = /AIza[0-9A-Za-z-_]{20,}/g;
  const replacement = "REDACTED_GOOGLE_API_KEY";

  return {
    name: "redact-google-api-keys",
    apply: "build" as const,
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          item.code = item.code.replace(googleApiKeyPattern, replacement);
        } else if (typeof item.source === "string") {
          item.source = item.source.replace(googleApiKeyPattern, replacement);
        }
      }
    },
  };
}

// The app is served under BASE, so hitting "/" would otherwise 404. Redirect the
// site root to the app in both the dev server and `vite preview`.
function redirectRootToBase() {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url === "/" || req.url === "") {
      res.statusCode = 302;
      res.setHeader("Location", BASE);
      res.end();
      return;
    }
    next();
  };

  return {
    name: "redirect-root-to-base",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [redactGoogleApiKeys(), redirectRootToBase(), react()],
  base: BASE,
  build: {
    // The Mermaid and Excalidraw engines are large by nature; Excalidraw is
    // already lazy-loaded on first export. Split the remaining vendor code so
    // chunks cache independently, and lift the warning above their real size.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          pdf: ["jspdf"],
        },
      },
    },
  },
});

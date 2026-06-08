import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function redactGoogleApiKeys() {
  const googleApiKeyPattern = /AIza[0-9A-Za-z-_]{20,}/g;
  const replacement = "REDACTED_GOOGLE_API_KEY";

  return {
    name: "redact-google-api-keys",
    apply: "build",
    generateBundle(_options, bundle) {
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

export default defineConfig({
  plugins: [redactGoogleApiKeys(), react()],
  base: "/tools/mermaid-on-steroids/",
});

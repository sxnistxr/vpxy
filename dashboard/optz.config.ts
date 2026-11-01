import { defineConfig } from "optz";

// The dashboard is exported as static files (`bun run build`) and embedded in the Go binary,
// which serves it at /management.html. Only the island ships JavaScript; it reads /vpxy/api.
export default defineConfig({
  port: 3001,
  // `bun run dev` forwards the dashboard API to a locally running VPXY.
  proxy: {
    "/vpxy": { target: "http://127.0.0.1:8317" },
    "/v8/management": { target: "http://127.0.0.1:8317" },
    "/v1": { target: "http://127.0.0.1:8317" },
  },
  client: {
    mode: "islands",
    navigation: false,
    prefetch: false,
    speculation: false,
    runtime: "react",
  },
  features: {
    middleware: false,
    dynamic: false,
    api: false,
    cache: false,
  },
  fonts: [
    {
      google:
        "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap",
    },
  ],
  llms: false,
});

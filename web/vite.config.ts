import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 後端（api/）在開發時跑在 3000；/api 與 /auth 都轉過去，讓 cookie 維持同源。
const BACKEND = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": BACKEND,
      "/auth": BACKEND,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});

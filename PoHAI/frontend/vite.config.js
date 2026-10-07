import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, discussion/metadata requests go to the agorá server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
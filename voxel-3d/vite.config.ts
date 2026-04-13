import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    {
      name: "model-config-api",
      configureServer(server) {
        server.middlewares.use("/api/model-config", (req, res) => {
          const configPath = path.resolve(__dirname, "public/model-config.json");
          if (req.method === "GET") {
            const data = fs.readFileSync(configPath, "utf-8");
            res.setHeader("Content-Type", "application/json");
            res.end(data);
          } else if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk));
            req.on("end", () => {
              fs.writeFileSync(configPath, body, "utf-8");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            });
          } else {
            res.statusCode = 405;
            res.end();
          }
        });
      },
    },
  ],
});
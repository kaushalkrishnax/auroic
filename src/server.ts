import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "fs";
import path from "path";

const runtimePath = path.join(process.cwd(), "src/config/runtime.json");
const indexPath = path.join(process.cwd(), "src/web/index.html");

const app = new Hono();

function readConfig() {
  const raw = fs.readFileSync(runtimePath, "utf-8");
  return JSON.parse(raw);
}

function writeConfig(data: any) {
  fs.writeFileSync(runtimePath, JSON.stringify(data, null, 2));
}

// Serve UI
app.get("/", (c) => {
  const html = fs.readFileSync(indexPath, "utf-8");
  return c.html(html);
});

// Get config
app.get("/config", (c) => {
  return c.json(readConfig());
});

// Save config
app.post("/config", async (c) => {
  const body = await c.req.json();
  writeConfig(body);
  return c.json({ success: true });
});

export function startServer() {
  serve({
    fetch: app.fetch,
    port: 3789,
  });

  console.log("⚙️ Config UI running → http://localhost:3789");
}

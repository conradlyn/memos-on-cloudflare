import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { memoRoutes } from "./routes/memos";
import { userRoutes } from "./routes/users";
import { attachmentRoutes } from "./routes/attachments";
import { fileRoutes } from "./routes/files";
import { instanceRoutes } from "./routes/instance";
import { healthRoutes } from "./routes/health";
import { shortcutRoutes } from "./routes/shortcuts";
import { idpRoutes } from "./routes/idp";
import { aiRoutes } from "./routes/ai";
import { sseRoutes } from "./routes/sse";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/memos", memoRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/attachments", attachmentRoutes);
app.route("/api/v1/instance", instanceRoutes);
app.route("/api/v1/health", healthRoutes);
app.route("/api/v1/shortcuts", shortcutRoutes);
app.route("/api/v1/idps", idpRoutes);
app.route("/api/v1/ai", aiRoutes);
app.route("/api/v1/sse", sseRoutes);
app.route("/file", fileRoutes);

export default app;

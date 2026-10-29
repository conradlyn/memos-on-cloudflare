import { Hono, type Context } from "hono";
import type { Env } from "../types";

type HealthApp = { Bindings: Env };

/**
 * Liveness probe. A 200 that never touches the database cannot distinguish a
 * healthy worker from one whose D1 binding is broken, so this issues a trivial
 * query and reports 503 when it fails.
 */
export async function healthHandler(c: Context<HealthApp>) {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok" });
  } catch (error) {
    console.error("health check failed", error);
    return c.json({ status: "unavailable" }, 503);
  }
}

export const healthRoutes = new Hono<HealthApp>();

healthRoutes.get("/", healthHandler);

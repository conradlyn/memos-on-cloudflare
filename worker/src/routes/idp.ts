import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";

type IdpApp = { Bindings: Env; Variables: { user: UserPayload } };

export const idpRoutes = new Hono<IdpApp>();

idpRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM idp").all();
  return c.json({ identityProviders: results || [] });
});

idpRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const result = await c.env.DB.prepare(
    "INSERT INTO idp (uid, name, type, identifier_filter, config) VALUES (?, ?, ?, ?, ?) RETURNING *"
  ).bind(uid, body.name || "", body.type || "oauth2", body.identifierFilter || "", JSON.stringify(body.config || {})).first();

  return c.json(result, 201);
});

idpRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json();
  const updates: string[] = [];
  const params: any[] = [];

  if (body.name !== undefined) { updates.push("name = ?"); params.push(body.name); }
  if (body.type !== undefined) { updates.push("type = ?"); params.push(body.type); }
  if (body.identifierFilter !== undefined) { updates.push("identifier_filter = ?"); params.push(body.identifierFilter); }
  if (body.config !== undefined) { updates.push("config = ?"); params.push(JSON.stringify(body.config)); }

  if (updates.length > 0) {
    params.push(id);
    await c.env.DB.prepare(`UPDATE idp SET ${updates.join(", ")} WHERE id = ? OR uid = ?`).bind(...params, id).run();
  }

  const result = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first();
  return c.json(result);
});

idpRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM idp WHERE id = ? OR uid = ?").bind(id, id).run();
  return c.json({});
});

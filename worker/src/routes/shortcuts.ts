import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";

type ShortcutApp = { Bindings: Env; Variables: { user: UserPayload } };

export const shortcutRoutes = new Hono<ShortcutApp>();

shortcutRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "shortcuts");
  const shortcuts = setting ? JSON.parse(setting.value) : [];
  return c.json({ shortcuts });
});

shortcutRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "shortcuts");
  const shortcuts = setting ? JSON.parse(setting.value) : [];

  const newShortcut = {
    ...body,
    id: crypto.randomUUID().slice(0, 8),
    name: `shortcuts/${crypto.randomUUID().slice(0, 8)}`,
  };
  shortcuts.push(newShortcut);

  await settingDB.setUserSetting(c.env.DB, user.id, "shortcuts", JSON.stringify(shortcuts));
  return c.json(newShortcut, 201);
});

shortcutRoutes.patch("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "shortcuts");
  const shortcuts = setting ? JSON.parse(setting.value) : [];

  const idx = shortcuts.findIndex((s: any) => s.id === id || s.name === `shortcuts/${id}`);
  if (idx === -1) return c.json({ error: "Not found" }, 404);

  shortcuts[idx] = { ...shortcuts[idx], ...body };
  await settingDB.setUserSetting(c.env.DB, user.id, "shortcuts", JSON.stringify(shortcuts));
  return c.json(shortcuts[idx]);
});

shortcutRoutes.delete("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "shortcuts");
  const shortcuts = setting ? JSON.parse(setting.value) : [];

  const filtered = shortcuts.filter((s: any) => s.id !== id && s.name !== `shortcuts/${id}`);
  await settingDB.setUserSetting(c.env.DB, user.id, "shortcuts", JSON.stringify(filtered));
  return c.json({});
});

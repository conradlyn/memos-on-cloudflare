import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import * as userDB from "../db/user";

type InstApp = { Bindings: Env; Variables: { user: UserPayload } };

export const instanceRoutes = new Hono<InstApp>();

// Get instance profile
instanceRoutes.get("/profile", async (c) => {
  const userCount = await userDB.countUsers(c.env.DB);
  const customProfile = await settingDB.getSystemSetting(c.env.DB, "instance_profile");
  const profile = customProfile ? JSON.parse(customProfile.value) : {};

  let admin = undefined;
  if (userCount > 0) {
    const adminUser = await c.env.DB.prepare(
      "SELECT * FROM user WHERE role = 'ADMIN' ORDER BY created_ts ASC LIMIT 1"
    ).first<any>();
    if (adminUser) {
      admin = {
        name: `users/${adminUser.username}`,
        username: adminUser.username,
        nickname: adminUser.nickname,
        role: 2,
      };
    }
  }

  return c.json({
    version: "1.0.0",
    mode: "prod",
    admin,
    ...profile,
  });
});

// Get instance setting
instanceRoutes.get("/settings/*", async (c) => {
  const fullPath = c.req.path;
  const name = fullPath.replace("/api/v1/instance/settings/", "");
  if (!name) {
    const settings = await settingDB.listSystemSettings(c.env.DB);
    return c.json({ settings });
  }
  const setting = await settingDB.getSystemSetting(c.env.DB, name);
  if (!setting) {
    return c.json({ name, value: "{}" });
  }
  return c.json({ name: setting.name, value: setting.value });
});

// List instance settings
instanceRoutes.get("/settings", async (c) => {
  const settings = await settingDB.listSystemSettings(c.env.DB);
  return c.json({ settings });
});

// Update instance setting (admin only)
instanceRoutes.patch("/settings/*", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const fullPath = c.req.path;
  const name = fullPath.replace("/api/v1/instance/settings/", "");
  const body = await c.req.json<{ value: string; description?: string }>();
  await settingDB.setSystemSetting(c.env.DB, name, body.value, body.description);
  return c.json({ name, value: body.value });
});

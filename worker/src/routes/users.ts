import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as userDB from "../db/user";
import * as settingDB from "../db/setting";
import * as memoDB from "../db/memo";
import * as webhookDB from "../db/webhook";
import { hashPassword } from "../auth/password";
import { generatePAT, hashPAT } from "../auth/pat";
import { exchangeOAuthCode } from "../auth/oauth";
import { createErrorBody } from "../error";
import { buildIdentityProviderName, extractIdentityProviderUid } from "../idp";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";
import { getWebhookUrlValidationError, normalizeWebhookUrl } from "../webhook";
import { protoTimestamp } from "../time";

type UserApp = { Bindings: Env; Variables: { user: UserPayload } };

export const userRoutes = new Hono<UserApp>();

const getGeneralSetting = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "GENERAL");
  if (!setting) {
    return {};
  }
  try {
    return JSON.parse(setting.value) || {};
  } catch {
    return {};
  }
};

export function formatUser(user: userDB.UserRow, options: { includeEmail?: boolean } = {}) {
  return {
    name: `users/${user.username}`,
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.nickname,
    nickname: user.nickname,
    email: options.includeEmail ? user.email : "",
    avatarUrl: user.avatar_url,
    description: user.description,
    // Memos v1 API requires `state`; native clients (MoeMemos, etc.) fail to decode
    // the user payload when only the legacy `rowStatus` field is present.
    state: user.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    rowStatus: user.row_status,
    createTime: protoTimestamp(user.created_ts),
    updateTime: protoTimestamp(user.updated_ts),
  };
}

/** Resolves a user by username, falling back to a numeric primary key. */
async function resolveUserByToken(db: D1Database, token: string): Promise<userDB.UserRow | null> {
  const byName = await userDB.findUserByUsername(db, token);
  if (byName) {
    return byName;
  }
  if (/^\d+$/.test(token)) {
    return db.prepare("SELECT * FROM user WHERE id = ?").bind(Number(token)).first<userDB.UserRow>();
  }
  return null;
}

function formatPersonalAccessToken(username: string, token: {
  hash: string;
  description?: string;
  createdAt?: string;
  expiresAt?: string | null;
  lastUsedAt?: string;
}) {
  return {
    name: `users/${username}/personalAccessTokens/${token.hash}`,
    description: token.description || "",
    createdAt: token.createdAt || new Date().toISOString(),
    expiresAt: token.expiresAt || undefined,
    lastUsedAt: token.lastUsedAt || undefined,
    hash: token.hash,
  };
}

const USER_STATS_CACHE_SCOPES = ["public", "authenticated", "owner"] as const;

function getUserStatsCacheKeys(username: string) {
  return [
    `user:stats:${username}`,
    ...USER_STATS_CACHE_SCOPES.map((scope) => `user:stats:${username}:${scope}`),
  ];
}

function getUserStatsVisibilityScope(targetUserId: number, currentUser: UserPayload | undefined) {
  if (currentUser?.id === targetUserId) {
    return "owner";
  }
  return currentUser ? "authenticated" : "public";
}

function appendStatsVisibilityFilter(conditions: string[], targetUserId: number, currentUser: UserPayload | undefined) {
  const scope = getUserStatsVisibilityScope(targetUserId, currentUser);
  if (scope === "public") {
    conditions.push("visibility = 'PUBLIC'");
  } else if (scope === "authenticated") {
    conditions.push("visibility IN ('PUBLIC', 'PROTECTED')");
  }
  return scope;
}

// List users
userRoutes.get("/", authOptional, async (c) => {
  const currentUser = c.get("user");
  const includeEmail = currentUser?.role === "ADMIN";
  const users = await userDB.listUsers(c.env.DB, { rowStatus: "NORMAL" });
  return c.json({ users: users.map((user) => formatUser(user, { includeEmail })), nextPageToken: "", totalSize: users.length });
});

// Batch get users
userRoutes.post("/:batchGet", async (c) => {
  const action = c.req.param("batchGet");
  if (action !== "batchGet") return c.notFound();

  const body = await c.req.json<{ usernames: string[] }>();
  const users = (await userDB.findUsersByUsernames(c.env.DB, body.usernames || [])).filter((user) => user.row_status === "NORMAL");
  return c.json({ users: users.map((user) => formatUser(user)) });
});

type UserStatsSnapshot = {
  username: string;
  scope: string;
  memoCount: number;
  tagCount: Record<string, number>;
  memoTypeStats: { linkCount: number; codeCount: number; todoCount: number; undoCount: number };
  pinnedMemoNames: string[];
  pinnedTimestamps: number[];
  createdTimestamps: number[];
  updatedTimestamps: number[];
};

async function collectUserStats(
  db: D1Database,
  user: userDB.UserRow,
  currentUser: UserPayload | undefined,
): Promise<UserStatsSnapshot> {
  const conditions = ["creator_id = ?", "row_status = 'NORMAL'"];
  const scope = appendStatsVisibilityFilter(conditions, user.id, currentUser);

  const { results: memos } = await db.prepare(
    `SELECT uid, created_ts, updated_ts, payload, pinned FROM memo WHERE ${conditions.join(" AND ")}`
  ).bind(user.id).all<{ uid: string; created_ts: number; updated_ts: number; payload: string; pinned: number }>();

  const tagCount: Record<string, number> = {};
  let linkCount = 0, codeCount = 0, todoCount = 0, undoCount = 0;
  const pinnedMemoNames: string[] = [];
  const pinnedTimestamps: number[] = [];

  for (const memo of memos) {
    let payload: any = {};
    try {
      payload = JSON.parse(memo.payload || "{}");
    } catch {
      payload = {};
    }
    if (Array.isArray(payload.tags)) {
      for (const tag of payload.tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }
    if (payload.property?.hasLink) linkCount++;
    if (payload.property?.hasCode) codeCount++;
    if (payload.property?.hasTaskList) todoCount++;
    if (payload.property?.hasIncompleteTask) undoCount++;
    if (memo.pinned) {
      pinnedMemoNames.push(`memos/${memo.uid}`);
      pinnedTimestamps.push(memo.created_ts);
    }
  }

  return {
    username: user.username,
    scope,
    memoCount: memos.length,
    tagCount,
    memoTypeStats: { linkCount, codeCount, todoCount, undoCount },
    pinnedMemoNames,
    pinnedTimestamps,
    createdTimestamps: memos.map((memo) => memo.created_ts),
    updatedTimestamps: memos.map((memo) => memo.updated_ts),
  };
}

// Get user stats (legacy shape consumed by the bundled web client)
userRoutes.get("/:username/stats", authOptional, async (c) => {
  const user = await resolveUserByToken(c.env.DB, c.req.param("username"));
  if (!user) return c.json({ error: "User not found" }, 404);

  const currentUser = c.get("user");
  const scope = getUserStatsVisibilityScope(user.id, currentUser);
  const cacheKey = `user:stats:${user.username}:${scope}`;
  const cached = scope === "owner" ? undefined : await getCachedJson(c.env.CACHE, cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const stats = await collectUserStats(c.env.DB, user, currentUser);
  const response = {
    name: `users/${user.username}/stats`,
    memoCount: stats.memoCount,
    tagCount: stats.tagCount,
    memoTypeStats: stats.memoTypeStats,
    pinnedMemos: stats.pinnedTimestamps,
    memoCreatedTimestamps: stats.createdTimestamps.map((ts) => ({ seconds: ts, nanos: 0 })),
    memoUpdatedTimestamps: stats.updatedTimestamps.map((ts) => ({ seconds: ts, nanos: 0 })),
  };

  if (scope !== "owner") {
    await putCachedJson(c.env.CACHE, cacheKey, response, 60);
  }
  return c.json(response);
});

// Get all user stats
userRoutes.get("/:action", authOptional, async (c) => {
  const action = c.req.param("action");
  if (action === "stats") {
    const cached = await getCachedJson(c.env.CACHE, "user:stats:all:public");
    if (cached) {
      return c.json(cached);
    }

    const users = await userDB.listUsers(c.env.DB, { rowStatus: "NORMAL" });
    const { results: memos } = await c.env.DB.prepare(
      "SELECT creator_id, payload FROM memo WHERE row_status = 'NORMAL' AND visibility = 'PUBLIC'"
    ).all<{ creator_id: number; payload: string }>();

    const memoStatsByUserId = new Map<number, { memoCount: number; tagCount: Record<string, number> }>();
    for (const memo of memos) {
      const stats = memoStatsByUserId.get(memo.creator_id) || { memoCount: 0, tagCount: {} };
      stats.memoCount += 1;
      const payload = JSON.parse(memo.payload || "{}");
      if (payload.tags) {
        for (const tag of payload.tags) {
          stats.tagCount[tag] = (stats.tagCount[tag] || 0) + 1;
        }
      }
      memoStatsByUserId.set(memo.creator_id, stats);
    }

    const stats = users.map((user) => {
      const memoStats = memoStatsByUserId.get(user.id) || { memoCount: 0, tagCount: {} };
      return {
        name: `users/${user.username}/stats`,
        username: user.username,
        memoCount: memoStats.memoCount,
        tagCount: memoStats.tagCount,
      };
    });
    const response = { stats };
    await putCachedJson(c.env.CACHE, "user:stats:all:public", response, 60);
    return c.json(response);
  }

  // Memos v1 custom verb: GET /api/v1/users/{user}:getStats
  // Native clients (MoeMemos 2.x) call this path instead of /users/{user}/stats.
  if (action.endsWith(":getStats")) {
    const user = await resolveUserByToken(c.env.DB, action.slice(0, -":getStats".length));
    if (!user) return c.json({ error: "User not found" }, 404);

    const currentUser = c.get("user");
    if (user.row_status !== "NORMAL" && currentUser?.id !== user.id && currentUser?.role !== "ADMIN") {
      return c.json({ error: "User not found" }, 404);
    }

    const scope = getUserStatsVisibilityScope(user.id, currentUser);
    const cacheKey = `user:stats:v1:${user.username}:${scope}`;
    const cached = scope === "owner" ? undefined : await getCachedJson(c.env.CACHE, cacheKey);
    if (cached) {
      return c.json(cached);
    }

    const stats = await collectUserStats(c.env.DB, user, currentUser);
    const response = {
      name: `users/${user.username}`,
      memoDisplayTimestamps: stats.createdTimestamps.map((ts) => protoTimestamp(ts)),
      memoTypeStats: stats.memoTypeStats,
      tagCount: stats.tagCount,
      pinnedMemos: stats.pinnedMemoNames,
      totalMemoCount: stats.memoCount,
    };

    if (scope !== "owner") {
      await putCachedJson(c.env.CACHE, cacheKey, response, 60);
    }
    return c.json(response);
  }

  // Get user by username (or numeric ID as fallback)
  const user = await resolveUserByToken(c.env.DB, action);
  if (!user) return c.json({ error: "User not found" }, 404);
  const currentUser = c.get("user");
  if (user.row_status !== "NORMAL" && currentUser?.id !== user.id && currentUser?.role !== "ADMIN") {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json(formatUser(user, { includeEmail: currentUser?.id === user.id || currentUser?.role === "ADMIN" }));
});

// Create user (admin, or self-registration when allowed)
userRoutes.post("/", async (c) => {
  const userCount = await userDB.countUsers(c.env.DB);

  // First user is always allowed (becomes admin)
  if (userCount === 0) {
    const body = await c.req.json();
    const userData = body.user || body;
    const username = userData.username;
    const password = userData.password;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    const passwordHash = await hashPassword(password);
    const user = await userDB.createUser(c.env.DB, { username, passwordHash, role: "ADMIN" });
    await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public"]);
    return c.json(formatUser(user, { includeEmail: true }), 201);
  }

  // Check if self-registration is allowed
  const generalSetting = await getGeneralSetting(c.env.DB);
  const disallowRegistration = generalSetting.disallowUserRegistration === true;
  const disallowPasswordAuth = generalSetting.disallowPasswordAuth === true;

  // Check auth header
  const authHeader = c.req.header("Authorization");
  let isAdmin = false;

  if (authHeader?.startsWith("Bearer ")) {
    const { verifyAccessToken } = await import("../auth/jwt");
    try {
      const claims = await verifyAccessToken(authHeader.slice(7), c.env.JWT_SECRET);
      isAdmin = claims.role === "ADMIN";
    } catch {}
  }

  // Admin can always create users; non-admin can self-register if allowed
  if (!isAdmin && (disallowRegistration || disallowPasswordAuth)) {
    return c.json(createErrorBody("User registration is disabled", { errorKey: "message.user-registration-disabled" }), 403);
  }

  const body = await c.req.json();
  const userData = body.user || body;
  const username = userData.username;
  const password = userData.password;

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const existing = await userDB.findUserByUsername(c.env.DB, username);
  if (existing) return c.json({ error: "Username taken" }, 409);

  // Only admin can create admin users
  const role = isAdmin && userData.role === 2 ? "ADMIN" : "USER";
  const passwordHash = await hashPassword(password);
  const user = await userDB.createUser(c.env.DB, { username, passwordHash, role });
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public"]);

  return c.json(formatUser(user, { includeEmail: true }), 201);
});

// Update user
userRoutes.patch("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json();
  const updateData: Parameters<typeof userDB.updateUser>[2] = {};

  const generalSetting = await getGeneralSetting(c.env.DB);

  if (body.nickname !== undefined || body.displayName !== undefined) {
    if (user.id === currentUser.id && currentUser.role !== "ADMIN" && generalSetting.disallowChangeNickname === true) {
      return c.json(createErrorBody("Changing nickname is disabled", { errorKey: "message.nickname-change-disabled" }), 403);
    }
    updateData.nickname = body.nickname ?? body.displayName;
  }
  if (body.email !== undefined) updateData.email = body.email;
  if (body.avatarUrl !== undefined) updateData.avatar_url = body.avatarUrl;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.password) updateData.password_hash = await hashPassword(body.password);
  if (body.role && currentUser.role === "ADMIN") updateData.role = body.role;
  if (body.rowStatus !== undefined) updateData.row_status = body.rowStatus;
  if (body.username !== undefined) {
    if (currentUser.role === "ADMIN") {
      updateData.username = body.username;
    } else if (user.id === currentUser.id) {
      if (generalSetting.disallowChangeUsername === true) {
        return c.json(createErrorBody("Changing username is disabled", { errorKey: "message.username-change-disabled" }), 403);
      }
      if (body.username !== user.username) {
        return c.json(createErrorBody("Changing username requires admin privileges", { errorKey: "message.username-change-admin-only" }), 403);
      }
    }
  }

  const updated = await userDB.updateUser(c.env.DB, user.id, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    "user:stats:all",
    "user:stats:all:public",
    ...getUserStatsCacheKeys(user.username),
    ...getUserStatsCacheKeys(updated.username),
  ]);

  return c.json(formatUser(updated, { includeEmail: true }));
});

// Delete user
userRoutes.delete("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  // Removing the last active administrator would leave the instance unmanageable
  // with no way back through the API, so refuse it before touching any row.
  if (user.role === "ADMIN" && user.row_status === "NORMAL") {
    const remaining = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM user WHERE role = 'ADMIN' AND row_status = 'NORMAL'"
    ).first<{ count: number }>();
    if ((remaining?.count ?? 0) <= 1) {
      return c.json({ error: "Cannot remove the last admin" }, 400);
    }
  }

  await userDB.deleteUser(c.env.DB, user.id);
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public", ...getUserStatsCacheKeys(user.username)]);
  return c.json({});
});

// --- User Settings ---
userRoutes.get("/:username/settings", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const settings = await settingDB.listUserSettings(c.env.DB, user.id);
  return c.json({ settings });
});

function parseSettingValue(raw: string | undefined | null): Record<string, any> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Builds a user setting payload that satisfies both contracts:
 * - Memos v1 (`{ name, generalSetting: { memoVisibility, locale, theme } }`), used by
 *   native clients such as MoeMemos.
 * - The legacy `{ setting: { key, value } }` shape consumed by the bundled web client.
 */
function formatUserSetting(username: string, key: string, setting: { key: string; value: string } | null | undefined) {
  const value = setting?.value || "";
  const parsed = parseSettingValue(value);
  const isGeneral = key.toUpperCase() === "GENERAL";
  const generalSetting = isGeneral
    ? {
        locale: parsed.locale,
        memoVisibility: parsed.memoVisibility ?? parsed.generalSetting?.memoVisibility,
        theme: parsed.theme,
      }
    : undefined;

  return {
    name: `users/${username}/settings/${key}`,
    ...(generalSetting ? { generalSetting } : {}),
    setting: setting || { key, value: "" },
  };
}

userRoutes.get("/:username/settings/:key", authRequired, async (c) => {
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await resolveUserByToken(c.env.DB, c.req.param("username"));
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, key);
  return c.json(formatUserSetting(user.username, key, setting));
});

userRoutes.patch("/:username/settings/:key", authRequired, async (c) => {
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await resolveUserByToken(c.env.DB, c.req.param("username"));
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ value?: any; generalSetting?: any }>();
  let newValue: any;
  if (body.value !== undefined) {
    if (typeof body.value === "string") {
      try {
        newValue = JSON.parse(body.value);
      } catch {
        newValue = {};
      }
    } else {
      newValue = body.value || {};
    }
  } else if (body.generalSetting !== undefined) {
    newValue = body.generalSetting || {};
  } else {
    newValue = {};
  }

  // Merge with existing setting value
  const existing = await settingDB.getUserSetting(c.env.DB, user.id, key);
  let merged = newValue;
  if (existing) {
    const existingValue = parseSettingValue(existing.value);
    merged = { ...existingValue, ...newValue };
  }

  const valueStr = JSON.stringify(merged);
  await settingDB.setUserSetting(c.env.DB, user.id, key, valueStr);
  return c.json(formatUserSetting(user.username, key, { key, value: valueStr }));
});

// --- Personal Access Tokens ---
userRoutes.get("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  return c.json({
    personalAccessTokens: tokens.map((token: {
      hash: string;
      description?: string;
      createdAt?: string;
      expiresAt?: string | null;
      lastUsedAt?: string;
    }) => formatPersonalAccessToken(username, token)),
    nextPageToken: "",
    totalSize: tokens.length,
  });
});

userRoutes.post("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  let body: { description?: string; expiresAt?: string; expiresInDays?: number } = {};
  try { body = await c.req.json(); } catch {}
  const token = generatePAT();
  const hash = await hashPAT(token);

  let expiresAt = body.expiresAt || null;
  if (!expiresAt && body.expiresInDays && body.expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + body.expiresInDays);
    expiresAt = d.toISOString();
  }

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  const tokenRecord = {
    hash,
    description: body.description || "",
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  tokens.push(tokenRecord);

  await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));

  return c.json({
    token,
    description: body.description || "",
    personalAccessToken: formatPersonalAccessToken(username, tokenRecord),
  });
});

userRoutes.delete("/:username/personalAccessTokens/:tokenHash", authRequired, async (c) => {
  const username = c.req.param("username");
  const tokenHash = c.req.param("tokenHash");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  if (setting) {
    const tokens = JSON.parse(setting.value).filter((t: { hash: string }) => t.hash !== tokenHash);
    await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));
  }

  return c.json({});
});

// --- Linked Identities ---
userRoutes.get("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM user_identity WHERE user_id = ?"
  ).bind(user.id).all<{ id: number; user_id: number; provider: string; extern_uid: string }>();

  const linkedIdentities = (results || []).map((row) => ({
    name: `users/${username}/linkedIdentities/${row.id}`,
    idpName: buildIdentityProviderName(row.provider),
    externUid: row.extern_uid,
  }));

  return c.json({ linkedIdentities });
});

userRoutes.post("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ idpName?: string; code?: string; redirectUri?: string; codeVerifier?: string }>();
  const idpUid = extractIdentityProviderUid(body.idpName);
  if (!idpUid || !body.code) {
    return c.json({ error: "Missing IDP name or authorization code" }, 400);
  }

  let oauthUser;
  try {
    oauthUser = await exchangeOAuthCode(c.env.DB, idpUid, body.code, body.redirectUri || "", body.codeVerifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to link identity provider";
    console.error("Failed to exchange OAuth code for linked identity:", error);
    const status =
      message.includes("already linked")
        ? 409
        : message.includes("Identity provider not found") ||
            message.includes("configuration is incomplete") ||
            message.includes("Token exchange failed") ||
            message.includes("OAuth error:") ||
            message.includes("No access_token") ||
            message.includes("User info request failed") ||
            message.includes("Could not extract user identifier") ||
            message.includes("does not match the allowed pattern")
          ? 400
          : 500;
    return c.json(createErrorBody(message), status);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM user_identity WHERE provider = ? AND extern_uid = ?"
  ).bind(idpUid, oauthUser.identifier).first<{ id: number }>();
  if (existing) {
    return c.json({ error: "This identity is already linked to another account" }, 409);
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO user_identity (user_id, provider, extern_uid) VALUES (?, ?, ?) RETURNING *"
  ).bind(user.id, idpUid, oauthUser.identifier).first<{ id: number; provider: string; extern_uid: string }>();

  return c.json({
    name: `users/${username}/linkedIdentities/${result!.id}`,
    idpName: buildIdentityProviderName(result!.provider),
    externUid: result!.extern_uid,
  }, 201);
});

userRoutes.delete("/:username/linkedIdentities/:identityId", authRequired, async (c) => {
  const username = c.req.param("username");
  const identityId = c.req.param("identityId");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM user_identity WHERE id = ? AND user_id = ?")
    .bind(identityId, user.id).run();

  return c.json({});
});

// --- User Notifications ---
userRoutes.get("/:username/notifications", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM inbox WHERE receiver_id = ? ORDER BY created_ts DESC"
  ).bind(user.id).all<{ id: number; created_ts: number; sender_id: number; receiver_id: number; status: string; message: string }>();

  const senderIds = [...new Set((results || []).map((r) => r.sender_id))];
  const senderMap = new Map<number, { username: string; nickname: string; avatar_url: string }>();
  const senders = await userDB.findUsersByIds(c.env.DB, senderIds);
  for (const sender of senders) {
    senderMap.set(sender.id, {
      username: sender.username,
      nickname: sender.nickname,
      avatar_url: sender.avatar_url,
    });
  }

  const notifications = (results || []).map((row) => {
    const msg = JSON.parse(row.message || "{}");
    const sender = senderMap.get(row.sender_id);
    const statusMap: Record<string, number> = { UNREAD: 1, ARCHIVED: 2 };
    const typeMap: Record<string, number> = { MEMO_COMMENT: 1, MEMO_MENTION: 2 };

    return {
      name: `users/${username}/notifications/${row.id}`,
      sender: sender ? `users/${sender.username}` : "",
      senderUser: sender ? {
        name: `users/${sender.username}`,
        username: sender.username,
        displayName: sender.nickname || sender.username,
        avatarUrl: sender.avatar_url || "",
      } : undefined,
      status: statusMap[row.status] || 0,
      createTime: { seconds: row.created_ts, nanos: 0 },
      type: typeMap[msg.type] || 0,
      payload: msg.type === "MEMO_COMMENT" ? {
        case: "memoComment",
        value: {
          memo: msg.memo || "",
          relatedMemo: msg.relatedMemo || "",
          memoSnippet: msg.memoSnippet || "",
          relatedMemoSnippet: msg.relatedMemoSnippet || "",
        },
      } : msg.type === "MEMO_MENTION" ? {
        case: "memoMention",
        value: {
          memo: msg.memo || "",
          relatedMemo: msg.relatedMemo || "",
          memoSnippet: msg.memoSnippet || "",
          relatedMemoSnippet: msg.relatedMemoSnippet || "",
        },
      } : { case: undefined },
    };
  });

  return c.json({ notifications });
});

userRoutes.patch("/:username/notifications/:notifId", authRequired, async (c) => {
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");
  const body = await c.req.json<{ status: string | number }>();

  const statusMap: Record<number, string> = { 1: "UNREAD", 2: "ARCHIVED" };
  const status = typeof body.status === "number" ? (statusMap[body.status] || "UNREAD") : body.status;

  await c.env.DB.prepare("UPDATE inbox SET status = ? WHERE id = ? AND receiver_id = ?")
    .bind(status, notifId, currentUser.id).run();

  return c.json({});
});

userRoutes.delete("/:username/notifications/:notifId", authRequired, async (c) => {
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");

  await c.env.DB.prepare("DELETE FROM inbox WHERE id = ? AND receiver_id = ?")
    .bind(notifId, currentUser.id).run();

  return c.json({});
});

// --- Webhooks ---
function formatWebhook(webhook: webhookDB.WebhookRow, username: string) {
  return {
    name: `users/${username}/webhooks/${webhook.id}`,
    url: webhook.url,
    displayName: webhook.display_name,
    createTime: protoTimestamp(webhook.created_ts),
    updateTime: protoTimestamp(webhook.updated_ts),
  };
}

userRoutes.get("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const webhooks = await webhookDB.listWebhooksByCreatorId(c.env.DB, user.id);
  return c.json({ webhooks: webhooks.map((w) => formatWebhook(w, username)) });
});

userRoutes.post("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  const urlError = getWebhookUrlValidationError(body.url);
  if (urlError) return c.json({ error: urlError }, 400);

  const webhook = await webhookDB.createWebhook(c.env.DB, {
    creatorId: user.id,
    url: normalizeWebhookUrl(body.url)!,
    displayName: body.displayName?.trim() || "",
  });
  return c.json(formatWebhook(webhook, username), 201);
});

userRoutes.patch("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  const updateData: Partial<{ url: string; display_name: string }> = {};
  if (body.url !== undefined) {
    const urlError = getWebhookUrlValidationError(body.url);
    if (urlError) return c.json({ error: urlError }, 400);
    updateData.url = normalizeWebhookUrl(body.url)!;
  }
  if (body.displayName !== undefined) updateData.display_name = body.displayName.trim();

  const updated = await webhookDB.updateWebhook(c.env.DB, webhookId, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  return c.json(formatWebhook(updated, username));
});

userRoutes.delete("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  await webhookDB.deleteWebhook(c.env.DB, webhookId);
  return c.json({});
});

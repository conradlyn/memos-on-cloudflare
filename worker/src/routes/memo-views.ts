import { Hono, type Context } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import * as userDB from "../db/user";
import { buildMemoFilterWhere, MemoFilterError } from "../filter/memo-filter";

/**
 * Memo views — Memos v1 `UserService.ListMemoViews` and friends.
 *
 * Upstream renamed `ShortcutService` to `MemoViewService` in 0.31 and moved the
 * REST surface from `/api/v1/users/{user}/shortcuts` to
 * `/api/v1/users/{user}/views`, with the resource name
 * `users/{user}/views/{view}`. A view is a named, reusable CEL filter that the
 * client passes straight back to `ListMemos`'s `filter` argument.
 *
 * The legacy `/api/v1/shortcuts` routes stay untouched for the bundled web
 * client. Views keep their own `memo_views` setting and are seeded once from
 * the legacy `shortcuts` setting so nothing disappears on upgrade.
 */

type MemoViewApp = { Bindings: Env; Variables: { user: UserPayload } };

export const memoViewRoutes = new Hono<MemoViewApp>();

const MEMO_VIEW_SETTING_KEY = "memo_views";
const LEGACY_SHORTCUT_SETTING_KEY = "shortcuts";
const MAX_VIEWS = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_FILTER_LENGTH = 2000;
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface MemoViewIcon {
  emoji?: string;
  lucide?: string;
}

interface MemoViewRecord {
  id: string;
  title: string;
  filter: string;
  icon?: MemoViewIcon;
}

class MemoViewValidationError extends Error {}

function createViewId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function buildViewName(username: string, id: string): string {
  return `users/${username}/views/${id}`;
}

function getViewIdFromName(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const parts = name.split("/");
  const index = parts.lastIndexOf("views");
  return index >= 0 ? parts[index + 1] || undefined : undefined;
}

/** `MemoView.Icon` is a oneof: exactly one of `emoji` or `lucide`. */
function parseIcon(value: unknown): MemoViewIcon | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new MemoViewValidationError("icon must be an object with either emoji or lucide");
  }
  const raw = value as Record<string, unknown>;
  const emoji = typeof raw.emoji === "string" && raw.emoji.trim() ? raw.emoji.trim() : undefined;
  const lucide = typeof raw.lucide === "string" && raw.lucide.trim() ? raw.lucide.trim() : undefined;
  if (emoji && lucide) {
    throw new MemoViewValidationError("icon must set either emoji or lucide, not both");
  }
  if (!emoji && !lucide) {
    return undefined;
  }
  return emoji ? { emoji } : { lucide };
}

/** Lenient icon reader for data already in storage: never throws, drops garbage. */
function readStoredIcon(value: unknown): MemoViewIcon | undefined {
  try {
    return parseIcon(value);
  } catch {
    return undefined;
  }
}

function normalizeStoredView(value: unknown): MemoViewRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = getViewIdFromName(raw.name) || (typeof raw.id === "string" ? raw.id : undefined);
  if (!id || !VIEW_ID_PATTERN.test(id)) {
    return undefined;
  }
  const title = typeof raw.title === "string" ? raw.title : "";
  const filter = typeof raw.filter === "string" ? raw.filter : "";
  const icon = readStoredIcon(raw.icon);
  return { id, title, filter, ...(icon ? { icon } : {}) };
}

function formatView(username: string, view: MemoViewRecord) {
  return {
    name: buildViewName(username, view.id),
    title: view.title,
    filter: view.filter,
    ...(view.icon ? { icon: view.icon } : {}),
  };
}

async function readViews(db: D1Database, userId: number): Promise<MemoViewRecord[] | undefined> {
  const setting = await settingDB.getUserSetting(db, userId, MEMO_VIEW_SETTING_KEY);
  if (!setting) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const view = normalizeStoredView(item);
      return view ? [view] : [];
    });
  } catch {
    return [];
  }
}

async function saveViews(db: D1Database, userId: number, views: MemoViewRecord[]) {
  await settingDB.setUserSetting(db, userId, MEMO_VIEW_SETTING_KEY, JSON.stringify(views));
}

/**
 * Seeds `memo_views` from the legacy `shortcuts` setting the first time a user
 * reads their views, so upgrading does not silently empty the sidebar.
 */
async function loadViews(db: D1Database, user: userDB.UserRow): Promise<MemoViewRecord[]> {
  const existing = await readViews(db, user.id);
  if (existing) {
    return existing;
  }

  const legacy = await settingDB.getUserSetting(db, user.id, LEGACY_SHORTCUT_SETTING_KEY);
  const seeded: MemoViewRecord[] = [];
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy.value);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const view = normalizeStoredView(item);
          if (view) {
            seeded.push(view);
          }
        }
      }
    } catch {
      // A corrupt legacy value should not block the views endpoint.
    }
  }
  await saveViews(db, user.id, seeded);
  return seeded;
}

async function findTargetUser(db: D1Database, identifier: string): Promise<userDB.UserRow | null> {
  const byUsername = await userDB.findUserByUsername(db, identifier);
  if (byUsername) {
    return byUsername;
  }
  // Native clients sometimes address users by numeric id (`users/1`).
  if (/^\d+$/.test(identifier)) {
    return userDB.findUserById(db, Number(identifier));
  }
  return null;
}

async function validateViewFilter(db: D1Database, filter: string): Promise<string | undefined> {
  try {
    await buildMemoFilterWhere(db, filter);
    return undefined;
  } catch (error) {
    return error instanceof MemoFilterError ? error.message : "Invalid memo view filter";
  }
}

/** Resolves `:username` and enforces "self or admin", mirroring the settings routes. */
async function resolveViewScope(c: Context<MemoViewApp>): Promise<
  { user: userDB.UserRow; currentUser: UserPayload } | { error: Response }
> {
  const currentUser = c.get("user") as UserPayload;
  const user = await findTargetUser(c.env.DB, c.req.param("username") ?? "");
  if (!user) {
    return { error: c.json({ error: "User not found" }, 404) };
  }
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return { error: c.json({ error: "Permission denied" }, 403) };
  }
  return { user, currentUser };
}

function readViewBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {};
  }
  const raw = body as Record<string, unknown>;
  // `body: "memo_view"` transcodes to the MemoView object itself, but accept a
  // wrapped `{ memoView: {...} }` too so hand-written clients are not punished.
  const wrapped = raw.memoView ?? raw.memo_view;
  return wrapped && typeof wrapped === "object" ? (wrapped as Record<string, unknown>) : raw;
}

function readUpdateMask(c: Context<MemoViewApp>): string[] {
  const raw = c.req.query("updateMask") || c.req.query("update_mask") || "";
  return raw
    .split(",")
    .map((field: string) => field.trim())
    .filter(Boolean);
}

function maskIncludes(mask: string[], field: string): boolean {
  if (mask.length === 0) {
    return true;
  }
  return mask.some((entry) => entry === field || entry.toLowerCase() === field.toLowerCase());
}

// --- Memo views ---

memoViewRoutes.get("/users/:username/views", authRequired, async (c) => {
  const scope = await resolveViewScope(c);
  if ("error" in scope) {
    return scope.error;
  }
  const views = await loadViews(c.env.DB, scope.user);
  return c.json({ memoViews: views.map((view) => formatView(scope.user.username, view)) });
});

memoViewRoutes.get("/users/:username/views/:view", authRequired, async (c) => {
  const scope = await resolveViewScope(c);
  if ("error" in scope) {
    return scope.error;
  }
  const viewId = c.req.param("view");
  const views = await loadViews(c.env.DB, scope.user);
  const view = views.find((item) => item.id === viewId);
  if (!view) {
    return c.json({ error: "Memo view not found" }, 404);
  }
  return c.json(formatView(scope.user.username, view));
});

memoViewRoutes.post("/users/:username/views", authRequired, async (c) => {
  const scope = await resolveViewScope(c);
  if ("error" in scope) {
    return scope.error;
  }

  const body = readViewBody(await c.req.json().catch(() => ({})));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const filter = typeof body.filter === "string" ? body.filter.trim() : "";

  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return c.json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` }, 400);
  }
  if (filter.length > MAX_FILTER_LENGTH) {
    return c.json({ error: `filter must be at most ${MAX_FILTER_LENGTH} characters` }, 400);
  }

  let icon: MemoViewIcon | undefined;
  try {
    icon = parseIcon(body.icon);
  } catch (error) {
    if (error instanceof MemoViewValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  const filterError = await validateViewFilter(c.env.DB, filter);
  if (filterError) {
    return c.json({ error: filterError }, 400);
  }

  const views = await loadViews(c.env.DB, scope.user);
  if (views.length >= MAX_VIEWS) {
    return c.json({ error: `A user can have at most ${MAX_VIEWS} memo views` }, 400);
  }

  let id = createViewId();
  while (views.some((view) => view.id === id)) {
    id = createViewId();
  }

  const record: MemoViewRecord = { id, title, filter, ...(icon ? { icon } : {}) };
  views.push(record);
  await saveViews(c.env.DB, scope.user.id, views);

  return c.json(formatView(scope.user.username, record));
});

memoViewRoutes.patch("/users/:username/views/:view", authRequired, async (c) => {
  const scope = await resolveViewScope(c);
  if ("error" in scope) {
    return scope.error;
  }

  const viewId = c.req.param("view");
  const views = await loadViews(c.env.DB, scope.user);
  const index = views.findIndex((item) => item.id === viewId);
  if (index === -1) {
    return c.json({ error: "Memo view not found" }, 404);
  }

  const body = readViewBody(await c.req.json().catch(() => ({})));
  const mask = readUpdateMask(c);
  const current = views[index];

  let title = current.title;
  if (maskIncludes(mask, "title") && body.title !== undefined) {
    title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json({ error: "title cannot be empty" }, 400);
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return c.json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` }, 400);
    }
  }

  let filter = current.filter;
  if (maskIncludes(mask, "filter") && body.filter !== undefined) {
    filter = typeof body.filter === "string" ? body.filter.trim() : "";
    if (filter.length > MAX_FILTER_LENGTH) {
      return c.json({ error: `filter must be at most ${MAX_FILTER_LENGTH} characters` }, 400);
    }
    const filterError = await validateViewFilter(c.env.DB, filter);
    if (filterError) {
      return c.json({ error: filterError }, 400);
    }
  }

  let icon = current.icon;
  // With an explicit mask, only a listed `icon` touches the icon. Without a
  // mask, the field is only rewritten when the body actually carries it — that
  // way a title-only PATCH does not silently drop the icon.
  const iconTouched = mask.length > 0 ? maskIncludes(mask, "icon") : Object.prototype.hasOwnProperty.call(body, "icon");
  if (iconTouched) {
    try {
      // An omitted or null icon under an explicit `icon` mask resets to the default.
      icon = parseIcon(body.icon);
    } catch (error) {
      if (error instanceof MemoViewValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  }

  const updated: MemoViewRecord = { id: current.id, title, filter, ...(icon ? { icon } : {}) };
  views[index] = updated;
  await saveViews(c.env.DB, scope.user.id, views);

  return c.json(formatView(scope.user.username, updated));
});

memoViewRoutes.delete("/users/:username/views/:view", authRequired, async (c) => {
  const scope = await resolveViewScope(c);
  if ("error" in scope) {
    return scope.error;
  }

  const viewId = c.req.param("view");
  const views = await loadViews(c.env.DB, scope.user);
  const remaining = views.filter((item) => item.id !== viewId);
  if (remaining.length === views.length) {
    return c.json({ error: "Memo view not found" }, 404);
  }
  await saveViews(c.env.DB, scope.user.id, remaining);
  return c.json({});
});

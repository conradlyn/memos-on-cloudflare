export interface UserSettingRow {
  user_id: number;
  key: string;
  value: string;
}

export async function getUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<UserSettingRow | null> {
  return db
    .prepare("SELECT * FROM user_setting WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .first<UserSettingRow>();
}

export async function listUserSettings(
  db: D1Database,
  userId: number
): Promise<UserSettingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM user_setting WHERE user_id = ?")
    .bind(userId)
    .all<UserSettingRow>();
  return results;
}

export async function setUserSetting(
  db: D1Database,
  userId: number,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value"
    )
    .bind(userId, key, value)
    .run();
}

export async function deleteUserSetting(
  db: D1Database,
  userId: number,
  key: string
): Promise<void> {
  await db
    .prepare("DELETE FROM user_setting WHERE user_id = ? AND key = ?")
    .bind(userId, key)
    .run();
}

// --- System Settings ---

export interface SystemSettingRow {
  name: string;
  value: string;
  description: string;
}

export async function getSystemSetting(
  db: D1Database,
  name: string
): Promise<SystemSettingRow | null> {
  return db
    .prepare("SELECT * FROM system_setting WHERE name = ?")
    .bind(name)
    .first<SystemSettingRow>();
}

export async function listSystemSettings(
  db: D1Database
): Promise<SystemSettingRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM system_setting")
    .all<SystemSettingRow>();
  return results;
}

export async function setSystemSetting(
  db: D1Database,
  name: string,
  value: string,
  description?: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO system_setting (name, value, description) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value"
    )
    .bind(name, value, description || "")
    .run();
}

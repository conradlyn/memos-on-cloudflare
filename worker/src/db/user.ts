export interface UserRow {
  id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  username: string;
  role: string;
  email: string;
  nickname: string;
  password_hash: string;
  avatar_url: string;
  description: string;
}

export async function findUserByUsername(
  db: D1Database,
  username: string
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM user WHERE username = ?")
    .bind(username)
    .first<UserRow>();
}

export async function findUserById(
  db: D1Database,
  id: number
): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM user WHERE id = ?").bind(id).first<UserRow>();
}

export async function countUsers(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM user")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function createUser(
  db: D1Database,
  data: { username: string; passwordHash: string; role: string }
): Promise<UserRow> {
  const result = await db
    .prepare(
      "INSERT INTO user (username, password_hash, role) VALUES (?, ?, ?) RETURNING *"
    )
    .bind(data.username, data.passwordHash, data.role)
    .first<UserRow>();
  return result!;
}

export async function listUsers(
  db: D1Database,
  opts?: { rowStatus?: string }
): Promise<UserRow[]> {
  let query = "SELECT * FROM user";
  const params: string[] = [];

  if (opts?.rowStatus) {
    query += " WHERE row_status = ?";
    params.push(opts.rowStatus);
  }

  query += " ORDER BY created_ts DESC";

  const stmt = params.length > 0
    ? db.prepare(query).bind(...params)
    : db.prepare(query);

  const { results } = await stmt.all<UserRow>();
  return results;
}

export async function updateUser(
  db: D1Database,
  id: number,
  data: Partial<{
    username: string;
    nickname: string;
    email: string;
    avatar_url: string;
    description: string;
    password_hash: string;
    role: string;
    row_status: string;
  }>
): Promise<UserRow | null> {
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return findUserById(db, id);

  fields.push("updated_ts = strftime('%s', 'now')");
  values.push(id);

  const query = `UPDATE user SET ${fields.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(query).bind(...values).first<UserRow>();
}

export async function deleteUser(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM user WHERE id = ?").bind(id).run();
}

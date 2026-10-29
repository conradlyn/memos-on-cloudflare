export interface MemoRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  content: string;
  visibility: string;
  pinned: number;
  payload: string;
}

export interface ListMemosOpts {
  creatorId?: number;
  rowStatus?: string;
  visibility?: string;
  visibilities?: string[];
  excludeComments?: boolean;
  pinned?: boolean;
  contentSearch?: string;
  tagSearch?: string;
  createdTsAfter?: number;
  createdTsBefore?: number;
  filterWhere?: string;
  filterParams?: (string | number)[];
  pageSize?: number;
  offset?: number;
  orderBy?: string;
  readableByUserId?: number;
}

export async function createMemo(
  db: D1Database,
  data: {
    uid: string;
    creatorId: number;
    content: string;
    visibility: string;
    payload?: string;
    createdTs?: number;
    updatedTs?: number;
    pinned?: boolean;
  }
): Promise<MemoRow> {
  const payload = data.payload || "{}";
  const pinned = data.pinned ? 1 : 0;

  let query: string;
  let params: (string | number)[];

  if (data.createdTs && data.updatedTs) {
    query = `INSERT INTO memo (uid, creator_id, content, visibility, payload, pinned, created_ts, updated_ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;
    params = [data.uid, data.creatorId, data.content, data.visibility, payload, pinned, data.createdTs, data.updatedTs];
  } else {
    query = `INSERT INTO memo (uid, creator_id, content, visibility, payload, pinned)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`;
    params = [data.uid, data.creatorId, data.content, data.visibility, payload, pinned];
  }

  return (await db.prepare(query).bind(...params).first<MemoRow>())!;
}

export async function getMemoByUid(
  db: D1Database,
  uid: string
): Promise<MemoRow | null> {
  return db.prepare("SELECT * FROM memo WHERE uid = ?").bind(uid).first<MemoRow>();
}

export async function getMemoById(
  db: D1Database,
  id: number
): Promise<MemoRow | null> {
  return db.prepare("SELECT * FROM memo WHERE id = ?").bind(id).first<MemoRow>();
}

export async function listMemos(
  db: D1Database,
  opts: ListMemosOpts
): Promise<{ memos: MemoRow[]; total: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.creatorId !== undefined) {
    conditions.push("creator_id = ?");
    params.push(opts.creatorId);
  }
  if (opts.rowStatus) {
    conditions.push("row_status = ?");
    params.push(opts.rowStatus);
  }
  if (opts.visibility) {
    conditions.push("visibility = ?");
    params.push(opts.visibility);
  }
  if (opts.visibilities && opts.visibilities.length > 0) {
    const placeholders = opts.visibilities.map(() => "?").join(", ");
    conditions.push(`visibility IN (${placeholders})`);
    params.push(...opts.visibilities);
  }
  if (opts.pinned !== undefined) {
    conditions.push("pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.excludeComments) {
    conditions.push("json_extract(payload, '$.parent') IS NULL");
  }
  if (opts.contentSearch) {
    conditions.push("content LIKE ?");
    params.push(`%${opts.contentSearch}%`);
  }
  if (opts.tagSearch) {
    conditions.push("payload LIKE ?");
    params.push(`%${opts.tagSearch}%`);
  }
  if (opts.createdTsAfter !== undefined) {
    conditions.push("created_ts >= ?");
    params.push(opts.createdTsAfter);
  }
  if (opts.createdTsBefore !== undefined) {
    conditions.push("created_ts < ?");
    params.push(opts.createdTsBefore);
  }
  if (opts.filterWhere) {
    conditions.push(`(${opts.filterWhere})`);
    params.push(...(opts.filterParams || []));
  }
  if (opts.readableByUserId !== undefined) {
    conditions.push("(visibility IN ('PUBLIC', 'PROTECTED') OR creator_id = ?)");
    params.push(opts.readableByUserId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countQuery = `SELECT COUNT(*) as total FROM memo ${where}`;
  const countResult = await db.prepare(countQuery).bind(...params).first<{ total: number }>();
  const total = countResult?.total ?? 0;

  let orderClause = "ORDER BY pinned DESC, created_ts DESC";
  if (opts.orderBy) {
    const allowedOrderColumns = new Set(["id", "created_ts", "updated_ts", "pinned"]);
    const parts = opts.orderBy.split(",").map((p) => p.trim());
    const orderParts: string[] = [];
    for (const part of parts) {
      const [field, dir] = part.split(" ");
      const col = field === "create_time" ? "created_ts" : field === "update_time" ? "updated_ts" : field;
      if (allowedOrderColumns.has(col)) {
        orderParts.push(`${col} ${dir?.toUpperCase() === "ASC" ? "ASC" : "DESC"}`);
      }
    }
    if (orderParts.length > 0) {
      orderClause = `ORDER BY ${orderParts.join(", ")}`;
    }
  }

  const pageSize = opts.pageSize || 50;
  const offset = opts.offset || 0;

  const dataQuery = `SELECT * FROM memo ${where} ${orderClause} LIMIT ? OFFSET ?`;
  const allParams = [...params, pageSize, offset];
  const { results } = await db.prepare(dataQuery).bind(...allParams).all<MemoRow>();

  return { memos: results, total };
}

export async function updateMemo(
  db: D1Database,
  id: number,
  data: Partial<{
    content: string;
    visibility: string;
    pinned: number;
    row_status: string;
    payload: string;
    created_ts: number;
    updated_ts: number;
  }>
): Promise<MemoRow | null> {
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getMemoById(db, id);

  if (!data.updated_ts) {
    fields.push("updated_ts = strftime('%s', 'now')");
  }
  values.push(id);

  const query = `UPDATE memo SET ${fields.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(query).bind(...values).first<MemoRow>();
}

/**
 * Deletes a memo together with its whole comment thread and every record that
 * points at those memos.
 *
 * Comments are ordinary memo rows whose `payload.parent` names the parent memo as
 * a resource (`memos/{uid}`), so removing only the parent row would leave every
 * reply orphaned: still stored, still counted, but unreachable through the API.
 * Relations, reactions and shares reference memos by id or uid and would rot the
 * same way, so they are cleared in the same transaction.
 *
 * Traversal is iterative rather than recursive so a deep thread cannot exhaust the
 * stack, and it walks to a fixed point because a reply may itself be replied to.
 */
export async function deleteMemo(db: D1Database, id: number): Promise<void> {
  const ids = new Set<number>([id]);
  const uids = new Set<string>();
  const root = await db.prepare("SELECT uid FROM memo WHERE id = ?").bind(id).first<{ uid: string }>();

  if (root?.uid) {
    uids.add(root.uid);
    const queue: string[] = [`memos/${root.uid}`];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const { results } = await db
        .prepare("SELECT id, uid FROM memo WHERE json_extract(payload, '$.parent') = ?")
        .bind(parent)
        .all<{ id: number; uid: string }>();

      for (const row of results || []) {
        if (ids.has(row.id)) {
          continue;
        }
        ids.add(row.id);
        uids.add(row.uid);
        queue.push(`memos/${row.uid}`);
      }
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const memoId of ids) {
    statements.push(db.prepare("DELETE FROM memo_relation WHERE memo_id = ? OR related_memo_id = ?").bind(memoId, memoId));
    statements.push(db.prepare("DELETE FROM memo_share WHERE memo_id = ?").bind(memoId));
    // Attachments outlive the memo: the file stays addressable, it just loses its owner.
    statements.push(db.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memoId));
  }
  for (const uid of uids) {
    statements.push(db.prepare("DELETE FROM reaction WHERE content_id = ?").bind(uid));
  }
  for (const memoId of ids) {
    statements.push(db.prepare("DELETE FROM memo WHERE id = ?").bind(memoId));
  }

  // D1 caps how much a single batch may carry, so long threads are flushed in slices.
  // Ordinary threads fit in one batch and stay atomic; oversized ones degrade to
  // several atomic batches rather than failing outright.
  const CHUNK_SIZE = 40;
  for (let index = 0; index < statements.length; index += CHUNK_SIZE) {
    await db.batch(statements.slice(index, index + CHUNK_SIZE));
  }
}

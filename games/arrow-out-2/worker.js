const MAX_BODY_BYTES = 200_000;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
const MIN_TIME_MS = 3_000;
const MAX_TIME_MS = 86_400_000;
const SCORE_LIMIT = 10;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/arrows.json" && request.method === "GET") {
        return await getArrows(request, env);
      }

      if (path === "/api/archive" && request.method === "GET") {
        return await listArchive(env);
      }

      if (path === "/api/scores" && request.method === "GET") {
        return await listScores(request, env);
      }

      if (path === "/api/scores" && request.method === "POST") {
        return await submitScore(request, env);
      }

      if (path === "/api/admin/levels" && request.method === "GET") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return await listLevels(env);
      }

      if (path === "/api/admin/levels" && request.method === "POST") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return await publishLevel(request, env);
      }

      if (path === "/api/admin/current" && request.method === "POST") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        return await setCurrentLevel(request, env);
      }

      if (path.startsWith("/api/")) {
        return jsonError(404, "not found");
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("worker error", err);
      return jsonError(500, "internal error");
    }
  },
};

function arrowsResponse(payload) {
  return new Response(payload, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getArrows(request, env) {
  const id = parsePositiveInt(new URL(request.url).searchParams.get("id"));
  if (id instanceof Response) return id;

  try {
    if (id != null) {
      const row = await env.DB.prepare(
        "SELECT payload FROM levels WHERE id = ?"
      )
        .bind(id)
        .first();
      if (!row?.payload) return jsonError(404, "level not found");
      return arrowsResponse(row.payload);
    }

    const row = await env.DB.prepare(
      `SELECT l.payload AS payload
       FROM current_level c
       JOIN levels l ON l.id = c.level_id
       WHERE c.id = 1`
    ).first();

    if (!row?.payload) {
      return env.ASSETS.fetch(request);
    }

    return arrowsResponse(row.payload);
  } catch (err) {
    if (id != null) {
      console.error("d1 level read failed", err);
      return jsonError(500, "internal error");
    }
    console.error("d1 current level read failed; serving bundled arrows.json", err);
    return env.ASSETS.fetch(request);
  }
}

async function listArchive(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT l.id, l.seed, l.created_at,
              CASE WHEN c.level_id = l.id THEN 1 ELSE 0 END AS is_current
       FROM levels l
       LEFT JOIN current_level c ON c.id = 1
       ORDER BY l.id ASC
       LIMIT 100`
    ).all();

    const levels = (result.results ?? []).map((row) => ({
      id: row.id,
      seed: row.seed,
      created_at: row.created_at,
      is_current: row.is_current === 1,
    }));

    return Response.json(
      { levels },
      { headers: { ...JSON_HEADERS, "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("d1 archive list failed", err);
    return jsonError(500, "internal error");
  }
}

function parsePositiveInt(raw) {
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return jsonError(400, "id must be a positive integer");
  }
  return id;
}

const BEST_SCORES_SQL = `
  WITH best AS (
    SELECT
      name,
      time_ms,
      lives_left,
      created_at,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(name)
        ORDER BY time_ms ASC, lives_left DESC, created_at ASC
      ) AS rn
    FROM scores
    WHERE level_id = ?
  )
  SELECT name, time_ms, lives_left, created_at
  FROM best
  WHERE rn = 1
  ORDER BY time_ms ASC, lives_left DESC, created_at ASC
`;

async function resolveLevelId(rawId, env) {
  if (rawId instanceof Response) return rawId;
  if (rawId != null) {
    const row = await env.DB.prepare("SELECT id FROM levels WHERE id = ?")
      .bind(rawId)
      .first();
    if (!row) return jsonError(404, "level not found");
    return rawId;
  }

  const row = await env.DB.prepare(
    "SELECT level_id AS id FROM current_level WHERE id = 1"
  ).first();
  if (!row?.id) return jsonError(404, "level not found");
  return row.id;
}

function mapScoreEntries(rows) {
  return (rows ?? []).map((row, i) => ({
    rank: i + 1,
    name: row.name,
    time_ms: row.time_ms,
    lives_left: row.lives_left,
    created_at: row.created_at,
  }));
}

async function listScores(request, env) {
  const id = await resolveLevelId(
    parsePositiveInt(new URL(request.url).searchParams.get("id")),
    env
  );
  if (id instanceof Response) return id;

  try {
    const result = await env.DB.prepare(`${BEST_SCORES_SQL} LIMIT ?`)
      .bind(id, SCORE_LIMIT)
      .all();

    return Response.json(
      { level_id: id, entries: mapScoreEntries(result.results) },
      { headers: { ...JSON_HEADERS, "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("d1 scores list failed", err);
    return jsonError(500, "internal error");
  }
}

async function rankForName(env, levelId, name) {
  const result = await env.DB.prepare(BEST_SCORES_SQL).bind(levelId).all();
  const key = name.toLowerCase();
  const entries = mapScoreEntries(result.results);
  const found = entries.find((row) => row.name.toLowerCase() === key);
  return found?.rank ?? null;
}

function parseScoreName(raw) {
  if (typeof raw !== "string") return jsonError(400, "name is required");
  const name = raw.trim();
  if (!NAME_RE.test(name)) {
    return jsonError(400, "name must be 1-16 letters, numbers, spaces, _ or -");
  }
  return name;
}

function parseTimeMs(raw) {
  const timeMs = Number(raw);
  if (!Number.isInteger(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) {
    return jsonError(400, "time_ms must be an integer between 3000 and 86400000");
  }
  return timeMs;
}

function parseLivesLeft(raw) {
  const livesLeft = Number(raw);
  if (!Number.isInteger(livesLeft) || livesLeft < 0 || livesLeft > 3) {
    return jsonError(400, "lives_left must be an integer between 0 and 3");
  }
  return livesLeft;
}

async function submitScore(request, env) {
  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;

  const id = await resolveLevelId(parsePositiveInt(parsed.id), env);
  if (id instanceof Response) return id;

  const name = parseScoreName(parsed.name);
  if (name instanceof Response) return name;

  const timeMs = parseTimeMs(parsed.time_ms);
  if (timeMs instanceof Response) return timeMs;

  const livesLeft = parseLivesLeft(parsed.lives_left);
  if (livesLeft instanceof Response) return livesLeft;

  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO scores (level_id, name, time_ms, lives_left)
       VALUES (?, ?, ?, ?)
       RETURNING id`
    )
      .bind(id, name, timeMs, livesLeft)
      .first();

    const scoreId = inserted?.id;
    if (scoreId == null) return jsonError(500, "failed to insert score");

    const rank = await rankForName(env, id, name);
    return Response.json(
      { id: scoreId, rank, level_id: id },
      { status: 201, headers: JSON_HEADERS }
    );
  } catch (err) {
    console.error("d1 score insert failed", err);
    return jsonError(500, "internal error");
  }
}

async function listLevels(env) {
  const result = await env.DB.prepare(
    `SELECT l.id, l.seed, l.created_at,
            CASE WHEN c.level_id = l.id THEN 1 ELSE 0 END AS is_current
     FROM levels l
     LEFT JOIN current_level c ON c.id = 1
     ORDER BY l.id DESC
     LIMIT 100`
  ).all();

  return Response.json({ levels: result.results ?? [] }, { headers: JSON_HEADERS });
}

async function publishLevel(request, env) {
  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;

  const error = validatePuzzle(parsed);
  if (error) return jsonError(400, error);

  const payload = JSON.stringify(parsed);
  if (payload.length > MAX_BODY_BYTES) {
    return jsonError(413, "payload too large");
  }

  const seed = typeof parsed.seed === "string" || typeof parsed.seed === "number"
    ? String(parsed.seed)
    : null;

  const inserted = await env.DB.prepare(
    "INSERT INTO levels (seed, payload) VALUES (?, ?) RETURNING id"
  )
    .bind(seed, payload)
    .first();

  const id = inserted?.id;
  if (id == null) return jsonError(500, "failed to insert level");

  await env.DB.prepare(
    `INSERT INTO current_level (id, level_id) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET level_id = excluded.level_id`
  )
    .bind(id)
    .run();

  return Response.json({ id, seed }, { status: 201, headers: JSON_HEADERS });
}

async function setCurrentLevel(request, env) {
  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;

  const id = Number(parsed.id);
  if (!Number.isInteger(id) || id < 1) {
    return jsonError(400, "id must be a positive integer");
  }

  const existing = await env.DB.prepare("SELECT id FROM levels WHERE id = ?")
    .bind(id)
    .first();
  if (!existing) return jsonError(404, "level not found");

  await env.DB.prepare(
    `INSERT INTO current_level (id, level_id) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET level_id = excluded.level_id`
  )
    .bind(id)
    .run();

  return Response.json({ id }, { headers: JSON_HEADERS });
}

async function requireAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return jsonError(401, "admin token is not configured");

  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return jsonError(401, "unauthorized");

  const provided = header.slice(prefix.length);
  if (!(await tokenEquals(provided, expected))) {
    return jsonError(401, "unauthorized");
  }
  return null;
}

async function tokenEquals(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aa.byteLength; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function readJsonObject(request) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return jsonError(413, "payload too large");
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return jsonError(400, "invalid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError(400, "JSON body must be an object");
  }
  return parsed;
}

function validatePuzzle(data) {
  if (typeof data.grid !== "number" || !Number.isFinite(data.grid) || data.grid < 1) {
    return "grid must be a positive number";
  }
  if (!Array.isArray(data.arrows) || data.arrows.length === 0) {
    return "arrows must be a non-empty array";
  }
  for (let i = 0; i < data.arrows.length; i++) {
    const arrow = data.arrows[i];
    if (arrow === null || typeof arrow !== "object" || Array.isArray(arrow)) {
      return `arrows[${i}] must be an object`;
    }
    if (typeof arrow.color !== "number" || !Number.isFinite(arrow.color)) {
      return `arrows[${i}].color must be a number`;
    }
    if (!Array.isArray(arrow.cells) || arrow.cells.length < 2) {
      return `arrows[${i}].cells must have at least 2 points`;
    }
    for (let j = 0; j < arrow.cells.length; j++) {
      const cell = arrow.cells[j];
      if (
        !Array.isArray(cell) ||
        cell.length !== 3 ||
        cell.some((n) => typeof n !== "number" || !Number.isFinite(n))
      ) {
        return `arrows[${i}].cells[${j}] must be [x, y, z] numbers`;
      }
    }
  }
  return null;
}

function jsonError(status, error) {
  return Response.json({ error }, { status, headers: JSON_HEADERS });
}

// One private benchmark node serves one shared job at a time. The public side
// only creates fixed jobs and reads their status; it cannot choose an RPC or command.
const heartbeatWindow = 45_000;
// Claimed jobs can survive short relay outages while the node continues the benchmark.
const activeLease = 3 * 60_000;
const runTimeout = 15 * 60_000;
const cooldown = 60_000;
const retention = 60 * 60_000;
const tables = [
  "CREATE TABLE IF NOT EXISTS framilier_runner (slot INTEGER PRIMARY KEY, seen INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS framilier_runs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, ended INTEGER,
    owner TEXT, lease INTEGER, policy TEXT, result TEXT)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS framilier_one_job ON framilier_runs ((1)) WHERE state IN ('queued','running')",
];
const ready = new WeakMap();

export function initialize(db) {
  if (!ready.has(db)) {
    ready.set(
      db,
      db.batch(tables.map((sql) => db.prepare(sql))).catch((error) => {
        ready.delete(db);
        throw error;
      })
    );
  }
  return ready.get(db);
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function publicJob(row) {
  const data = {
    id: row.id,
    status: row.state === "queued" ? "running" : row.state,
    startedAt: new Date(row.created).toISOString(),
  };
  if (row.policy) data.policy = row.policy;
  if (row.state === "complete") data.result = JSON.parse(row.result);
  if (row.state === "failed")
    data.error = "The isolated runner could not finish this comparison. Please try again.";
  return data;
}

function authorized(request, secret) {
  const bearer = request.headers.get("authorization") || "";
  if (bearer.length !== secret.length + 7 || !bearer.startsWith("Bearer ")) return false;
  let difference = 0;
  for (let i = 0; i < secret.length; i++) difference |= secret.charCodeAt(i) ^ bearer.charCodeAt(i + 7);
  return difference === 0;
}

function expire(db, now) {
  return db
    .prepare(
      `UPDATE framilier_runs SET state='failed',ended=?,owner=NULL
    WHERE state IN ('running','queued') AND (created<=? OR lease<=?)`
    )
    .bind(now, now - runTimeout, now);
}

const validId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value);

async function readMessage(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Missing message");
  const decoder = new TextDecoder();
  let length = 0,
    body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24_576) {
      await reader.cancel();
      throw Error("Message too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

async function privateRoute(path, request, db, now) {
  let body;
  try {
    body = await readMessage(request);
  } catch {
    return json({ error: "Invalid message." }, 400);
  }
  if (!validId(body?.runner)) return json({ error: "Invalid runner ID." }, 400);
  if (path === "/_runner/poll") {
    const query = db
      .prepare(`SELECT id FROM framilier_runs WHERE owner=? AND state='running'`)
      .bind(body.runner);
    const batch = await db.batch([
      expire(db, now),
      db
        .prepare(
          "INSERT INTO framilier_runner (slot,seen) VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET seen=excluded.seen"
        )
        .bind(now),
      db
        .prepare(
          `UPDATE framilier_runs SET state='running', owner=?, lease=?
        WHERE state='queued' OR (state='running' AND owner=?)`
        )
        .bind(body.runner, now + activeLease, body.runner),
      query,
    ]);
    return json({ id: batch.at(-1).results[0]?.id ?? null });
  }

  if (!validId(body.id) || !["running", "complete", "failed"].includes(body.status))
    return json({ error: "Invalid job update." }, 400);
  const policy = ["off", "fifo", "fair"].includes(body.policy) ? body.policy : null;
  if (body.status === "complete") {
    const result = body.result;
    if (
      result?.source !== "live" ||
      result.chainId !== 8141337 ||
      result.rounds !== 1 ||
      result.burst !== 8 ||
      !["off", "fifo", "fair"].every((p) => result.policies?.[p])
    )
      return json({ error: "Invalid live result." }, 400);
  }
  const terminal = body.status !== "running";
  const update = await db
    .prepare(
      `UPDATE framilier_runs SET state=?,policy=COALESCE(?,policy),result=?,ended=?,lease=?
    WHERE id=? AND owner=? AND state='running' AND lease>? AND created>?`
    )
    .bind(
      body.status,
      policy,
      body.status === "complete" ? JSON.stringify(body.result) : null,
      terminal ? now : null,
      now + activeLease,
      body.id,
      body.runner,
      now,
      now - runTimeout
    )
    .run();
  if (update.meta.changes) {
    if (terminal) {
      // The final report also announces that the runner is available for the next job.
      await db.prepare("UPDATE framilier_runner SET seen=? WHERE slot=1 AND seen<?").bind(now, now).run();
    }
    return json({ ok: true });
  }
  if (terminal) {
    // A lost acknowledgement must permit retrying a delivered terminal result.
    const delivered = await db.prepare("SELECT id FROM framilier_runs WHERE id=? AND owner=? AND state=?")
      .bind(body.id, body.runner, body.status).first();
    if (delivered) return json({ ok: true });
  }
  return json({ error: "Lease expired." }, 409);
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const privatePath = path === "/_runner/poll" || path === "/_runner/report";
  const readId = path.startsWith("/api/runs/") && path.slice(10);
  if (!privatePath && path !== "/api/runs" && !validId(readId)) return json({ error: "Unknown route." }, 404);
  if (request.method !== (readId ? "GET" : "POST")) return json({ error: "Method unavailable." }, 405);
  if (!env.DB || typeof env.FRAMILIER_RUNNER_TOKEN !== "string" || env.FRAMILIER_RUNNER_TOKEN.length < 32) {
    return json({ error: "The live runner is offline. You can still view the saved comparison." }, 503);
  }
  if (privatePath && !authorized(request, env.FRAMILIER_RUNNER_TOKEN))
    return json({ error: "Unauthorized." }, 401);
  const origin = request.headers.get("origin");
  if (
    !privatePath &&
    (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== url.origin))
  ) {
    return json({ error: "Use the demo's own page." }, 403);
  }

  if (path === "/api/runs" && request.headers.get("x-framilier-run") !== "1")
    return json({ error: "Start the comparison from this page." }, 403);
  if (path === "/api/runs" && request.body !== null) {
    // Some edge runtimes represent a length-zero POST as an empty stream.
    const reader = request.body.getReader();
    const { done } = await reader.read();
    if (!done) {
      await reader.cancel();
      return json({ error: "This comparison accepts no parameters." }, 400);
    }
  }

  const db = env.DB,
    now = Date.now();
  await initialize(db);
  if (privatePath) return privateRoute(path, request, db, now);
  if (readId) {
    let row = await db
      .prepare("SELECT * FROM framilier_runs WHERE id=? AND created>?")
      .bind(readId, now - retention)
      .first();
    if (
      row &&
      ["queued", "running"].includes(row.state) &&
      (row.created <= now - runTimeout || row.lease <= now)
    ) {
      await expire(db, now).run();
      row = await db.prepare("SELECT * FROM framilier_runs WHERE id=?").bind(readId).first();
    }
    return row ? json(publicJob(row)) : json({ error: "This comparison has expired." }, 404);
  }

  const id = crypto.randomUUID();
  const result = await db.batch([
    db.prepare("DELETE FROM framilier_runs WHERE created<=?").bind(now - retention),
    expire(db, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO framilier_runs (id,state,created,lease)
      SELECT ?, 'queued', ?, ? WHERE EXISTS (SELECT 1 FROM framilier_runner WHERE slot=1 AND seen>?)
      AND NOT EXISTS (SELECT 1 FROM framilier_runs WHERE ended>?)`
      )
      .bind(id, now, now + heartbeatWindow, now - heartbeatWindow, now - cooldown),
    db.prepare("SELECT * FROM framilier_runs WHERE state IN ('queued','running')"),
    db.prepare("SELECT seen FROM framilier_runner WHERE slot=1"),
    db.prepare("SELECT MAX(ended) AS ended FROM framilier_runs"),
  ]);
  const current = result[3].results[0];
  if (current) return json(publicJob(current), 202);
  if (!(result[4].results[0]?.seen > now - heartbeatWindow)) {
    return json({ error: "The live runner is offline. You can still view the saved comparison." }, 503);
  }
  const seconds = Math.max(1, Math.ceil((result[5].results[0].ended + cooldown - now) / 1000));
  return json({ error: `The runner is cooling down. Try again in ${seconds}s.` }, 429, {
    "Retry-After": String(seconds),
  });
}

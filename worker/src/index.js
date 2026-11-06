/**
 * NextGen Smart Classroom — API Worker
 * Cloudflare Worker + D1 + static assets
 *
 * Routes under /api/*
 * Non-API paths are served from the ASSETS binding (public/).
 */

const COOKIE_NAME = 'ngsc_session';
const SESSION_TTL = 60 * 60 * 8; // 8 hours

const corsHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...extra },
  });

const fail = (message, status = 400) => json({ error: message }, status);

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function makeSession(username, secret) {
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        sub: username,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
      })
    )
  );
  return `${payload}.${b64url(await sign(payload, secret))}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readSession(request, secret) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const value = match.slice(COOKIE_NAME.length + 1);
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  try {
    const expected = await sign(parts[0], secret);
    const actual = decodeB64url(parts[1]);
    if (!timingSafeEqual(expected, actual)) return null;
    const p = JSON.parse(new TextDecoder().decode(decodeB64url(parts[0])));
    if (!p.sub || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p.sub;
  } catch {
    return null;
  }
}

function cookie(value, maxAge = SESSION_TTL) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function mapRecord(r) {
  return {
    id: r.id,
    qrToken: r.qr_token,
    category: r.category,
    pcNumber: r.pc_number || '',
    fullName: r.full_name,
    grade: r.grade || '',
    section: r.section || '',
    school: r.school || '',
    office: r.office || '',
    position: r.position || '',
    preTest: r.pre_test,
    postTest: r.post_test,
    feedback: r.feedback || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: !!r.archived,
    archivedAt: r.archived_at || null,
    archivedBy: r.archived_by || null,
  };
}

function cleanString(v, max = 160) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function cleanScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/**
 * Normalize and validate a registration payload.
 * Visitors are not required to provide scores.
 * Students must provide PC Number.
 */
function normalize(body) {
  const category = ['student', 'employee', 'visitor'].includes(body.category)
    ? body.category
    : null;
  if (!category) throw new Error('Choose a valid registration category.');

  const fullName = cleanString(body.fullName, 160);
  const pcNumber = cleanString(body.pcNumber, 40);
  if (!fullName) throw new Error('Full name is required.');
  if (category === 'student' && !pcNumber) {
    throw new Error('PC Number is required for student records.');
  }

  const preTest = cleanScore(body.preTest);
  const postTest = cleanScore(body.postTest);
  if (Number.isNaN(preTest) || Number.isNaN(postTest)) {
    throw new Error('Scores must be non-negative numbers.');
  }

  return {
    category,
    pcNumber,
    fullName,
    grade: category === 'student' ? cleanString(body.grade, 80) : null,
    section: category === 'student' ? cleanString(body.section, 100) : null,
    school: category === 'student' ? cleanString(body.school, 160) : null,
    office: category !== 'student' ? cleanString(body.office, 160) : null,
    position: category !== 'student' ? cleanString(body.position, 120) : null,
    preTest,
    postTest,
    feedback: cleanString(body.feedback, 2000),
  };
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function requireUser(request, env) {
  if (!env.SESSION_SECRET) return { error: 'SESSION_SECRET is not configured.' };
  const user = await readSession(request, env.SESSION_SECRET);
  return user ? { user } : { error: 'Authentication required.' };
}

/** Dataset generation — bumped on permanent wipe so stale offline queues are rejected */
async function ensureAppMetaTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
}

async function getDataGeneration(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM app_meta WHERE key = 'data_generation'"
    ).first();
    if (row && row.value != null) {
      const n = parseInt(String(row.value), 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
  } catch (_) {
    try {
      await ensureAppMetaTable(env);
    } catch (__) { /* ignore */ }
  }
  return 1;
}

async function bumpDataGeneration(env) {
  const current = await getDataGeneration(env);
  const next = current + 1;
  const ts = now();
  await ensureAppMetaTable(env);
  // INSERT OR REPLACE avoids ON CONFLICT edge cases across D1 SQLite versions
  await env.DB.prepare(
    `INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('data_generation', ?, ?)`
  ).bind(String(next), ts).run();
  return next;
}

async function writeAudit(env, { action, recordId, actor, details }) {
  const id = uuid();
  const ts = now();
  // Prefer schema with details; fall back if column missing on older D1 DBs
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, action, record_id, actor, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, action, recordId || null, actor, details != null ? JSON.stringify(details) : null, ts).run();
    return id;
  } catch (e1) {
    try {
      await env.DB.prepare(
        `INSERT INTO audit_logs (id, action, record_id, actor, previous_pre_test, previous_post_test, new_pre_test, new_post_test, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
      ).bind(id, action, recordId || null, actor, ts).run();
      return id;
    } catch (e2) {
      console.error('[NextGen] audit write failed', action, String(e2 && e2.message ? e2.message : e2));
      return null;
    }
  }
}

// In-memory lock to reduce concurrent wipe races on the same isolate
let wipeInProgress = false;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return saltB64 + ':' + hashB64;
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return computed === hashB64;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Serve static assets for all non-API routes
    if (!path.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return fail('Not found.', 404);
    }

    // ---------- Health (public) ----------
    if (path === '/api/health' && method === 'GET') {
      return json({ ok: true });
    }

    // ---------- Login (public) — sets HttpOnly session cookie ----------
    if (path === '/api/login' && method === 'POST') {
      if (!env.SESSION_SECRET) {
        return fail('SESSION_SECRET is not configured on the Worker.', 503);
      }
      let body;
      try { body = await bodyJson(request); } catch (e) { return fail(e.message); }
      const username = cleanString(body.username, 80);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) return fail('Username and password are required.');

      let ok = false;
      // Primary admin from environment secrets
      if (
        env.ADMIN_USERNAME &&
        env.ADMIN_PASSWORD &&
        username === env.ADMIN_USERNAME &&
        password === env.ADMIN_PASSWORD
      ) {
        ok = true;
      }
      // Optional additional staff accounts in D1 users table
      if (!ok) {
        try {
          const row = await env.DB.prepare(
            'SELECT password_hash FROM users WHERE username = ?'
          ).bind(username).first();
          if (row && row.password_hash) {
            ok = await verifyPassword(password, row.password_hash);
          }
        } catch (_) { /* users table may be empty */ }
      }

      if (!ok) return fail('Invalid username or password.', 401);

      const token = await makeSession(username, env.SESSION_SECRET);
      return json(
        { ok: true, user: { username } },
        200,
        { 'Set-Cookie': cookie(token) }
      );
    }

    // ---------- Logout (public) — clears session cookie ----------
    if (path === '/api/logout' && method === 'POST') {
      return json(
        { ok: true },
        200,
        { 'Set-Cookie': cookie('', 0) }
      );
    }

    // ---------- Public PC Number lookup (read-only, never creates) ----------
    if (path === '/api/lookup-pc' && method === 'GET') {
      const pc = cleanString(url.searchParams.get('pc'), 40);
      if (!pc) return fail('PC Number is required.');
      const { results = [] } = await env.DB.prepare(
        'SELECT * FROM records WHERE pc_number = ? ORDER BY created_at DESC'
      ).bind(pc).all();
      if (!results.length) return fail('No record found for that PC Number.', 404);
      return json({ records: results.map(mapRecord) });
    }


    // ---------- Public record deletion (no login required) ----------
    const publicDeleteMatch = path.match(/^\/api\/records\/([^/]+)$/);
    if (publicDeleteMatch && method === 'DELETE') {
      const id = decodeURIComponent(publicDeleteMatch[1]);
      try {
        const result = await env.DB.prepare('DELETE FROM records WHERE id = ?').bind(id).run();
        if (!result.meta.changes) return fail('Record not found.', 404);
        return json({ ok: true });
      } catch (e) {
        return fail('Could not delete the record.', 500);
      }
    }

    // ---------- Public registration (no login required) ----------
    if (path === '/api/records' && method === 'POST') {
      let body, data;
      try {
        body = await bodyJson(request);
        data = normalize(body);
      } catch (e) {
        return fail(e.message);
      }
      const id = uuid();
      const qrToken = uuid().replace(/-/g, '') + uuid().replace(/-/g, '').slice(0, 16);
      const ts = now();
      try {
        await env.DB.prepare(
          `INSERT INTO records (
            id, qr_token, category, pc_number, full_name, grade, section, school,
            office, position, pre_test, post_test, feedback, created_at, updated_at,
            created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            id,
            qrToken,
            data.category,
            data.pcNumber,
            data.fullName,
            data.grade,
            data.section,
            data.school,
            data.office,
            data.position,
            data.preTest,
            data.postTest,
            data.feedback,
            ts,
            ts,
            'public',
            'public'
          )
          .run();
        const r = await env.DB.prepare('SELECT * FROM records WHERE id = ?')
          .bind(id)
          .first();
        return json({ record: mapRecord(r) }, 201);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return fail('That PC Number is already registered in this category.', 409);
        }
        return fail('Could not save the record.', 500);
      }
    }



    // ---------- Public records list (for overview) — active records only ----------
    if (path === '/api/records' && method === 'GET') {
      const includeArchived = url.searchParams.get('archived') === '1' || url.searchParams.get('include_archived') === '1';
      const onlyArchived = url.searchParams.get('archived') === 'only';
      try {
        let sql = 'SELECT * FROM records WHERE COALESCE(archived, 0) = 0 ORDER BY created_at DESC';
        if (onlyArchived) sql = 'SELECT * FROM records WHERE archived = 1 ORDER BY archived_at DESC, created_at DESC';
        else if (includeArchived) sql = 'SELECT * FROM records ORDER BY created_at DESC';
        const { results = [] } = await env.DB.prepare(sql).all();
        const dataGeneration = await getDataGeneration(env);
        return json({ records: results.map(mapRecord), dataGeneration });
      } catch (e) {
        // Production D1 may not have the archived column yet — fall back safely
        const msg = String(e && e.message ? e.message : e);
        if (/no such column:\s*archived/i.test(msg) || /archived/i.test(msg)) {
          const { results = [] } = await env.DB.prepare(
            'SELECT * FROM records ORDER BY created_at DESC'
          ).all();
          const dataGeneration = await getDataGeneration(env);
          return json({
            records: results.map(mapRecord),
            dataGeneration,
            warning: 'Archive columns not migrated yet. Run worker/migrations/001_add_archived.sql on D1.',
          });
        }
        return fail('Could not load records.', 500);
      }
    }

    // ---------- Authenticated endpoints ----------
    const auth = await requireUser(request, env);
    if (auth.error) {
      return fail(
        auth.error,
        auth.error === 'Authentication required.' ? 401 : 503
      );
    }
    const user = auth.user;

    if (path === '/api/me' && method === 'GET') {
      const dataGeneration = await getDataGeneration(env);
      return json({ ok: true, user: { username: user }, dataGeneration });
    }

    // ---------- Permanent wipe — sequential validation (authenticated staff only) ----------
    // Auth already enforced above via requireUser → user is set.
    // Never deletes users, audit_logs, or credentials.
    if (path === '/api/admin/wipe-data') {
      const operationId = uuid();

      // Step A — method + body
      if (method !== 'POST') {
        return json({
          success: false,
          ok: false,
          error: 'Use POST for permanent delete.',
          code: 'INVALID_REQUEST',
          stage: 'request_validation',
          operationId,
        }, 405);
      }

      let body;
      try {
        body = await bodyJson(request);
      } catch (e) {
        return json({
          success: false,
          ok: false,
          error: e.message || 'Request body must be valid JSON.',
          code: 'INVALID_REQUEST',
          stage: 'request_validation',
          operationId,
        }, 400);
      }

      // Step A continued — required fields
      const phrase = String(body.confirmationPhrase || '').trim();
      if (phrase !== 'DELETE ALL DATA') {
        return json({
          success: false,
          ok: false,
          error: 'Confirmation phrase must be exactly: DELETE ALL DATA',
          code: 'INVALID_REQUEST',
          stage: 'request_validation',
          operationId,
        }, 400);
      }
      if (body.permanent !== true) {
        return json({
          success: false,
          ok: false,
          error: 'permanent: true is required.',
          code: 'INVALID_REQUEST',
          stage: 'request_validation',
          operationId,
        }, 400);
      }

      // Step B — authorization already passed (requireUser). user is authenticated staff.
      // (No further role table exists in this project beyond session login.)

      // Step C — scope allowlist + DB reachability
      const ALLOWED_SCOPES = new Set(['records', 'scan_events']);
      const requested = Array.isArray(body.scopes)
        ? body.scopes.map((s) => String(s))
        : ['records', 'scan_events'];
      const scopes = [...new Set(requested.filter((s) => ALLOWED_SCOPES.has(s)))];
      if (!scopes.length) {
        return json({
          success: false,
          ok: false,
          error: 'No valid scopes. Allowed: records, scan_events.',
          code: 'DATABASE_VALIDATION_FAILED',
          stage: 'database_validation',
          operationId,
        }, 400);
      }

      if (wipeInProgress) {
        return json({
          success: false,
          ok: false,
          error: 'Another wipe is already running. Wait and retry.',
          code: 'WIPE_IN_PROGRESS',
          stage: 'database_validation',
          operationId,
        }, 409);
      }

      // Prove D1 binding works before deleting
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
      } catch (e) {
        console.error('[NextGen] wipe DB probe failed', operationId, e && e.message);
        return json({
          success: false,
          ok: false,
          error: 'Database is not reachable from the Worker (D1 binding).',
          code: 'DATABASE_VALIDATION_FAILED',
          stage: 'database_validation',
          operationId,
        }, 500);
      }

      wipeInProgress = true;
      const ts = now();
      const countsBefore = { records: 0, scan_events: 0 };
      const countsAfter = { records: null, scan_events: null };
      const warnings = [];
      let newGeneration = null;

      try {
        // Optional counts
        try {
          const rc = await env.DB.prepare('SELECT COUNT(*) AS c FROM records').first();
          countsBefore.records = Number(rc && rc.c) || 0;
        } catch (_) {}
        try {
          const sc = await env.DB.prepare('SELECT COUNT(*) AS c FROM scan_events').first();
          countsBefore.scan_events = Number(sc && sc.c) || 0;
        } catch (_) {}

        // Step D — sequential deletes (child table first)
        // D1 does not expose multi-statement transactions the same way as full SQLite;
        // we delete in dependency order and verify emptiness afterward.
        if (scopes.includes('scan_events') || scopes.includes('records')) {
          try {
            await env.DB.prepare('DELETE FROM scan_events').run();
          } catch (e) {
            const msg = String(e && e.message ? e.message : e);
            if (!/no such table/i.test(msg)) {
              console.error('[NextGen] wipe DELETE scan_events', operationId, msg);
              return json({
                success: false,
                ok: false,
                error: 'Failed deleting scan_events: ' + msg,
                code: 'PERMANENT_DELETE_FAILED',
                stage: 'sql_execution',
                operationId,
              }, 500);
            }
            warnings.push('scan_events table missing — skipped');
          }
        }

        if (scopes.includes('records')) {
          try {
            await env.DB.prepare('DELETE FROM records').run();
          } catch (e) {
            const msg = String(e && e.message ? e.message : e);
            console.error('[NextGen] wipe DELETE records', operationId, msg);
            return json({
              success: false,
              ok: false,
              error: 'Failed deleting records: ' + msg,
              code: 'PERMANENT_DELETE_FAILED',
              stage: 'sql_execution',
              operationId,
            }, 500);
          }
        }

        // Verify deletion actually emptied the tables
        if (scopes.includes('records')) {
          try {
            const rc = await env.DB.prepare('SELECT COUNT(*) AS c FROM records').first();
            countsAfter.records = Number(rc && rc.c) || 0;
            if (countsAfter.records > 0) {
              return json({
                success: false,
                ok: false,
                error: 'Delete ran but records still remain (' + countsAfter.records + ').',
                code: 'PERMANENT_DELETE_FAILED',
                stage: 'sql_execution',
                operationId,
                countsBefore,
                countsAfter,
              }, 500);
            }
          } catch (e) {
            warnings.push('Could not verify records count after delete');
          }
        }
        if (scopes.includes('scan_events') || scopes.includes('records')) {
          try {
            const sc = await env.DB.prepare('SELECT COUNT(*) AS c FROM scan_events').first();
            countsAfter.scan_events = Number(sc && sc.c) || 0;
          } catch (_) {}
        }

        // Step E — post-delete bookkeeping (non-fatal)
        try {
          newGeneration = await bumpDataGeneration(env);
        } catch (e) {
          console.error('[NextGen] wipe generation', operationId, e && e.message);
          warnings.push('data_generation not updated (run migrations/002_app_meta.sql)');
        }
        try {
          await writeAudit(env, {
            action: 'permanent_wipe',
            recordId: null,
            actor: user,
            details: {
              operationId,
              scopes,
              countsBefore,
              countsAfter,
              dataGeneration: newGeneration,
              result: 'success',
            },
          });
        } catch (e) {
          warnings.push('audit log not written');
        }

        // Step E — success
        return json({
          success: true,
          ok: true,
          permanent: true,
          scopes,
          deleted: countsBefore,
          countsAfter,
          dataGeneration: newGeneration,
          actor: user,
          at: ts,
          operationId,
          stage: 'complete',
          preserved: ['users', 'audit_logs', 'staff credentials'],
          warning: warnings.length ? warnings.join(' · ') : undefined,
          message: 'Permanent deletion completed.',
        });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        console.error('[NextGen] wipe unexpected', operationId, msg);
        try {
          await writeAudit(env, {
            action: 'permanent_wipe_failed',
            recordId: null,
            actor: user,
            details: { operationId, error: msg.slice(0, 400) },
          });
        } catch (_) {}
        return json({
          success: false,
          ok: false,
          error: 'Unexpected server error during wipe: ' + msg,
          code: 'UNKNOWN_ERROR',
          stage: 'sql_execution',
          operationId,
        }, 500);
      } finally {
        wipeInProgress = false;
      }
    }

    // Optional in-app notification feed (empty until a real feed is implemented)
    if (path === '/api/notifications' && method === 'GET') {
      return json({ notifications: [], unreadCount: 0 });
    }
    if (path.match(/^\/api\/notifications\/[^/]+\/read$/) && method === 'POST') {
      return json({ ok: true });
    }
    if (path === '/api/notifications/read-all' && method === 'POST') {
      return json({ ok: true });
    }

    // ---------- Permanent delete after confirmed export (authenticated) ----------
    // Body: { ids: string[], permanent: true }
    if (path === '/api/records/archive' && method === 'POST') {
      const operationId = uuid();
      let body;
      try { body = await bodyJson(request); } catch (e) {
        return json({ error: e.message, code: 'INVALID_JSON', operationId }, 400);
      }
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanString(id, 80)).filter(Boolean) : [];
      if (!ids.length) {
        return json({ error: 'Provide at least one record id to delete.', code: 'NO_IDS', operationId }, 400);
      }
      if (ids.length > 500) {
        return json({ error: 'Too many records in one request (max 500).', code: 'TOO_MANY_IDS', operationId }, 400);
      }
      if (body.permanent !== true) {
        return json({
          error: 'Permanent deletion requires permanent: true in the request body.',
          code: 'PERMANENT_FLAG_REQUIRED',
          operationId,
        }, 400);
      }

      const deleted = [];
      const skipped = [];

      try {
        for (const id of ids) {
          try {
            // Delete scan_events for this record first (safe if table/FK missing)
            try {
              await env.DB.prepare('DELETE FROM scan_events WHERE record_id = ?').bind(id).run();
            } catch (_) {}

            const result = await env.DB.prepare(
              'DELETE FROM records WHERE id = ?'
            ).bind(id).run();

            if (result.meta && result.meta.changes) {
              deleted.push(id);
              // Best-effort audit — never fail the delete because of logging
              try {
                await writeAudit(env, {
                  action: 'permanent_delete',
                  recordId: id,
                  actor: user,
                  details: { operationId, batchSize: ids.length },
                });
              } catch (_) {}
            } else {
              skipped.push({ id, reason: 'not_found_or_already_gone' });
            }
          } catch (e) {
            console.error('[NextGen] permanent delete one', operationId, id, e && e.message);
            skipped.push({ id, reason: 'error', error: String(e && e.message ? e.message : e).slice(0, 120) });
          }
        }

        return json({
          ok: true,
          deletedCount: deleted.length,
          archivedCount: deleted.length,
          deletedIds: deleted,
          skipped,
          permanent: true,
          operationId,
        });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        console.error('[NextGen] permanent delete batch', operationId, msg);
        return json({
          error: 'Could not permanently delete records: ' + msg,
          code: 'DELETE_BATCH_FAILED',
          operationId,
          deletedCount: deleted.length,
          deletedIds: deleted,
        }, 500);
      }
    }

    // ---------- Unarchive (restore) records ----------
    if (path === '/api/records/unarchive' && method === 'POST') {
      let body;
      try { body = await bodyJson(request); } catch (e) { return fail(e.message); }
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanString(id, 80)).filter(Boolean) : [];
      if (!ids.length) return fail('Provide at least one record id to restore.');
      if (ids.length > 500) return fail('Too many records in one request (max 500).');

      const ts = now();
      const restored = [];
      for (const id of ids) {
        const result = await env.DB.prepare(
          'UPDATE records SET archived = 0, archived_at = NULL, archived_by = NULL, updated_at = ?, updated_by = ? WHERE id = ? AND archived = 1'
        ).bind(ts, user, id).run();
        if (result.meta.changes) {
          restored.push(id);
          try {
            await env.DB.prepare(
              `INSERT INTO audit_logs (id, action, record_id, actor, details, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(uuid(), 'unarchive', id, user, null, ts).run();
          } catch (_) {}
        }
      }
      return json({ ok: true, restoredCount: restored.length, restoredIds: restored });
    }

    const recordMatch = path.match(/^\/api\/records\/([^/]+)$/);

    if (recordMatch && method === 'DELETE') {
      const id = decodeURIComponent(recordMatch[1]);
      try {
        const result = await env.DB.prepare('DELETE FROM records WHERE id = ?')
          .bind(id)
          .run();
        if (!result.meta.changes) return fail('Record not found.', 404);
        return json({ ok: true });
      } catch (e) {
        return fail('Could not delete the record.', 500);
      }
    }

    if (recordMatch && method === 'PATCH') {
      const id = decodeURIComponent(recordMatch[1]);
      let body, data;
      try {
        body = await bodyJson(request);
        data = normalize(body);
      } catch (e) {
        return fail(e.message);
      }
      const ts = now();
      try {
        const result = await env.DB.prepare(
          `UPDATE records SET
            category = ?, pc_number = ?, full_name = ?, grade = ?, section = ?,
            school = ?, office = ?, position = ?, pre_test = ?, post_test = ?,
            feedback = ?, updated_at = ?, updated_by = ?
          WHERE id = ?`
        )
          .bind(
            data.category,
            data.pcNumber,
            data.fullName,
            data.grade,
            data.section,
            data.school,
            data.office,
            data.position,
            data.preTest,
            data.postTest,
            data.feedback,
            ts,
            user,
            id
          )
          .run();
        if (!result.meta.changes) return fail('Record not found.', 404);
        const r = await env.DB.prepare('SELECT * FROM records WHERE id = ?')
          .bind(id)
          .first();
        return json({ record: mapRecord(r) });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return fail('That PC Number is already registered in this category.', 409);
        }
        return fail('Could not update the record.', 500);
      }
    }


    // ---------- Score-only update (authenticated, does not change identity fields) ----------
    const scoreMatch = path.match(/^\/api\/records\/([^/]+)\/scores$/);
    if (scoreMatch && method === 'PATCH') {
      const id = decodeURIComponent(scoreMatch[1]);
      let body;
      try { body = await bodyJson(request); } catch (e) { return fail(e.message); }

      const preTest = cleanScore(body.preTest);
      const postTest = cleanScore(body.postTest);
      if (Number.isNaN(preTest) || Number.isNaN(postTest)) {
        return fail('Scores must be non-negative numbers.');
      }

      const existing = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
      if (!existing) return fail('Record not found.', 404);

      const ts = now();
      try {
        await env.DB.prepare(
          'UPDATE records SET pre_test = ?, post_test = ?, updated_at = ?, updated_by = ? WHERE id = ?'
        ).bind(preTest, postTest, ts, user, id).run();

        // Audit log (best-effort)
        try {
          await env.DB.prepare(
            `INSERT INTO audit_logs (id, action, record_id, actor, previous_pre_test, previous_post_test, new_pre_test, new_post_test, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(uuid(), 'score_update', id, user, existing.pre_test, existing.post_test, preTest, postTest, ts).run();
        } catch (_) { /* table may not exist yet; ignore */ }

        const updated = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
        return json({ record: mapRecord(updated) });
      } catch (e) {
        return fail('Could not update scores.', 500);
      }
    }

    const scanMatch = path.match(/^\/api\/records\/([^/]+)\/scan$/);
    if (scanMatch && method === 'POST') {
      const id = decodeURIComponent(scanMatch[1]);
      const r = await env.DB.prepare('SELECT id FROM records WHERE id = ?')
        .bind(id)
        .first();
      if (!r) return fail('Record not found.', 404);
      let purpose = 'staff_lookup';
      try {
        const body = await bodyJson(request);
        purpose = cleanString(body.purpose, 60) || purpose;
      } catch {
        /* optional body */
      }
      await env.DB.prepare(
        'INSERT INTO scan_events (id, record_id, scanned_at, scanned_by, purpose) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(uuid(), id, now(), user, purpose)
        .run();
      return json({ ok: true });
    }

    if (path === '/api/lookup' && method === 'GET') {
      const token = cleanString(url.searchParams.get('token'), 100);
      if (!token) return fail('QR token is required.');
      const r = await env.DB.prepare('SELECT * FROM records WHERE qr_token = ?')
        .bind(token)
        .first();
      if (!r) return fail('Record not found.', 404);
      return json({ record: mapRecord(r) });
    }


    // ---------- Offline sync endpoint (authenticated, idempotent) ----------
    if (path === '/api/sync' && method === 'POST') {
      let body;
      try { body = await bodyJson(request); } catch (e) { return fail(e.message); }
      const items = Array.isArray(body.items) ? body.items : [];
      const results = [];

      // Reject entire batch if client dataset generation is older than the server wipe generation
      const serverGen = await getDataGeneration(env);
      const clientGen = body.dataGeneration != null ? parseInt(String(body.dataGeneration), 10) : null;
      if (clientGen != null && Number.isFinite(clientGen) && clientGen < serverGen) {
        return json({
          results: items.map((item) => ({
            id: item && item.id,
            status: 'rejected',
            error: 'Stale offline queue: server data was permanently reset. Clear local pending items and refresh.',
          })),
          dataGeneration: serverGen,
          stale: true,
        });
      }

      for (const item of items) {
        const itemId = cleanString(item.id, 80);
        const type = cleanString(item.type, 40);
        if (!itemId || !type) {
          results.push({ id: item.id, status: 'failed', error: 'Missing id or type.' });
          continue;
        }

        try {
          if (type === 'scan') {
            const recordId = cleanString(item.recordId, 80);
            if (!recordId) { results.push({ id: itemId, status: 'failed', error: 'Missing recordId.' }); continue; }
            const exists = await env.DB.prepare('SELECT id FROM records WHERE id = ?').bind(recordId).first();
            if (!exists) { results.push({ id: itemId, status: 'failed', error: 'Record not found.' }); continue; }
            // Idempotent: use client-provided id; ignore if already inserted
            await env.DB.prepare(
              'INSERT OR IGNORE INTO scan_events (id, record_id, scanned_at, scanned_by, purpose) VALUES (?, ?, ?, ?, ?)'
            ).bind(itemId, recordId, item.createdAt || now(), user, cleanString(item.purpose, 60) || 'staff_lookup').run();
            results.push({ id: itemId, status: 'synced' });

          } else if (type === 'score_update') {
            const recordId = cleanString(item.recordId, 80);
            if (!recordId) { results.push({ id: itemId, status: 'failed', error: 'Missing recordId.' }); continue; }
            const existing = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(recordId).first();
            if (!existing) { results.push({ id: itemId, status: 'failed', error: 'Record not found.' }); continue; }
            // Conflict check: reject if server was updated after the client's base timestamp
            const baseUpdated = item.baseUpdatedAt || null;
            if (baseUpdated && existing.updated_at && existing.updated_at > baseUpdated) {
              results.push({ id: itemId, status: 'conflict', error: 'Server record is newer. Refresh and retry.', serverRecord: mapRecord(existing) });
              continue;
            }
            const pre = cleanScore(item.preTest);
            const post = cleanScore(item.postTest);
            if (Number.isNaN(pre) || Number.isNaN(post)) {
              results.push({ id: itemId, status: 'failed', error: 'Invalid scores.' });
              continue;
            }
            const ts = now();
            await env.DB.prepare(
              'UPDATE records SET pre_test = ?, post_test = ?, updated_at = ?, updated_by = ? WHERE id = ?'
            ).bind(pre, post, ts, user, recordId).run();
            try {
              await env.DB.prepare(
                `INSERT INTO audit_logs (id, action, record_id, actor, previous_pre_test, previous_post_test, new_pre_test, new_post_test, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(uuid(), 'score_update_offline', recordId, user, existing.pre_test, existing.post_test, pre, post, ts).run();
            } catch (_) {}
            results.push({ id: itemId, status: 'synced' });

          } else if (type === 'registration') {
            // Offline registration: create only if PC number not already taken in category
            let data;
            try { data = normalize(item.payload || {}); } catch (e) {
              results.push({ id: itemId, status: 'failed', error: e.message }); continue;
            }
            const id = uuid();
            const qrToken = uuid().replace(/-/g, '') + uuid().replace(/-/g, '').slice(0, 16);
            const ts = now();
            try {
              await env.DB.prepare(
                `INSERT INTO records (id, qr_token, category, pc_number, full_name, grade, section, school, office, position, pre_test, post_test, feedback, created_at, updated_at, created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(id, qrToken, data.category, data.pcNumber, data.fullName, data.grade, data.section, data.school, data.office, data.position, data.preTest, data.postTest, data.feedback, ts, ts, user, user).run();
              results.push({ id: itemId, status: 'synced', recordId: id });
            } catch (e) {
              if (String(e.message).includes('UNIQUE')) {
                results.push({ id: itemId, status: 'conflict', error: 'PC Number already registered in this category.' });
              } else {
                results.push({ id: itemId, status: 'failed', error: 'Could not save registration.' });
              }
            }

          } else {
            results.push({ id: itemId, status: 'failed', error: 'Unknown operation type.' });
          }
        } catch (e) {
          results.push({ id: itemId, status: 'failed', error: 'Sync error.' });
        }
      }

      return json({ results, dataGeneration: await getDataGeneration(env) });
    }

    return fail('Not found.', 404);
  },
};

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
  
    // ---------- Offline sync endpoint (authenticated, idempotent) ----------
    if (path === '/api/sync' && method === 'POST') {
      let body;
      try { body = await bodyJson(request); } catch (e) { return fail(e.message); }
      const items = Array.isArray(body.items) ? body.items : [];
      const results = [];

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

      return json({ results });
    }

    return fail('Not found.', 404);
    }

    if (!env.DB) return fail('D1 binding DB is not configured.', 503);

    // ---------- Public endpoints ----------
    if (path === '/api/health' && method === 'GET') {
      return json({
        ok: true,
        service: 'nextgen-smart-classroom-api',
        database: !!env.DB,
      });
    }

    if (path === '/api/login' && method === 'POST') {
      if (!env.SESSION_SECRET) return fail('SESSION_SECRET is not configured.', 503);
      let body;
      try {
        body = await bodyJson(request);
      } catch (e) {
        return fail(e.message);
      }
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return fail('Username and password are required.');

      // Primary admin from environment secrets
      if (
        env.ADMIN_USERNAME &&
        env.ADMIN_PASSWORD &&
        username === env.ADMIN_USERNAME &&
        password === env.ADMIN_PASSWORD
      ) {
        const token = await makeSession(username, env.SESSION_SECRET);
        return json(
          { ok: true, user: { username } },
          200,
          { 'Set-Cookie': cookie(token) }
        );
      }

      // Secondary users stored in D1
      const row = await env.DB.prepare(
        'SELECT password_hash FROM users WHERE username = ?'
      )
        .bind(username)
        .first();
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return fail('Incorrect username or password.', 401);
      }
      const token = await makeSession(username, env.SESSION_SECRET);
      return json(
        { ok: true, user: { username } },
        200,
        { 'Set-Cookie': cookie(token) }
      );
    }

    if (path === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }

    // Create additional staff accounts (only primary env admin)
    if (path === '/api/users' && method === 'POST') {
      const auth = await requireUser(request, env);
      if (auth.error) return fail(auth.error, 401);
      if (auth.user !== env.ADMIN_USERNAME) {
        return fail('Only the primary administrator can create staff accounts.', 403);
      }
      let body;
      try {
        body = await bodyJson(request);
      } catch (e) {
        return fail(e.message);
      }
      const username = cleanString(body.username, 60);
      const password = String(body.password || '');
      if (!username || username.length < 3) {
        return fail('Username must be at least 3 characters.');
      }
      if (password.length < 10) {
        return fail('Password must be at least 10 characters.');
      }
      const id = uuid();
      const hash = await hashPassword(password);
      const ts = now();
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, username, password_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
        )
          .bind(id, username, hash, ts, auth.user)
          .run();
        return json({ ok: true, username }, 201);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return fail('That username is already taken.', 409);
        }
        return fail('Could not create the account.', 500);
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
      const createdBy = 'public';
      try {
        await env.DB.prepare(
          `INSERT INTO records (
            id, qr_token, category, pc_number, full_name, grade, section, school,
            office, position, pre_test, post_test, feedback, created_at, updated_at,
            created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            id, qrToken, data.category, data.pcNumber, data.fullName,
            data.grade, data.section, data.school, data.office, data.position,
            data.preTest, data.postTest, data.feedback, ts, ts, createdBy, createdBy
          )
          .run();
        const r = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
        return json({ record: mapRecord(r) }, 201);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          return fail('That PC Number is already registered in this category.', 409);
        }
        return fail('Could not save the record.', 500);
      }
    }


    // ---------- Public records list (for overview and records page) ----------
    if (path === '/api/records' && method === 'GET') {
      const { results = [] } = await env.DB.prepare(
        'SELECT * FROM records ORDER BY created_at DESC'
      ).all();
      return json({ records: results.map(mapRecord) });
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
      return json({ ok: true, user: { username: user } });
    }

    if (path === '/api/records' && method === 'GET') {
      const { results = [] } = await env.DB.prepare(
        'SELECT * FROM records ORDER BY created_at DESC'
      ).all();
      return json({ records: results.map(mapRecord) });
    }

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
            user,
            user
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

      return json({ results });
    }

    return fail('Not found.', 404);
  },
};

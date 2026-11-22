// StarC Cafe – file storage API (Cloudflare Worker + R2)
// Routes (all need the header  Authorization: Bearer <FILES_PASSWORD>):
//   GET    /api/files              -> list files
//   GET    /api/files?key=...      -> download one file
//   PUT    /api/files?name=...     -> upload one file (raw body)
//   DELETE /api/files?key=...      -> delete one file

const PREFIX = 'manager-files/';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function passwordOk(given, expected) {
  const a = await sha256(given);
  const b = await sha256(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cleanName(raw) {
  let name = (raw || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

function validKey(key) {
  return /^manager-files\/[a-z0-9]{8}\/[^/]+$/.test(key);
}

export async function handleFiles(request, env) {
  if (!env.FILES) return json({ error: 'File storage is not set up yet (missing FILES binding).' }, 500);
  if (!env.FILES_PASSWORD) return json({ error: 'Files password is not set (FILES_PASSWORD).' }, 500);

  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await passwordOk(bearer, env.FILES_PASSWORD))) {
    return json({ error: 'Wrong password' }, 401);
  }

  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  // ----- list or download -----
  if (request.method === 'GET') {
    if (!key) {
      const listed = await env.FILES.list({ prefix: PREFIX, limit: 1000 });
      const files = listed.objects
        .map((o) => ({
          key: o.key,
          name: o.key.split('/').slice(2).join('/'),
          size: o.size,
          uploaded: o.uploaded,
        }))
        .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return json({ files });
    }
    if (!validKey(key)) return json({ error: 'Bad file key' }, 400);
    const obj = await env.FILES.get(key);
    if (!obj) return json({ error: 'File not found' }, 404);
    const name = key.split('/').slice(2).join('/');
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'Cache-Control': 'no-store',
      },
    });
  }

  // ----- upload -----
  if (request.method === 'PUT') {
    const length = Number(request.headers.get('Content-Length'));
    if (!length) return json({ error: 'Empty or unsized upload' }, 411);
    if (length > MAX_BYTES) return json({ error: 'File is larger than 50 MB' }, 413);
    const name = cleanName(url.searchParams.get('name'));
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const newKey = `${PREFIX}${id}/${name}`;
    await env.FILES.put(newKey, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
    });
    return json({ ok: true, key: newKey, name });
  }

  // ----- delete -----
  if (request.method === 'DELETE') {
    if (!key || !validKey(key)) return json({ error: 'Bad file key' }, 400);
    await env.FILES.delete(key);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

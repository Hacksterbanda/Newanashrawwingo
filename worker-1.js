// ═══════════════════════════════════════════════════════
//  ANASHRAW.AI — Simple Collector Worker
//  Sirf ek kaam: Har 5 min mein WinGo results Firebase mein save karo
// ═══════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'anashrawdb';
const FIREBASE_API_KEY = 'AIzaSyAEePSevU-3vNAP0nQN9EY4u7z628458sg';
const FIREBASE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const WINGO_API = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=10&language=0&ts=';

async function fbGet(path) {
  const r = await fetch(`${FIREBASE_BASE}/${path}?key=${FIREBASE_API_KEY}`);
  if (!r.ok) return null;
  return r.json();
}

async function fbSet(path, fields) {
  const body = { fields: toFields(fields) };
  const r = await fetch(`${FIREBASE_BASE}/${path}?key=${FIREBASE_API_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function toFields(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') f[k] = { stringValue: v };
    else if (typeof v === 'number') f[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') f[k] = { booleanValue: v };
  }
  return f;
}

function colorOf(n) {
  if (n === 0 || n === 5) return 'violet';
  if ([1, 3, 7, 9].includes(n)) return 'green';
  return 'red';
}
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

async function collect() {
  try {
    const resp = await fetch(WINGO_API + Date.now(), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!resp.ok) throw new Error('WinGo API error: ' + resp.status);

    const data = await resp.json();
    let list = [];
    if (data.data?.list) list = data.data.list;
    else if (Array.isArray(data.data)) list = data.data;
    else if (Array.isArray(data)) list = data;

    if (!list.length) return { saved: 0, message: 'No data' };

    let saved = 0;

    for (const item of list) {
      const number = parseInt(item.openNum ?? item.number ?? item.num ?? '0');
      const period = String(item.issue ?? item.issueNumber ?? item.period ?? '0');
      if (isNaN(number) || !period) continue;

      const existing = await fbGet(`results/${period}`);
      if (existing?.fields) continue;

      await fbSet(`results/${period}`, {
        period,
        number,
        colour: colorOf(number),
        bigSmall: sizeOf(number),
        savedAt: new Date().toISOString(),
      });
      saved++;
    }

    if (list.length > 0) {
      const latest = list[0];
      const num = parseInt(latest.openNum ?? latest.number ?? '0');
      const period = String(latest.issue ?? latest.issueNumber ?? '0');

      await fbSet('meta/latest', {
        period,
        number: num,
        colour: colorOf(num),
        bigSmall: sizeOf(num),
        updatedAt: new Date().toISOString(),
      });

      await fbSet('meta/collector', {
        lastRun: new Date().toISOString(),
        lastPeriod: period,
        lastNumber: num,
        savedThisRun: saved,
        status: 'ok',
      });
    }

    return { saved, total: list.length };

  } catch (e) {
    await fbSet('meta/collector', {
      lastRun: new Date().toISOString(),
      status: 'error',
      error: e.message,
    }).catch(() => {});
    return { saved: 0, error: e.message };
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const result = await collect();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect());
  },
};

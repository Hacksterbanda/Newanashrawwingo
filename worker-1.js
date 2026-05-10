// ═══════════════════════════════════════════════════════════
//  ANASHRAW.AI — Cloudflare Worker
//  Handles: key validation, AI chat, heartbeat, save-chat,
//           results collection, predictions, admin actions
// ═══════════════════════════════════════════════════════════

const FIREBASE_PROJECT = 'anashrawdb';
const FIREBASE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const WINGO_API = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

// ── CORS ──────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

function corsErr(msg, status = 400) {
  return cors({ ok: false, error: msg }, status);
}

// ── FIREBASE REST HELPERS ─────────────────────────────────
async function fbGet(path, apiKey) {
  const r = await fetch(`${FIREBASE_BASE}/${path}?key=${apiKey}`);
  if (!r.ok) return null;
  return r.json();
}

async function fbSet(path, fields, apiKey) {
  const body = { fields: toFbFields(fields) };
  const r = await fetch(`${FIREBASE_BASE}/${path}?key=${apiKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function fbCreate(collection, fields, apiKey) {
  const body = { fields: toFbFields(fields) };
  const r = await fetch(`${FIREBASE_BASE}/${collection}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function fbQuery(collection, filters, apiKey, orderBy = null, limit = 50) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    limit,
  };
  if (filters && filters.length) {
    structuredQuery.where = filters.length === 1 ? filters[0] : {
      compositeFilter: { op: 'AND', filters },
    };
  }
  if (orderBy) structuredQuery.orderBy = orderBy;

  const r = await fetch(`${FIREBASE_BASE}:runQuery?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => ({
    id: d.document.name.split('/').pop(),
    ...fromFbDoc(d.document.fields),
  }));
}

// ── FIREBASE FIELD CONVERTERS ─────────────────────────────
function toFbFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(i => typeof i === 'string' ? { stringValue: i } : typeof i === 'number' ? { integerValue: String(i) } : { stringValue: JSON.stringify(i) }) } };
    else if (typeof v === 'object') fields[k] = { stringValue: JSON.stringify(v) };
  }
  return fields;
}

function fromFbDoc(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
    else if (v.doubleValue !== undefined) obj[k] = parseFloat(v.doubleValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) obj[k] = v.timestampValue;
    else if (v.arrayValue) obj[k] = (v.arrayValue.values || []).map(i => i.stringValue ?? i.integerValue ?? i.booleanValue ?? JSON.stringify(i));
    else if (v.nullValue !== undefined) obj[k] = null;
  }
  return obj;
}

function fbFilter(field, op, value, type = 'stringValue') {
  return {
    fieldFilter: {
      field: { fieldPath: field },
      op,
      value: { [type]: value },
    },
  };
}

// ── KEY VALIDATION ────────────────────────────────────────
async function validateKey(keyStr, apiKey) {
  // Try doc ID first (fast)
  const doc = await fbGet(`keys/${keyStr}`, apiKey);
  if (doc && doc.fields) {
    const data = fromFbDoc(doc.fields);
    return data;
  }
  // Fallback: query by key field
  const results = await fbQuery('keys', [fbFilter('key', 'EQUAL', keyStr)], apiKey, null, 1);
  return results[0] || null;
}

// ── QUOTA HELPERS ─────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

async function getQuota(keyStr, apiKey) {
  const today = getTodayStr();
  const doc = await fbGet(`quotas/${keyStr}_${today}`, apiKey);
  if (!doc || !doc.fields) return { used: 0, date: today };
  return fromFbDoc(doc.fields);
}

async function incrementQuota(keyStr, apiKey) {
  const today = getTodayStr();
  const q = await getQuota(keyStr, apiKey);
  await fbSet(`quotas/${keyStr}_${today}`, { key: keyStr, date: today, used: (q.used || 0) + 1 }, apiKey);
  return q.used + 1;
}

// ── MAIN HANDLER ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // OPTIONS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const apiKey = env.FIREBASE_API_KEY || 'AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
    const groqKey = env.GROQ_API_KEY || '';

    // ── GET /results ──────────────────────────────────────
    if (path === '/results' && method === 'GET') {
      try {
        const snap = await fbQuery('results', [], apiKey,
          [{ field: { fieldPath: 'period' }, direction: 'DESCENDING' }], 100);
        return cors({ ok: true, results: snap });
      } catch (e) {
        return corsErr('Failed to fetch results: ' + e.message);
      }
    }

    // ── GET /prediction ───────────────────────────────────
    if (path === '/prediction' && method === 'GET') {
      try {
        const doc = await fbGet('meta/latestPrediction', apiKey);
        if (!doc || !doc.fields) return cors({ ok: false, prediction: null });
        return cors({ ok: true, prediction: fromFbDoc(doc.fields) });
      } catch (e) {
        return corsErr('Failed to fetch prediction');
      }
    }

    // ── POST /validate-key ────────────────────────────────
    if (path === '/validate-key' && method === 'POST') {
      try {
        const body = await request.json();
        const keyStr = (body.key || '').trim().toUpperCase();
        if (!keyStr) return corsErr('Key required');

        const keyData = await validateKey(keyStr, apiKey);
        if (!keyData) return cors({ ok: false, error: 'Invalid key — key not found' });

        // Check blocked
        if (keyData.blocked || keyData.status === 'blocked') {
          return cors({ ok: false, error: 'Key is blocked' });
        }

        // Check kicked (but reset it so they can re-login)
        if (keyData.kicked) {
          await fbSet(`keys/${keyStr}`, { kicked: false }, apiKey);
          return cors({ ok: false, error: 'Key was kicked — try again' });
        }

        // Check expiry
        if (!keyData.lifetime && keyData.expiresAt) {
          const exp = new Date(keyData.expiresAt);
          if (exp < new Date()) {
            return cors({ ok: false, error: 'Key expired on ' + exp.toLocaleDateString() });
          }
        }

        // Get quota info
        const globalSettings = await fbGet('settings/global', apiKey);
        const globalData = globalSettings?.fields ? fromFbDoc(globalSettings.fields) : {};
        const maxQ = keyData.questionsOverride || globalData.questionsPerDay || 5;
        const today = getTodayStr();
        const quotaDoc = await fbGet(`quotas/${keyStr}_${today}`, apiKey);
        const quotaData = quotaDoc?.fields ? fromFbDoc(quotaDoc.fields) : { used: 0 };
        const remaining = Math.max(0, maxQ - (quotaData.used || 0));

        return cors({
          ok: true,
          data: {
            label: keyData.label || keyStr.slice(0, 8),
            tier: keyData.tier || 'basic',
            confidenceMode: keyData.confidenceMode || 'normal',
            questionsOverride: keyData.questionsOverride || null,
            expiresAt: keyData.expiresAt || null,
            lifetime: keyData.lifetime || false,
          },
          remaining,
          max: maxQ,
        });
      } catch (e) {
        return corsErr('Validation error: ' + e.message, 500);
      }
    }

    // ── POST /heartbeat ───────────────────────────────────
    if (path === '/heartbeat' && method === 'POST') {
      try {
        const body = await request.json();
        const keyStr = (body.key || '').trim().toUpperCase();
        if (!keyStr) return corsErr('Key required');

        const sessionId = keyStr + '_session';
        await fbSet(`sessions/${sessionId}`, {
          key: keyStr,
          lastSeen: new Date().toISOString(),
          kicked: false,
        }, apiKey);

        // Check if kicked
        const keyData = await validateKey(keyStr, apiKey);
        if (keyData?.kicked) {
          return cors({ ok: true, kicked: true });
        }

        return cors({ ok: true, kicked: false });
      } catch (e) {
        return corsErr('Heartbeat error: ' + e.message, 500);
      }
    }

    // ── POST /ai-chat ─────────────────────────────────────
    if (path === '/ai-chat' && method === 'POST') {
      try {
        const body = await request.json();
        const keyStr = (body.key || '').trim().toUpperCase();
        const message = body.message || '';
        const history = body.history || [];

        if (!keyStr) return corsErr('Key required');
        if (!message) return corsErr('Message required');

        // Validate key
        const keyData = await validateKey(keyStr, apiKey);
        if (!keyData || keyData.blocked) return corsErr('Invalid or blocked key', 403);

        // Check quota
        const globalSettings = await fbGet('settings/global', apiKey);
        const globalData = globalSettings?.fields ? fromFbDoc(globalSettings.fields) : {};
        const maxQ = keyData.questionsOverride || globalData.questionsPerDay || 5;
        const today = getTodayStr();
        const quotaDoc = await fbGet(`quotas/${keyStr}_${today}`, apiKey);
        const quotaData = quotaDoc?.fields ? fromFbDoc(quotaDoc.fields) : { used: 0 };

        if ((quotaData.used || 0) >= maxQ) {
          return cors({ ok: false, quotaExceeded: true, remaining: 0, max: maxQ, error: 'Daily quota reached' });
        }

        // Get Groq API key from Firebase settings
        let activeGroqKey = groqKey;
        if (!activeGroqKey) {
          const apiKeyDoc = await fbGet('settings/apiKeys', apiKey);
          if (apiKeyDoc?.fields) {
            activeGroqKey = fromFbDoc(apiKeyDoc.fields).groqKey || '';
          }
        }

        if (!activeGroqKey) return corsErr('AI service not configured', 503);

        // Build messages for Groq
        const messages = [
          {
            role: 'system',
            content: `You are ANASHRAW AI, a WinGo prediction assistant for ANASHRAW.AI platform by Anashraw Dixit. 
Help users understand WinGo patterns, strategies, and predictions. 
Be concise, helpful, and use hacking/tech aesthetic language. 
Never guarantee wins — WinGo is random but patterns can be analyzed.
Respond in the same language the user writes in (Hindi/Hinglish/English).`,
          },
          ...history.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          { role: 'user', content: message },
        ];

        // Call Groq
        const groqResp = await fetch(GROQ_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeGroqKey}`,
          },
          body: JSON.stringify({
            model: 'llama3-8b-8192',
            messages,
            max_tokens: 512,
            temperature: 0.7,
          }),
        });

        const groqData = await groqResp.json();
        if (!groqResp.ok) {
          return corsErr('AI error: ' + (groqData.error?.message || 'Unknown'), 502);
        }

        const reply = groqData.choices?.[0]?.message?.content || 'No response';

        // Increment quota
        const newUsed = await incrementQuota(keyStr, apiKey);
        const remaining = Math.max(0, maxQ - newUsed);

        return cors({ ok: true, reply, remaining, max: maxQ });
      } catch (e) {
        return corsErr('AI chat error: ' + e.message, 500);
      }
    }

    // ── POST /save-chat ───────────────────────────────────
    if (path === '/save-chat' && method === 'POST') {
      try {
        const body = await request.json();
        const { key, role, content, chatId, senderName, isGuest } = body;
        if (!chatId || !content) return corsErr('chatId and content required');

        const newMsg = {
          role: role || 'user',
          content,
          timestamp: new Date().toISOString(),
          ...(senderName && { senderName }),
          ...(isGuest && { isGuest: true }),
        };

        // Get existing doc
        const existing = await fbGet(`adminChat/${chatId}`, apiKey);
        let messages = [];
        if (existing?.fields) {
          const data = fromFbDoc(existing.fields);
          try { messages = JSON.parse(data.messagesJson || '[]'); } catch { messages = []; }
        }
        messages.push(newMsg);

        await fbSet(`adminChat/${chatId}`, {
          chatId,
          key: key || chatId,
          messagesJson: JSON.stringify(messages),
          lastUpdated: new Date().toISOString(),
          resolved: false,
        }, apiKey);

        return cors({ ok: true });
      } catch (e) {
        return corsErr('Save chat error: ' + e.message, 500);
      }
    }

    // ── POST /collect ─────────────────────────────────────
    // Called by cron or manually to collect WinGo results
    if (path === '/collect' && method === 'POST') {
      try {
        // Fetch from WinGo API
        const resp = await fetch(WINGO_API + '?ts=' + Date.now(), { cf: { cacheEverything: false } });
        const data = await resp.json();

        let list = [];
        if (data.data?.list) list = data.data.list;
        else if (Array.isArray(data.data)) list = data.data;
        else if (Array.isArray(data)) list = data;

        if (!list.length) return cors({ ok: false, message: 'No data from WinGo API' });

        // Get global settings for maxResults
        const settDoc = await fbGet('settings/global', apiKey);
        const settData = settDoc?.fields ? fromFbDoc(settDoc.fields) : {};
        const maxResults = settData.maxResults || 500;

        let saved = 0;
        const colorOf = n => (n === 0 || n === 5) ? 'violet' : ([1,3,7,9].includes(n) ? 'green' : 'red');
        const sizeOf = n => n >= 5 ? 'BIG' : 'SMALL';

        for (const item of list.slice(0, 20)) {
          const number = parseInt(item.openNum ?? item.number ?? item.num ?? '0');
          const period = String(item.issue ?? item.issueNumber ?? item.period ?? '0');
          if (isNaN(number)) continue;

          const colour = String(item.colour ?? item.color ?? colorOf(number)).toLowerCase();
          const bigSmall = String(item.bigSmall ?? item.size ?? sizeOf(number)).toUpperCase();

          // Check if exists
          const existing = await fbGet(`results/${period}`, apiKey);
          if (existing?.fields) continue; // Already saved

          await fbSet(`results/${period}`, {
            period, number, colour, bigSmall,
            savedAt: new Date().toISOString(),
          }, apiKey);
          saved++;
        }

        // Update meta/latest with most recent
        if (list.length > 0) {
          const latest = list[0];
          const num = parseInt(latest.openNum ?? latest.number ?? '0');
          const period = String(latest.issue ?? latest.issueNumber ?? '0');
          const colorOf2 = n => (n === 0 || n === 5) ? 'violet' : ([1,3,7,9].includes(n) ? 'green' : 'red');
          const sizeOf2 = n => n >= 5 ? 'BIG' : 'SMALL';

          await fbSet('meta/latest', {
            period, number: num,
            colour: colorOf2(num),
            bigSmall: sizeOf2(num),
            updatedAt: new Date().toISOString(),
          }, apiKey);

          // Update meta/collector
          await fbSet('meta/collector', {
            lastRun: new Date().toISOString(),
            lastPeriod: period,
            savedThisRun: saved,
          }, apiKey);
        }

        // Run prediction engine
        await runPrediction(apiKey);

        return cors({ ok: true, saved, message: `Saved ${saved} new results` });
      } catch (e) {
        return corsErr('Collect error: ' + e.message, 500);
      }
    }

    // ── GET /collect (trigger manually) ──────────────────
    if (path === '/collect' && method === 'GET') {
      return fetch(new Request(request.url, { method: 'POST', headers: request.headers }));
    }

    // ── POST /admin/trim ──────────────────────────────────
    if (path === '/admin/trim' && method === 'POST') {
      try {
        const settDoc = await fbGet('settings/global', apiKey);
        const settData = settDoc?.fields ? fromFbDoc(settDoc.fields) : {};
        const maxResults = settData.maxResults || 500;

        // Get all results ordered by period desc
        const results = await fbQuery('results', [], apiKey,
          [{ field: { fieldPath: 'period' }, direction: 'DESCENDING' }], 1000);

        if (results.length <= maxResults) {
          return cors({ ok: true, message: `No trim needed (${results.length} <= ${maxResults})` });
        }

        const toDelete = results.slice(maxResults);
        let deleted = 0;
        for (const r of toDelete) {
          await fetch(`${FIREBASE_BASE}/results/${r.period}?key=${apiKey}`, { method: 'DELETE' });
          deleted++;
        }

        return cors({ ok: true, message: `Trimmed ${deleted} old results`, deleted });
      } catch (e) {
        return corsErr('Trim error: ' + e.message, 500);
      }
    }

    // ── POST /admin/update-api-key ────────────────────────
    if (path === '/admin/update-api-key' && method === 'POST') {
      try {
        const body = await request.json();
        const { apiKey: newGroqKey, service } = body;
        if (!newGroqKey) return corsErr('apiKey required');
        await fbSet('settings/apiKeys', {
          groqKey: newGroqKey,
          service: service || 'groq',
          updatedAt: new Date().toISOString(),
        }, apiKey);
        return cors({ ok: true, message: 'API key updated' });
      } catch (e) {
        return corsErr('Update API key error: ' + e.message, 500);
      }
    }

    // ── SCHEDULED CRON ───────────────────────────────────
    // (Cloudflare cron trigger calls scheduled())
    return corsErr('Not found: ' + path, 404);
  },

  // ── CRON TRIGGER ─────────────────────────────────────
  async scheduled(event, env, ctx) {
    const apiKey = env.FIREBASE_API_KEY || 'AIzaSyCrhsY2aLZaos19ULooCbQJZh4AxMZV9wQ';
    ctx.waitUntil(collectAndPredict(apiKey));
  },
};

// ── PREDICTION ENGINE ─────────────────────────────────────
async function runPrediction(apiKey) {
  try {
    // Get last 100 results
    const results = await fbQuery('results', [], apiKey,
      [{ field: { fieldPath: 'period' }, direction: 'DESCENDING' }], 100);

    if (results.length < 10) return;

    const nums = results.map(r => typeof r.number === 'string' ? parseInt(r.number) : r.number).reverse();
    const colorOf = n => (n === 0 || n === 5) ? 'violet' : ([1,3,7,9].includes(n) ? 'green' : 'red');
    const sizeOf = n => n >= 5 ? 'BIG' : 'SMALL';

    const freq = Array(10).fill(0);
    nums.forEach(x => freq[x]++);
    const sorted = freq.map((f, i) => ({ n: i, f })).sort((a, b) => b.f - a.f);
    const hot = sorted.slice(0, 3).map(x => x.n);
    const cold = sorted.slice(-3).map(x => x.n);

    const n = nums.length;
    let streakNum = nums[n-1], streakLen = 1;
    for (let i = n-2; i >= 0; i--) { if (nums[i] === streakNum) streakLen++; else break; }

    const colors = results.map(r => r.colour).reverse();
    let colorRun = colors[n-1], colorRunLen = 1;
    for (let i = n-2; i >= 0; i--) { if (String(colors[i]).toLowerCase() === String(colorRun).toLowerCase()) colorRunLen++; else break; }

    const last10 = nums.slice(-10);
    const bigCount = last10.filter(x => x >= 5).length;
    const last5 = nums.slice(-5);
    const missing = [];
    for (let i = 0; i < 10; i++) { if (!last5.includes(i)) missing.push(i); }

    const scores = Array(10).fill(0);
    freq.forEach((f, i) => { scores[i] += f * 2; });
    if (streakLen >= 3) scores[streakNum] -= 15;
    if (streakLen >= 2) scores[streakNum] -= 8;
    if (colorRunLen >= 3) {
      const opp = colorRun.includes('green') ? 'red' : 'green';
      for (let i = 0; i < 10; i++) { if (colorOf(i) === opp) scores[i] += 12; }
    }
    if (bigCount >= 8) { for (let i = 0; i < 5; i++) scores[i] += 10; }
    if (10 - bigCount >= 8) { for (let i = 5; i < 10; i++) scores[i] += 10; }
    missing.forEach(m => scores[m] += 5);
    last5.forEach((x, i) => { scores[x] -= (5 - i) * 1.5; });

    const minScore = Math.min(...scores);
    const adj = scores.map(s => s - minScore + 1);
    const total = adj.reduce((a, b) => a + b, 0);
    const probs = adj.map(s => Math.round((s / total) * 100));
    const best = probs.indexOf(Math.max(...probs));
    const altsAll = probs.map((p, i) => ({ n: i, p })).sort((a, b) => b.p - a.p);
    const alts = altsAll.filter(x => x.n !== best).slice(0, 3);
    const gap = probs[best] - altsAll[1].p;

    const numConf = Math.min(90, Math.max(28, 33 + gap * 2 + (n >= 50 ? 10 : n >= 30 ? 6 : 0)));
    const bsImbalance = Math.abs(bigCount - 5);
    const bsConf = Math.min(90, Math.max(28, Math.round(38 + bsImbalance * 4 + (n >= 50 ? 8 : 5))));
    let colorConf = colorRunLen >= 4 ? 73 : colorRunLen >= 3 ? 62 : colorRunLen >= 2 ? 51 : 44;
    colorConf = Math.min(90, Math.max(28, colorConf));

    const reasons = [];
    if (streakLen >= 2) reasons.push(`${streakNum} appeared ${streakLen}x in a row`);
    if (colorRunLen >= 3) reasons.push(`${colorRun} streak of ${colorRunLen}`);
    if (bigCount >= 7) reasons.push(`Big heavy (${bigCount}/10), Small likely`);
    if (10 - bigCount >= 7) reasons.push(`Small heavy (${10 - bigCount}/10), Big likely`);
    reasons.push(`Hot: ${hot.join(',')} · №${best} top score from ${n} records`);

    const predData = {
      number: best,
      colour: colorOf(best),
      bigSmall: sizeOf(best),
      numberConfidence: Math.round(numConf),
      colorConfidence: colorConf,
      bsConfidence: bsConf,
      alternatives: JSON.stringify(alts.map(a => ({ number: a.n, color: colorOf(a.n), bigSmall: sizeOf(a.n), probability: a.p }))),
      reasoning: reasons.slice(0, 2).join('. ') + '.',
      hotNumbers: JSON.stringify(hot),
      coldNumbers: JSON.stringify(cold),
      streak: `${streakNum}x${streakLen}`,
      colorRun: `${colorRun}x${colorRunLen}`,
      bsRatio: `Big${bigCount}/Small${10-bigCount}`,
      period: results[0]?.period || '',
      generatedAt: new Date().toISOString(),
      basedOn: n,
    };

    await fbSet('meta/latestPrediction', predData, apiKey);
  } catch (e) {
    console.error('Prediction error:', e.message);
  }
}

async function collectAndPredict(apiKey) {
  try {
    const resp = await fetch(WINGO_API + '?ts=' + Date.now());
    const data = await resp.json();
    let list = data.data?.list || data.data || data || [];
    if (!Array.isArray(list)) return;

    const colorOf = n => (n === 0 || n === 5) ? 'violet' : ([1,3,7,9].includes(n) ? 'green' : 'red');
    const sizeOf = n => n >= 5 ? 'BIG' : 'SMALL';
    let saved = 0;

    for (const item of list.slice(0, 10)) {
      const number = parseInt(item.openNum ?? item.number ?? '0');
      const period = String(item.issue ?? item.issueNumber ?? '0');
      if (isNaN(number)) continue;
      const existing = await fbGet(`results/${period}`, apiKey);
      if (existing?.fields) continue;
      await fbSet(`results/${period}`, {
        period, number,
        colour: colorOf(number),
        bigSmall: sizeOf(number),
        savedAt: new Date().toISOString(),
      }, apiKey);
      saved++;
    }

    if (list.length > 0) {
      const latest = list[0];
      const num = parseInt(latest.openNum ?? latest.number ?? '0');
      const period = String(latest.issue ?? latest.issueNumber ?? '0');
      await fbSet('meta/latest', {
        period, number: num,
        colour: colorOf(num),
        bigSmall: sizeOf(num),
        updatedAt: new Date().toISOString(),
      }, apiKey);
      await fbSet('meta/collector', {
        lastRun: new Date().toISOString(),
        lastPeriod: period,
        status: 'ok',
        savedThisRun: saved,
      }, apiKey);
    }

    await runPrediction(apiKey);
  } catch (e) {
    console.error('Cron collect error:', e.message);
  }
}

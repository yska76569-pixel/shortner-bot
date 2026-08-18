
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const { Pool } = require('pg');

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const SHORTENER_API_KEY = String(process.env.SHORTENER_API_KEY || '').trim();
const SHORTENER_BASE_URL = String(
  process.env.SHORTENER_BASE_URL || 'https://thispersonisbrandshortner.world'
).trim().replace(/\/+$/, '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const PORT = Number(process.env.PORT || 8080);

const SHORTENER_DOMAINS = String(
  process.env.SHORTENER_DOMAINS ||
  'thispersonisbrandshortner.world,thispersonisbrandshortner.asia,thispersonisbrandshortner.xyz,thispersonisbrandshortner.shop'
)
  .split(',')
  .map(v => v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
  .filter(Boolean);

const ALLOWED_TELEGRAM_IDS = new Set(
  String(process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!SHORTENER_API_KEY) throw new Error('SHORTENER_API_KEY is required');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for V2 PostgreSQL support');

// Railway public Postgres URLs commonly work with TLS through the proxy.
// Set PGSSLMODE=disable only if your database explicitly requires no SSL.
const useSsl = String(process.env.PGSSLMODE || '').toLowerCase() !== 'disable';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Math.max(2, Number(process.env.PG_POOL_MAX || 10)),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

const api = axios.create({
  baseURL: SHORTENER_BASE_URL,
  timeout: 20000,
  headers: {
    'x-api-key': SHORTENER_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'ThisPersonIsBrand-TelegramBot/2.0'
  },
  validateStatus: () => true
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
const sessions = new Map();

async function initDatabase() {
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bot_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
      total_links_created INTEGER NOT NULL DEFAULT 0,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bot_links (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      short_url TEXT NOT NULL,
      original_url TEXT,
      domain TEXT,
      short_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tg_bot_links_user
    ON telegram_bot_links(telegram_user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bot_activity (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('✅ PostgreSQL connected');
  console.log('✅ Bot tables ready: telegram_bot_users, telegram_bot_links, telegram_bot_activity');
}

async function upsertTelegramUser(from) {
  if (!from?.id) return null;
  const r = await pool.query(`
    INSERT INTO telegram_bot_users
      (telegram_user_id, username, first_name, last_name, last_seen_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      username=EXCLUDED.username,
      first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name,
      last_seen_at=NOW()
    RETURNING *
  `, [
    from.id,
    from.username || null,
    from.first_name || null,
    from.last_name || null
  ]);
  return r.rows[0];
}

async function logActivity(userId, action, details = {}) {
  try {
    await pool.query(
      `INSERT INTO telegram_bot_activity(telegram_user_id, action, details)
       VALUES($1,$2,$3::jsonb)`,
      [userId || null, action, JSON.stringify(details || {})]
    );
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

async function saveBotLink(userId, data = {}) {
  const shortUrl = String(data.shortUrl || '').trim();
  if (!shortUrl) return null;

  // Avoid duplicates if My Links is loaded repeatedly.
  const existing = await pool.query(
    `SELECT id FROM telegram_bot_links
     WHERE telegram_user_id=$1 AND short_url=$2
     ORDER BY id DESC LIMIT 1`,
    [userId, shortUrl]
  );
  if (existing.rowCount) return existing.rows[0].id;

  const r = await pool.query(`
    INSERT INTO telegram_bot_links
      (telegram_user_id, short_url, original_url, domain, short_code)
    VALUES($1,$2,$3,$4,$5)
    RETURNING id
  `, [
    userId,
    shortUrl,
    data.originalUrl || data.original_url || null,
    data.domain || null,
    data.shortCode || data.short_code || null
  ]);
  return r.rows[0].id;
}

async function getBotLinkById(id, telegramUserId) {
  const r = await pool.query(
    `SELECT * FROM telegram_bot_links WHERE id=$1 AND telegram_user_id=$2 LIMIT 1`,
    [id, telegramUserId]
  );
  return r.rows[0] || null;
}

async function isAllowed(from) {
  const id = String(from?.id || '');
  if (ALLOWED_TELEGRAM_IDS.size && !ALLOWED_TELEGRAM_IDS.has(id)) return false;

  const user = await upsertTelegramUser(from);
  if (!user) return false;
  return !user.is_blocked;
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔗 Create Short Link', callback_data: 'create' },
        { text: '📚 My Links', callback_data: 'links' }
      ],
      [
        { text: '📊 Stats', callback_data: 'stats' },
        { text: '👤 My Bot Stats', callback_data: 'mystats' }
      ],
      [{ text: '❓ Help', callback_data: 'help' }]
    ]
  };
}

function cancelKeyboard() {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] };
}

async function fetchWebsiteDomains() {
  const r=await api.get('/api/v1/domains');
  if(r.status!==200) throw new Error(r.data?.error||'Could not load website domains');
  return Array.isArray(r.data?.domains)?r.data.domains:[];
}

function domainKeyboard(domains) {
  const rows=[];
  domains.forEach((item,i)=>{
    const domain=String(item.domain||'').trim(); if(!domain)return;
    if(item.selectable) rows.push([{text:`✅ ${domain}`,callback_data:`domain:${i}`}]);
    else rows.push([{text:`${item.maintenance?'🛠 Maintenance':'⏳ Unavailable'} • ${domain}`,callback_data:`domainoff:${i}`}]);
  });
  rows.push([{text:'🔄 Refresh Domains',callback_data:'domains_refresh'}]);
  rows.push([{text:'❌ Cancel',callback_data:'cancel'}]);
  return {inline_keyboard:rows};
}

async function askForDomain(chatId,state){
  try{
    const domains=await fetchWebsiteDomains(); state.domains=domains; state.step='domain'; sessions.set(chatId,state);
    const ready=domains.filter(d=>d.selectable).length;
    return bot.sendMessage(chatId,`🌐 <b>Choose Short Domain</b>\n\n✅ Ready: <b>${ready}</b>\n📋 Detected from website: <b>${domains.length}</b>\n\nNew website domains appear after Refresh Domains.`,{parse_mode:'HTML',reply_markup:domainKeyboard(domains)});
  }catch(e){console.error('Domain sync error:',e.message);return bot.sendMessage(chatId,'❌ Could not load domains from website API. Website V7.17+ is required.');}
}

function expiryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '♾ Never', callback_data: 'expiry:0' },
        { text: '1 Day', callback_data: 'expiry:1' }
      ],
      [
        { text: '7 Days', callback_data: 'expiry:7' },
        { text: '30 Days', callback_data: 'expiry:30' }
      ],
      [
        { text: '90 Days', callback_data: 'expiry:90' },
        { text: '❌ Cancel', callback_data: 'cancel' }
      ]
    ]
  };
}

function yesNoSkipKeyboard(prefix) {
  return {
    inline_keyboard: [[
      { text: '✅ Yes', callback_data: `${prefix}:yes` },
      { text: '⏭ Skip', callback_data: `${prefix}:skip` }
    ], [{ text: '❌ Cancel', callback_data: 'cancel' }]]
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function deny(chatId) {
  return bot.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
}

async function sendMain(chatId, extra = '') {
  const text =
    `🔗 <b>THIS PERSON IS BRAND Shortener Bot</b>\n\n` +
    (extra ? `${extra}\n\n` : '') +
    `Create branded short links using your website API.`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: mainKeyboard()
  });
}

async function apiError(chatId, response, fallback) {
  const msg = response?.data?.error || fallback || 'Request failed';
  await bot.sendMessage(chatId, `❌ ${escapeHtml(msg)}`, { parse_mode: 'HTML' });
}

async function showStats(chatId) {
  const r = await api.get('/api/v1/stats');
  if (r.status !== 200) return apiError(chatId, r, 'Could not load stats');

  const s = r.data || {};
  await bot.sendMessage(
    chatId,
    `📊 <b>Shortener Website Stats</b>\n\n` +
    `🔗 Links: <b>${Number(s.links || 0).toLocaleString()}</b>\n` +
    `🟢 Real Clicks: <b>${Number(s.realClicks || 0).toLocaleString()}</b>\n` +
    `🤖 Bot Clicks: <b>${Number(s.botClicks || 0).toLocaleString()}</b>\n` +
    `👥 Unique Visitors: <b>${Number(s.uniqueVisitors || 0).toLocaleString()}</b>`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard() }
  );
}

async function showMyBotStats(chatId, userId) {
  const u = await pool.query(
    `SELECT total_links_created, first_seen_at, last_seen_at
     FROM telegram_bot_users WHERE telegram_user_id=$1`,
    [userId]
  );
  const l = await pool.query(
    `SELECT COUNT(*)::int AS count FROM telegram_bot_links WHERE telegram_user_id=$1`,
    [userId]
  );

  const user = u.rows[0] || {};
  const saved = l.rows[0]?.count || 0;

  await bot.sendMessage(
    chatId,
    `👤 <b>My Bot Stats</b>\n\n` +
    `🔗 Created through bot: <b>${Number(user.total_links_created || 0)}</b>\n` +
    `💾 Saved bot links: <b>${saved}</b>\n` +
    `🗓 First seen: <b>${user.first_seen_at ? new Date(user.first_seen_at).toLocaleString() : '-'}</b>`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard() }
  );
}

async function showLinks(chatId, telegramUserId) {
  const r = await api.get('/api/v1/links');
  if (r.status !== 200) return apiError(chatId, r, 'Could not load links');

  const links = Array.isArray(r.data?.links) ? r.data.links : [];
  if (!links.length) {
    return bot.sendMessage(chatId, '📭 No short links found yet.', {
      reply_markup: mainKeyboard()
    });
  }

  const shown = links.slice(0, 10);

  for (let i = 0; i < shown.length; i++) {
    const l = shown[i];
    const shortUrl = String(l.shortUrl || '').trim();
    const original = l.originalUrl || l.original_url || '';
    const clicks = Number(l.clicks || 0);
    if (!shortUrl) continue;

    const dbId = await saveBotLink(telegramUserId, l);

    await bot.sendMessage(
      chatId,
      `🔗 <b>${i + 1}. ${escapeHtml(shortUrl)}</b>\n` +
      `➡️ ${escapeHtml(original)}\n` +
      `👆 Clicks: <b>${clicks}</b>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Open', url: shortUrl },{ text: '📱 QR', callback_data: `qrdb:${dbId}` }],
            [{ text: '✏️ Edit Destination', callback_data: `edit:${l.id}` }]
          ]
        }
      }
    );
  }

  if (links.length > 10) {
    await bot.sendMessage(chatId, `ℹ️ Showing latest 10 of ${links.length} links.`);
  }

  await bot.sendMessage(chatId, 'Choose another action:', {
    reply_markup: mainKeyboard()
  });
}

async function createShortLink(chatId, telegramUserId, state) {
  const payload = {
    url: state.url,
    domain: state.domain
  };

  if (state.customSlug) payload.customSlug = state.customSlug;
  if (Number(state.expiresIn) > 0) payload.expiresIn = Number(state.expiresIn);
  if (state.password) payload.password = state.password;

  const r = await api.post('/api/v1/shorten', payload);

  if (r.status !== 201) {
    await logActivity(telegramUserId, 'shorten_failed', {
      status: r.status,
      error: r.data?.error || null
    });
    await apiError(chatId, r, 'Could not create short link');
    return sendMain(chatId);
  }

  const d = r.data || {};
  sessions.delete(chatId);

  const dbId = await saveBotLink(telegramUserId, {
    shortUrl: d.shortUrl,
    originalUrl: state.url,
    domain: d.domain || state.domain,
    shortCode: d.shortCode || null
  });

  await pool.query(
    `UPDATE telegram_bot_users
     SET total_links_created=total_links_created+1, last_seen_at=NOW()
     WHERE telegram_user_id=$1`,
    [telegramUserId]
  );

  await logActivity(telegramUserId, 'shorten_success', {
    shortUrl: d.shortUrl,
    domain: d.domain || state.domain
  });

  await bot.sendMessage(
    chatId,
    `✅ <b>Short link created!</b>\n\n` +
    `🔗 <code>${escapeHtml(d.shortUrl || '')}</code>\n` +
    `🌐 Domain: <b>${escapeHtml(d.domain || state.domain || '')}</b>\n` +
    `🔐 Password: <b>${d.passwordProtected ? 'Protected' : 'No'}</b>\n` +
    `⏳ Expiry: <b>${d.expiresAt ? escapeHtml(d.expiresAt) : 'Never'}</b>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🌐 Open Link', url: d.shortUrl },
            { text: '📱 QR Code', callback_data: `qrdb:${dbId}` }
          ],
          [{ text: '🏠 Main Menu', callback_data: 'menu' }]
        ]
      }
    }
  );
}

bot.onText(/\/start/, async msg => {
  try {
    if (!(await isAllowed(msg.from))) return deny(msg.chat.id);
    sessions.delete(msg.chat.id);
    await logActivity(msg.from.id, 'start');
    await sendMain(msg.chat.id, `👋 Welcome, <b>${escapeHtml(msg.from.first_name || 'User')}</b>!`);
  } catch (e) {
    console.error('/start error:', e);
    await bot.sendMessage(msg.chat.id, '❌ Temporary bot error. Please try again.');
  }
});

bot.onText(/\/menu/, async msg => {
  if (!(await isAllowed(msg.from))) return deny(msg.chat.id);
  sessions.delete(msg.chat.id);
  await sendMain(msg.chat.id);
});

bot.onText(/\/shorten(?:\s+(.+))?/, async (msg, match) => {
  if (!(await isAllowed(msg.from))) return deny(msg.chat.id);

  const chatId = msg.chat.id;
  const inlineUrl = (match?.[1] || '').trim();

  sessions.set(chatId, {
    step: inlineUrl ? 'domain' : 'url',
    telegramUserId: msg.from.id,
    url: inlineUrl || '',
    domain: '',
    customSlug: '',
    expiresIn: 0,
    password: ''
  });

  if (inlineUrl) {
    await askForDomain(chatId, sessions.get(chatId));
  } else {
    await bot.sendMessage(
      chatId,
      '🔗 Send the destination URL you want to shorten.\n\nExample:\nhttps://example.com/page',
      { reply_markup: cancelKeyboard() }
    );
  }
});

bot.onText(/\/links/, async msg => {
  if (!(await isAllowed(msg.from))) return deny(msg.chat.id);
  await showLinks(msg.chat.id, msg.from.id);
});

bot.onText(/\/stats/, async msg => {
  if (!(await isAllowed(msg.from))) return deny(msg.chat.id);
  await showStats(msg.chat.id);
});

bot.on('callback_query', async query => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  try {
    if (!(await isAllowed(query.from))) {
      await bot.answerCallbackQuery(query.id);
      return deny(chatId);
    }

    const telegramUserId = query.from.id;
    const data = String(query.data || '');

    await bot.answerCallbackQuery(query.id);

    if (data === 'menu') {
      sessions.delete(chatId);
      return sendMain(chatId);
    }

    if (data === 'cancel') {
      sessions.delete(chatId);
      return sendMain(chatId, '❌ Cancelled.');
    }

    if (data === 'create') {
      sessions.set(chatId, {
        step: 'url',
        telegramUserId,
        url: '',
        domain: '',
        customSlug: '',
        expiresIn: 0,
        password: ''
      });
      return bot.sendMessage(chatId, '🔗 Send the destination URL you want to shorten.', {
        reply_markup: cancelKeyboard()
      });
    }

    if (data === 'links') return showLinks(chatId, telegramUserId);
    if (data === 'stats') return showStats(chatId);
    if (data === 'mystats') return showMyBotStats(chatId, telegramUserId);

    if (data === 'help') {
      return bot.sendMessage(
        chatId,
        `❓ <b>How to use</b>\n\n` +
        `1️⃣ Tap <b>Create Short Link</b>\n` +
        `2️⃣ Send destination URL\n` +
        `3️⃣ Choose a domain\n` +
        `4️⃣ Add custom path if you want\n` +
        `5️⃣ Choose expiry\n` +
        `6️⃣ Add optional password\n\n` +
        `Commands:\n/start\n/menu\n/shorten\n/links\n/stats`,
        { parse_mode: 'HTML', reply_markup: mainKeyboard() }
      );
    }

    if (data === 'domains_refresh') {
      const state=sessions.get(chatId); if(!state)return sendMain(chatId,'Session expired. Start again.');
      return askForDomain(chatId,state);
    }

    if (data.startsWith('domainoff:')) {
      return bot.sendMessage(chatId,'⚠️ This domain is unavailable or under maintenance. Choose a Ready domain.');
    }

    if (data.startsWith('domain:')) {
      const state=sessions.get(chatId); if(!state)return sendMain(chatId,'Session expired. Start again.');
      const idx=Number(data.split(':')[1]); const selected=Array.isArray(state.domains)?state.domains[idx]:null;
      if(!Number.isInteger(idx)||!selected||!selected.selectable)return bot.sendMessage(chatId,'❌ Domain unavailable. Refresh Domains and choose again.');
      state.domain=selected.domain; state.step='slug_choice'; sessions.set(chatId,state);
      return bot.sendMessage(chatId,`✅ Domain: <b>${escapeHtml(state.domain)}</b>\n\nDo you want a custom short path?`,{parse_mode:'HTML',reply_markup:yesNoSkipKeyboard('slug')});
    }

    if (data.startsWith('edit:')) {
      const linkId=Number(data.slice(5));
      if(!Number.isInteger(linkId)||linkId<=0)return bot.sendMessage(chatId,'❌ Invalid link reference.');
      sessions.set(chatId,{step:'edit_url',telegramUserId,linkId});
      return bot.sendMessage(chatId,'✏️ <b>Edit Destination URL</b>\n\nSend the NEW destination URL.\nThe short URL/domain/code will stay the same.',{parse_mode:'HTML',reply_markup:cancelKeyboard()});
    }

    if (data === 'slug:yes') {
      const state = sessions.get(chatId);
      if (!state) return sendMain(chatId, 'Session expired.');
      state.step = 'slug';
      sessions.set(chatId, state);
      return bot.sendMessage(
        chatId,
        '✏️ Send custom path.\nAllowed: letters, numbers, _ and -\nExample: my-link',
        { reply_markup: cancelKeyboard() }
      );
    }

    if (data === 'slug:skip') {
      const state = sessions.get(chatId);
      if (!state) return sendMain(chatId, 'Session expired.');
      state.customSlug = '';
      state.step = 'expiry';
      sessions.set(chatId, state);
      return bot.sendMessage(chatId, '⏳ Choose expiry:', {
        reply_markup: expiryKeyboard()
      });
    }

    if (data.startsWith('expiry:')) {
      const state = sessions.get(chatId);
      if (!state) return sendMain(chatId, 'Session expired.');
      state.expiresIn = Number(data.split(':')[1] || 0);
      state.step = 'password_choice';
      sessions.set(chatId, state);

      return bot.sendMessage(
        chatId,
        '🔐 Add a password to protect the short link?',
        { reply_markup: yesNoSkipKeyboard('password') }
      );
    }

    if (data === 'password:yes') {
      const state = sessions.get(chatId);
      if (!state) return sendMain(chatId, 'Session expired.');
      state.step = 'password';
      sessions.set(chatId, state);
      return bot.sendMessage(
        chatId,
        '🔐 Send the link password (minimum 4 characters).',
        { reply_markup: cancelKeyboard() }
      );
    }

    if (data === 'password:skip') {
      const state = sessions.get(chatId);
      if (!state) return sendMain(chatId, 'Session expired.');
      state.password = '';
      return createShortLink(chatId, telegramUserId, state);
    }

    // V2 FIX: callback_data contains only a small database row ID.
    if (data.startsWith('qrdb:')) {
      const id = Number(data.slice('qrdb:'.length));
      if (!Number.isInteger(id) || id <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid QR reference.');
      }

      const link = await getBotLinkById(id, telegramUserId);
      if (!link?.short_url) {
        return bot.sendMessage(chatId, '❌ QR link record not found.');
      }

      const png = await QRCode.toBuffer(link.short_url, {
        type: 'png',
        width: 720,
        margin: 3,
        errorCorrectionLevel: 'H'
      });

      await logActivity(telegramUserId, 'qr_generated', {
        botLinkId: id,
        shortUrl: link.short_url
      });

      return bot.sendPhoto(chatId, png, {
        caption: `📱 QR Code\n${link.short_url}`
      });
    }
  } catch (e) {
    console.error('callback_query error:', {
      message: e.message,
      responseBody: e.response?.body || e.response?.data || null
    });
    try {
      await bot.sendMessage(chatId, '❌ Telegram request failed. Please try again.');
    } catch {}
  }
});

bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;

  try {
    if (!(await isAllowed(msg.from))) return deny(msg.chat.id);

    const chatId = msg.chat.id;
    const state = sessions.get(chatId);
    if (!state) return;

    const text = msg.text.trim();

    if (state.step === 'edit_url') {
      try{const u=new URL(text);if(!['http:','https:'].includes(u.protocol))throw new Error();}
      catch{return bot.sendMessage(chatId,'❌ Please send a valid http:// or https:// URL.');}
      const r=await api.patch(`/api/v1/links/${state.linkId}`,{url:text});
      if(r.status!==200){await logActivity(msg.from.id,'link_edit_failed',{linkId:state.linkId,status:r.status,error:r.data?.error||null});return apiError(chatId,r,'Could not update this short link');}
      const d=r.data||{};
      await pool.query(`UPDATE telegram_bot_links SET original_url=$1 WHERE telegram_user_id=$2 AND short_url=$3`,[d.originalUrl||text,msg.from.id,d.shortUrl||'']);
      await logActivity(msg.from.id,'link_edit_success',{linkId:state.linkId,shortUrl:d.shortUrl}); sessions.delete(chatId);
      return bot.sendMessage(chatId,`✅ <b>Destination Updated</b>\n\n🔗 Short URL stays the same:\n<code>${escapeHtml(d.shortUrl||'')}</code>\n\n➡️ New destination:\n${escapeHtml(d.originalUrl||text)}`,{parse_mode:'HTML',disable_web_page_preview:true,reply_markup:mainKeyboard()});
    }

    if (state.step === 'url') {
      try {
        const u = new URL(text);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch {
        return bot.sendMessage(chatId, '❌ Please send a valid http:// or https:// URL.');
      }

      state.url = text;
      sessions.set(chatId, state);
      return askForDomain(chatId, state);
    }

    if (state.step === 'slug') {
      if (!/^[A-Za-z0-9_-]{2,80}$/.test(text)) {
        return bot.sendMessage(
          chatId,
          '❌ Invalid custom path.\nUse 2–80 characters: letters, numbers, _ or - only.'
        );
      }

      state.customSlug = text;
      state.step = 'expiry';
      sessions.set(chatId, state);
      return bot.sendMessage(chatId, '⏳ Choose expiry:', {
        reply_markup: expiryKeyboard()
      });
    }

    if (state.step === 'password') {
      if (text.length < 4) {
        return bot.sendMessage(chatId, '❌ Password must be at least 4 characters.');
      }

      state.password = text;
      sessions.set(chatId, state);
      return createShortLink(chatId, msg.from.id, state);
    }
  } catch (e) {
    console.error('message handler error:', e.message);
    await bot.sendMessage(msg.chat.id, '❌ Temporary bot error. Please try again.');
  }
});

bot.on('polling_error', err => {
  // Print only useful Telegram error information, not a giant TLS/socket dump.
  console.error('Telegram polling error:', {
    message: err.message,
    statusCode: err.response?.statusCode || err.response?.status || null,
    body: err.response?.body || err.response?.data || null
  });
});

app.get('/', (req, res) => {
  res.status(200).send('THIS PERSON IS BRAND Telegram Shortener Bot V2 is running.');
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      bot: 'telegram-shortener-v2',
      database: 'connected',
      apiBase: SHORTENER_BASE_URL,
      domains: SHORTENER_DOMAINS.length
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      database: 'error',
      error: e.message
    });
  }
});

async function start() {
  await initDatabase();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health server running on port ${PORT}`);
    console.log(`🤖 Telegram bot polling started`);
    console.log(`📡 Shortener API: ${SHORTENER_BASE_URL}`);
    console.log(`🌐 Dynamic website domain sync: ENABLED`);
    console.log(`🗄 PostgreSQL: CONNECTED`);
    console.log(`🔐 API key: ${SHORTENER_API_KEY ? 'SET' : 'MISSING'}`);
    console.log(`🔑 Bot token: ${BOT_TOKEN ? 'SET' : 'MISSING'}`);
    console.log(`👥 Access control: ${ALLOWED_TELEGRAM_IDS.size ? 'WHITELIST' : 'PUBLIC'}`);
  });
}

start().catch(err => {
  console.error('❌ Bot startup failed:', err.message);
  process.exit(1);
});


const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const SHORTENER_API_KEY = String(process.env.SHORTENER_API_KEY || '').trim();
const SHORTENER_BASE_URL = String(process.env.SHORTENER_BASE_URL || 'https://thispersonisbrandshortner.world')
  .trim().replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 8080);

// Comma-separated domains, e.g.
// thispersonisbrandshortner.world,thispersonisbrandshortner.asia,...
const SHORTENER_DOMAINS = String(
  process.env.SHORTENER_DOMAINS ||
  'thispersonisbrandshortner.world,thispersonisbrandshortner.asia,thispersonisbrandshortner.xyz,thispersonisbrandshortner.shop'
)
  .split(',')
  .map(v => v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
  .filter(Boolean);

// Optional: limit bot usage to Telegram user IDs.
// Leave blank to allow everyone.
const ALLOWED_TELEGRAM_IDS = new Set(
  String(process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!SHORTENER_API_KEY) throw new Error('SHORTENER_API_KEY is required');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const api = axios.create({
  baseURL: SHORTENER_BASE_URL,
  timeout: 20000,
  headers: {
    'x-api-key': SHORTENER_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'ThisPersonIsBrand-TelegramBot/1.0'
  },
  validateStatus: () => true
});

const sessions = new Map();

function isAllowed(msgOrQuery) {
  if (!ALLOWED_TELEGRAM_IDS.size) return true;
  const userId = String(msgOrQuery.from?.id || '');
  return ALLOWED_TELEGRAM_IDS.has(userId);
}

function deny(chatId) {
  return bot.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
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
        { text: '❓ Help', callback_data: 'help' }
      ]
    ]
  };
}

function cancelKeyboard() {
  return {
    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]]
  };
}

function domainKeyboard() {
  const rows = SHORTENER_DOMAINS.map((domain, i) => [{
    text: `🌐 ${domain}`,
    callback_data: `domain:${i}`
  }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
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

bot.onText(/\/start/, async msg => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  sessions.delete(msg.chat.id);
  await sendMain(msg.chat.id, `👋 Welcome, <b>${escapeHtml(msg.from.first_name || 'User')}</b>!`);
});

bot.onText(/\/menu/, async msg => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  sessions.delete(msg.chat.id);
  await sendMain(msg.chat.id);
});

bot.onText(/\/shorten(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const chatId = msg.chat.id;
  const inlineUrl = (match?.[1] || '').trim();

  sessions.set(chatId, {
    step: inlineUrl ? 'domain' : 'url',
    url: inlineUrl || '',
    domain: '',
    customSlug: '',
    expiresIn: 0,
    password: ''
  });

  if (inlineUrl) {
    await bot.sendMessage(chatId, '🌐 Choose the short-link domain:', {
      reply_markup: domainKeyboard()
    });
  } else {
    await bot.sendMessage(
      chatId,
      '🔗 Send the destination URL you want to shorten.\n\nExample:\nhttps://example.com/page',
      { reply_markup: cancelKeyboard() }
    );
  }
});

bot.onText(/\/links/, async msg => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await showLinks(msg.chat.id);
});

bot.onText(/\/stats/, async msg => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await showStats(msg.chat.id);
});

async function showStats(chatId) {
  const r = await api.get('/api/v1/stats');
  if (r.status !== 200) return apiError(chatId, r, 'Could not load stats');

  const s = r.data || {};
  await bot.sendMessage(
    chatId,
    `📊 <b>Shortener Stats</b>\n\n` +
    `🔗 Links: <b>${Number(s.links || 0).toLocaleString()}</b>\n` +
    `🟢 Real Clicks: <b>${Number(s.realClicks || 0).toLocaleString()}</b>\n` +
    `🤖 Bot Clicks: <b>${Number(s.botClicks || 0).toLocaleString()}</b>\n` +
    `👥 Unique Visitors: <b>${Number(s.uniqueVisitors || 0).toLocaleString()}</b>`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard() }
  );
}

async function showLinks(chatId) {
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
    const shortUrl = l.shortUrl || '';
    const original = l.originalUrl || l.original_url || '';
    const clicks = Number(l.clicks || 0);

    await bot.sendMessage(
      chatId,
      `🔗 <b>${i + 1}. ${escapeHtml(shortUrl)}</b>\n` +
      `➡️ ${escapeHtml(original)}\n` +
      `👆 Clicks: <b>${clicks}</b>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '🌐 Open', url: shortUrl },
            { text: '📱 QR', callback_data: `qr:${i}` }
          ]]
        }
      }
    );
  }

  sessions.set(`links:${chatId}`, shown);

  if (links.length > 10) {
    await bot.sendMessage(chatId, `ℹ️ Showing latest 10 of ${links.length} links.`);
  }

  await bot.sendMessage(chatId, 'Choose another action:', {
    reply_markup: mainKeyboard()
  });
}

async function createShortLink(chatId, state) {
  const payload = {
    url: state.url,
    domain: state.domain
  };

  if (state.customSlug) payload.customSlug = state.customSlug;
  if (Number(state.expiresIn) > 0) payload.expiresIn = Number(state.expiresIn);
  if (state.password) payload.password = state.password;

  const r = await api.post('/api/v1/shorten', payload);

  if (r.status !== 201) {
    await apiError(chatId, r, 'Could not create short link');
    return sendMain(chatId);
  }

  const d = r.data || {};
  sessions.delete(chatId);

  await bot.sendMessage(
    chatId,
    `✅ <b>Short link created!</b>\n\n` +
    `🔗 <code>${escapeHtml(d.shortUrl || '')}</code>\n` +
    `🌐 Domain: <b>${escapeHtml(d.domain || '')}</b>\n` +
    `🔐 Password: <b>${d.passwordProtected ? 'Protected' : 'No'}</b>\n` +
    `⏳ Expiry: <b>${d.expiresAt ? escapeHtml(d.expiresAt) : 'Never'}</b>`,
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🌐 Open Link', url: d.shortUrl },
            { text: '📱 QR Code', callback_data: `qrurl:${Buffer.from(d.shortUrl).toString('base64url')}` }
          ],
          [{ text: '🏠 Main Menu', callback_data: 'menu' }]
        ]
      }
    }
  );
}

bot.on('callback_query', async query => {
  if (!isAllowed(query)) {
    await bot.answerCallbackQuery(query.id);
    return deny(query.message.chat.id);
  }

  const chatId = query.message.chat.id;
  const data = query.data || '';
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
      url: '',
      domain: '',
      customSlug: '',
      expiresIn: 0,
      password: ''
    });
    return bot.sendMessage(
      chatId,
      '🔗 Send the destination URL you want to shorten.',
      { reply_markup: cancelKeyboard() }
    );
  }

  if (data === 'links') return showLinks(chatId);
  if (data === 'stats') return showStats(chatId);

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

  if (data.startsWith('domain:')) {
    const state = sessions.get(chatId);
    if (!state) return sendMain(chatId, 'Session expired. Start again.');

    const idx = Number(data.split(':')[1]);
    if (!Number.isInteger(idx) || !SHORTENER_DOMAINS[idx]) {
      return bot.sendMessage(chatId, '❌ Invalid domain.');
    }

    state.domain = SHORTENER_DOMAINS[idx];
    state.step = 'slug_choice';
    sessions.set(chatId, state);

    return bot.sendMessage(
      chatId,
      `✅ Domain: <b>${escapeHtml(state.domain)}</b>\n\nDo you want a custom short path?`,
      { parse_mode: 'HTML', reply_markup: yesNoSkipKeyboard('slug') }
    );
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
    return createShortLink(chatId, state);
  }

  if (data.startsWith('qrurl:')) {
    try {
      const encoded = data.slice('qrurl:'.length);
      const url = Buffer.from(encoded, 'base64url').toString('utf8');
      const png = await QRCode.toBuffer(url, {
        type: 'png',
        width: 720,
        margin: 3,
        errorCorrectionLevel: 'H'
      });
      return bot.sendPhoto(chatId, png, {
        caption: `📱 QR Code\n${url}`
      });
    } catch (e) {
      console.error('QR error:', e);
      return bot.sendMessage(chatId, '❌ Could not generate QR code.');
    }
  }

  if (data.startsWith('qr:')) {
    const idx = Number(data.split(':')[1]);
    const list = sessions.get(`links:${chatId}`) || [];
    const link = list[idx];
    if (!link?.shortUrl) return bot.sendMessage(chatId, '❌ Link not found. Open My Links again.');

    try {
      const png = await QRCode.toBuffer(link.shortUrl, {
        type: 'png',
        width: 720,
        margin: 3,
        errorCorrectionLevel: 'H'
      });
      return bot.sendPhoto(chatId, png, {
        caption: `📱 QR Code\n${link.shortUrl}`
      });
    } catch (e) {
      return bot.sendMessage(chatId, '❌ Could not generate QR code.');
    }
  }
});

bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAllowed(msg)) return deny(msg.chat.id);

  const chatId = msg.chat.id;
  const state = sessions.get(chatId);
  if (!state) return;

  const text = msg.text.trim();

  if (state.step === 'url') {
    try {
      const u = new URL(text);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      return bot.sendMessage(chatId, '❌ Please send a valid http:// or https:// URL.');
    }

    state.url = text;
    state.step = 'domain';
    sessions.set(chatId, state);
    return bot.sendMessage(chatId, '🌐 Choose the short-link domain:', {
      reply_markup: domainKeyboard()
    });
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
    return createShortLink(chatId, state);
  }
});

bot.on('polling_error', err => {
  console.error('Telegram polling error:', err.message);
});

// Railway health server
const app = express();
app.get('/', (req, res) => {
  res.status(200).send('THIS PERSON IS BRAND Telegram Shortener Bot is running.');
});
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: 'telegram-shortener',
    apiBase: SHORTENER_BASE_URL,
    domains: SHORTENER_DOMAINS.length
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Health server running on port ${PORT}`);
  console.log(`🤖 Telegram bot polling started`);
  console.log(`📡 Shortener API: ${SHORTENER_BASE_URL}`);
  console.log(`🌐 Domains configured: ${SHORTENER_DOMAINS.length}`);
  console.log(`🔐 API key: ${SHORTENER_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`🔑 Bot token: ${BOT_TOKEN ? 'SET' : 'MISSING'}`);
  console.log(`👥 Access control: ${ALLOWED_TELEGRAM_IDS.size ? 'WHITELIST' : 'PUBLIC'}`);
});

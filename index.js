const { Bot, InlineKeyboard, InputFile } = require('grammy');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pipeline } = require('stream/promises');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

// Kalitlar faqat Render -> Environment bo'limidan olinadi
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.BOT;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SHAZAM_HOST = 'shazam.p.rapidapi.com';
const JAMENDO_ID = process.env.JAMENDO_CLIENT_ID;
const AUDIUS_BEARER = process.env.AUDIUS_BEARER_TOKEN;
const AUDIUS_ENABLED = Boolean(AUDIUS_BEARER);
const AUDIUS_APP = 'saveit_uz_bot';
const audiusHeaders = { Authorization: `Bearer ${AUDIUS_BEARER}` };

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN topilmadi! Render -> Environment bo\'limiga kiriting.');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ---------- Yordamchi funksiyalar ----------

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const normalize = (s = '') =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const VARIANT_WORDS = ['remix', 'slowed', 'reverb', 'sped up', 'speed up', 'bass boosted',
  'cover', 'tribute', 'live', 'karaoke', 'instrumental', 'acoustic'];

// Video sarlavhasini tozalash: "(Official Video)", "[Lyrics]" va h.k.
function cleanTitle(title = '') {
  return title
    .replace(/[\(\[][^\)\]]*(official|video|lyrics?|audio|clip|klip|mv|hd|4k|visualizer)[^\)\]]*[\)\]]/gi, ' ')
    .replace(/\b(official|video|lyrics?|audio|music|klip|clip|rasmiy|hd|4k)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Natija so'rovga qanchalik mos ekanini baholash
function scoreTrack(track, query, index) {
  const q = normalize(query);
  const qWords = q.split(' ').filter(Boolean);
  const haystack = normalize(`${track.artist.name} ${track.title}`);

  let matched = 0;
  for (const w of qWords) if (haystack.includes(w)) matched++;
  let score = qWords.length ? matched / qWords.length : 0;

  const titleNorm = normalize(track.title);
  for (const v of VARIANT_WORDS) {
    if (titleNorm.includes(v) && !q.includes(v)) {
      score -= 0.6;
      break;
    }
  }

  score += (10 - index) * 0.01;
  return score;
}

// ---------- API'lar ----------

// Shazam (RapidAPI): xom audio (s16le, 44100 Hz, mono) base64 ko'rinishida
async function recognizeAudio(filePath) {
  if (!RAPIDAPI_KEY) {
    console.error('RAPIDAPI_KEY topilmadi!');
    return null;
  }
  try {
    const base64 = fs.readFileSync(filePath).toString('base64');
    const { data } = await axios.post(
      `https://${SHAZAM_HOST}/songs/v2/detect`,
      base64,
      {
        params: { timezone: 'Asia/Tashkent', locale: 'en-US' },
        headers: {
          'content-type': 'text/plain',
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': SHAZAM_HOST,
        },
        timeout: 30000,
        maxBodyLength: Infinity,
      }
    );
    if (data && data.track) {
      return { artist: data.track.subtitle, title: data.track.title };
    }
    console.log('Shazam: trek topilmadi');
    return null;
  } catch (err) {
    console.error('Shazam error:', err.response?.status, err.message);
    return null;
  }
}

async function searchTracks(query) {
  try {
    const { data } = await axios.get('https://api.deezer.com/search', {
      params: { q: query, limit: 30 },
      timeout: 15000,
    });
    const list = data && data.data;
    if (!list || !list.length) return [];

    const ranked = list
      .map((t, i) => ({ t, score: scoreTrack(t, query, Math.min(i, 10)) }))
      .sort((a, b) => b.score - a.score);

    // Bir xil qo'shiqlarni (takrorlarni) olib tashlash
    const seen = new Set();
    const result = [];
    for (const { t } of ranked) {
      const key = normalize(`${t.artist ? t.artist.name : ''} ${t.title}`);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: t.id,
        title: t.title,
        artist: t.artist ? t.artist.name : 'Nomaʼlum',
        duration: formatDuration(t.duration),
      });
    }
    return result;
  } catch (err) {
    console.error('Deezer API error:', err.message);
    return [];
  }
}

// Jamendo: erkin litsenziyali musiqa (to'liq trek)
async function searchJamendo(query) {
  if (!JAMENDO_ID) return [];
  try {
    const { data } = await axios.get('https://api.jamendo.com/v3.0/tracks/', {
      params: {
        client_id: JAMENDO_ID,
        format: 'json',
        limit: 10,
        search: query,
        audioformat: 'mp32',
      },
      timeout: 15000,
    });
    return ((data && data.results) || []).map((t) => ({
      id: t.id,
      title: t.name,
      artist: t.artist_name,
      duration: formatDuration(t.duration),
    }));
  } catch (err) {
    console.error('Jamendo search error:', err.message);
    return [];
  }
}

async function getJamendoTrack(id) {
  if (!JAMENDO_ID) return null;
  try {
    const { data } = await axios.get('https://api.jamendo.com/v3.0/tracks/', {
      params: { client_id: JAMENDO_ID, format: 'json', id, audioformat: 'mp32' },
      timeout: 15000,
    });
    const t = data && data.results && data.results[0];
    if (!t) return null;
    return {
      id: t.id,
      title: t.name,
      artist: t.artist_name,
      audioUrl: t.audio,
      shareUrl: t.shareurl,
    };
  } catch (err) {
    console.error('Jamendo track error:', err.message);
    return null;
  }
}

// Audius: to'liq treklar (mustaqil musiqachilar)
async function searchAudius(query) {
  if (!AUDIUS_ENABLED) return [];
  try {
    const { data } = await axios.get('https://api.audius.co/v1/tracks/search', {
      params: { query, limit: 10, app_name: AUDIUS_APP },
      headers: audiusHeaders,
      timeout: 15000,
    });
    return ((data && data.data) || [])
      .filter((t) => t.is_streamable !== false)
      .map((t) => ({
        id: t.id,
        title: t.title,
        artist: (t.user && t.user.name) || 'Nomaʼlum',
        duration: formatDuration(t.duration),
      }));
  } catch (err) {
    console.error('Audius search error:', err.response?.status, err.message);
    return null;
  }
}

async function downloadAudius(id) {
  try {
    const info = await axios.get(`https://api.audius.co/v1/tracks/${id}`, {
      params: { app_name: AUDIUS_APP },
      headers: audiusHeaders,
      timeout: 15000,
    });
    const t = info.data && info.data.data;
    if (!t) return null;

    const stream = await axios.get(`https://api.audius.co/v1/tracks/${id}/stream`, {
      params: { app_name: AUDIUS_APP },
      headers: audiusHeaders,
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: 50 * 1024 * 1024,
    });

    return {
      title: t.title,
      artist: (t.user && t.user.name) || 'Nomaʼlum',
      permalink: t.permalink,
      buffer: Buffer.from(stream.data),
    };
  } catch (err) {
    console.error('Audius stream error:', err.response?.status, err.message);
    return null;
  }
}

async function getTrackById(id) {
  try {
    const { data } = await axios.get(`https://api.deezer.com/track/${id}`, { timeout: 15000 });
    if (!data || data.error) return null;
    return {
      id: data.id,
      title: data.title,
      artist: data.artist ? data.artist.name : 'Nomaʼlum',
      audioUrl: data.preview,
      link: data.link,
      duration: formatDuration(data.duration),
    };
  } catch (err) {
    console.error('Deezer track error:', err.message);
    return null;
  }
}

// YouTube havolasidan sarlavha olish (oEmbed)
async function getTitleFromLink(url) {
  const isYoutube = /(youtube\.com|youtu\.be)/i.test(url);
  if (!isYoutube) return null;
  try {
    const { data } = await axios.get('https://www.youtube.com/oembed', {
      params: { url, format: 'json' },
      timeout: 15000,
    });
    return cleanTitle(data.title || '');
  } catch (err) {
    console.error('oEmbed error:', err.message);
    return null;
  }
}

// ---------- Audio ajratish ----------

function extractAudio(videoPath, outPath, startSec) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(startSec)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(44100)
      .duration(5)
      .format('s16le')
      .on('error', reject)
      .on('end', resolve)
      .save(outPath);
  });
}

// ---------- Javob yuborish ----------

const PER_PAGE = 10;
const searchCache = new Map();
const queryCache = new Map();

function cacheSet(key, tracks) {
  searchCache.set(key, tracks);
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
}

function renderPage(tracks, page, key) {
  const start = page * PER_PAGE;
  const slice = tracks.slice(start, start + PER_PAGE);

  let text = `🎵 <b>Topilgan qo'shiqlar</b> (${start + 1}-${start + slice.length} / ${tracks.length})\n\n`;
  slice.forEach((t, i) => {
    text += `${start + i + 1}. <b>${escapeHtml(t.artist)}</b> — ${escapeHtml(t.title)} (${t.duration})\n`;
  });
  text += `\nYuklab olish uchun raqamni bosing 👇`;

  const kb = new InlineKeyboard();
  slice.forEach((t, i) => {
    kb.text(String(start + i + 1), `dl:${t.id}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row();
  if (page > 0) kb.text('⬅️ Oldingi', `pg:${key}:${page - 1}`);
  if (start + PER_PAGE < tracks.length) kb.text('Keyingi ➡️', `pg:${key}:${page + 1}`);
  if (AUDIUS_ENABLED) kb.row().text("🎵 Audius (to'liq trek, bot ichida)", `au:${key}`);
  if (JAMENDO_ID) kb.row().text("🎼 Erkin musiqa (Jamendo)", `jm:${key}`);

  return { text, kb };
}

async function replyWithTrack(ctx, query, waitingMsgId) {
  const tracks = await searchTracks(query);

  if (!tracks.length) {
    await ctx.api.editMessageText(ctx.chat.id, waitingMsgId, "❌ Kechirasiz, bu qo'shiq topilmadi.");
    return;
  }

  const key = `${ctx.chat.id}_${waitingMsgId}`;
  cacheSet(key, tracks);
  queryCache.set(key, query);
  if (queryCache.size > 300) queryCache.delete(queryCache.keys().next().value);
  const { text, kb } = renderPage(tracks, 0, key);

  await ctx.api.editMessageText(ctx.chat.id, waitingMsgId, text, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

// ---------- Handlerlar ----------

bot.command('start', (ctx) =>
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
      `Menga qo'shiq nomini, YouTube havolasini yoki video yuboring, qo'shiqni topib beraman! 🎧`
  )
);

bot.on(['message:video', 'message:video_note'], async (ctx) => {
  const waitingMsg = await ctx.reply('🔍 Videodagi musiqa tahlil qilinmoqda...');
  const stamp = Date.now();
  const tempVideo = path.join(__dirname, `temp_${stamp}.mp4`);
  const tempAudio = path.join(__dirname, `temp_${stamp}.raw`);

  const cleanup = () => {
    for (const f of [tempVideo, tempAudio]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  };
  const edit = async (msg) => {
    try { await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, msg); } catch (_) {}
  };

  try {
    const file = await ctx.getFile(); // Telegram: 20 MB gacha
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const response = await axios({ url: fileUrl, responseType: 'stream', timeout: 60000 });
    await pipeline(response.data, fs.createWriteStream(tempVideo));

    // Avval boshidan, topilmasa 10-soniyadan boshlab tekshiramiz
    let result = null;
    for (const start of [0, 10]) {
      try {
        await extractAudio(tempVideo, tempAudio, start);
      } catch (e) {
        console.error('ffmpeg error:', e.message);
        continue;
      }
      if (!fs.existsSync(tempAudio) || fs.statSync(tempAudio).size < 20000) continue;

      result = await recognizeAudio(tempAudio);
      if (result) break;
    }

    cleanup();

    if (result) {
      await replyWithTrack(ctx, `${result.artist} ${result.title}`, waitingMsg.message_id);
    } else {
      await edit('❌ Videodagi musiqa aniqlanmadi.');
    }
  } catch (error) {
    console.error(error);
    cleanup();
    await edit('⚠️ Xatolik yuz berdi.');
  }
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (/^https?:\/\//i.test(text)) {
    const waitingMsg = await ctx.reply('🔗 Havola tekshirilmoqda...');
    const title = await getTitleFromLink(text);

    if (!title) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        waitingMsg.message_id,
        `⚠️ Bu havoladan qo'shiq nomini olib bo'lmadi (hozircha faqat YouTube qo'llab-quvvatlanadi).\n\n` +
          `Videoni fayl ko'rinishida yuboring yoki qo'shiq nomini yozing! 🎧`
      );
      return;
    }

    await replyWithTrack(ctx, title, waitingMsg.message_id);
    return;
  }

  const waitingMsg = await ctx.reply("🔎 Qo'shiq qidirilmoqda...");
  await replyWithTrack(ctx, text, waitingMsg.message_id);
});

bot.callbackQuery(/^dl:(\d+)$/, async (ctx) => {
  const track = await getTrackById(ctx.match[1]);

  if (!track || !track.audioUrl) {
    return ctx.answerCallbackQuery({
      text: "⚠️ Qo'shiq ma'lumotlari topilmadi. Qaytadan qidiring.",
      show_alert: true,
    });
  }

  await ctx.answerCallbackQuery({ text: `⏳ ${track.title} yuborilmoqda...` });

  try {
    await ctx.replyWithAudio(track.audioUrl, {
      title: track.title,
      performer: track.artist,
      caption: `🎵 <b>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</b>\n🤖 @${ctx.me.username}`,
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .url("🎧 To'liq qo'shiq (Deezer)", track.link || 'https://www.deezer.com')
        .row()
        .url(
          '▶️ YouTube\'da tinglash',
          `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.artist} ${track.title}`)}`
        ),
    });
  } catch (err) {
    console.error('Audio yuborishda xatolik:', err.message);
    await ctx.reply('⚠️ Audioni yuborishda xatolik yuz berdi.');
  }
});

bot.callbackQuery(/^pg:(.+):(\d+)$/, async (ctx) => {
  const tracks = searchCache.get(ctx.match[1]);
  if (!tracks) {
    return ctx.answerCallbackQuery({
      text: "⚠️ Natijalar eskirgan. Qaytadan qidiring.",
      show_alert: true,
    });
  }
  const { text, kb } = renderPage(tracks, Number(ctx.match[2]), ctx.match[1]);
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    console.error('Sahifalash xatosi:', err.message);
  }
});

bot.callbackQuery(/^jm:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const query = queryCache.get(key);
  if (!query) {
    return ctx.answerCallbackQuery({ text: '⚠️ Natijalar eskirgan. Qaytadan qidiring.', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: '🔎 Erkin musiqa qidirilmoqda...' });

  const tracks = await searchJamendo(query);
  const kb = new InlineKeyboard();

  if (!tracks.length) {
    kb.text('⬅️ Orqaga', `pg:${key}:0`);
    try {
      await ctx.editMessageText(
        "🎼 Jamendo'da (erkin musiqa) bu qo'shiq topilmadi.\n\nMashhur artistlarning qo'shiqlari u yerda bo'lmaydi.",
        { reply_markup: kb }
      );
    } catch (_) {}
    return;
  }

  let text = `🎼 <b>Erkin musiqa (Jamendo)</b>, to'liq treklar:\n\n`;
  tracks.forEach((t, i) => {
    text += `${i + 1}. <b>${escapeHtml(t.artist)}</b> — ${escapeHtml(t.title)} (${t.duration})\n`;
    kb.text(String(i + 1), `jd:${t.id}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row().text('⬅️ Orqaga', `pg:${key}:0`);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    console.error('Jamendo ro\'yxat xatosi:', err.message);
  }
});

bot.callbackQuery(/^jd:(\d+)$/, async (ctx) => {
  const track = await getJamendoTrack(ctx.match[1]);
  if (!track || !track.audioUrl) {
    return ctx.answerCallbackQuery({ text: '⚠️ Trek topilmadi.', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: `⏳ ${track.title} yuborilmoqda...` });

  try {
    await ctx.replyWithAudio(track.audioUrl, {
      title: track.title,
      performer: track.artist,
      caption:
        `🎼 <b>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</b>\n` +
        `Manba: Jamendo (Creative Commons)\n🤖 @${ctx.me.username}`,
      parse_mode: 'HTML',
      reply_markup: track.shareUrl
        ? new InlineKeyboard().url('ℹ️ Litsenziya / trek sahifasi', track.shareUrl)
        : undefined,
    });
  } catch (err) {
    console.error('Jamendo audio xatosi:', err.message);
    await ctx.reply('⚠️ Audioni yuborishda xatolik yuz berdi.');
  }
});

bot.callbackQuery(/^au:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const query = queryCache.get(key);
  if (!query) {
    return ctx.answerCallbackQuery({ text: '⚠️ Natijalar eskirgan. Qaytadan qidiring.', show_alert: true });
  }
  await ctx.answerCallbackQuery({ text: '🔎 Audius qidirilmoqda...' });

  const tracks = await searchAudius(query);
  const kb = new InlineKeyboard();

  if (tracks === null) {
    kb.text('⬅️ Orqaga', `pg:${key}:0`);
    try {
      await ctx.editMessageText(
        "⚠️ Audius bilan bog'lanib bo'lmadi. Kalit (AUDIUS_BEARER_TOKEN) noto'g'ri bo'lishi mumkin. Render Logs'dagi 'Audius search error' qatoriga qarang.",
        { reply_markup: kb }
      );
    } catch (_) {}
    return;
  }

  if (!tracks.length) {
    kb.text('⬅️ Orqaga', `pg:${key}:0`);
    try {
      await ctx.editMessageText(
        "🎵 Audius'da bu qo'shiq topilmadi.\n\nMashhur artistlarning qo'shiqlari u yerda ko'pincha bo'lmaydi. Boshqa so'z yoki artist nomi bilan sinab ko'ring.",
        { reply_markup: kb }
      );
    } catch (_) {}
    return;
  }

  let text = `🎵 <b>Audius</b>, to'liq treklar:\n\n`;
  tracks.forEach((t, i) => {
    text += `${i + 1}. <b>${escapeHtml(t.artist)}</b> — ${escapeHtml(t.title)} (${t.duration})\n`;
    kb.text(String(i + 1), `ad:${t.id}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row().text('⬅️ Orqaga', `pg:${key}:0`);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    console.error('Audius ro\'yxat xatosi:', err.message);
  }
});

bot.callbackQuery(/^ad:([A-Za-z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: '⏳ To\'liq trek yuklanmoqda, biroz kuting...' });

  const track = await downloadAudius(ctx.match[1]);
  if (!track) {
    return ctx.reply('⚠️ Treksni yuklab bo\'lmadi. Keyinroq qayta urinib ko\'ring.');
  }

  try {
    await ctx.replyWithAudio(new InputFile(track.buffer, `${track.artist} - ${track.title}.mp3`), {
      title: track.title,
      performer: track.artist,
      caption: `🎵 <b>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</b>\nManba: Audius\n🤖 @${ctx.me.username}`,
      parse_mode: 'HTML',
      reply_markup: track.permalink
        ? new InlineKeyboard().url('ℹ️ Audius sahifasi', `https://audius.co${track.permalink}`)
        : undefined,
    });
  } catch (err) {
    console.error('Audius yuborish xatosi:', err.message);
    await ctx.reply('⚠️ Audioni yuborishda xatolik yuz berdi.');
  }
});

bot.catch((err) => console.error('Bot xatosi:', err.error || err));

bot.start({
  drop_pending_updates: true,
  onStart: (info) => console.log(`Bot @${info.username} ishga tushdi!`),
});

// ---------- Render uchun server ----------
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!\n');
  })
  .listen(process.env.PORT || 3000, () => console.log('Server ishlamoqda'));

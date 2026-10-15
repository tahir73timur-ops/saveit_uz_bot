const { Bot, InlineKeyboard } = require('grammy');
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

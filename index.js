const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = process.env.BOT_TOKEN;
const AUDD_API_KEY = process.env.AUDD_API_KEY;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN topilmadi! Environment variable sifatida kiriting.');
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

// Video sarlavhasini tozalash: "(Official Video)", "[Lyrics]" va h.k. ni olib tashlaydi
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

  // Foydalanuvchi so'ramagan bo'lsa remix/cover/live'ni jarimaga tortamiz
  const titleNorm = normalize(track.title);
  for (const v of VARIANT_WORDS) {
    if (titleNorm.includes(v) && !q.includes(v)) {
      score -= 0.6;
      break;
    }
  }

  // Deezer o'zi bergan tartibga ozgina ustunlik
  score += (10 - index) * 0.01;
  return score;
}

// ---------- API'lar ----------

async function recognizeAudio(filePath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('api_token', AUDD_API_KEY);
    const { data } = await axios.post('https://api.audd.io/', form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
    return data;
  } catch (err) {
    console.error('AudD error:', err.message);
    return null;
  }
}

async function searchBestTrack(query) {
  try {
    const { data } = await axios.get('https://api.deezer.com/search', {
      params: { q: query, limit: 15 },
      timeout: 15000,
    });
    const list = data && data.data;
    if (!list || !list.length) return null;

    const ranked = list
      .map((t, i) => ({ t, score: scoreTrack(t, query, i) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0].t;
    return {
      id: best.id,
      title: best.title,
      artist: best.artist ? best.artist.name : 'Nomaʼlum',
      audioUrl: best.preview,
      duration: formatDuration(best.duration),
    };
  } catch (err) {
    console.error('Deezer API error:', err.message);
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

// ---------- Javob yuborish ----------

async function replyWithTrack(ctx, query, waitingMsgId) {
  const track = await searchBestTrack(query);

  if (!track) {
    await ctx.api.editMessageText(ctx.chat.id, waitingMsgId, "❌ Kechirasiz, bu qo'shiq topilmadi.");
    return;
  }

  const text =
    `🎵 <b>Topilgan qo'shiq:</b>\n\n` +
    `👤 <b>Ijrochi:</b> ${escapeHtml(track.artist)}\n` +
    `🎧 <b>Nomi:</b> ${escapeHtml(track.title)}\n` +
    `⏱ <b>Davomiyligi:</b> ${track.duration}\n\n` +
    `#MusicLovers`;

  const keyboard = new InlineKeyboard().text("⬇️ Qo'shiqni yuklab olish", `dl:${track.id}`);

  await ctx.api.editMessageText(ctx.chat.id, waitingMsgId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
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
  const tempAudio = path.join(__dirname, `temp_${stamp}.mp3`);

  const cleanup = () => {
    for (const f of [tempVideo, tempAudio]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  };
  const fail = async (msg) => {
    cleanup();
    try { await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, msg); } catch (_) {}
  };

  try {
    const file = await ctx.getFile(); // Telegram: 20 MB gacha
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const response = await axios({ url: fileUrl, responseType: 'stream' });
    const writer = fs.createWriteStream(tempVideo);
    response.data.pipe(writer);

    writer.on('error', () => fail('⚠️ Faylni yuklashda xatolik.'));
    writer.on('finish', () => {
      ffmpeg(tempVideo)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(44100)
        .duration(25) // faqat 25 soniya yetarli
        .format('mp3')
        .on('error', (e) => {
          console.error('ffmpeg error:', e.message);
          fail('⚠️ Videodan audio ajratib bo\'lmadi.');
        })
        .on('end', async () => {
          try {
            const result = await recognizeAudio(tempAudio);
            cleanup();

            if (result && result.status === 'success' && result.result) {
              const songName = `${result.result.artist} ${result.result.title}`;
              await replyWithTrack(ctx, songName, waitingMsg.message_id);
            } else {
              await ctx.api.editMessageText(
                ctx.chat.id, waitingMsg.message_id, '❌ Videodagi musiqa aniqlanmadi.'
              );
            }
          } catch (e) {
            console.error(e);
            fail('⚠️ Xatolik yuz berdi.');
          }
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    fail('⚠️ Xatolik yuz berdi.');
  }
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // Havola bo'lsa
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
    });
  } catch (err) {
    console.error('Audio yuborishda xatolik:', err.message);
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

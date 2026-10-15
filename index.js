const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

// Вставьте ваш токен бота
const BOT_TOKEN = "8761282938:AAH7NZ4Ivwo8kz3qBpzWNBJnpW2tnPC6P8A";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  return ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, original qo'shiqni topib beraman! 🎧`
  );
});

// Форматирование времени (MM:SS)
function formatDuration(seconds) {
  if (!seconds) return '03:00';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes < 10 ? '0' : ''}${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

// Распознавание через AudD API
async function recognizeAudio(filePath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('api_token', AUDD_API_KEY);

    const response = await axios.post('https://api.audd.io/', form, {
      headers: form.getHeaders(),
    });

    return response.data;
  } catch (err) {
    console.error("AudD error:", err.message);
    return null;
  }
}

// Поиск 1 самого точного оригинального трека через Deezer API
async function searchSingleBestTrack(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://api.deezer.com/search?q=${formattedQuery}&limit=10`;
    
    const response = await axios.get(url);

    if (response.data && response.data.data && response.data.data.length > 0) {
      let tracks = response.data.data.map((track) => ({
        title: track.title || 'Nomaʼlum',
        artist: track.artist ? track.artist.name : 'Nomaʼlum artist',
        audioUrl: track.preview,
        duration: formatDuration(track.duration),
        isCoverOrRemix: /remix|slowed|reverb|sped up|bass boosted|cover|tribute|live|karaoke|instrumental/i.test(track.title)
      }));

      // Приоритет оригинальной версии
      tracks.sort((a, b) => a.isCoverOrRemix - b.isCoverOrRemix);

      return tracks[0];
    } else {
      return null;
    }
  } catch (error) {
    console.error("Deezer API error:", error.message);
    return null;
  }
}

// Отправка карточки с 1 результатом
async function handleSingleSearchAndReply(ctx, query, waitingMsgId) {
  const track = await searchSingleBestTrack(query);

  if (!track) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsgId, 
      '❌ Kechirasiz, bu qo\'shiq topilmadi.'
    );
    return;
  }

  const messageText = `🎵 **Topilgan original qo'shiq:**\n\n` +
                      `👤 **Ijrochi:** ${track.artist}\n` +
                      `🎧 **Nomi:** ${track.title}\n` +
                      `⏱ **Davomiyligi:** ${track.duration}\n\n` +
                      `#MusicLovers`;

  const keyboard = new InlineKeyboard();
  keyboard.text("⬇️ Qo'shiqni yuklab olish", "dl_single");

  global.lastSingleTrack = global.lastSingleTrack || {};
  global.lastSingleTrack[ctx.chat.id] = track;

  await ctx.api.editMessageText(
    ctx.chat.id,
    waitingMsgId,
    messageText,
    { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    }
  );
}

// Обработка видеофайлов
bot.on(['message:video', 'message:video_note'], async (ctx) => {
  const waitingMsg = await ctx.reply('🔍 Videodagi musiqa tahlil qilinmoqda...');

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const tempVideo = path.join(__dirname, `temp_${Date.now()}.mp4`);
    const tempAudio = path.join(__dirname, `temp_${Date.now()}.mp3`);

    const response = await axios({ url: fileUrl, responseType: 'stream' });
    const writer = fs.createWriteStream(tempVideo);
    response.data.pipe(writer);

    writer.on('finish', () => {
      ffmpeg(tempVideo)
        .toFormat('mp3')
        .on('end', async () => {
          const result = await recognizeAudio(tempAudio);

          if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
          if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);

          if (result && result.status === 'success' && result.result) {
            const songName = `${result.result.artist} ${result.result.title}`;
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              `✨ Topilgan musiqa: **${songName}**\n⏳ Qo'shiq qidirilmoqda...`,
              { parse_mode: 'Markdown' }
            );

            await handleSingleSearchAndReply(ctx, songName, waitingMsg.message_id);
          } else {
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              '❌ Videodagi musiqa aniqlanmadi.'
            );
          }
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Xatolik yuz berdi.');
  }
});

// Обработка текста и ссылок
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith('http://') || text.startsWith('https://')) {
    await ctx.reply(
      `⚠️ Hozircha havolalardan (link) to'g'ridan-to'g'ri musiqani ajratish to'xtatilgan.\n\n` +
      `Iltimos, videoni telegramga fayl ko'rinishida yuboring yoki qo'shiq nomini yozing! 🎧`
    );
    return;
  }

  const waitingMsg = await ctx.reply('🔎 Qo\'shiq qidirilmoqda...');
  await handleSingleSearchAndReply(ctx, text, waitingMsg.message_id);
});

// Скачивание выбранного трека
bot.callbackQuery("dl_single", async (ctx) => {
  const selectedTrack = global.lastSingleTrack && global.lastSingleTrack[ctx.chat.id];

  if (!selectedTrack || !selectedTrack.audioUrl) {
    return ctx.answerCallbackQuery({
      text: "⚠️ Qo'shiq ma'lumotlari eskirgan. Qaytadan qidiring.",
      show_alert: true
    });
  }

  await ctx.answerCallbackQuery({ text: `⏳ ${selectedTrack.title} yuborilmoqda...` });

  try {
    await ctx.replyWithAudio(selectedTrack.audioUrl, {
      title: selectedTrack.title,
      performer: selectedTrack.artist,
      caption: `🎵 **${selectedTrack.artist} — ${selectedTrack.title}**\n⏱ Davomiyligi: ${selectedTrack.duration}\n🤖 @${ctx.me.username}`,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error("Audio yuborishda xatolik:", err.message);
    await ctx.reply("⚠️ Audioni yuborishda xatolik yuz berdi.");
  }
});

bot.start({
  dropPendingUpdates: true,
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} muvaffaqiyatli ishga tushdi!`);
  }
});

// Сервер для работы на Render
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

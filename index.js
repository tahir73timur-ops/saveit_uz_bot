const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAE9AD2C-uVTVnxiKMbf6t-kgvXRevFHHds";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, chiroyli ro'yxat tuzib beraman! 🎧`
  );
});

// Форматирование времени из миллисекунд в MM:SS
function formatDurationFromMs(ms) {
  if (!ms) return '3:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Распознавание аудио через AudD API
async function recognizeAudio(filePath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('api_token', AUDD_API_KEY);
    form.append('return', 'apple_music,spotify');

    const response = await axios.post('https://api.audd.io/', form, {
      headers: form.getHeaders(),
    });

    return response.data;
  } catch (err) {
    console.error("AudD Error:", err.message);
    return null;
  }
}

// Поиск музыки через iTunes API
async function searchMusicFromiTunes(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://itunes.apple.com/search?term=${formattedQuery}&entity=song&limit=5`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (response.data && response.data.results && response.data.results.length > 0) {
      return response.data.results.map((track, index) => ({
        id: index + 1,
        title: track.trackName || 'Без названия',
        artist: track.artistName || 'Неизвестный исполнитель',
        audioUrl: track.previewUrl,
        duration: formatDurationFromMs(track.trackTimeMillis),
        album: track.collectionName || 'Single'
      }));
    } else {
      return [];
    }
  } catch (error) {
    console.error("iTunes API error:", error.message);
    return [];
  }
}

// Обработка поиска и отправка меню
async function handleSearchAndReply(ctx, query, waitingMsgId) {
  const tracks = await searchMusicFromiTunes(query);

  if (!tracks || tracks.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsgId, 
      '❌ Kechirasiz, hech qanday qo\'shiq topilmadi.'
    );
    return;
  }

  const mainTrack = tracks[0];
  let messageText = `🎵 **${mainTrack.artist} — ${mainTrack.title}**\n\n`;

  tracks.forEach((track) => {
    messageText += `${track.id}. ${track.title} — *${track.artist}*  \`\${track.duration}\`\n`;
  });

  messageText += `\n#MusicLovers`;

  const keyboard = new InlineKeyboard();

  // Кнопка Video
  keyboard.text("🎬 Video", "dummy_video").row();

  // Сохраняем поисковый запрос прямо в callback_data кнопок
  // Формат: dl_<index>_<query>
  const safeQuery = encodeURIComponent(query.slice(0, 30));
  tracks.forEach((track, idx) => {
    keyboard.text(`${track.id}`, `dl_${idx}_${safeQuery}`);
  });

  // Дополнительно дублируем в глобальное хранилище
  global.lastSearchResults = global.lastSearchResults || {};
  global.lastSearchResults[ctx.chat.id] = tracks;

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

// Обработка видео и кружочков
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
              `✨ Topilgan musiqa: **${songName}**\n⏳ Ro'yxat tuzilmoqda...`,
              { parse_mode: 'Markdown' }
            );

            await handleSearchAndReply(ctx, songName, waitingMsg.message_id);

          } else {
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              '❌ Videodagi musiqa aniqlanmadi.'
            );
          }
        })
        .on('error', async (err) => {
          console.error(err);
          await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Videoni qayta ishlashda xatolik.');
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Xatolik yuz berdi.');
  }
});

// Текстовый поиск
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 Qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg.message_id);
});

// Заглушка для кнопки Video
bot.callbackQuery("dummy_video", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bu tugma video ko'rsatish uchun mo'ljallangan.", show_alert: false });
});

// Обработка клика по кнопкам 1-5 (с восстановлением из памяти или повторным поиском)
bot.callbackQuery(/^dl_(\d+)_(.*)\$/, async (ctx) => {
  const trackIndex = parseInt(ctx.match[1]);
  const searchQuery = decodeURIComponent(ctx.match[2]);

  let selectedTrack = null;

  // 1. Проверяем оперативную память
  if (global.lastSearchResults && global.lastSearchResults[ctx.chat.id]) {
    selectedTrack = global.lastSearchResults[ctx.chat.id][trackIndex];
  }

  // 2. Если память очистилась, делаем быстрый повторный поиск
  if (!selectedTrack) {
    const refreshedTracks = await searchMusicFromiTunes(searchQuery);
    if (refreshedTracks && refreshedTracks[trackIndex]) {
      selectedTrack = refreshedTracks[trackIndex];
    }
  }

  if (!selectedTrack || !selectedTrack.audioUrl) {
    return ctx.answerCallbackQuery({ 
      text: "❌ Qo'shiq topilmadi yoki audio havolasi eskirgan. Qaytadan qidiring.", 
      show_alert: true 
    });
  }

  await ctx.answerCallbackQuery({ text: `⏳ ${selectedTrack.title} yuborilmoqda...` });

  try {
    await ctx.replyWithAudio(selectedTrack.audioUrl, {
      title: selectedTrack.title,
      performer: selectedTrack.artist,
      caption: `🎵 **${selectedTrack.title}** — ${selectedTrack.artist}\n🤖 @${ctx.me.username}`,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error("Audio yuborishda xatolik:", err.message);
    await ctx.reply("⚠️ Audioni yuborishda xatolik yuz berdi.");
  }
});

// Запуск бота с очисткой зависших обновлений
bot.start({
  dropPendingUpdates: true,
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} muvaffaqiyatli ishga tushdi!`);
  }
});

// Веб-сервер для поддержания работы на Render
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

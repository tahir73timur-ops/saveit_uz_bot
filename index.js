const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAEnK4qKlFOGxbl-a5doTMUS1tJdU8JKP4w";
const AUDD_API_KEY = "your_audd_api_key_here"; // O'zingizning AudD API kalitingizni yozing

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, chiroyli ro'yxat tuzib beraman! 🎧`
  );
});

// Millisekundlarni MM:SS formatiga o'tkazish
function formatDurationFromMs(ms) {
  if (!ms) return '3:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Videoni AudD API orqali tanib olish
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
    console.error("AudD xatolik:", err.message);
    return null;
  }
}

// iTunes Search API orqali qo'shiq qidirish (barqaror ishlaydi)
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
        title: track.trackName || 'Nomaʼlum',
        artist: track.artistName || 'Nomaʼlum artist',
        audioUrl: track.previewUrl,
        duration: formatDurationFromMs(track.trackTimeMillis),
        album: track.collectionName || 'Single'
      }));
    } else {
      return [];
    }
  } catch (error) {
    console.error("iTunes API xatolik:", error.message);
    return [];
  }
}

// Qidiruv natijalarini formatlab yuborish
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

  // Video tugmasi
  keyboard.text("🎬 Video", "dummy_video").row();

  // 1 dan 5 gacha raqamli tugmalar
  tracks.forEach((track) => {
    keyboard.text(`${track.id}`, `dl_${track.id - 1}`);
  });

  // Natijalarni vaqtincha saqlash
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

// Video va video-note yuborilganda
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

// Matnli xabar orqali qidirish
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 Qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg.message_id);
});

// Video tugmasi bosilganda
bot.callbackQuery("dummy_video", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bu tugma video ko'rsatish uchun mo'ljallangan.", show_alert: false });
});

// Raqamli tugmalar bosilganda audioni yuborish
bot.callbackQuery(/^dl_(\d+)\$/, async (ctx) => {
  const trackIndex = parseInt(ctx.match[1]);
  const userTracks = global.lastSearchResults && global.lastSearchResults[ctx.chat.id];

  if (!userTracks || !userTracks[trackIndex]) {
    return ctx.answerCallbackQuery({
      text: "⚠️ Natijalar topilmadi. Qaytadan qo'shiq qidiring.",
      show_alert: true
    });
  }

  const selectedTrack = userTracks[trackIndex];

  if (!selectedTrack.audioUrl) {
    return ctx.answerCallbackQuery({ 
      text: "❌ Kechirasiz, bu qo'shiq uchun audio mavjud emas.", 
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

bot.start();
console.log('Bot muvaffaqiyatli ishga tushdi!');

// Render yoki boshqa hostinglar port talabini qondirish uchun
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAHD2Khl59MTiUNz5DH6CHwGkWO0KvfPIcg";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, \${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, xuddi rasmda ko'rsatilgandek chiroyli ro'yxat tuzib beraman! 🎧`
  );
});

// Saniyeyi MM:SS formatına dönüştüren fonksiyon
function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `\${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
}

// Videodan ses çıkarma ve AudD API ile tanıma
async function recognizeAudio(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('api_token', AUDD_API_KEY);
  form.append('return', 'apple_music,spotify');

  const response = await axios.post('https://api.audd.io/', form, {
    headers: form.getHeaders(),
  });

  return response.data;
}

// Deezer API üzerinden şarkı arama
async function searchMusicFromDeezer(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://api.deezer.com/search?q=\${formattedQuery}&limit=5`;
    
    const response = await axios.get(url);
    const data = response.data;

    if (data.data && data.data.length > 0) {
      return data.data.map((track, index) => ({
        id: index + 1,
        title: track.title,
        artist: track.artist.name,
        audioUrl: track.preview,
        duration: formatDuration(track.duration),
        album: track.album.title
      }));
    } else {
      return [];
    }
  } catch (error) {
    console.error("Deezer API error:", error.message);
    return [];
  }
}

// Şablon dizileri düzeltilmiş arama ve yanıt fonksiyonu
async function handleSearchAndReply(ctx, query, waitingMsgId) {
  const tracks = await searchMusicFromDeezer(query);

  if (tracks.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsgId, 
      '❌ Kechirasiz, hech qanday qo\'shiq topilmadi.'
    );
    return;
  }

  const mainTrack = tracks[0];
  let messageText = `🎵 **${mainTrack.artist} —${mainTrack.title}**\n\n`;

  // Backtick (`) kullanılarak süre değişkeni doğru şekilde bağlandı
  tracks.forEach((track) => {
    messageText += `${track.id}. ${track.title} — *${track.artist}*  \`\${track.duration}\`\n`;
  });

  messageText += `\n#MusicLovers`;

  const keyboard = new InlineKeyboard();

  // 1. Satır: Video butonu
  keyboard.text("🎬 Video", "dummy_video").row();

  // 2. Satır: 1-5 arası rakam butonları
  tracks.forEach((track) => {
    keyboard.text(`${track.id}`, `dl_${track.id - 1}`);
  });

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

// Video ve Video Note işleyici
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

// Metin mesajı işleyici
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 Qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg.message_id);
});

// Video butonu bildirimi
bot.callbackQuery("dummy_video", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bu tugma video ko'rsatish uchun mo'ljallangan.", show_alert: false });
});

// Rakam butonlarına tıklandığında müziği gönderme
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

const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

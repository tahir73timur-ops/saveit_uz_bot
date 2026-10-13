const { Bot, InputFile, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

// Token va API kalitlar
const BOT_TOKEN = "8761282938:AAHNVvI5CGP8rvY2Jz9vkzhwtXBHhIZL1cc";
const AUDD_API_KEY = "your_audd_api_key_here"; // O'zingizning AudD API kalitingizni yozing

const bot = new Bot(BOT_TOKEN);

// /start komandasi
bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga:\n` +
    `1. Qo'shiq nomini yuboring (10 tagacha variant chiqarib beraman) 🎧\n` +
    `2. Video yoki video-note yuboring (ichidagi musiqani topib beraman) 📹`
  );
});

// Videodan audio ajratib olish va AudD orqali tanib olish
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

// iTunes API orqali qo'shiq qidirish (10 tagacha natija)
async function searchMusicFromiTunes(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    // limit=10 qilib belgilaymiz
    const url = `https://itunes.apple.com/search?term=${formattedQuery}&entity=song&limit=10`;
    
    const response = await axios.get(url);
    const data = response.data;

    if (data.resultCount > 0) {
      return data.results.map(track => ({
        title: track.trackName,
        artist: track.artistName,
        audioUrl: track.previewUrl, // 30 soniyalik audio preview
        album: track.collectionName || 'Album'
      }));
    } else {
      return [];
    }
  } catch (error) {
    console.error("iTunes API error:", error.message);
    return [];
  }
}

// Video yoki Video-note yuborilganda ishlovchi qism
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
              `✨ Topilgan musiqa: **${songName}**\n⏳ Shu nom bo'yicha qo'shiqlar qidirilmoqda...`,
              { parse_mode: 'Markdown' }
            );

            // Topilgan qo'shiq bo'yicha 10 ta natija chiqarish
            const tracks = await searchMusicFromiTunes(songName);
            sendTracksList(ctx, tracks, waitingMsg.message_id);

          } else {
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              '❌ Kechirasiz, ushbu videodagi musiqa aniqlanmadi.'
            );
          }
        })
        .on('error', async (err) => {
          console.error(err);
          await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Videoni qayta ishlashda xatolik yuz berdi.');
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Xatolik yuz berdi.');
  }
});

// Matnli xabar orqali qo'shiq qidirish (Kamida 10 ta chiqazish)
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 10 tagacha qo\'shiq qidirilmoqda...');

  const tracks = await searchMusicFromiTunes(query);
  sendTracksList(ctx, tracks, waitingMsg.message_id);
});

// Topilgan qo'shiqlar ro'yxatini yuborish yordamchi funksiyasi
async function sendTracksList(ctx, tracks, messageId) {
  if (tracks.length === 0) {
    await ctx.api.editMessageText(ctx.chat.id, messageId, '❌ Hech qanday qo\'shiq topilmadi.');
    return;
  }

  await ctx.api.deleteMessage(ctx.chat.id, messageId);

  // Topilgan har bir qo'shiqni bot orqali yuborish (kamida 10 ta yoki topilganicha)
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    try {
      if (track.audioUrl) {
        await ctx.replyWithAudio(track.audioUrl, {
          title: track.title,
          performer: track.artist,
          caption: `🎵 **${i + 1}. ${track.title}** - ${track.artist}\n💿 Albom: ${track.album}` ,
          parse_mode: 'Markdown'
        });
      } else {
        await ctx.reply(`🎵 **${i + 1}. ${track.title}** - ${track.artist} (Audio havolasi mavjud emas)`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error("Audio yuborishda xatolik:", err.message);
    }
  }
}

// Botni ishga tushirish
bot.start();
console.log('Bot muvaffaqiyatli ishga tushdi!');

// Render / Server port talabini qondirish uchun
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

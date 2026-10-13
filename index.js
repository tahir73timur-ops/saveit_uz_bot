const { Bot, InputFile } = require('grammy');
const play = require('play-dl');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

// BU YERGA O'Z TOKENINGIZNI YOZING:
const BOT_TOKEN = "8761282938:AAEL41cKHFJAv-4FH9quEFvCreWM690FbTo";
// BU YERGA AUDD API KALITINGIZNI YOZING:
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

// play-dl sozlamasini faollashtirish
try {
  play.authorization();
} catch (e) {
  console.log("play-dl auth warning:", e.message);
}

// /start komandasi
bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga:\n` +
    `1. Qo'shiq nomi yoki matnini yuboring 🎧\n` +
    `2. Video/Audio fayl yuboring (videodagi musiqani topaman) 📹\n` +
    `3. Instagram Reels yoki video havolasini yuboring 🔗`
  );
});

// Audio fayldan qo'shiqni tanib olish funksiyasi (AudD API)
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

// Qo'shiqni YouTube'dan qidirib yuklab berish funksiyasi
async function downloadAndSendSong(ctx, query, waitingMsg) {
  try {
    const searchResults = await play.search(query, { limit: 1, source: { youtube: 'video' } });

    if (!searchResults || searchResults.length === 0) {
      return ctx.api.editMessageText(
        ctx.chat.id,
        waitingMsg.message_id,
        '❌ Kechirasiz, qo\'shiq topilmadi.'
      );
    }

    const video = searchResults[0];

    await ctx.api.editMessageText(
      ctx.chat.id,
      waitingMsg.message_id,
      `🎶 Topildi: **${video.title}**\n⏳ Audio yuklab olinmoqda...`,
      { parse_mode: 'Markdown' }
    );

    const stream = await play.stream(video.url, { quality: 2 });
    const filePath = path.join(__dirname, `song_${Date.now()}.mp3`);
    const fileStream = fs.createWriteStream(filePath);

    stream.stream.pipe(fileStream);

    fileStream.on('finish', async () => {
      await ctx.replyWithAudio(new InputFile(filePath), {
        title: video.title,
        performer: video.channel ? video.channel.name : 'Unknown Artist',
        caption: `🎵 **${video.title}**\n\n🤖 @${ctx.me.username} orqali yuklandi`,
        parse_mode: 'Markdown'
      });

      await ctx.api.deleteMessage(ctx.chat.id, waitingMsg.message_id);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    fileStream.on('error', async (err) => {
      console.error('File stream error:', err);
      await ctx.api.editMessageText(
        ctx.chat.id, 
        waitingMsg.message_id, 
        '⚠️ YouTube serveri Render IP-manzilini blokladi. Audioni yuklab bo\'lmadi.'
      );
    });

  } catch (err) {
    console.error('Download error:', err);
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsg.message_id, 
      '⚠️ YouTube cheklovi tufayli yuklab olish imkonsiz (Render IP bloklandi).'
    );
  }
}

// Video yoki Video-note yuborilganda ishlovchi qism
bot.on(['message:video', 'message:video_note'], async (ctx) => {
  const waitingMsg = await ctx.reply('🔍 Videodagi musiqa tahlil qilinmoqda...');

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Vaqtinchalik fayllar yo'li
    const tempVideo = path.join(__dirname, `temp_${Date.now()}.mp4`);
    const tempAudio = path.join(__dirname, `temp_${Date.now()}.mp3`);

    // Videoni yuklab olish
    const response = await axios({ url: fileUrl, responseType: 'stream' });
    const writer = fs.createWriteStream(tempVideo);
    response.data.pipe(writer);

    writer.on('finish', () => {
      // Videodan audioni ajratish
      ffmpeg(tempVideo)
        .toFormat('mp3')
        .on('end', async () => {
          // AudD API orqali qo'shiqni tanish
          const result = await recognizeAudio(tempAudio);

          // Vaqtinchalik fayllarni o'chirish
          if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
          if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);

          if (result && result.status === 'success' && result.result) {
            const songName = `${result.result.artist} ${result.result.title}`;
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              `🔍 Topilgan qo'shiq: **${songName}**\n⏳ To'liq audio izlanmoqda...`,
              { parse_mode: 'Markdown' }
            );
            await downloadAndSendSong(ctx, songName, waitingMsg);
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
          await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Videoni qayta ishlashda xatolik.');
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Xatolik yuz berdi.');
  }
});

// Matnli xabar va linklar uchun
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;

  // Oddiy matn orqali qidiruv
  const waitingMsg = await ctx.reply('🔎 Qo\'shiq qidirilmoqda...');
  await downloadAndSendSong(ctx, text, waitingMsg);
});

// Botni ishga tushirish (FAQAT 1 MARTA)
bot.start();
console.log('Bot muvaffaqiyatli ishga tushdi!');

// Render port talab qilmasligi uchun qo'shimcha server
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

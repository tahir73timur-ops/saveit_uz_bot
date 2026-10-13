const { Bot, InputFile, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

// Token va API kalitlar
const BOT_TOKEN = "8761282938:AAHHiYLsyxCuhDXYnpsccW_LII-ZXODLDSI";
const AUDD_API_KEY = "your_audd_api_key_here"; // AudD API kalitingizni yozing

const bot = new Bot(BOT_TOKEN);

// Vaqtincha qidiruv natijalarini saqlash uchun kesh (memory store)
const searchCache = new Map();

// /start komandasi
bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga:\n` +
    `1. Qo'shiq nomini yuboring (10 talik ro'yxat chiqaraman) 🎧\n` +
    `2. Video yoki video-note yuboring (ichidagi musiqani topaman) 📹\n\n` +
    `Ro'yxatdan kerakli raqamli tugmani bossangiz, qo'shiq yuklanadi!`
  );
});

// Videodan audio ajratish va AudD orqali tanib olish
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

// iTunes API orqali 10 ta qo'shiq qidirish
async function searchMusicFromiTunes(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://itunes.apple.com/search?term=${formattedQuery}&entity=song&limit=10`;
    
    const response = await axios.get(url);
    const data = response.data;

    if (data.resultCount > 0) {
      return data.results.map((track, index) => ({
        id: index + 1,
        title: track.trackName,
        artist: track.artistName,
        audioUrl: track.previewUrl,
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

// 10 talik ro'yxat va tugmalarni shakllantirish hamda yuborish
async function handleSearchAndReply(ctx, query, waitingMsg) {
  const tracks = await searchMusicFromiTunes(query);

  if (tracks.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsg.message_id, 
      '❌ Kechirasiz, hech qanday qo\'shiq topilmadi.'
    );
    return;
  }

  // Qidiruv natijasini xabar ID si bilan keshga saqlaymiz
  searchCache.set(ctx.chat.id, tracks);

  let messageText = `🔍 **"${query}"** bo'yicha topilgan qo'shiqlar ro'yxati:\n\n`;
  
  const keyboard = new InlineKeyboard();

  tracks.forEach((track, idx) => {
    messageText += `**${track.id}.** ${track.title} — *${track.artist}*\n`;
    
    // Har 5 ta tugmadan keyin yangi qator ochamiz (2 qator 5 talik tugma)
    keyboard.text(`${track.id}`, `dl_${track.id}`);
    if ((idx + 1) % 5 === 0) {
      keyboard.row();
    }
  });

  messageText += `\n👇 **Yuklab olish uchun pastdagi raqamlardan birini bosing:**`;

  await ctx.api.editMessageText(
    ctx.chat.id,
    waitingMsg.message_id,
    messageText,
    { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    }
  );
}

// Video yuborilganda
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

            await handleSearchAndReply(ctx, songName, waitingMsg);

          } else {
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              '❌ Kechirasiz, videodagi musiqa aniqlanmadi.'
            );
          }
        })
        .on('error', async (err) => {
          console.error(err);
          await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Videoni ishlashda xatolik.');
        })
        .save(tempAudio);
    });
  } catch (error) {
    console.error(error);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Xatolik yuz berdi.');
  }
});

// Matnli xabar kelganda
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 Qo\'shiqlar qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg);
});

// Raqamli tugma bosilganda ishlovchi qism (Callback Query)
bot.callbackQuery(/^dl_(\d+)\$/, async (ctx) => {
  const trackId = parseInt(ctx.match[1]);
  const userTracks = searchCache.get(ctx.chat.id);

  if (!userTracks) {
    return ctx.answerCallbackQuery({
      text: "⚠️ Qidiruv natijalari eskirgan. Qaytadan qidiruv yuboring.",
      show_alert: true
    });
  }

  const selectedTrack = userTracks.find(t => t.id === trackId);

  if (!selectedTrack) {
    return ctx.answerCallbackQuery({ text: "❌ Qo'shiq topilmadi." });
  }

  await ctx.answerCallbackQuery({ text: `⏳ ${selectedTrack.title} yuklanmoqda...` });

  try {
    await ctx.replyWithAudio(selectedTrack.audioUrl, {
      title: selectedTrack.title,
      performer: selectedTrack.artist,
      caption: `🎵 **${selectedTrack.title}** — ${selectedTrack.artist}\n💿 Albom: ${selectedTrack.album}\n\n🤖 @${ctx.me.username} orqali yuklab olindi`,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error("Audio yuborishda xatolik:", err.message);
    await ctx.reply("⚠️ Audioni yuborishda xatolik yuz berdi.");
  }
});

// Botni ishga tushirish
bot.start();
console.log('Bot muvaffaqiyatli ishga tushdi!');

// Web server (Render/Koyeb port talablari uchun)
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

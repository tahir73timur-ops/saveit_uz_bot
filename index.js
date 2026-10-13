const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAGoKsouBVNZX0jsbQH-ndjIAzsj1QGERxE";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yuboring, 10 ta natija chiqaraman va raqamni bossangiz to'g'ridan-to'g'ri yuklab beraman! 🎧`
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

// Deezer API orqali 10 ta qo'shiq qidirish (To'liq MP3 preview bilan)
async function searchMusicFromDeezer(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://api.deezer.com/search?q=${formattedQuery}&limit=10`;
    
    const response = await axios.get(url);
    const data = response.data;

    if (data.data && data.data.length > 0) {
      return data.data.map((track, index) => ({
        id: index + 1,
        title: track.title,
        artist: track.artist.name,
        audioUrl: track.preview, // MP3 audio havolasi
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

// Kesh o'rniga qidiruv so'rovini va trek ma'lumotini callback_data ga yashiramiz
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

  let messageText = `🔍 **"${query}"** bo'yicha topilgan qo'shiqlar:\n\n`;
  const keyboard = new InlineKeyboard();

  tracks.forEach((track, idx) => {
    messageText += `**${track.id}.** ${track.title} — *${track.artist}*\n`;
    
    // Callback data ichiga qaysi qo'shiq ekanligini va qidiruv so'rovini qisqartirib yozamiz
    // Masalan: idx_0, idx_1 ... idx_9
    keyboard.text(`${track.id}`, `dl_${idx}_${encodeURIComponent(query)}`);
    if ((idx + 1) % 5 === 0) {
      keyboard.row();
    }
  });

  messageText += `\n👇 **Yuklab olish uchun raqamni bosing:**`;

  // Natijalarni vaqtinchalik saqlab turish uchun global masivga yozib qo'yamiz (har bir chat uchun alohida)
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

bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 10 ta qo\'shiq qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg.message_id);
});

// Tugma bosilganda ishlaydigan qism
bot.callbackQuery(/^dl_(\d+)_(.*)\$/, async (ctx) => {
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
      caption: `🎵 **${selectedTrack.title}** — ${selectedTrack.artist}\n💿 Albom: ${selectedTrack.album}\n\n🤖 @${ctx.me.username}`,
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

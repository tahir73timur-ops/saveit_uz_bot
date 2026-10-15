const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAEWjd-seLxU033SHLxm8HjyfO0CHcy74vo";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, original va haqiqiy ijrochining to'liq qo'shig'ini topib beraman! 🎧`
  );
});

// Sekundlarni MM:SS formatiga o'tkazish
function formatDuration(seconds) {
  if (!seconds) return '03:00';
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes < 10 ? '0' : ''}${minutes}:${secs < 10 ? '0' : ''}${secs}`;
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

// Deezer API orqali qo'shiq qidirish (O'zbekcha, ruscha va xorijiy qo'shiqlarni mukammal topadi)
async function searchMusicFromDeezer(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://api.deezer.com/search?q=${formattedQuery}&limit=25`;
    
    const response = await axios.get(url);

    if (response.data && response.data.data && response.data.data.length > 0) {
      let tracks = response.data.data.map((track) => ({
        title: track.title || 'Nomaʼlum',
        artist: track.artist ? track.artist.name : 'Nomaʼlum artist',
        audioUrl: track.preview, // 30 soniyalik preview yoki to'liq qism
        duration: formatDuration(track.duration),
        album: track.album ? track.album.title : 'Single',
        isCoverOrRemix: /remix|slowed|reverb|sped up|bass boosted|cover|tribute|live|karaoke|instrumental/i.test(track.title)
      }));

      // Original qo'shiqlarni tepaga chiqaramiz
      tracks.sort((a, b) => a.isCoverOrRemix - b.isCoverOrRemix);

      // 10 ta eng yaxshi natijani qaytaramiz
      return tracks.slice(0, 10).map((track, index) => ({
        id: index + 1,
        title: track.title,
        artist: track.artist,
        audioUrl: track.audioUrl,
        duration: track.duration,
        album: track.album
      }));
    } else {
      return [];
    }
  } catch (error) {
    console.error("Deezer API xatolik:", error.message);
    return [];
  }
}

// Natijalarni formatlab yuborish
async function handleSearchAndReply(ctx, query, waitingMsgId) {
  const tracks = await searchMusicFromDeezer(query);

  if (!tracks || tracks.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsgId, 
      '❌ Kechirasiz, bu qo\'shiq topilmadi. Boshqacharoq yozib ko\'ring.'
    );
    return;
  }

  const mainTrack = tracks[0];
  let messageText = `🎵 **${mainTrack.artist} — ${mainTrack.title}**\n\n`;

  tracks.forEach((track) => {
    messageText += `${track.id}. ${track.artist} — *${track.title}*  \`[\${track.duration}]\`\n`;
  });

  messageText += `\n#MusicLovers`;

  const keyboard = new InlineKeyboard();

  // Video tugmasi
  keyboard.text("🎬 Video", "dummy_video").row();

  // 1 dan 10 gacha tugmalar (har qatorda 5 tadan)
  tracks.forEach((track, idx) => {
    keyboard.text(`${track.id}`, `dl_${idx}`);
    if ((idx + 1) % 5 === 0) {
      keyboard.row();
    }
  });

  // Xotirada saqlash
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
      text: "⚠️ Natijalar eskirgan yoki topilmadi. Qaytadan qo'shiq qidiring.",
      show_alert: true
    });
  }

  const selectedTrack = userTracks[trackIndex];

  if (!selectedTrack.audioUrl) {
    return ctx.answerCallbackQuery({ 
      text: "❌ Kechirasiz, bu qo'shiq uchun yuklab olish havolasi mavjud emas.", 
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

// Botni ishga tushirish
bot.start({
  dropPendingUpdates: true,
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} muvaffaqiyatli ishga tushdi!`);
  }
});

// Serverni ishga tushirish
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

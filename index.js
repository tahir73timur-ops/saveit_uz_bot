const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = "8761282938:AAG3AyJJplkLHnsxjBI1MdxF7NeLHQ9bNxc";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini yoki video yuboring, original va haqiqiy ijrochining qo'shig'ini topib beraman! 🎧`
  );
});

// Millisekundlarni MM:SS formatiga o'tkazish
function formatDurationFromMs(ms) {
  if (!ms) return '03:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
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

// Qo'shiqning haqiqiy egasi va davomiyligi (minuti) bilan topish
async function searchMusicFromiTunes(query) {
  try {
    const formattedQuery = encodeURIComponent(query);
    const url = `https://itunes.apple.com/search?term=${formattedQuery}&entity=song&limit=30`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (response.data && response.data.results && response.data.results.length > 0) {
      let tracks = response.data.results.map((track) => ({
        title: track.trackName || 'Nomaʼlum',
        artist: track.artistName || 'Nomaʼlum artist',
        audioUrl: track.previewUrl,
        duration: formatDurationFromMs(track.trackTimeMillis),
        album: track.collectionName || 'Single',
        // Remiks, kaver, slowed va boshqa o'zgartirilgan versiyalarni aniqlash
        isRemixOrCover: /remix|slowed|reverb|sped up|bass boosted|cover|tribute|live|karaoke|instrumental/i.test(track.trackName)
      }));

      // Asl (original) qo'shiq va haqiqiy ijrochini birinchi o'ringa saralash
      tracks.sort((a, b) => a.isRemixOrCover - b.isRemixOrCover);

      // Qidiruv so'ziga eng mosini ustun qo'yish
      const lowerQuery = query.toLowerCase();
      tracks.sort((a, b) => {
        const aMatch = (a.artist.toLowerCase().includes(lowerQuery) || a.title.toLowerCase().includes(lowerQuery)) ? 0 : 1;
        const bMatch = (b.artist.toLowerCase().includes(lowerQuery) || b.title.toLowerCase().includes(lowerQuery)) ? 0 : 1;
        return aMatch - bMatch;
      });

      // 10 ta eng yaxshi original natijani qaytarish
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
    console.error("iTunes API xatolik:", error.message);
    return [];
  }
}

// Natijalarni formatlab chiqarish
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

  // Har bir qo'shiq yonida daqiqasi (minuti) va haqiqiy egasi chiqariladi
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

// Video va video-note bo'yicha qidiruv
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

// Matnli qidiruv
bot.on('message:text', async (ctx) => {
  const query = ctx.message.text;
  const waitingMsg = await ctx.reply('🔎 Qidirilmoqda...');
  await handleSearchAndReply(ctx, query, waitingMsg.message_id);
});

// Video tugmasi
bot.callbackQuery("dummy_video", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bu tugma video ko'rsatish uchun mo'ljallangan.", show_alert: false });
});

// Raqam bosilganda qo'shiqni yuborish
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
      text: "❌ Kechirasiz, bu qo'shiq uchun manba topilmadi.", 
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

// Web server (Render uchun)
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

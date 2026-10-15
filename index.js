const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const instagramGetUrl = require('@social-sister/instagram-url-direct');

ffmpeg.setFfmpegPath(ffmpegPath);

// BOT TOKENINGIZNI @BotFather ORQALI YANGILAB SHU YERGA YOZING
const BOT_TOKEN = "8761282938:AAEB0sE8a-P1n9YTPNfzKNFU1WktLavrPr8";
const AUDD_API_KEY = "your_audd_api_key_here";

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  return ctx.reply(
    `Salom, ${ctx.from.first_name}! 👋\n\n` +
    `Menga qo'shiq nomini, video yoki Instagram Reels havolasini (link) yuboring, original va haqiqiy qo'shiqni topib beraman! 🎧`
  );
});

// Sekundlarni MM:SS formatiga o'tkazish
function formatDuration(seconds) {
  if (!seconds) return '03:00';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes < 10 ? '0' : ''}${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

// AudD API orqali audioni tanib olish
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
    console.error("AudD xatolik:", err.message);
    return null;
  }
}

// Deezer API orqali eng yaxshi 1 TA ORIGINAL qo'shiqni topish
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

      // Asl original qo'shiqni 1-o'ringa suramiz
      tracks.sort((a, b) => a.isCoverOrRemix - b.isCoverOrRemix);

      // Faqat eng yaxshi 1 ta natijani qaytaramiz
      return tracks[0];
    } else {
      return null;
    }
  } catch (error) {
    console.error("Deezer API xatolik:", error.message);
    return null;
  }
}

// Bitta eng aniq natijani yuborish
async function handleSingleSearchAndReply(ctx, query, waitingMsgId) {
  const track = await searchSingleBestTrack(query);

  if (!track) {
    await ctx.api.editMessageText(
      ctx.chat.id, 
      waitingMsgId, 
      '❌ Kechirasiz, bu qo\'shiq topilmadi. Qaytadan urinib ko\'ring.'
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

  // Xotirada bitta qo'shiqni saqlaymiz
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

// Instagram havolasidan videoni yuklab olish va tanib olish
async function handleInstagramLink(ctx, link) {
  const waitingMsg = await ctx.reply('📥 Instagram videosi yuklanmoqda va musiqa tanib olinmoqda...');

  const tempVideo = path.join(__dirname, `insta_${Date.now()}.mp4`);
  const tempAudio = path.join(__dirname, `insta_${Date.now()}.mp3`);

  try {
    const instaData = await instagramGetUrl(link);
    const mediaUrl = instaData?.url_list?.[0];

    if (!mediaUrl) {
      await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '❌ Instagram videoga kirish imkoni bo\'lmadi.');
      return;
    }

    const response = await axios({ url: mediaUrl, responseType: 'stream' });
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
              `✨ Videodagi musiqa: **${songName}**\n⏳ Qo'shiq tayyorlanmoqda...`,
              { parse_mode: 'Markdown' }
            );

            await handleSingleSearchAndReply(ctx, songName, waitingMsg.message_id);
          } else {
            await ctx.api.editMessageText(
              ctx.chat.id,
              waitingMsg.message_id,
              '❌ Videodagi musiqa tanib olinmadi.'
            );
          }
        })
        .on('error', async (err) => {
          console.error(err);
          if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
          if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
          await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Video audio shakliga o\'tkazilmadi.');
        })
        .save(tempAudio);
    });

  } catch (error) {
    console.error("Insta error:", error.message);
    if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
    if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
    await ctx.api.editMessageText(ctx.chat.id, waitingMsg.message_id, '⚠️ Instagram havolasini qayta ishlashda xatolik yuz berdi.');
  }
}

// Telegram ichida yuborilgan video va video_note
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

// Matnli xabarlar va linklar
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Instagram havolasi bo'lsa
  if (text.includes('instagram.com/')) {
    await handleInstagramLink(ctx, text);
    return;
  }

  // Boshqa turdagi havola bo'lsa
  if (text.startsWith('http://') || text.startsWith('https://')) {
    await ctx.reply('⚠️ Hozircha faqat Instagram Reels havolalarini tahlil qila olaman.');
    return;
  }

  // Odatdiy matnli qidiruv
  const waitingMsg = await ctx.reply('🔎 Qo\'shiq qidirilmoqda...');
  await handleSingleSearchAndReply(ctx, text, waitingMsg.message_id);
});

// Yuklab olish tugmasi
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

// Botni ishga tushirish
bot.start({
  dropPendingUpdates: true,
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} muvaffaqiyatli ishga tushdi!`);
  }
});

// HTTP Server
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});

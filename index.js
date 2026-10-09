const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

const TOKEN = '8761282938:AAGQGa2gRx9YpVE0Dw3mhW2fiBxMuFzvugE';
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
    ctx.reply("Salom! Menga YouTube yoki Instagram havolasini (linkini) yuboring, men uni to'liq (full) MP3 formatida yuklab beraman! 🎵");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    // Faqat havola ekanligini tekshiramiz
    if (!text.includes('http://') && !text.includes('https://')) {
        return ctx.reply("❌ Iltimos, qo'shiq qidirish uchun so'z yozmang, shunchaki bevosita **YouTube** yoki **Instagram** havolasini (linkini) tashlang!");
    }

    await ctx.reply("⏳ Havola bo'yicha yuklab olinmoqda, biroz kuting...");

    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputTemplate = path.join(downloadsDir, '%(id)s.%(ext)s');

    try {
        await ytDlp(text, {
            output: outputTemplate,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            noCheckCertificates: true,
            geoBypass: true,
            extractorArgs: 'youtube:player_client=android',
            addHeader: [
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        });

        const files = fs.readdirSync(downloadsDir);
        if (files.length === 0) {
            throw new Error("Fayl topilmadi.");
        }

        const latestFile = files.reduce((a, b) => {
            return fs.statSync(path.join(downloadsDir, a)).mtime > fs.statSync(path.join(downloadsDir, b)).mtime ? a : b;
        });

        const filePath = path.join(downloadsDir, latestFile);

        // Telegramga audio yuborish
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { caption: "Mana qo'shiqning to'liq (full) versiyasi! 🎧" });

        // Faylni serverdan tozalash
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Kechirasiz, havoladan yuklab bo'lmadi. Havola to'g'riligiga yoki bloklanmaganiga amin bo'ling.");
    }
});

bot.launch();
console.log("Bot ishga tushdi!");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

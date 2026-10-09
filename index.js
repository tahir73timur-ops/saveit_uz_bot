const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

// Yangi tokeningizni shu yerga yozing
const TOKEN = '8761282938:AAFVx3FeL1dmijyaaZMvxRNCtBH_2aRGg1I';
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
    ctx.reply("Salom! Menga YouTube/Instagram havolasini yuboring yoki qo'shiq nomi va ijodkorini yozing (masalan: Jony - Kamin), men uni MP3 qilib topib beraman! 🎵");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    await ctx.reply("⏳ Qidirilmoqda va yuklab olinmoqda, biroz kuting...");

    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputTemplate = path.join(downloadsDir, '%(id)s.%(ext)s');

    try {
        let searchTarget = text;
        
        // Agar havola bo'lmasa, uni YouTube'dan to'liq audio versiyasi bo'yicha qidiramiz
        if (!text.includes('http://') && !text.includes('https://')) {
            searchTarget = `ytsearch1:${text} official audio`;
        }

        await ytDlp(searchTarget, {
            output: outputTemplate,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            defaultSearch: 'ytsearch',
            noCheckCertificates: true,
            geoBypass: true,
            // YouTube blokirovkasini chetlab o'tish uchun qo'shimcha parametrlar
            extractorArgs: 'youtube:player_client=android',
        });

        const files = fs.readdirSync(downloadsDir);
        if (files.length === 0) {
            throw new Error("Musiqa topilmadi.");
        }

        const latestFile = files.reduce((a, b) => {
            return fs.statSync(path.join(downloadsDir, a)).mtime > fs.statSync(path.join(downloadsDir, b)).mtime ? a : b;
        });

        const filePath = path.join(downloadsDir, latestFile);

        // Telegramga audio yuborish
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { caption: "Mana so'ragan qo'shig'ingiz! 🎧" });

        // Faylni serverdan tozalash
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Kechirasiz, YouTube serveri so'rovni blokladi yoki qo'shiq topilmadi. Iltimos, qo'shiqning bevosita YouTube havolasini yuborib ko'ring.");
    }
});

bot.launch();
console.log("Bot ishga tushdi!");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

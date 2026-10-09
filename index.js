const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

// Bot tokeningizni shu yerga yozing
const TOKEN = '8761282938:AAEUSIxj77OPz6nM9q9IUKb7840OFLvGXQ4';
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
    ctx.reply("Salom! Menga YouTube/Instagram havolasini yuboring yoki shunchaki qo'shiq nomi va ijodkorini yozing, men uni MP3 qilib topib beraman! 🎵");
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
        
        // Agar kiritilgan matn havola bo'lmasa, uni YouTube'dan qidirish uchun moslaymiz
        if (!text.includes('http://') && !text.includes('https://')) {
            searchTarget = `ytsearch1:${text}`;
        }

        await ytDlp(searchTarget, {
            output: outputTemplate,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            defaultSearch: 'ytsearch',
            noCheckCertificates: true,
            geoBypass: true,
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
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { caption: "Mana siz so'ragan qo'shiq! 🎧" });

        // Faylni serverdan tozalash
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Kechirasiz, bu nom bo'yicha hech narsa topilmadi yoki yuklab bo'lmadi.");
    }
});

bot.launch();
console.log("Bot ishga tushdi!");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

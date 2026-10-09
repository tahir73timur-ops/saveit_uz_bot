const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

const TOKEN = '8761282938:AAFVx3FeL1dmijyaaZMvxRNCtBH_2aRGg1I';
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
    ctx.reply("Salom! Menga qo'shiq nomi va ijodkorini yozing (masalan: Jony - Kamin), men uning aynan to'liq (full) versiyasini MP3 qilib topib beraman! 🎵");
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    await ctx.reply("⏳ Qo'shiqning to'liq versiyasi qidirilmoqda va yuklab olinmoqda, biroz kuting...");

    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputTemplate = path.join(downloadsDir, '%(id)s.%(ext)s');

    try {
        let searchTarget = text;
        
        // Agar havola bo'lmasa, faqat to'liq studio audio versiyasini qidirish uchun kalit so'zlar qo'shamiz
        if (!text.includes('http://') && !text.includes('https://')) {
            // "full song audio" deb qidirsa, bot qisqa parchalarni emas, to'liq trekni topadi
            searchTarget = `ytsearch1:${text} full song audio`;
        }

        await ytDlp(searchTarget, {
            output: outputTemplate,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            defaultSearch: 'ytsearch',
            noCheckCertificates: true,
            geoBypass: true,
            extractorArgs: 'youtube:player_client=android',
            // 1 daqiqadan qisqa bo'lgan videolarni (Shorts, parcha) tashlab yuborish sharti
            matchFilter: 'duration > 60',
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
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { caption: "Mana qo'shiqning to'liq (full) versiyasi! 🎧" });

        // Faylni serverdan tozalash
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Kechirasiz, bu qo'shiqning to'liq versiyasi topilmadi yoki YouTube vaqtincha blokladi. Boshqa nom bilan urinib ko'ring.");
    }
});

bot.launch();
console.log("Bot ishga tushdi!");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

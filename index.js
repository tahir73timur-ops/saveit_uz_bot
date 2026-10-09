const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

// Укажите токен вашего бота
const TOKEN = '8761282938:AAEUSIxj77OPz6nM9q9IUKb7840OFLvGXQ4';
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
    ctx.reply("Salom! Menga qo'shiqning nomi va ijodkorini yozing (masalan: Jony - Kamin), men uning to'liq (full) versiyasini MP3 qilib topib beraman! 🎵");
});

bot.on('text', async (ctx) => {
    let query = ctx.message.text.trim();

    await ctx.reply("⏳ Qo'shiqning to'liq versiyasi qidirilmoqda va yuklab olinmoqda, biroz kuting...");

    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputTemplate = path.join(downloadsDir, '%(id)s.%(ext)s');

    try {
        let searchTarget = query;
        
        // Если это не прямая ссылка, ищем полноценный трек (добавляем 'audio', чтобы не скачивались клипы с лишними звуками)
        if (!query.includes('http://') && !query.includes('https://')) {
            searchTarget = `ytsearch1:${query} audio`;
        }

        await ytDlp(searchTarget, {
            output: outputTemplate,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0', // Максимальное качество звука
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

        // Отправка готового аудиофайла пользователю
        await ctx.replyWithAudio({ source: fs.createReadStream(filePath) }, { caption: "Mana qo'shiqning to'liq (full) versiyasi! 🎧" });

        // Удаление файла с сервера после отправки
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 5000);

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Kechirasiz, bu qo'shiqni topib bo'lmadi yoki YouTube vaqtincha blokladi. Birozdan keyin qayta urinib ko'ring.");
    }
});

bot.launch();
console.log("Bot ishga tushdi!");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const { Telegraf } = require('telegraf');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

// Bot tokeningizni shu yerga yozing
const TOKEN = '8761282938:AAFXIRJova80Y6vLvIb85cyFwhQtVrUgwOM';
const bot = new Telegraf(TOKEN);

// /start komandasi
bot.start((ctx) => {
    ctx.reply("Salom! Menga YouTube yoki Instagram'dan video havolasini yuboring, men uni yuklab beraman.");
});

// Xabarlarni qabul qilish
bot.on('text', async (ctx) => {
    const url = ctx.message.text.trim();

    // Havolani tekshirish
    if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('instagram.com')) {
        await ctx.reply("⏳ Video yuklab olinmoqda, biroz kuting...");

        const downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir);
        }

        const outputTemplate = path.join(downloadsDir, '%(id)s.%(ext)s');

        try {
            // yt-dlp yordamida videoni yuklab olish
            const output = await ytDlp(url, {
                output: outputTemplate,
                format: 'best',
            });

            // Yuklangan faylni topish uchun oxirgi yuklangan faylni aniqlaymiz yoki yt-dlp natijasidan foydalanamiz
            // Oddiyroq usul: downloads papkasidagi oxirgi o'zgartirilgan faylni olish
            const files = fs.readdirSync(downloadsDir);
            if (files.length === 0) {
                throw new Error("Video topilmadi.");
            }

            // Eng oxirgi yuklangan faylni tanlaymiz
            const latestFile = files.reduce((a, b) => {
                return fs.statSync(path.join(downloadsDir, a)).mtime > fs.statSync(path.join(downloadsDir, b)).mtime ? a : b;
            });

            const filePath = path.join(downloadsDir, latestFile);

            // Videoni Telegramga yuborish
            await ctx.replyWithVideo({ source: fs.createReadStream(filePath) }, { caption: "Mana siz so'ragan video! 🚀" });

            // Faylni o'chirib yuborish
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }, 5000); // 5 sekunddan keyin faylni tozalash

        } catch (error) {
            console.error(error);
            ctx.reply("❌ Xatolik yuz berdi: Videoni yuklab bo'lmadi.");
        }
    } else {
        ctx.reply("⚠️ Iltimos, faqat YouTube yoki Instagram havolasini yuboring.");
    }
});

// Botni ishga tushirish
bot.launch();
console.log("Bot ishga tushdi!");

// Dastur to'xtaganda botni to'xtatish
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

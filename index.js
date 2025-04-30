const {
    Client,
    LocalAuth,
    MessageMedia
} = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const xlsx = require('xlsx');

const issueFilePath = './kendala.json';
const settingsFile = './settings.json';

let dataReports = [];

// ========== Load & Save Data ==========
function loadIssues() {
    if (!fs.existsSync(issueFilePath)) return {};
    return JSON.parse(fs.readFileSync(issueFilePath));
}

function saveIssues(data) {
    fs.writeFileSync(issueFilePath, JSON.stringify(data, null, 2));
}

function loadSettings() {
    if (!fs.existsSync(settingsFile)) return {
        admins: [],
        cs_ho_ids: []
    };
    return JSON.parse(fs.readFileSync(settingsFile));
}

function saveSettings(data) {
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2));
}

let issueResponses = loadIssues();
let settings = loadSettings();

// ========== Inisialisasi Client ==========
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('Scan QR Code berikut di WhatsApp:');
    qrcode.generate(qr, {
        small: true
    });
});

client.on('ready', () => {
    console.log('Bot siap digunakan!');
    console.log('📁 Kendala berhasil dimuat dari kendala.json!');
});

// ========== Follow-Up dan Round Robin ==========
const followUpTimers = {}; // Untuk menyimpan timer follow-up
const csIndex = {}; // Untuk menyimpan index CS HO terakhir

function handleFollowUp(chatId, issueCode) {
    if (!settings.cs_ho_ids || settings.cs_ho_ids.length === 0) {
        console.warn("Tidak ada CS HO yang terdaftar di settings.json!");
        return;
    }

    if (typeof csIndex[chatId] === 'undefined') {
        csIndex[chatId] = 0;
    }

    const hoId = settings.cs_ho_ids[csIndex[chatId] % settings.cs_ho_ids.length];
    console.log("Mengambil kontak CS:", hoId);

    client.getContactById(hoId).then(contact => {
        client.getChatById(chatId).then(chat => {
            console.log("Berhasil dapat chat & contact, mencoba kirim mention...");

            chat.sendMessage(`@${hoId.split('@')[0]} ⚠️ Mohon bantuannya untuk kendala: ${issueCode}`, {
                mentions: [contact]
            }).catch(err => console.error("Gagal mention CS HO:", err));
        });
    }).catch(err => console.error("Gagal mendapatkan kontak CS HO:", err));

    csIndex[chatId] = (csIndex[chatId] + 1) % settings.cs_ho_ids.length;
}



// ========== Listener Pesan ==========
client.on('message', async (msg) => {
    const senderNumber = msg.from.replace(/[@c.us|@s.whatsapp.net]/g, '');
    const chat = await msg.getChat();
    console.log("=== DETAIL CHAT ===");
    console.log(chat);
    const command = msg.body.trim().toLowerCase();
    const isAdmin = settings.admins.includes(senderNumber);

    // ========== Menu Kendala ==========
    if (command === '!error') {
        let response = `👋 Halo! Silakan pilih kendala Anda:\n\n`;
        let index = 1;
        for (const [kode, data] of Object.entries(issueResponses)) {
            if (data.judul) {
                response += `${index++}. *${data.judul}* - Ketik: \`${kode}\`\n`;
            }
        }
        await msg.reply(response);
        return;
    }


    // ========== Proses Kendala ==========
    if (issueResponses[command]) {
        const data = issueResponses[command];
        const response = `📌 *${data.judul}*\n💡 ${data.solusi}`;
        await msg.reply(response);
    
        const isGroup = msg.from.endsWith('@g.us');
        console.log("KODE KENDALA:", command);
        console.log("Diselesaikan oleh:", data.diselesaikan_oleh);
        console.log("Deteksi Grup via msg.from:", isGroup);
    
        if (data.diselesaikan_oleh.toUpperCase() === 'HO' && isGroup) {
            followUpTimers[chat.id._serialized] = {
                timeout: setTimeout(() => {
                    chat.sendMessage("Apakah kendala sudah selesai? Balas 'belum' jika masih membutuhkan bantuan.");
                }, 30000),
                issueCode: command
            };
    
            if (typeof csIndex[chat.id._serialized] === 'undefined') {
                csIndex[chat.id._serialized] = 0;
            }
        }
    }
    

    // ========== Handle Balasan "belum" ==========
    if (command === 'belum' && followUpTimers[chat.id._serialized]) {
        console.log("BALASAN 'BELUM' DITERIMA dari:", senderNumber);
        console.log("Untuk kendala:", followUpTimers[chat.id._serialized].issueCode);
    
        clearTimeout(followUpTimers[chat.id._serialized].timeout); // Hentikan timer
        const issueCode = followUpTimers[chat.id._serialized].issueCode; // Ambil kode kendala
        handleFollowUp(chat.id._serialized, issueCode); // Mention CS HO
        delete followUpTimers[chat.id._serialized]; // Hapus timer
        return;
    }
    
    
    

    // ========== Fitur Laporan (Admin Only) ==========
    if (command === '!report') {
        if (!isAdmin) return msg.reply("🚫 Anda tidak memiliki izin.");
        if (dataReports.length === 0) return msg.reply("📋 Tidak ada laporan saat ini.");

        let reportText = `📋 *Laporan Pengguna:*\n\n`;
        dataReports.forEach((report, index) => {
            reportText += `${index + 1}. *User:* ${report["User ID"]}\n *Issue:* ${report["Issue"]}\n *Status:* ${report["Status"]}\n\n`;
        });
        return msg.reply(reportText);
    }

    if (command === '!report_excel') {
        if (!isAdmin) return msg.reply("🚫 Anda tidak memiliki izin.");
        if (dataReports.length === 0) return msg.reply("📋 Tidak ada laporan untuk diekspor.");
        if (msg.from.includes('@g.us')) return msg.reply("⚠️ Perintah ini hanya bisa dijalankan melalui chat pribadi bot.");

        try {
            const wb = xlsx.utils.book_new();
            const ws = xlsx.utils.json_to_sheet(dataReports);
            xlsx.utils.book_append_sheet(wb, ws, "Laporan");
            const filePath = `./laporan_${new Date().toISOString().slice(0, 10)}.xlsx`;
            xlsx.writeFile(wb, filePath);
            const media = MessageMedia.fromFilePath(filePath);
            await client.sendMessage(msg.from, media, {
                caption: "📂 Berikut laporan dalam bentuk Excel."
            });
        } catch (err) {
            console.error("❌ Gagal ekspor:", err);
            await msg.reply("❌ Terjadi kesalahan saat mengekspor laporan.");
        }
        return;
    }

    // ========== Perintah Admin (Admin Only) ==========
    if (command.startsWith('!add_admin')) {
        if (!isAdmin) return msg.reply("🚫 Anda tidak memiliki izin.");
        const parts = command.split(' ');
        if (parts.length !== 2) return msg.reply("❌ Format salah. Contoh: !add_admin 6281234567890");
        const newAdmin = parts[1].replace(/@c\.us$/, "");

        if (settings.admins.includes(newAdmin)) return msg.reply("⚠️ Admin sudah ada.");

        settings.admins.push(newAdmin);
        saveSettings(settings);
        return msg.reply(`✅ Admin ${newAdmin} berhasil ditambahkan.`);
    }

    if (command.startsWith('!add_cs')) {
        if (!isAdmin) return msg.reply("🚫 Anda tidak memiliki izin.");
        const parts = command.split(' ');
        if (parts.length !== 2) return msg.reply("❌ Format salah. Contoh: !add_cs 6281234567890");
        const newCs = parts[1];
        const formattedCs = `${newCs}@c.us`;

        if (settings.cs_ho_ids.includes(formattedCs)) return msg.reply("⚠️ CS HO sudah ada.");

        settings.cs_ho_ids.push(formattedCs);
        saveSettings(settings);
        return msg.reply(`✅ CS HO ${formattedCs} berhasil ditambahkan.`);
    }
});

client.initialize();

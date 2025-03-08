const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const fsPromises = require('fs').promises;

const app = express();

// Gunakan port dari environment variable atau default ke 3000 untuk lokal
const port = process.env.PORT || 3000;

// Konfigurasi multer untuk menyimpan file sementara
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Autentikasi untuk Sheets dan Drive menggunakan credentials dari environment variable
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), // Ambil dari env
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const spreadsheetId = process.env.SPREADSHEET_ID; // Ambil dari env

async function initializeSheet() {
    console.log('Memulai inisialisasi sheet...');
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:H1',
        });
        console.log('Respons get sheet:', response.data);

        if (!response.data.values) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Sheet1!A1:H1',
                valueInputOption: 'RAW',
                resource: {
                    values: [['ID', 'Tanggal', 'Nama Penerima', 'Departemen', 'Deskripsi Barang', 'Foto Penerima (URL)', 'Tanda Tangan Pengirim (URL)', 'Tanda Tangan Penerima (URL)']],
                },
            });
            console.log('Header Google Sheets diinisialisasi');
        }
    } catch (error) {
        console.error('Gagal inisialisasi header:', error.message);
        throw error;
    }
}

async function uploadToDrive(filePath, fileName) {
    console.log('Mengunggah file ke Drive:', filePath);
    try {
        const fileMetadata = {
            name: fileName,
            // parents: ['YOUR_GOOGLE_DRIVE_FOLDER_ID'], // Opsional, tambahkan di env jika perlu
        };
        const media = {
            mimeType: fileName.endsWith('.png') ? 'image/png' : 'image/jpeg',
            body: fs.createReadStream(filePath),
        };
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
        });
        console.log('File diunggah, ID:', response.data.id);
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });
        return response.data.webViewLink;
    } catch (error) {
        console.error('Gagal mengunggah ke Drive:', error.message);
        throw error;
    }
}

app.post('/api/receipts', upload.fields([
    { name: 'photo' },
    { name: 'signatureSender' },
    { name: 'signatureReceiver' }
]), async (req, res) => {
    console.log('Menerima request:', req.body, req.files);
    const { recipientName, department, items, date } = req.body;
    const photoFile = req.files['photo'] ? req.files['photo'][0] : null;
    const signatureSenderFile = req.files['signatureSender'] ? req.files['signatureSender'][0] : null;
    const signatureReceiverFile = req.files['signatureReceiver'] ? req.files['signatureReceiver'][0] : null;

    try {
        await initializeSheet();

        const itemsArray = JSON.parse(items);
        const itemsString = itemsArray.map(item => 
            `${item.desc} (Qty: ${item.qty} ${item.unit}, PR: ${item.prNumber}, PO: ${item.poNumber})`
        ).join('; ');

        const photoUrl = photoFile ? await uploadToDrive(photoFile.path, `photo_${Date.now()}.jpg`) : '';
        const signatureSenderUrl = signatureSenderFile ? await uploadToDrive(signatureSenderFile.path, `sender_${Date.now()}.png`) : '';
        const signatureReceiverUrl = signatureReceiverFile ? await uploadToDrive(signatureReceiverFile.path, `receiver_${Date.now()}.png`) : '';

        if (photoFile) await fsPromises.unlink(photoFile.path);
        if (signatureSenderFile) await fsPromises.unlink(signatureSenderFile.path);
        if (signatureReceiverFile) await fsPromises.unlink(signatureReceiverFile.path);

        console.log('Mendapatkan jumlah baris saat ini...');
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A:A',
        });
        const rowCount = response.data.values ? response.data.values.length : 1;
        const newId = rowCount;

        console.log('Menulis data ke Sheets...');
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A:H',
            valueInputOption: 'RAW',
            resource: {
                values: [[newId, date, recipientName, department, itemsString, photoUrl, signatureSenderUrl, signatureReceiverUrl]],
            },
        });

        console.log('Data berhasil ditulis ke Google Sheets');
        res.json({ message: 'Tanda terima berhasil disimpan ke Google Sheets', id: newId });
    } catch (error) {
        console.error('Gagal menulis ke Google Sheets:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${port}`);
});
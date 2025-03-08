const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ dest: '/tmp' }); // Vercel pakai /tmp untuk file sementara

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Autentikasi Google
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });
const spreadsheetId = process.env.SPREADSHEET_ID;

// Fungsi untuk inisialisasi sheet (jika belum ada header)
async function initializeSheet() {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!A1:G1',
    });
    if (!response.data.values) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'Sheet1!A1:G1',
            valueInputOption: 'RAW',
            resource: {
                values: [['ID', 'Recipient Name', 'Department', 'Items', 'Date', 'Photo URL', 'Signature URLs']],
            },
        });
    }
}

// Fungsi untuk upload ke Google Drive
async function uploadToDrive(file) {
    const fileMetadata = { name: file.originalname };
    const media = {
        mimeType: file.mimetype,
        body: require('fs').createReadStream(file.path),
    };
    const response = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id, webViewLink',
    });
    await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
    });
    return response.data.webViewLink;
}

// Export fungsi serverless
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        const multerMiddleware = upload.fields([
            { name: 'photo', maxCount: 1 },
            { name: 'signatureSender', maxCount: 1 },
            { name: 'signatureReceiver', maxCount: 1 },
        ]);

        multerMiddleware(req, res, async (err) => {
            if (err) return res.status(500).json({ error: 'Upload failed' });

            const { recipientName, department, items, date } = req.body;
            const photoFile = req.files['photo'] ? req.files['photo'][0] : null;
            const sigSenderFile = req.files['signatureSender'] ? req.files['signatureSender'][0] : null;
            const sigReceiverFile = req.files['signatureReceiver'] ? req.files['signatureReceiver'][0] : null;

            try {
                await initializeSheet();

                const photoUrl = photoFile ? await uploadToDrive(photoFile) : '';
                const sigSenderUrl = sigSenderFile ? await uploadToDrive(sigSenderFile) : '';
                const sigReceiverUrl = sigReceiverFile ? await uploadToDrive(sigReceiverFile) : '';

                const values = [[
                    Date.now(), // ID sederhana
                    recipientName,
                    department,
                    items,
                    date,
                    photoUrl,
                    `${sigSenderUrl},${sigReceiverUrl}`,
                ]];

                await sheets.spreadsheets.values.append({
                    spreadsheetId,
                    range: 'Sheet1!A2:G',
                    valueInputOption: 'RAW',
                    resource: { values },
                });

                res.json({ message: 'Tanda terima berhasil disimpan', id: values[0][0] });
            } catch (error) {
                console.error(error);
                res.status(500).json({ error: 'Server error' });
            }
        });
    } else {
        res.status(405).json({ error: 'Method Not Allowed' });
    }
};
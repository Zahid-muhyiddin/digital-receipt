const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: '/tmp' });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });
const spreadsheetId = process.env.SPREADSHEET_ID;

// Endpoint untuk login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const validUsername = process.env.LOGIN_USERNAME;
        const validPassword = process.env.LOGIN_PASSWORD;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username dan password diperlukan' });
        }

        if (username === validUsername && password === validPassword) {
            return res.status(200).json({ message: 'Login berhasil' });
        } else {
            return res.status(401).json({ error: 'Username atau password salah' });
        }
    } catch (error) {
        console.error('Error during login:', error);
        return res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// Endpoint untuk history
app.get('/api/history', async (req, res) => {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A2:I',
        }, { timeout: 15000 }); // Timeout 15 detik

        const rows = response.data.values || [];
        const data = rows.map(row => ({
            id: row[0] || '',
            date: row[1] || '',
            recipientName: row[2] || '',
            department: row[3] || '',
            items: row[4] || '',
            photoUrl: row[5] || '',
            signatureSenderUrl: row[6] || '',
            signatureReceiverUrl: row[7] || '',
            pdfUrl: row[8] || ''
        }));

        res.status(200).json({ data });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ error: 'Failed to fetch history: ' + error.message });
    }
});

async function initializeSheet() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:I1',
        }, { timeout: 10000 });
        if (!response.data.values || response.data.values.length === 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Sheet1!A1:I1',
                valueInputOption: 'RAW',
                resource: {
                    values: [['ID', 'Date', 'Recipient Name', 'Department', 'Items', 'Photo URL', 'Signature Sender URL', 'Signature Receiver URL', 'PDF URL']],
                },
            }, { timeout: 10000 });
            console.log('Sheet header initialized');
        }
    } catch (error) {
        console.error('Error initializing sheet:', error);
        throw new Error('Failed to initialize sheet: ' + error.message);
    }
}

async function uploadToDrive(file) {
    try {
        const fileMetadata = { name: file.originalname };
        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path),
        };
        const response = await drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, webViewLink',
        }, { timeout: 15000 });
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        }, { timeout: 10000 });
        console.log(`Uploaded file: ${response.data.webViewLink}`);
        return response.data.webViewLink;
    } catch (error) {
        console.error('Error uploading to Drive:', error);
        throw new Error('Failed to upload file: ' + error.message);
    }
}

function parseItems(body) {
    console.log('Parsing req.body:', JSON.stringify(body, null, 2));
    const items = Array.isArray(body.items) ? body.items : [];
    const validItems = items.filter(item => 
        item && 
        item.desc && 
        item.qty && 
        item.unit && 
        item.prNumber && 
        item.poNumber
    ).map(item => ({
        desc: item.desc,
        qty: item.qty,
        unit: item.unit,
        prNumber: item.prNumber,
        poNumber: item.poNumber
    }));
    console.log('Parsed items:', validItems);
    return validItems;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST' || req.path !== '/api/receipts') {
        if (req.path === '/api/login' || req.path === '/api/history') return;
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const multerMiddleware = upload.fields([
        { name: 'photo', maxCount: 1 },
        { name: 'signatureSender', maxCount: 1 },
        { name: 'signatureReceiver', maxCount: 1 },
    ]);

    try {
        await new Promise((resolve, reject) => {
            multerMiddleware(req, res, (err) => {
                if (err) reject(new Error('Upload failed: ' + err.message));
                else resolve();
            });
        });

        console.log('Full req.body:', JSON.stringify(req.body, null, 2));
        console.log('Full req.files:', req.files);

        const { recipientName, department, date } = req.body;
        const items = parseItems(req.body);
        const photoFile = req.files && req.files['photo'] ? req.files['photo'][0] : null;
        const sigSenderFile = req.files && req.files['signatureSender'] ? req.files['signatureSender'][0] : null;
        const sigReceiverFile = req.files && req.files['signatureReceiver'] ? req.files['signatureReceiver'][0] : null;

        await initializeSheet();

        const photoUrl = photoFile ? await uploadToDrive(photoFile) : '';
        const sigSenderUrl = sigSenderFile ? await uploadToDrive(sigSenderFile) : '';
        const sigReceiverUrl = sigReceiverFile ? await uploadToDrive(sigReceiverFile) : '';

        const itemsString = items.length > 0 
            ? items.map(item => `${item.desc} - Qty: ${item.qty} ${item.unit} - PR: ${item.prNumber} - PO: ${item.poNumber}`).join('\n')
            : 'Tidak ada barang';

        console.log('Items String:', itemsString);

        const values = [[
            Date.now(),
            date || new Date().toISOString(),
            recipientName || 'Tidak ada nama',
            department || 'Tidak ada departemen',
            itemsString,
            photoUrl,
            sigSenderUrl,
            sigReceiverUrl,
            ''
        ]];

        console.log('Values to Sheets:', values);

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A2:I',
            valueInputOption: 'RAW',
            resource: { values },
        }, { timeout: 10000 });

        res.status(200).json({ message: 'Tanda terima berhasil disimpan' });
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    } finally {
        const files = [req.files?.['photo']?.[0], req.files?.['signatureSender']?.[0], req.files?.['signatureReceiver']?.[0]];
        files.forEach(file => {
            if (file && fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
                console.log(`Deleted temp file: ${file.path}`);
            }
        });
    }
};
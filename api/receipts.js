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

async function initializeSheet() {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!A1:I1',
    });
    if (!response.data.values) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'Sheet1!A1:I1',
            valueInputOption: 'RAW',
            resource: {
                values: [['ID', 'Date', 'Recipient Name', 'Department', 'Items', 'Photo URL', 'Signature Sender URL', 'Signature Receiver URL', 'PDF URL']],
            },
        });
    }
}

async function uploadToDrive(file) {
    const fileMetadata = { name: file.originalname };
    const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
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

function parseItems(body) {
    const items = [];
    const itemRegex = /^items\[(\d+)\]\[(\w+)\]$/;

    console.log('Parsing req.body:', JSON.stringify(body, null, 2));

    for (const key in body) {
        const match = key.match(itemRegex);
        if (match) {
            const index = parseInt(match[1], 10);
            const field = match[2];
            if (!items[index]) items[index] = {};
            items[index][field] = body[key];
        }
    }

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
    if (req.method === 'POST') {
        const multerMiddleware = upload.fields([
            { name: 'photo', maxCount: 1 },
            { name: 'signatureSender', maxCount: 1 },
            { name: 'signatureReceiver', maxCount: 1 },
        ]);

        multerMiddleware(req, res, async (err) => {
            if (err) return res.status(500).json({ error: 'Upload failed: ' + err.message });

            console.log('Full req.body:', JSON.stringify(req.body, null, 2));
            console.log('Full req.files:', req.files);

            const { recipientName, department, date } = req.body;
            const items = parseItems(req.body);
            const photoFile = req.files && req.files['photo'] ? req.files['photo'][0] : null;
            const sigSenderFile = req.files && req.files['signatureSender'] ? req.files['signatureSender'][0] : null;
            const sigReceiverFile = req.files && req.files['signatureReceiver'] ? req.files['signatureReceiver'][0] : null;

            try {
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
                });

                res.json({ message: 'Tanda terima berhasil disimpan' });
            } catch (error) {
                console.error('Server error:', error);
                res.status(500).json({ error: 'Server error: ' + error.message });
            } finally {
                if (photoFile) fs.unlinkSync(photoFile.path);
                if (sigSenderFile) fs.unlinkSync(sigSenderFile.path);
                if (sigReceiverFile) fs.unlinkSync(sigReceiverFile.path);
            }
        });
    } else {
        res.status(405).json({ error: 'Method Not Allowed' });
    }
};
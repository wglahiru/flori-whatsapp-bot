const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const archiver = require('archiver');
const axios = require('axios');
const extractZip = require('extract-zip');
const FormData = require('form-data');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;
const API_BASE_URL = 'https://www.flori.lk/admin/api'; 
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const ZIP_FILE = path.join(__dirname, 'session.zip');

app.use(cors());
app.use(express.json());

// State variables
let qrCodeData = null;
let clientStatus = 'disconnected'; // 'disconnected', 'authenticating', 'connected'
let isSavingSession = false;
let client = null;

// Helpers to save and load session to/from flori.lk to survive Render container restarts
async function saveSessionToRemote() {
    if (isSavingSession) return;
    isSavingSession = true;
    console.log('Zipping session directory...');
    try {
        const output = fs.createWriteStream(ZIP_FILE);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        const zipPromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
        });
        
        archive.pipe(output);
        
        // Exclude caches to keep the ZIP small and avoid 500 errors on PHP side
        archive.glob('**/*', {
            cwd: SESSION_DIR,
            ignore: ['**/Cache/**', '**/Code Cache/**', '**/Service Worker/CacheStorage/**', '**/Crashpad/**']
        });
        
        await archive.finalize();
        await zipPromise;
        console.log('Session zipped successfully. Uploading to remote server...');
        
        const form = new FormData();
        form.append('session_file', fs.createReadStream(ZIP_FILE));
        
        const response = await axios.post(`${API_BASE_URL}/whatsapp_save_session.php`, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });
        
        console.log('Session uploaded successfully:', response.data);
    } catch (err) {
        console.error('Error saving session to remote:', err.message);
    } finally {
        isSavingSession = false;
        if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
    }
}

async function loadSessionFromRemote() {
    console.log('Attempting to download session from remote server...');
    try {
        const response = await axios.get(`${API_BASE_URL}/whatsapp_get_session.php`, { responseType: 'stream' });
        
        if (response.headers['content-type'] && response.headers['content-type'].includes('application/zip')) {
            const writer = fs.createWriteStream(ZIP_FILE);
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            
            console.log('Session downloaded. Extracting...');
            await extractZip(ZIP_FILE, { dir: SESSION_DIR });
            console.log('Session extracted successfully.');
        } else {
            console.log('No valid session found on remote server. Will start fresh.');
        }
    } catch (err) {
        console.log('Could not load session from remote (might be first run):', err.message);
    } finally {
        if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
    }
}

async function initializeClient() {
    // 1. Fetch remote session first
    await loadSessionFromRemote();
    
    // 2. Initialize WhatsApp Client
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-extensions',
                '--js-flags="--max-old-space-size=256"' // Prevent Node/Chromium from exceeding Render memory
            ]
        },
        // Cache prevents downloading huge whatsapp web updates to RAM
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    client.on('qr', (qr) => {
        console.log('QR Code generated. Scan to authenticate.');
        clientStatus = 'disconnected';
        
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) {
                qrCodeData = url;
            }
        });
    });

    client.on('ready', async () => {
        console.log('Client is ready and connected!');
        clientStatus = 'connected';
        qrCodeData = null;
        
        // As soon as we are ready, save the session back to remote!
        await saveSessionToRemote();
    });

    client.on('authenticated', () => {
        console.log('Client authenticated successfully.');
        clientStatus = 'authenticating';
    });

    client.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        clientStatus = 'disconnected';
        qrCodeData = null;
    });

    client.on('disconnected', async (reason) => {
        console.log('Client was logged out', reason);
        clientStatus = 'disconnected';
        qrCodeData = null;
        try {
            await client.destroy();
        } catch (err) {
            console.error('Error destroying client:', err);
        }
        // Instead of reinitializing immediately, wait a bit
        setTimeout(() => {
            client.initialize(); 
        }, 5000);
    });

    console.log('Initializing WhatsApp client...');
    client.initialize();
}

// Check Status
app.get('/api/status', (req, res) => {
    res.json({
        status: clientStatus,
        phone: client && client.info ? client.info.wid.user : null
    });
});

// Get QR Code
app.get('/api/qr', (req, res) => {
    if (clientStatus === 'connected') {
        return res.status(400).json({ error: 'Already connected.' });
    }
    if (!qrCodeData) {
        return res.status(404).json({ error: 'QR code not generated yet. Please wait.' });
    }
    const html = `
        <div style="text-align: center; font-family: sans-serif; padding: 20px;">
            <h3>Scan QR Code to Connect WhatsApp</h3>
            <img src="${qrCodeData}" alt="QR Code" style="width: 300px; height: 300px;"/>
            <p>Open WhatsApp on your phone > Settings > Linked Devices > Link a Device</p>
            <p><small>Note: If you already scanned and it says disconnected, wait 1-2 minutes for the server to process the login and refresh this page.</small></p>
        </div>
    `;
    res.send(html);
});

// Send Message
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (clientStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    if (!number || !message) {
        return res.status(400).json({ success: false, error: 'Number and message are required.' });
    }

    try {
        const formattedNumber = `${number}@c.us`;
        const response = await client.sendMessage(formattedNumber, message);
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// A manual trigger to force save session just in case
app.get('/api/save-session', async (req, res) => {
    if (clientStatus === 'connected') {
        await saveSessionToRemote();
        res.json({ success: true, message: 'Session saved.' });
    } else {
        res.status(400).json({ success: false, error: 'Not connected.' });
    }
});

// Start Server & Client
app.listen(port, () => {
    console.log(`WhatsApp API Microservice listening at http://localhost:${port}`);
    initializeClient();
});

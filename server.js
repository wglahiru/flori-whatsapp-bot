const express = require('express');

const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const archiver = require('archiver');
const axios = require('axios');
const extractZip = require('extract-zip');
const FormData = require('form-data');
const path = require('path');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 10000;
const API_BASE_URL = 'https://www.flori.lk/admin/api'; 
const SESSION_DIR = path.join(__dirname, 'auth_info_baileys');
const ZIP_FILE = path.join(__dirname, 'session.zip');

app.use(cors());
app.use(express.json());

// State variables
let qrCodeData = null;
let clientStatus = 'disconnected'; // 'disconnected', 'authenticating', 'connected'
let isSavingSession = false;
let sock = null;
let saveTimeout = null;

// Helpers to save and load session to/from flori.lk to survive Render container restarts
async function saveSessionToRemote() {
    if (isSavingSession) return;
    isSavingSession = true;
    console.log('Zipping session directory...');
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            isSavingSession = false;
            return;
        }

        const output = fs.createWriteStream(ZIP_FILE);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        const zipPromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
        });
        
        archive.pipe(output);
        archive.directory(SESSION_DIR, false);
        
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

async function connectToWhatsApp() {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Flori.lk", "Chrome", "1.0.0"],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code generated. Scan to authenticate.');
            clientStatus = 'disconnected';
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeData = url;
                }
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            clientStatus = 'disconnected';
            
            // Reconnect if not logged out
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            } else {
                // Logged out, delete session and start fresh
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Client is ready and connected!');
            clientStatus = 'connected';
            qrCodeData = null;
            
            // Save initial connection session
            await saveSessionToRemote();
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // Debounce save session to avoid spamming the PHP server
        if (clientStatus === 'connected') {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(saveSessionToRemote, 10000);
        }
    });
}

async function initializeClient() {
    // 1. Fetch remote session first
    await loadSessionFromRemote();
    
    // 2. Initialize WhatsApp Client
    console.log('Initializing WhatsApp client...');
    connectToWhatsApp();
}

// Check Status
app.get('/api/status', (req, res) => {
    res.json({
        status: clientStatus
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
            <p><small>Note: Using Baileys Lightweight Client for Render Free Tier.</small></p>
        </div>
    `;
    res.send(html);
});

// Send Message
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (clientStatus !== 'connected' || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    if (!number || !message) {
        return res.status(400).json({ success: false, error: 'Number and message are required.' });
    }

    try {
        // Format number: e.g., 94771234567 -> 94771234567@s.whatsapp.net for Baileys
        const formattedNumber = `${number}@s.whatsapp.net`;
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: "Sent successfully" });
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

const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
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
let isConnecting = false;

// Delete session on flori.lk remote server
async function deleteSessionOnRemote() {
    try {
        await axios.get(`${API_BASE_URL}/whatsapp_delete_session.php`, { timeout: 8000 });
        console.log('Remote session deleted successfully on flori.lk');
    } catch (err) {
        console.log('Remote session delete notification skipped/failed:', err.message);
    }
}

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
            maxContentLength: Infinity,
            timeout: 15000
        });
        
        console.log('Session uploaded successfully:', response.data);
    } catch (err) {
        console.error('Error saving session to remote:', err.message);
    } finally {
        isSavingSession = false;
        if (fs.existsSync(ZIP_FILE)) {
            try { fs.unlinkSync(ZIP_FILE); } catch (e) {}
        }
    }
}

async function loadSessionFromRemote() {
    console.log('Attempting to download session from remote server...');
    try {
        const response = await axios.get(`${API_BASE_URL}/whatsapp_get_session.php`, { 
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': 'FloriBot/1.0' }
        });
        
        if (response.headers['content-type'] && response.headers['content-type'].includes('application/zip') && response.data.length > 200) {
            fs.writeFileSync(ZIP_FILE, Buffer.from(response.data));
            const targetDir = path.resolve(SESSION_DIR);
            
            console.log(`Session downloaded (${response.data.length} bytes). Extracting to ${targetDir}...`);
            await extractZip(ZIP_FILE, { dir: targetDir });
            console.log('Session extracted successfully.');

            // Validate that the extracted session is actually registered and valid
            const credsFile = path.join(targetDir, 'creds.json');
            if (fs.existsSync(credsFile)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                    if (creds && creds.me && creds.registered === false) {
                        console.log('Downloaded session is invalid/unregistered (creds.registered is false). Purging...');
                        fs.rmSync(targetDir, { recursive: true, force: true });
                        await deleteSessionOnRemote();
                    }
                } catch (err) {
                    console.log('Error inspecting creds.json:', err.message);
                }
            }
        } else {
            console.log('No valid session found on remote server. Starting fresh.');
        }
    } catch (err) {
        console.log('Could not load session from remote:', err.message);
    } finally {
        if (fs.existsSync(ZIP_FILE)) {
            try { fs.unlinkSync(ZIP_FILE); } catch (e) {}
        }
    }
}

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        // 1. Fetch latest WhatsApp Web version to prevent 405 Method Not Allowed / Client Out of Date errors
        let version;
        try {
            const versionInfo = await fetchLatestBaileysVersion();
            version = versionInfo.version;
            console.log('Using WhatsApp Web version:', version);
        } catch (e) {
            console.log('Failed to fetch latest WA version, using fallback:', e.message);
            version = [2, 3000, 1043857760];
        }

        // 2. Load auth state
        let { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        // Sanity check: if creds has .me but registered is false, it's a dead session
        if (state.creds && state.creds.me && state.creds.registered === false) {
            console.log('Corrupted session detected (me set but registered: false). Wiping and creating fresh...');
            if (fs.existsSync(SESSION_DIR)) {
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            }
            await deleteSessionOnRemote();
            const fresh = await useMultiFileAuthState(SESSION_DIR);
            state = fresh.state;
            saveCreds = fresh.saveCreds;
        }

        // 3. Create Socket
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        // 4. Listen for Connection Updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('New QR Code generated successfully.');
                clientStatus = 'disconnected';
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        qrCodeData = url;
                    }
                });
            }
            
            if (connection === 'close') {
                isConnecting = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.log('Connection closed. Code:', statusCode, 'Error:', lastDisconnect?.error?.message);
                clientStatus = 'disconnected';
                
                // Check if logged out, unauthorized, or client version blocked
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403 || statusCode === 405;
                
                if (isLoggedOut) {
                    console.log('Session logged out or expired. Wiping session and preparing fresh QR...');
                    qrCodeData = null;
                    if (fs.existsSync(SESSION_DIR)) {
                        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    }
                    await deleteSessionOnRemote();
                    setTimeout(connectToWhatsApp, 2000);
                } else {
                    // Reconnect on transient disconnects
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('WhatsApp client is connected and ready!');
                clientStatus = 'connected';
                qrCodeData = null;
                
                // Save session to flori.lk
                await saveSessionToRemote();
            }
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            if (clientStatus === 'connected') {
                if (saveTimeout) clearTimeout(saveTimeout);
                saveTimeout = setTimeout(saveSessionToRemote, 10000);
            }
        });

    } catch (err) {
        isConnecting = false;
        console.error('Error in connectToWhatsApp:', err.message);
        setTimeout(connectToWhatsApp, 5000);
    }
}

async function initializeClient() {
    // 1. Fetch remote session first
    await loadSessionFromRemote();
    
    // 2. Initialize WhatsApp Client
    console.log('Initializing WhatsApp client...');
    connectToWhatsApp();
}

// Check Status & QR endpoint
app.get('/api/status', (req, res) => {
    let phone = null;
    if (sock?.user?.id) {
        phone = sock.user.id.split(':')[0];
    }
    res.json({
        status: clientStatus,
        qr: qrCodeData,
        phone: phone
    });
});

// Reset Session Endpoint (POST or GET)
app.all('/api/reset', async (req, res) => {
    console.log('Resetting WhatsApp session as requested...');
    try {
        qrCodeData = null;
        clientStatus = 'disconnected';
        isConnecting = false;

        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch (e) {}
            sock = null;
        }

        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }

        await deleteSessionOnRemote();

        setTimeout(connectToWhatsApp, 1500);

        res.json({
            success: true,
            message: 'Session successfully reset. A fresh QR code is being generated...'
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Get QR Code - Enhanced with auto-refreshing HTML fallback
app.get('/api/qr', (req, res) => {
    if (clientStatus === 'connected') {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Connected</title></head>
            <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; background: #f9fafb;">
                <div style="display: inline-block; padding: 20px; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                    <div style="font-size: 40px; margin-bottom: 10px;">✅</div>
                    <h3 style="color: #16a34a; margin: 0 0 8px 0;">WhatsApp Connected!</h3>
                    <p style="color: #6b7280; font-size: 14px; margin: 0;">The device is already connected and active.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta http-equiv="refresh" content="3">
                <title>Generating QR...</title>
            </head>
            <body style="font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; background: #f9fafb;">
                <div style="display: inline-block; padding: 25px; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 320px;">
                    <div style="font-size: 32px; margin-bottom: 15px; animation: spin 2s linear infinite;">⏳</div>
                    <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 18px;">Generating QR Code...</h3>
                    <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0;">Connecting to WhatsApp servers. This page will automatically refresh every 3 seconds.</p>
                </div>
            </body>
            </html>
        `);
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta http-equiv="refresh" content="18">
            <title>Scan WhatsApp QR</title>
        </head>
        <body style="font-family: system-ui, sans-serif; text-align: center; padding: 20px; background: #f9fafb;">
            <div style="display: inline-block; padding: 20px; background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                <h3 style="margin: 0 0 12px 0; color: #1f2937; font-size: 17px;">Scan QR to Link Device</h3>
                <img src="${qrCodeData}" alt="WhatsApp QR Code" style="width: 250px; height: 250px; border: 1px solid #e5e7eb; border-radius: 8px;"/>
                <p style="font-size: 12px; color: #6b7280; margin: 12px 0 0 0;">Open WhatsApp > Linked Devices > Link a Device</p>
                <p style="font-size: 11px; color: #9ca3af; margin: 6px 0 0 0;">(Auto-refreshes every 18 seconds)</p>
            </div>
        </body>
        </html>
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
        // Format number: e.g., 0771234567 -> 94771234567@s.whatsapp.net
        let cleanedNumber = number.toString().replace(/[^0-9]/g, '');
        if (cleanedNumber.startsWith('0')) {
            cleanedNumber = '94' + cleanedNumber.substring(1);
        }
        const formattedNumber = `${cleanedNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: "Sent successfully" });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual trigger to force save session
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

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// State variables
let qrCodeData = null;
let clientStatus = 'disconnected'; // 'disconnected', 'authenticating', 'connected'

// Initialize WhatsApp Client with local authentication (saves session)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
    }
});

client.on('qr', (qr) => {
    console.log('QR Code generated. Scan to authenticate.');
    clientStatus = 'disconnected';
    
    // Convert QR to base64 image data
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
            qrCodeData = url;
        }
    });
});

client.on('ready', () => {
    console.log('Client is ready and connected!');
    clientStatus = 'connected';
    qrCodeData = null; // Clear QR code as it's no longer needed
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

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    clientStatus = 'disconnected';
    qrCodeData = null;
    // Client automatically reconnects if session is valid, 
    // but if explicitly logged out, we wait for re-initialization.
    client.initialize(); 
});

// Initialize the client
console.log('Initializing WhatsApp client...');
client.initialize();

// --- API Endpoints ---

// Check Status
app.get('/api/status', (req, res) => {
    res.json({
        status: clientStatus,
        phone: client.info ? client.info.wid.user : null
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
    // Return HTML page with image
    const html = `
        <div style="text-align: center; font-family: sans-serif; padding: 20px;">
            <h3>Scan QR Code to Connect WhatsApp</h3>
            <img src="${qrCodeData}" alt="QR Code" style="width: 300px; height: 300px;"/>
            <p>Open WhatsApp on your phone > Settings > Linked Devices > Link a Device</p>
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
        // Format number: e.g., 94771234567 -> 94771234567@c.us
        const formattedNumber = `${number}@c.us`;
        
        // Send message
        const response = await client.sendMessage(formattedNumber, message);
        
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`WhatsApp API Microservice listening at http://localhost:${port}`);
});

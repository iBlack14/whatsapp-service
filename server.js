const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// State
let qrCodeData = null;
let connectionStatus = 'disconnected'; // disconnected | qr_pending | connected
let clientInfo = null;
let isClientReady = false;

// Initialize WhatsApp client with local auth (persists session)
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu'
        ]
    }
});

// QR Event
client.on('qr', async (qr) => {
    console.log('📱 QR Code received, scan with WhatsApp');
    connectionStatus = 'qr_pending';
    try {
        qrCodeData = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    } catch (err) {
        console.error('Error generating QR:', err);
    }
});

// Ready Event
client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    connectionStatus = 'connected';
    isClientReady = true;
    qrCodeData = null;
    clientInfo = {
        name: client.info?.pushname || 'Unknown',
        phone: client.info?.wid?.user || 'Unknown',
        platform: client.info?.platform || 'Unknown'
    };
});

// Auth Success
client.on('authenticated', () => {
    console.log('🔐 Authentication successful');
    // Don't set connected here - wait for 'ready' event
    qrCodeData = null;
});

// Auth Failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    connectionStatus = 'disconnected';
    qrCodeData = null;
});

// Disconnected
client.on('disconnected', (reason) => {
    console.log('🔌 Disconnected:', reason);
    connectionStatus = 'disconnected';
    isClientReady = false;
    qrCodeData = null;
    clientInfo = null;
});

// ============ API ENDPOINTS ============

// GET /api/status - Connection status
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        client: clientInfo
    });
});

// GET /api/qr - Get QR code
app.get('/api/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'connected', qr: null, client: clientInfo });
    }
    res.json({
        status: connectionStatus,
        qr: qrCodeData
    });
});

// POST /api/send - Send a message
app.post('/api/send', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'Phone and message are required' });
        }

        if (connectionStatus !== 'connected' || !isClientReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp not connected. Please scan QR first.' });
        }

        // Format phone number: ensure it has country code and @c.us suffix
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.length === 9) {
            formattedPhone = '51' + formattedPhone; // Peru country code
        }
        const chatId = formattedPhone + '@c.us';

        // Send message
        const result = await client.sendMessage(chatId, message);

        res.json({
            success: true,
            messageId: result.id?.id,
            timestamp: result.timestamp,
            to: formattedPhone
        });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/chats - Get recent chats
app.get('/api/chats', async (req, res) => {
    try {
        if (connectionStatus !== 'connected' || !isClientReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
        }

        const chats = await client.getChats();
        const recentChats = chats.slice(0, 30).map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? {
                body: chat.lastMessage.body?.substring(0, 100),
                timestamp: chat.lastMessage.timestamp,
                fromMe: chat.lastMessage.fromMe
            } : null,
            timestamp: chat.timestamp
        }));

        res.json({ success: true, chats: recentChats });

    } catch (error) {
        console.error('Error getting chats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/messages/:chatId - Get messages from a chat
app.get('/api/messages/:chatId', async (req, res) => {
    try {
        if (connectionStatus !== 'connected') {
            return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
        }

        const chatId = req.params.chatId;
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });

        const formattedMessages = messages.map(msg => ({
            id: msg.id?.id,
            body: msg.body,
            fromMe: msg.fromMe,
            timestamp: msg.timestamp,
            type: msg.type,
            hasMedia: msg.hasMedia
        }));

        res.json({ success: true, messages: formattedMessages });

    } catch (error) {
        console.error('Error getting messages:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/disconnect - Disconnect session
app.post('/api/disconnect', async (req, res) => {
    try {
        await client.logout();
        connectionStatus = 'disconnected';
        qrCodeData = null;
        clientInfo = null;
        res.json({ success: true, message: 'Disconnected successfully' });
    } catch (error) {
        console.error('Error disconnecting:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp Service running on port ${PORT}`);
    console.log('⏳ Initializing WhatsApp client...');
    client.initialize();
});

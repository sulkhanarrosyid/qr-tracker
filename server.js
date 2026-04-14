const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── Init data file ───────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ links: [], visits: [] }, null, 2));
}

const getData = () => {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { links: [], visits: [] };
  }
};

const saveData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: Create tracked QR link ──────────────────────────────────────────────
app.post('/api/create', async (req, res) => {
  try {
    const { url, name } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Basic URL validation
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const data = getData();
    const id = uuidv4().replace(/-/g, '').substring(0, 10);
    const host = req.get('host') || `localhost:${PORT}`;
    const protocol = req.protocol || 'http';
    const trackingUrl = `${protocol}://${host}/track/${id}`;

    // Generate QR code as data URL (high quality)
    const qrDataUrl = await qrcode.toDataURL(trackingUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
      errorCorrectionLevel: 'H'
    });

    const link = {
      id,
      name: name?.trim() || parsedUrl.hostname,
      originalUrl: url,
      trackingUrl,
      qrCode: qrDataUrl,
      createdAt: new Date().toISOString()
    };

    data.links.unshift(link); // newest first
    saveData(data);

    res.json({ ...link, visitCount: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create QR code' });
  }
});

// ─── Tracking redirect ────────────────────────────────────────────────────────
app.get('/track/:id', (req, res) => {
  const { id } = req.params;
  const data = getData();

  const link = data.links.find((l) => l.id === id);
  if (!link) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>Link not found</h2>
        <p>This QR code may have been deleted.</p>
        <a href="/">Back to QR Tracker</a>
      </body></html>
    `);
  }

  // Parse user-agent for device info
  const ua = req.headers['user-agent'] || '';
  let device = 'Desktop';
  if (/Mobile|Android|iPhone|iPad/i.test(ua)) device = 'Mobile';
  else if (/Tablet/i.test(ua)) device = 'Tablet';

  let browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  const visit = {
    id: uuidv4(),
    linkId: id,
    timestamp: new Date().toISOString(),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(),
    userAgent: ua,
    referer: req.headers['referer'] || 'Direct / QR Scan',
    device,
    browser,
    os
  };

  data.visits.push(visit);
  saveData(data);

  // Redirect to original URL
  res.redirect(302, link.originalUrl);
});

// ─── API: Get all links with stats ────────────────────────────────────────────
app.get('/api/links', (req, res) => {
  const data = getData();

  const linksWithStats = data.links.map((link) => {
    const visits = data.visits.filter((v) => v.linkId === link.id);
    const sorted = [...visits].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return {
      ...link,
      visitCount: visits.length,
      lastVisit: sorted[0]?.timestamp || null
    };
  });

  res.json(linksWithStats);
});

// ─── API: Get visits for a specific link ─────────────────────────────────────
app.get('/api/links/:id/visits', (req, res) => {
  const data = getData();
  const visits = data.visits
    .filter((v) => v.linkId === req.params.id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(visits);
});

// ─── API: Get a single link ───────────────────────────────────────────────────
app.get('/api/links/:id', (req, res) => {
  const data = getData();
  const link = data.links.find((l) => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });

  const visits = data.visits.filter((v) => v.linkId === link.id);
  res.json({ ...link, visitCount: visits.length });
});

// ─── API: Delete a link ───────────────────────────────────────────────────────
app.delete('/api/links/:id', (req, res) => {
  const data = getData();
  data.links = data.links.filter((l) => l.id !== req.params.id);
  data.visits = data.visits.filter((v) => v.linkId !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ─── API: Stats summary ───────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const data = getData();
  const totalLinks = data.links.length;
  const totalVisits = data.visits.length;

  // Visits in the last 7 days by day
  const now = new Date();
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dayStr = d.toISOString().split('T')[0];
    const count = data.visits.filter((v) => v.timestamp.startsWith(dayStr)).length;
    last7.push({ label, count });
  }

  // Device breakdown
  const devices = data.visits.reduce((acc, v) => {
    acc[v.device] = (acc[v.device] || 0) + 1;
    return acc;
  }, {});

  // Browser breakdown
  const browsers = data.visits.reduce((acc, v) => {
    acc[v.browser] = (acc[v.browser] || 0) + 1;
    return acc;
  }, {});

  res.json({ totalLinks, totalVisits, last7, devices, browsers });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 QR Tracker is running!`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});

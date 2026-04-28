const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Railway Volume veya lokal data klasörü
// Railway'de RAILWAY_VOLUME_MOUNT_PATH env var set edilir
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
  : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Veritabanı bağlantısı
const dbPath = path.join(dataDir, 'demlik.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err);
    process.exit(1);
  }
  console.log(`📊 Veritabanı: ${dbPath}`);
});

// Promise wrapper
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// WAL modu ve tabloları oluştur
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT,
    avatar TEXT,
    status TEXT DEFAULT 'offline',
    bio TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'text',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    attachment TEXT,
    reply_to INTEGER,
    edited BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (reply_to) REFERENCES messages(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    attachment TEXT,
    read BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(id),
    FOREIGN KEY (to_user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS channel_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(channel_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(message_id, user_id, emoji)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'dark',
    notifications BOOLEAN DEFAULT 1,
    sound BOOLEAN DEFAULT 1,
    language TEXT DEFAULT 'tr',
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Varsayılan kanal
  db.get('SELECT id FROM channels WHERE name = ?', ['genel'], (err, row) => {
    if (!row) {
      db.run('INSERT INTO channels (name, description, type) VALUES (?, ?, ?)',
        ['genel', 'Genel sohbet kanalı', 'text']);
    }
  });
});

// Multer yapılandırması
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|mp4|webm|pdf|doc|docx|txt/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Geçersiz dosya türü!'));
    }
  }
});

// ── ROUTES ──────────────────────────────────────────────

// Kayıt
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, display_name } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Tüm alanlar gereklidir' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, email, password, display_name) VALUES (?, ?, ?, ?)',
      [username, email, hashedPassword, display_name || username]
    );
    await dbRun('INSERT INTO user_settings (user_id) VALUES (?)', [result.lastID]);
    res.json({ success: true, userId: result.lastID, message: 'Kayıt başarılı' });
  } catch (error) {
    console.error('Kayıt hatası:', error);
    res.status(500).json({ error: 'Kayıt başarısız: ' + error.message });
  }
});

// Giriş
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Hatalı şifre' });

    await dbRun('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', ['online', user.id]);
    delete user.password;
    res.json({ success: true, user, message: 'Giriş başarılı' });
  } catch (error) {
    console.error('Giriş hatası:', error);
    res.status(500).json({ error: 'Giriş başarısız' });
  }
});

// Çıkış
app.post('/api/logout/:userId', async (req, res) => {
  try {
    await dbRun('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', ['offline', req.params.userId]);
    res.json({ success: true, message: 'Çıkış başarılı' });
  } catch (error) {
    console.error('Çıkış hatası:', error);
    res.status(500).json({ error: 'Çıkış başarısız' });
  }
});

// Kullanıcı profili
app.get('/api/users/:userId', async (req, res) => {
  try {
    const user = await dbGet(
      'SELECT id, username, email, display_name, avatar, status, bio, created_at, last_seen FROM users WHERE id = ?',
      [req.params.userId]
    );
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user);
  } catch (error) {
    console.error('Profil hatası:', error);
    res.status(500).json({ error: 'Profil yüklenemedi' });
  }
});

// Profil güncelleme
app.put('/api/users/:userId', async (req, res) => {
  try {
    const { display_name, bio, avatar } = req.body;
    await dbRun('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?',
      [display_name, bio, avatar, req.params.userId]);
    res.json({ success: true, message: 'Profil güncellendi' });
  } catch (error) {
    console.error('Profil güncelleme hatası:', error);
    res.status(500).json({ error: 'Profil güncellenemedi' });
  }
});

// Tüm kullanıcılar
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, display_name, avatar, status, last_seen FROM users ORDER BY username');
    res.json(users);
  } catch (error) {
    console.error('Kullanıcı listesi hatası:', error);
    res.status(500).json({ error: 'Kullanıcılar yüklenemedi' });
  }
});

// Kanallar
app.get('/api/channels', async (req, res) => {
  try {
    const channels = await dbAll(`
      SELECT c.*, u.username as creator_name,
             (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as member_count
      FROM channels c
      LEFT JOIN users u ON c.created_by = u.id
      ORDER BY c.created_at DESC
    `);
    res.json(channels);
  } catch (error) {
    console.error('Kanal listesi hatası:', error);
    res.status(500).json({ error: 'Kanallar yüklenemedi' });
  }
});

// Kanal oluştur
app.post('/api/channels', async (req, res) => {
  try {
    const { name, description, type, created_by } = req.body;
    const result = await dbRun(
      'INSERT INTO channels (name, description, type, created_by) VALUES (?, ?, ?, ?)',
      [name, description, type || 'text', created_by]
    );
    await dbRun('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)',
      [result.lastID, created_by, 'admin']);
    res.json({ success: true, channelId: result.lastID, message: 'Kanal oluşturuldu' });
  } catch (error) {
    console.error('Kanal oluşturma hatası:', error);
    res.status(500).json({ error: 'Kanal oluşturulamadı' });
  }
});

// Kanal mesajları
app.get('/api/channels/:channelId/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const messages = await dbAll(`
      SELECT m.*, u.username, u.display_name, u.avatar,
             (SELECT COUNT(*) FROM reactions WHERE message_id = m.id) as reaction_count
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.channelId, limit, offset]);
    res.json(messages.reverse());
  } catch (error) {
    console.error('Mesaj getirme hatası:', error);
    res.status(500).json({ error: 'Mesajlar yüklenemedi' });
  }
});

// Mesaj gönder
app.post('/api/channels/:channelId/messages', async (req, res) => {
  try {
    const { userId, content, type, attachment, reply_to } = req.body;
    if (!content && !attachment) return res.status(400).json({ error: 'Mesaj içeriği gerekli' });

    const result = await dbRun(
      'INSERT INTO messages (channel_id, user_id, content, type, attachment, reply_to) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.channelId, userId, content || '', type || 'text', attachment || null, reply_to || null]
    );
    const message = await dbGet(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `, [result.lastID]);
    res.json({ success: true, message });
  } catch (error) {
    console.error('Mesaj gönderme hatası:', error);
    res.status(500).json({ error: 'Mesaj gönderilemedi' });
  }
});

// Mesaj düzenle
app.put('/api/messages/:messageId', async (req, res) => {
  try {
    const { content, userId } = req.body;
    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    if (message.user_id !== userId) return res.status(403).json({ error: 'Yetkiniz yok' });
    await dbRun('UPDATE messages SET content = ?, edited = 1 WHERE id = ?', [content, req.params.messageId]);
    res.json({ success: true, message: 'Mesaj düzenlendi' });
  } catch (error) {
    console.error('Mesaj düzenleme hatası:', error);
    res.status(500).json({ error: 'Mesaj düzenlenemedi' });
  }
});

// Mesaj sil
app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const { userId } = req.body;
    const message = await dbGet('SELECT * FROM messages WHERE id = ?', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mesaj bulunamadı' });
    if (message.user_id !== userId) return res.status(403).json({ error: 'Yetkiniz yok' });
    await dbRun('DELETE FROM reactions WHERE message_id = ?', [req.params.messageId]);
    await dbRun('DELETE FROM messages WHERE id = ?', [req.params.messageId]);
    res.json({ success: true, message: 'Mesaj silindi' });
  } catch (error) {
    console.error('Mesaj silme hatası:', error);
    res.status(500).json({ error: 'Mesaj silinemedi' });
  }
});

// Dosya yükleme
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi' });
    res.json({
      success: true,
      url: `/uploads/${req.file.filename}`,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('Dosya yükleme hatası:', error);
    res.status(500).json({ error: 'Dosya yüklenemedi' });
  }
});

app.use('/uploads', express.static(uploadsDir));

// Health check (Railway için)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Sunucuyu başlat
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Demlik sunucusu http://0.0.0.0:${PORT} adresinde çalışıyor`);
  console.log(`📁 Yüklemeler: ${uploadsDir}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM alındı, sunucu kapatılıyor...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 Sunucu kapatılıyor...');
  db.close();
  process.exit(0);
});

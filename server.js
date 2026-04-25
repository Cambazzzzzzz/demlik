const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Veritabanı klasörünü oluştur
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Uploads klasörünü oluştur
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Veritabanı bağlantısı
const db = new Database(path.join(dataDir, 'demlik.db'));
db.pragma('journal_mode = WAL');

// Veritabanı tablolarını oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
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
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'text',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
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
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
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
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'dark',
    notifications BOOLEAN DEFAULT 1,
    sound BOOLEAN DEFAULT 1,
    language TEXT DEFAULT 'tr',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Varsayılan kanal oluştur
const defaultChannel = db.prepare('SELECT * FROM channels WHERE name = ?').get('genel');
if (!defaultChannel) {
  db.prepare('INSERT INTO channels (name, description, type) VALUES (?, ?, ?)').run(
    'genel',
    'Genel sohbet kanalı',
    'text'
  );
}

// Multer yapılandırması
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|webm|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Geçersiz dosya türü!'));
    }
  }
});

// Kayıt
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, display_name } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Tüm alanlar gereklidir' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = db.prepare(
      'INSERT INTO users (username, email, password, display_name) VALUES (?, ?, ?, ?)'
    ).run(username, email, hashedPassword, display_name || username);

    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);

    res.json({ 
      success: true, 
      userId: result.lastInsertRowid,
      message: 'Kayıt başarılı' 
    });
  } catch (error) {
    console.error('Kayıt hatası:', error);
    res.status(500).json({ error: 'Kayıt başarısız: ' + error.message });
  }
});

// Giriş
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
    
    if (!user) {
      return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Hatalı şifre' });
    }

    db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
      .run('online', user.id);

    delete user.password;

    res.json({ 
      success: true, 
      user,
      message: 'Giriş başarılı' 
    });
  } catch (error) {
    console.error('Giriş hatası:', error);
    res.status(500).json({ error: 'Giriş başarısız' });
  }
});

// Çıkış
app.post('/api/logout/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
      .run('offline', userId);

    res.json({ success: true, message: 'Çıkış başarılı' });
  } catch (error) {
    console.error('Çıkış hatası:', error);
    res.status(500).json({ error: 'Çıkış başarısız' });
  }
});

// Kullanıcı profili
app.get('/api/users/:userId', (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, email, display_name, avatar, status, bio, created_at, last_seen FROM users WHERE id = ?')
      .get(req.params.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    res.json(user);
  } catch (error) {
    console.error('Profil hatası:', error);
    res.status(500).json({ error: 'Profil yüklenemedi' });
  }
});

// Profil güncelleme
app.put('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { display_name, bio, avatar } = req.body;
    
    db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?')
      .run(display_name, bio, avatar, userId);

    res.json({ success: true, message: 'Profil güncellendi' });
  } catch (error) {
    console.error('Profil güncelleme hatası:', error);
    res.status(500).json({ error: 'Profil güncellenemedi' });
  }
});

// Tüm kullanıcıları listele
app.get('/api/users', (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, display_name, avatar, status, last_seen FROM users ORDER BY username')
      .all();
    
    res.json(users);
  } catch (error) {
    console.error('Kullanıcı listesi hatası:', error);
    res.status(500).json({ error: 'Kullanıcılar yüklenemedi' });
  }
});

// Tüm kanalları listele
app.get('/api/channels', (req, res) => {
  try {
    const channels = db.prepare(`
      SELECT c.*, u.username as creator_name, 
             (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as member_count
      FROM channels c
      LEFT JOIN users u ON c.created_by = u.id
      ORDER BY c.created_at DESC
    `).all();
    
    res.json(channels);
  } catch (error) {
    console.error('Kanal listesi hatası:', error);
    res.status(500).json({ error: 'Kanallar yüklenemedi' });
  }
});

// Kanal oluştur
app.post('/api/channels', (req, res) => {
  try {
    const { name, description, type, created_by } = req.body;
    
    const result = db.prepare('INSERT INTO channels (name, description, type, created_by) VALUES (?, ?, ?, ?)')
      .run(name, description, type || 'text', created_by);

    db.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)')
      .run(result.lastInsertRowid, created_by, 'admin');

    res.json({ 
      success: true, 
      channelId: result.lastInsertRowid,
      message: 'Kanal oluşturuldu' 
    });
  } catch (error) {
    console.error('Kanal oluşturma hatası:', error);
    res.status(500).json({ error: 'Kanal oluşturulamadı' });
  }
});

// Kanal mesajlarını getir
app.get('/api/channels/:channelId/messages', (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const messages = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar,
             (SELECT COUNT(*) FROM reactions WHERE message_id = m.id) as reaction_count
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(channelId, limit, offset);
    
    res.json(messages.reverse());
  } catch (error) {
    console.error('Mesaj getirme hatası:', error);
    res.status(500).json({ error: 'Mesajlar yüklenemedi' });
  }
});

// Mesaj gönder
app.post('/api/channels/:channelId/messages', (req, res) => {
  try {
    const { channelId } = req.params;
    const { userId, content, type, attachment, reply_to } = req.body;
    
    if (!content && !attachment) {
      return res.status(400).json({ error: 'Mesaj içeriği gerekli' });
    }

    const result = db.prepare(
      'INSERT INTO messages (channel_id, user_id, content, type, attachment, reply_to) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(channelId, userId, content || '', type || 'text', attachment, reply_to);

    const message = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);

    res.json({ success: true, message });
  } catch (error) {
    console.error('Mesaj gönderme hatası:', error);
    res.status(500).json({ error: 'Mesaj gönderilemedi' });
  }
});

// Mesaj düzenle
app.put('/api/messages/:messageId', (req, res) => {
  try {
    const { messageId } = req.params;
    const { content, userId } = req.body;
    
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Mesaj bulunamadı' });
    }

    if (message.user_id !== userId) {
      return res.status(403).json({ error: 'Bu mesajı düzenleme yetkiniz yok' });
    }

    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?')
      .run(content, messageId);

    res.json({ success: true, message: 'Mesaj düzenlendi' });
  } catch (error) {
    console.error('Mesaj düzenleme hatası:', error);
    res.status(500).json({ error: 'Mesaj düzenlenemedi' });
  }
});

// Mesaj sil
app.delete('/api/messages/:messageId', (req, res) => {
  try {
    const { messageId } = req.params;
    const { userId } = req.body;
    
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Mesaj bulunamadı' });
    }

    if (message.user_id !== userId) {
      return res.status(403).json({ error: 'Bu mesajı silme yetkiniz yok' });
    }

    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);

    res.json({ success: true, message: 'Mesaj silindi' });
  } catch (error) {
    console.error('Mesaj silme hatası:', error);
    res.status(500).json({ error: 'Mesaj silinemedi' });
  }
});

// Dosya yükleme
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Dosya yüklenmedi' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ 
      success: true, 
      url: fileUrl,
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

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`🚀 Demlik sunucusu http://localhost:${PORT} adresinde çalışıyor`);
  console.log(`📊 Veritabanı: ${path.join(dataDir, 'demlik.db')}`);
  console.log(`📁 Yüklemeler: ${uploadsDir}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Sunucu kapatılıyor...');
  db.close();
  process.exit(0);
});

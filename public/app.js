const API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

let currentUser = null;
let currentChannel = null;
let messages = [];
let channels = [];
let users = [];

const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const messagesContainer = document.getElementById('messagesContainer');

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 20px;
        background: ${type === 'error' ? '#f04747' : type === 'success' ? '#43b581' : '#7289da'};
        color: white;
        border-radius: 5px;
        z-index: 10000;
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.remove(), 3000);
}

function formatTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Az önce';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} dakika önce`;
    if (diff < 86400000) return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function getAvatarEmoji(username) {
    const emojis = ['😀', '😎', '🤖', '👽', '🦊', '🐱', '🐶', '🐼', '🦁', '🐯'];
    const index = username.charCodeAt(0) % emojis.length;
    return emojis[index];
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(`${tab}Form`).classList.add('active');
    });
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('demlik_user', JSON.stringify(currentUser));
            showChatScreen();
            showNotification('Giriş başarılı!', 'success');
        } else {
            showNotification(data.error, 'error');
        }
    } catch (error) {
        console.error('Giriş hatası:', error);
        showNotification('Giriş yapılamadı', 'error');
    }
});

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('registerUsername').value;
    const email = document.getElementById('registerEmail').value;
    const display_name = document.getElementById('registerDisplayName').value;
    const password = document.getElementById('registerPassword').value;
    
    try {
        const response = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, display_name, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('Kayıt başarılı! Giriş yapabilirsiniz.', 'success');
            document.querySelector('[data-tab="login"]').click();
            document.getElementById('loginUsername').value = username;
        } else {
            showNotification(data.error, 'error');
        }
    } catch (error) {
        console.error('Kayıt hatası:', error);
        showNotification('Kayıt yapılamadı', 'error');
    }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (confirm('Çıkış yapmak istediğinize emin misiniz?')) {
        try {
            await fetch(`${API_URL}/logout/${currentUser.id}`, { method: 'POST' });
            localStorage.removeItem('demlik_user');
            currentUser = null;
            loginScreen.classList.add('active');
            chatScreen.classList.remove('active');
            showNotification('Çıkış yapıldı', 'success');
        } catch (error) {
            console.error('Çıkış hatası:', error);
        }
    }
});

function showChatScreen() {
    loginScreen.classList.remove('active');
    chatScreen.classList.add('active');
    
    document.getElementById('userDisplayName').textContent = currentUser.display_name || currentUser.username;
    document.getElementById('userAvatar').textContent = getAvatarEmoji(currentUser.username);
    
    loadChannels();
    loadUsers();
    startPolling();
}

async function loadChannels() {
    try {
        const response = await fetch(`${API_URL}/channels`);
        channels = await response.json();
        renderChannels();
    } catch (error) {
        console.error('Kanal yükleme hatası:', error);
    }
}

function renderChannels() {
    const container = document.getElementById('channelsContent');
    container.innerHTML = '';
    
    channels.forEach(channel => {
        const item = document.createElement('div');
        item.className = 'list-item';
        if (currentChannel && currentChannel.id === channel.id) {
            item.classList.add('active');
        }
        
        item.innerHTML = `
            <div class="list-item-icon">#</div>
            <div class="list-item-content">
                <div class="list-item-name">${channel.name}</div>
                <div class="list-item-desc">${channel.member_count || 0} üye</div>
            </div>
        `;
        
        item.addEventListener('click', () => selectChannel(channel));
        container.appendChild(item);
    });
}

async function selectChannel(channel) {
    currentChannel = channel;
    
    document.getElementById('chatTitle').textContent = `# ${channel.name}`;
    document.getElementById('chatDescription').textContent = channel.description || '';
    
    messageInput.disabled = false;
    sendBtn.disabled = false;
    
    renderChannels();
    await loadMessages();
}

async function loadMessages() {
    if (!currentChannel) return;
    
    try {
        const response = await fetch(`${API_URL}/channels/${currentChannel.id}/messages`);
        messages = await response.json();
        renderMessages();
    } catch (error) {
        console.error('Mesaj yükleme hatası:', error);
    }
}

function renderMessages() {
    messagesContainer.innerHTML = '';
    
    if (messages.length === 0) {
        messagesContainer.innerHTML = `
            <div class="welcome-message">
                <h2>Henüz mesaj yok</h2>
                <p>İlk mesajı siz gönderin!</p>
            </div>
        `;
        return;
    }
    
    messages.forEach(message => {
        const messageEl = createMessageElement(message);
        messagesContainer.appendChild(messageEl);
    });
    
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function createMessageElement(message) {
    const div = document.createElement('div');
    div.className = 'message';
    div.dataset.messageId = message.id;
    
    const isOwn = message.user_id === currentUser.id;
    
    div.innerHTML = `
        <div class="message-avatar">${getAvatarEmoji(message.username)}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-author">${message.display_name || message.username}</span>
                <span class="message-time">${formatTime(message.created_at)}</span>
                ${message.edited ? '<span class="message-edited">(düzenlendi)</span>' : ''}
            </div>
            <div class="message-text">${escapeHtml(message.content)}</div>
            ${isOwn ? `
                <div class="message-actions">
                    <button class="icon-btn edit-message" title="Düzenle">✏️</button>
                    <button class="icon-btn delete-message" title="Sil">🗑️</button>
                </div>
            ` : ''}
        </div>
    `;
    
    if (isOwn) {
        div.querySelector('.edit-message')?.addEventListener('click', () => editMessage(message));
        div.querySelector('.delete-message')?.addEventListener('click', () => deleteMessage(message));
    }
    
    return div;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !currentChannel) return;
    
    try {
        const response = await fetch(`${API_URL}/channels/${currentChannel.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                content
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            messageInput.value = '';
            messages.push(data.message);
            renderMessages();
        }
    } catch (error) {
        console.error('Mesaj gönderme hatası:', error);
        showNotification('Mesaj gönderilemedi', 'error');
    }
}

async function editMessage(message) {
    const newContent = prompt('Yeni mesaj:', message.content);
    if (!newContent || newContent === message.content) return;
    
    try {
        const response = await fetch(`${API_URL}/messages/${message.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                content: newContent
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadMessages();
            showNotification('Mesaj düzenlendi', 'success');
        }
    } catch (error) {
        console.error('Mesaj düzenleme hatası:', error);
        showNotification('Mesaj düzenlenemedi', 'error');
    }
}

async function deleteMessage(message) {
    if (!confirm('Bu mesajı silmek istediğinize emin misiniz?')) return;
    
    try {
        const response = await fetch(`${API_URL}/messages/${message.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadMessages();
            showNotification('Mesaj silindi', 'success');
        }
    } catch (error) {
        console.error('Mesaj silme hatası:', error);
        showNotification('Mesaj silinemedi', 'error');
    }
}

async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/users`);
        users = await response.json();
        renderUsers();
    } catch (error) {
        console.error('Kullanıcı yükleme hatası:', error);
    }
}

function renderUsers() {
    const container = document.getElementById('usersContent');
    container.innerHTML = '';
    
    users.forEach(user => {
        if (user.id === currentUser.id) return;
        
        const item = document.createElement('div');
        item.className = 'list-item';
        
        const statusEmoji = user.status === 'online' ? '🟢' : '⚫';
        
        item.innerHTML = `
            <div class="message-avatar">${getAvatarEmoji(user.username)}</div>
            <div class="list-item-content">
                <div class="list-item-name">${user.display_name || user.username}</div>
                <div class="list-item-desc">${statusEmoji} ${user.status === 'online' ? 'Çevrimiçi' : 'Çevrimdışı'}</div>
            </div>
        `;
        
        container.appendChild(item);
    });
}

document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.list-container').forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(`${tabName}List`).classList.add('active');
    });
});

document.getElementById('createChannelBtn').addEventListener('click', () => {
    document.getElementById('createChannelModal').classList.add('active');
});

document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.closest('.modal').classList.remove('active');
    });
});

document.getElementById('createChannelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('channelName').value;
    const description = document.getElementById('channelDescription').value;
    
    try {
        const response = await fetch(`${API_URL}/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                description,
                type: 'text',
                created_by: currentUser.id
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('createChannelModal').classList.remove('active');
            document.getElementById('createChannelForm').reset();
            await loadChannels();
            showNotification('Kanal oluşturuldu!', 'success');
        }
    } catch (error) {
        console.error('Kanal oluşturma hatası:', error);
        showNotification('Kanal oluşturulamadı', 'error');
    }
});

let pollingInterval;

function startPolling() {
    pollingInterval = setInterval(async () => {
        if (currentChannel) {
            await loadMessages();
        }
    }, 3000);
}

const savedUser = localStorage.getItem('demlik_user');
if (savedUser) {
    currentUser = JSON.parse(savedUser);
    showChatScreen();
}

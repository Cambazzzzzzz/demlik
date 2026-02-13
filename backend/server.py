from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict, EmailStr
from typing import List, Optional
import uuid
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt
import base64
from io import BytesIO
from PIL import Image

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# JWT Settings
JWT_SECRET = os.environ.get('JWT_SECRET', 'demlik-secret-key-2024')
JWT_ALGORITHM = 'HS256'

# Create the main app
app = FastAPI()
api_router = APIRouter(prefix="/api")
security = HTTPBearer()

# Logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ========== MODELS ==========

class UserRegister(BaseModel):
    username: str
    email: EmailStr
    password: str
    kvkk_accepted: bool

class UserLogin(BaseModel):
    username: str
    password: str

class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    email: str
    role: str = "normal"  # normal, vip, plus, admin
    level: int = 1
    topics_count: int = 0
    replies_count: int = 0
    daily_topics: int = 0
    last_topic_date: str = ""
    profile_photo: Optional[str] = None
    profile_color: Optional[str] = None
    name_color: Optional[str] = None
    is_banned: bool = False
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class Topic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    content: str
    category: str
    author_id: str
    author_username: str
    replies_count: int = 0
    is_book: bool = False
    book_author: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class Reply(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    topic_id: str
    content: str
    author_id: str
    author_username: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class BookPage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    book_id: str
    page_number: int
    title: str
    content: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class Level(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    level_number: int
    name: str
    topics_required: int
    replies_required: int

class Category(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    icon: Optional[str] = None

class Announcement(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    content: str
    created_by: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class ActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    username: str
    action: str
    details: str
    ip_address: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# ========== HELPER FUNCTIONS ==========

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def create_token(user_id: str) -> str:
    payload = {
        'user_id': user_id,
        'exp': datetime.now(timezone.utc) + timedelta(days=30)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def get_client_ip(request: Request) -> str:
    if "x-forwarded-for" in request.headers:
        return request.headers["x-forwarded-for"].split(",")[0]
    elif "x-real-ip" in request.headers:
        return request.headers["x-real-ip"]
    return request.client.host if request.client else "unknown"

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        token = credentials.credentials
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get('user_id')
        user = await db.users.find_one({"id": user_id}, {"_id": 0})
        if not user:
            raise HTTPException(status_code=401, detail="Kullanıcı bulunamadı")
        if user.get('is_banned'):
            raise HTTPException(status_code=403, detail="Hesabınız yasaklandı")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token süresi dolmuş")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Geçersiz token")

async def get_admin_user(user: dict = Depends(get_current_user)) -> dict:
    if user['role'] != 'admin':
        raise HTTPException(status_code=403, detail="Yetkiniz yok")
    return user

async def log_activity(user_id: str, username: str, action: str, details: str, ip_address: str):
    log = ActivityLog(
        user_id=user_id,
        username=username,
        action=action,
        details=details,
        ip_address=ip_address
    )
    await db.activity_logs.insert_one(log.model_dump())

# ========== INITIALIZATION ==========

@app.on_event("startup")
async def initialize_data():
    # Check if admin exists
    admin = await db.users.find_one({"username": "ADMIN"}, {"_id": 0})
    if not admin:
        admin_user = User(
            username="ADMIN",
            email="admin@demlik.com",
            role="admin",
            level=20
        )
        admin_dict = admin_user.model_dump()
        admin_dict['password'] = hash_password("31622cMs4128!_")
        await db.users.insert_one(admin_dict)
        logger.info("Admin user created")
    
    # Initialize default levels
    levels_count = await db.levels.count_documents({})
    if levels_count == 0:
        default_levels = [
            {"level_number": 1, "name": "Yeni Başlayan", "topics_required": 0, "replies_required": 0},
            {"level_number": 2, "name": "Acemi", "topics_required": 5, "replies_required": 20},
            {"level_number": 3, "name": "Öğrenci", "topics_required": 10, "replies_required": 40},
            {"level_number": 4, "name": "Deneyimli", "topics_required": 15, "replies_required": 60},
            {"level_number": 5, "name": "Uzman", "topics_required": 20, "replies_required": 80},
            {"level_number": 6, "name": "Usta", "topics_required": 25, "replies_required": 100},
            {"level_number": 7, "name": "Profesyonel", "topics_required": 30, "replies_required": 120},
            {"level_number": 8, "name": "Elit", "topics_required": 35, "replies_required": 140},
            {"level_number": 9, "name": "Şampiyon", "topics_required": 40, "replies_required": 160},
            {"level_number": 10, "name": "Efsane", "topics_required": 45, "replies_required": 180},
            {"level_number": 11, "name": "Ölümsüz", "topics_required": 50, "replies_required": 200},
            {"level_number": 12, "name": "Tanrısal", "topics_required": 55, "replies_required": 220},
            {"level_number": 13, "name": "Evrensel", "topics_required": 60, "replies_required": 240},
            {"level_number": 14, "name": "Kozmik", "topics_required": 65, "replies_required": 260},
            {"level_number": 15, "name": "Yıldız", "topics_required": 70, "replies_required": 280},
            {"level_number": 16, "name": "Galaksi", "topics_required": 75, "replies_required": 300},
            {"level_number": 17, "name": "Nebula", "topics_required": 80, "replies_required": 320},
            {"level_number": 18, "name": "Kara Delik", "topics_required": 85, "replies_required": 340},
            {"level_number": 19, "name": "Kuasar", "topics_required": 90, "replies_required": 360},
            {"level_number": 20, "name": "Sonsuzluk", "topics_required": 100, "replies_required": 400},
        ]
        for level_data in default_levels:
            level = Level(id=str(uuid.uuid4()), **level_data)
            await db.levels.insert_one(level.model_dump())
        logger.info("Default levels created")
    
    # Initialize default categories
    categories_count = await db.categories.count_documents({})
    if categories_count == 0:
        default_categories = [
            {"name": "Oyun", "icon": "gamepad-2"},
            {"name": "Kitap", "icon": "book"},
            {"name": "Eğitim", "icon": "graduation-cap"},
            {"name": "AdminDestek", "icon": "shield-alert"},
        ]
        for cat_data in default_categories:
            category = Category(id=str(uuid.uuid4()), **cat_data)
            await db.categories.insert_one(category.model_dump())
        logger.info("Default categories created")

# ========== AUTH ENDPOINTS ==========

@api_router.post("/auth/register")
async def register(data: UserRegister, request: Request):
    if not data.kvkk_accepted:
        raise HTTPException(status_code=400, detail="KVKK onayı gereklidir")
    
    # Check if user exists
    existing_user = await db.users.find_one({"$or": [{"username": data.username}, {"email": data.email}]}, {"_id": 0})
    if existing_user:
        raise HTTPException(status_code=400, detail="Kullanıcı adı veya e-posta zaten kullanılıyor")
    
    user = User(
        username=data.username,
        email=data.email
    )
    user_dict = user.model_dump()
    user_dict['password'] = hash_password(data.password)
    
    await db.users.insert_one(user_dict)
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user.id, user.username, "register", "Kullanıcı kaydı yapıldı", ip)
    
    token = create_token(user.id)
    return {"token": token, "user": user}

@api_router.post("/auth/login")
async def login(data: UserLogin, request: Request):
    user = await db.users.find_one({"username": data.username}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya şifre hatalı")
    
    if not verify_password(data.password, user['password']):
        raise HTTPException(status_code=401, detail="Kullanıcı adı veya şifre hatalı")
    
    if user.get('is_banned'):
        raise HTTPException(status_code=403, detail="Hesabınız yasaklandı")
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "login", "Kullanıcı giriş yaptı", ip)
    
    token = create_token(user['id'])
    user_data = User(**user)
    return {"token": token, "user": user_data}

@api_router.get("/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    return user

# ========== TOPICS ENDPOINTS ==========

@api_router.get("/topics")
async def get_topics(category: Optional[str] = None, is_book: Optional[bool] = None):
    query = {}
    if category:
        query['category'] = category
    if is_book is not None:
        query['is_book'] = is_book
    
    topics = await db.topics.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return topics

@api_router.post("/topics")
async def create_topic(data: dict, user: dict = Depends(get_current_user), request: Request = None):
    # Check daily limit
    today = datetime.now(timezone.utc).date().isoformat()
    if user.get('last_topic_date') == today:
        daily_topics = user.get('daily_topics', 0)
        role = user.get('role', 'normal')
        
        limits = {"normal": 10, "vip": 25, "plus": 999999, "admin": 999999}
        if daily_topics >= limits.get(role, 10):
            raise HTTPException(status_code=400, detail="Günlük konu oluşturma limitine ulaştınız")
    
    topic = Topic(
        title=data['title'],
        content=data['content'],
        category=data['category'],
        author_id=user['id'],
        author_username=user['username'],
        is_book=data.get('is_book', False),
        book_author=data.get('book_author')
    )
    
    await db.topics.insert_one(topic.model_dump())
    
    # Update user stats
    if user.get('last_topic_date') == today:
        await db.users.update_one(
            {"id": user['id']},
            {"$inc": {"topics_count": 1, "daily_topics": 1}}
        )
    else:
        await db.users.update_one(
            {"id": user['id']},
            {"$inc": {"topics_count": 1}, "$set": {"daily_topics": 1, "last_topic_date": today}}
        )
    
    # Check level up
    updated_user = await db.users.find_one({"id": user['id']}, {"_id": 0})
    new_topics_count = updated_user['topics_count']
    new_replies_count = updated_user['replies_count']
    
    # Level calculation: 5 topics = 1 level OR 20 replies = 1 level
    topic_levels = new_topics_count // 5
    reply_levels = new_replies_count // 20
    calculated_level = min(topic_levels + reply_levels + 1, 20)
    
    if calculated_level > updated_user.get('level', 1):
        await db.users.update_one({"id": user['id']}, {"$set": {"level": calculated_level}})
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_topic", f"Konu oluşturuldu: {topic.title}", ip)
    
    return topic

@api_router.get("/topics/{topic_id}")
async def get_topic(topic_id: str):
    topic = await db.topics.find_one({"id": topic_id}, {"_id": 0})
    if not topic:
        raise HTTPException(status_code=404, detail="Konu bulunamadı")
    
    replies = await db.replies.find({"topic_id": topic_id}, {"_id": 0}).sort("created_at", 1).to_list(1000)
    
    return {"topic": topic, "replies": replies}

@api_router.delete("/topics/{topic_id}")
async def delete_topic(topic_id: str, user: dict = Depends(get_admin_user), request: Request = None):
    topic = await db.topics.find_one({"id": topic_id}, {"_id": 0})
    if not topic:
        raise HTTPException(status_code=404, detail="Konu bulunamadı")
    
    await db.topics.delete_one({"id": topic_id})
    await db.replies.delete_many({"topic_id": topic_id})
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "delete_topic", f"Konu silindi: {topic['title']}", ip)
    
    return {"message": "Konu silindi"}

# ========== REPLIES ENDPOINTS ==========

@api_router.post("/topics/{topic_id}/replies")
async def create_reply(topic_id: str, data: dict, user: dict = Depends(get_current_user), request: Request = None):
    topic = await db.topics.find_one({"id": topic_id}, {"_id": 0})
    if not topic:
        raise HTTPException(status_code=404, detail="Konu bulunamadı")
    
    reply = Reply(
        topic_id=topic_id,
        content=data['content'],
        author_id=user['id'],
        author_username=user['username']
    )
    
    await db.replies.insert_one(reply.model_dump())
    await db.topics.update_one({"id": topic_id}, {"$inc": {"replies_count": 1}})
    await db.users.update_one({"id": user['id']}, {"$inc": {"replies_count": 1}})
    
    # Check level up
    updated_user = await db.users.find_one({"id": user['id']}, {"_id": 0})
    new_topics_count = updated_user['topics_count']
    new_replies_count = updated_user['replies_count']
    
    topic_levels = new_topics_count // 5
    reply_levels = new_replies_count // 20
    calculated_level = min(topic_levels + reply_levels + 1, 20)
    
    if calculated_level > updated_user.get('level', 1):
        await db.users.update_one({"id": user['id']}, {"$set": {"level": calculated_level}})
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_reply", f"Yanıt oluşturuldu: {topic['title']}", ip)
    
    return reply

@api_router.delete("/replies/{reply_id}")
async def delete_reply(reply_id: str, user: dict = Depends(get_admin_user), request: Request = None):
    reply = await db.replies.find_one({"id": reply_id}, {"_id": 0})
    if not reply:
        raise HTTPException(status_code=404, detail="Yanıt bulunamadı")
    
    await db.replies.delete_one({"id": reply_id})
    await db.topics.update_one({"id": reply['topic_id']}, {"$inc": {"replies_count": -1}})
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "delete_reply", f"Yanıt silindi", ip)
    
    return {"message": "Yanıt silindi"}

# ========== BOOKS ENDPOINTS ==========

@api_router.get("/books")
async def get_books():
    books = await db.topics.find({"is_book": True}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return books

@api_router.get("/books/{book_id}/pages")
async def get_book_pages(book_id: str):
    pages = await db.book_pages.find({"book_id": book_id}, {"_id": 0}).sort("page_number", 1).to_list(1000)
    return pages

@api_router.post("/books/{book_id}/pages")
async def create_book_page(book_id: str, data: dict, user: dict = Depends(get_current_user), request: Request = None):
    book = await db.topics.find_one({"id": book_id, "is_book": True}, {"_id": 0})
    if not book:
        raise HTTPException(status_code=404, detail="Kitap bulunamadı")
    
    if book['author_id'] != user['id'] and user['role'] != 'admin':
        raise HTTPException(status_code=403, detail="Bu kitaba sayfa ekleyemezsiniz")
    
    # Get next page number
    existing_pages = await db.book_pages.find({"book_id": book_id}, {"_id": 0}).sort("page_number", -1).limit(1).to_list(1)
    next_page_number = existing_pages[0]['page_number'] + 1 if existing_pages else 1
    
    page = BookPage(
        book_id=book_id,
        page_number=next_page_number,
        title=data['title'],
        content=data['content']
    )
    
    await db.book_pages.insert_one(page.model_dump())
    
    # Log activity
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_book_page", f"Kitap sayfası eklendi: {book['title']} - Sayfa {next_page_number}", ip)
    
    return page

# ========== PROFILE ENDPOINTS ==========

@api_router.get("/users/{user_id}")
async def get_user_profile(user_id: str):
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0, "email": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Kullanıcı bulunamadı")
    
    topics = await db.topics.find({"author_id": user_id}, {"_id": 0}).sort("created_at", -1).limit(10).to_list(10)
    
    return {"user": user, "recent_topics": topics}

@api_router.put("/users/profile")
async def update_profile(data: dict, user: dict = Depends(get_current_user), request: Request = None):
    update_data = {}
    
    if 'username' in data:
        # Check if username is taken
        existing = await db.users.find_one({"username": data['username'], "id": {"$ne": user['id']}}, {"_id": 0})
        if existing:
            raise HTTPException(status_code=400, detail="Kullanıcı adı zaten kullanılıyor")
        update_data['username'] = data['username']
    
    if 'password' in data and data['password']:
        update_data['password'] = hash_password(data['password'])
    
    if 'profile_color' in data:
        role = user.get('role', 'normal')
        if role not in ['vip', 'plus', 'admin']:
            raise HTTPException(status_code=403, detail="Renk değiştirme özelliği sadece VIP+ üyelere özeldir")
        update_data['profile_color'] = data['profile_color']
    
    if 'name_color' in data:
        role = user.get('role', 'normal')
        if role not in ['vip', 'plus', 'admin']:
            raise HTTPException(status_code=403, detail="Renk değiştirme özelliği sadece VIP+ üyelere özeldir")
        update_data['name_color'] = data['name_color']
    
    if 'profile_photo' in data:
        update_data['profile_photo'] = data['profile_photo']
    
    if update_data:
        await db.users.update_one({"id": user['id']}, {"$set": update_data})
        
        # Log activity
        ip = get_client_ip(request)
        await log_activity(user['id'], user['username'], "update_profile", "Profil güncellendi", ip)
    
    updated_user = await db.users.find_one({"id": user['id']}, {"_id": 0})
    return User(**updated_user)

@api_router.post("/users/profile/photo")
async def upload_profile_photo(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="Sadece resim dosyaları kabul edilir")
    
    # Read and resize image
    contents = await file.read()
    image = Image.open(BytesIO(contents))
    image.thumbnail((300, 300))
    
    # Convert to base64
    buffered = BytesIO()
    image.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    data_url = f"data:image/png;base64,{img_str}"
    
    await db.users.update_one({"id": user['id']}, {"$set": {"profile_photo": data_url}})
    
    return {"profile_photo": data_url}

# ========== ANNOUNCEMENTS ENDPOINTS ==========

@api_router.get("/announcements")
async def get_announcements():
    announcements = await db.announcements.find({}, {"_id": 0}).sort("created_at", -1).limit(5).to_list(5)
    return announcements

# ========== ADMIN ENDPOINTS ==========

@api_router.get("/admin/users")
async def get_all_users(user: dict = Depends(get_admin_user)):
    users = await db.users.find({}, {"_id": 0, "password": 0}).sort("created_at", -1).to_list(1000)
    return users

@api_router.put("/admin/users/{target_user_id}/ban")
async def ban_user(target_user_id: str, data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    await db.users.update_one({"id": target_user_id}, {"$set": {"is_banned": data['is_banned']}})
    
    target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
    ip = get_client_ip(request)
    action = "ban" if data['is_banned'] else "unban"
    await log_activity(user['id'], user['username'], action, f"Kullanıcı {action}: {target_user['username']}", ip)
    
    return {"message": "Kullanıcı durumu güncellendi"}

@api_router.put("/admin/users/{target_user_id}/level")
async def change_user_level(target_user_id: str, data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    await db.users.update_one({"id": target_user_id}, {"$set": {"level": data['level']}})
    
    target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "change_level", f"Kullanıcı seviyesi değiştirildi: {target_user['username']} -> Seviye {data['level']}", ip)
    
    return {"message": "Seviye güncellendi"}

@api_router.put("/admin/users/{target_user_id}/role")
async def change_user_role(target_user_id: str, data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    await db.users.update_one({"id": target_user_id}, {"$set": {"role": data['role']}})
    
    target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "change_role", f"Kullanıcı rolü değiştirildi: {target_user['username']} -> {data['role']}", ip)
    
    return {"message": "Rol güncellendi"}

@api_router.get("/admin/levels")
async def get_levels(user: dict = Depends(get_admin_user)):
    levels = await db.levels.find({}, {"_id": 0}).sort("level_number", 1).to_list(100)
    return levels

@api_router.post("/admin/levels")
async def create_level(data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    level = Level(**data)
    await db.levels.insert_one(level.model_dump())
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_level", f"Seviye oluşturuldu: {level.name}", ip)
    
    return level

@api_router.put("/admin/levels/{level_id}")
async def update_level(level_id: str, data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    await db.levels.update_one({"id": level_id}, {"$set": data})
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "update_level", f"Seviye güncellendi", ip)
    
    return {"message": "Seviye güncellendi"}

@api_router.delete("/admin/levels/{level_id}")
async def delete_level(level_id: str, user: dict = Depends(get_admin_user), request: Request = None):
    await db.levels.delete_one({"id": level_id})
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "delete_level", f"Seviye silindi", ip)
    
    return {"message": "Seviye silindi"}

@api_router.get("/admin/categories")
async def get_categories(user: dict = Depends(get_admin_user)):
    categories = await db.categories.find({}, {"_id": 0}).to_list(100)
    return categories

@api_router.post("/admin/categories")
async def create_category(data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    category = Category(**data)
    await db.categories.insert_one(category.model_dump())
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_category", f"Kategori oluşturuldu: {category.name}", ip)
    
    return category

@api_router.delete("/admin/categories/{category_id}")
async def delete_category(category_id: str, user: dict = Depends(get_admin_user), request: Request = None):
    category = await db.categories.find_one({"id": category_id}, {"_id": 0})
    if not category:
        raise HTTPException(status_code=404, detail="Kategori bulunamadı")
    
    await db.categories.delete_one({"id": category_id})
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "delete_category", f"Kategori silindi: {category['name']}", ip)
    
    return {"message": "Kategori silindi"}

@api_router.get("/admin/announcements")
async def get_all_announcements(user: dict = Depends(get_admin_user)):
    announcements = await db.announcements.find({}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return announcements

@api_router.post("/admin/announcements")
async def create_announcement(data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    announcement = Announcement(
        title=data['title'],
        content=data['content'],
        created_by=user['username']
    )
    await db.announcements.insert_one(announcement.model_dump())
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "create_announcement", f"Duyuru oluşturuldu: {announcement.title}", ip)
    
    return announcement

@api_router.put("/admin/announcements/{announcement_id}")
async def update_announcement(announcement_id: str, data: dict, user: dict = Depends(get_admin_user), request: Request = None):
    update_data = data.copy()
    update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
    
    await db.announcements.update_one({"id": announcement_id}, {"$set": update_data})
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "update_announcement", f"Duyuru güncellendi", ip)
    
    return {"message": "Duyuru güncellendi"}

@api_router.delete("/admin/announcements/{announcement_id}")
async def delete_announcement(announcement_id: str, user: dict = Depends(get_admin_user), request: Request = None):
    await db.announcements.delete_one({"id": announcement_id})
    
    ip = get_client_ip(request)
    await log_activity(user['id'], user['username'], "delete_announcement", f"Duyuru silindi", ip)
    
    return {"message": "Duyuru silindi"}

@api_router.get("/admin/logs")
async def get_activity_logs(user: dict = Depends(get_admin_user)):
    logs = await db.activity_logs.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    return logs

@api_router.get("/categories")
async def get_public_categories():
    categories = await db.categories.find({}, {"_id": 0}).to_list(100)
    return categories

# Include router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

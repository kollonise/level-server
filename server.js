// Загружаем переменные из .env (только для локальной разработки)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ КОНФИГУРАЦИЯ GIST ============
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

// Проверяем, что переменные заданы
if (!GITHUB_TOKEN || !GIST_ID) {
  console.error('❌ ERROR: GITHUB_TOKEN and GIST_ID must be set in environment variables!');
  console.error('   Local: create .env file with these variables');
  console.error('   Render: add them in Environment settings');
  process.exit(1);
}

console.log(`✅ Gist storage configured (ID: ${GIST_ID.substring(0, 8)}...)`);

// ... остальной код без изменений

// Middleware
app.use(cors());
app.use(express.json());

// Настройка multer для временного хранения (в памяти)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Кэш данных
let cachedLevels = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000; // 1 минута

// ============ ФУНКЦИИ ДЛЯ РАБОТЫ С GIST ============

async function fetchGist() {
  const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Level-Server'
    }
  });
  
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }
  
  return await response.json();
}

async function readDatabase() {
  // Проверяем кэш
  const now = Date.now();
  if (cachedLevels && (now - lastFetchTime) < CACHE_TTL) {
    return cachedLevels;
  }
  
  try {
    const gist = await fetchGist();
    const dbFile = gist.files['levels_database.json'];
    
    if (!dbFile) {
      return { levels: [] };
    }
    
    const content = JSON.parse(dbFile.content);
    cachedLevels = content;
    lastFetchTime = now;
    
    console.log(`📖 Read database: ${content.levels.length} levels`);
    return content;
  } catch (error) {
    console.error('Error reading database:', error);
    return cachedLevels || { levels: [] };
  }
}

async function writeDatabase(data) {
  try {
    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Level-Server'
      },
      body: JSON.stringify({
        files: {
          'levels_database.json': {
            content: JSON.stringify(data, null, 2)
          }
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    cachedLevels = data;
    lastFetchTime = Date.now();
    
    console.log(`💾 Saved database: ${data.levels.length} levels`);
    return true;
  } catch (error) {
    console.error('Error writing database:', error);
    return false;
  }
}

async function uploadLevelFile(filename, content) {
  try {
    // Создаем отдельный gist для файла уровня
    const response = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Level-Server'
      },
      body: JSON.stringify({
        description: `Level: ${filename}`,
        public: false,
        files: {
          [filename]: {
            content: content
          }
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const gist = await response.json();
    const fileGistId = gist.id;
    
    // Получаем raw URL
    const rawUrl = gist.files[filename].raw_url;
    
    console.log(`📤 Uploaded level file: ${filename} -> ${fileGistId}`);
    return { fileGistId, rawUrl };
  } catch (error) {
    console.error('Error uploading level file:', error);
    throw error;
  }
}

async function downloadLevelFile(fileGistId, filename) {
  try {
    const response = await fetch(`https://api.github.com/gists/${fileGistId}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Level-Server'
      }
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    const gist = await response.json();
    const file = gist.files[filename];
    
    if (!file) {
      throw new Error('File not found in gist');
    }
    
    return file.content;
  } catch (error) {
    console.error('Error downloading level file:', error);
    throw error;
  }
}

async function deleteLevelFile(fileGistId) {
  try {
    const response = await fetch(`https://api.github.com/gists/${fileGistId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Level-Server'
      }
    });
    
    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    console.log(`🗑️ Deleted level gist: ${fileGistId}`);
    return true;
  } catch (error) {
    console.error('Error deleting level file:', error);
    return false;
  }
}

// ============ API ENDPOINTS ============

// Получить список уровней
app.get('/api/levels', async (req, res) => {
  try {
    const db = await readDatabase();
    const { limit = 50, offset = 0, sort = 'created_at' } = req.query;
    
    let levels = [...db.levels];
    
    // Сортировка
    if (sort === 'created_at') {
      levels.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else if (sort === 'downloads') {
      levels.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else if (sort === 'name') {
      levels.sort((a, b) => a.name.localeCompare(b.name));
    }
    
    // Пагинация
    const paginated = levels.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    // Убираем технические поля
    const response = paginated.map(l => ({
      id: l.id,
      name: l.name,
      author: l.author,
      description: l.description,
      size: l.size,
      objects_count: l.objects_count,
      downloads: l.downloads || 0,
      created_at: l.created_at
    }));
    
    res.json({
      levels: response,
      total: db.levels.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('GET /levels error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получить информацию об уровне
app.get('/api/levels/:id', async (req, res) => {
  try {
    const db = await readDatabase();
    const level = db.levels.find(l => l.id === req.params.id);
    
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }
    
    // Не отправляем fileGistId клиенту
    const { fileGistId, ...safeLevel } = level;
    res.json(safeLevel);
  } catch (error) {
    console.error('GET /levels/:id error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Скачать уровень
app.get('/api/levels/:id/download', async (req, res) => {
  try {
    const db = await readDatabase();
    const level = db.levels.find(l => l.id === req.params.id);
    
    if (!level) {
      return res.status(404).json({ error: 'Level not found' });
    }
    
    const content = await downloadLevelFile(level.fileGistId, level.filename);
    
    // Увеличиваем счетчик
    level.downloads = (level.downloads || 0) + 1;
    await writeDatabase(db);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${level.name}.mylevel"`);
    res.send(content);
  } catch (error) {
    console.error('GET /levels/:id/download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Загрузить уровень
app.post('/api/levels/upload', upload.single('levelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const id = uuidv4();
    const { name = 'Untitled', author = 'Anonymous', description = '' } = req.body;
    
    const content = req.file.buffer.toString('utf-8');
    
    let objectsCount = 0;
    let levelName = name;
    
    try {
      const levelData = JSON.parse(content);
      objectsCount = levelData.objects?.length || 0;
      levelName = levelData.levelName || levelName;
    } catch (e) {
      console.warn('Could not parse JSON:', e.message);
    }
    
    const filename = `${id}.mylevel`;
    
    // Загружаем файл уровня в отдельный gist
    const { fileGistId } = await uploadLevelFile(filename, content);
    
    const newLevel = {
      id,
      name: levelName,
      author,
      description,
      filename,
      fileGistId,
      size: req.file.size,
      objects_count: objectsCount,
      downloads: 0,
      created_at: new Date().toISOString()
    };
    
    const db = await readDatabase();
    db.levels.push(newLevel);
    await writeDatabase(db);
    
    console.log(`✅ Level uploaded: ${levelName} (${id})`);
    
    res.json({
      id,
      name: levelName,
      message: 'Level uploaded successfully'
    });
  } catch (error) {
    console.error('POST /upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Удалить уровень
app.delete('/api/levels/:id', async (req, res) => {
  try {
    const db = await readDatabase();
    const index = db.levels.findIndex(l => l.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Level not found' });
    }
    
    const level = db.levels[index];
    
    // Удаляем gist с файлом
    await deleteLevelFile(level.fileGistId);
    
    // Удаляем из базы
    db.levels.splice(index, 1);
    await writeDatabase(db);
    
    res.json({ message: 'Level deleted successfully' });
  } catch (error) {
    console.error('DELETE /levels/:id error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Статистика
app.get('/api/stats', async (req, res) => {
  try {
    const db = await readDatabase();
    
    const stats = {
      total_levels: db.levels.length,
      total_size: db.levels.reduce((sum, l) => sum + (l.size || 0), 0),
      total_downloads: db.levels.reduce((sum, l) => sum + (l.downloads || 0), 0),
      total_objects: db.levels.reduce((sum, l) => sum + (l.objects_count || 0), 0)
    };
    
    res.json(stats);
  } catch (error) {
    console.error('GET /stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Корневая страница
app.get('/', async (req, res) => {
  try {
    const db = await readDatabase();
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Level Server (Gist Storage)</title>
        <style>
          body { font-family: Arial; max-width: 800px; margin: 50px auto; padding: 20px; }
          h1 { color: #333; }
          .badge { background: #4CAF50; color: white; padding: 5px 10px; border-radius: 20px; }
          ul { background: #f5f5f5; padding: 20px; border-radius: 5px; }
          li { margin: 10px 0; }
          code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
          .stats { background: #e8f5e9; padding: 15px; border-radius: 5px; margin-top: 20px; }
          .level { background: white; padding: 10px; margin: 5px 0; border-radius: 5px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        </style>
      </head>
      <body>
        <h1>🎮 Level Server <span class="badge">Gist Storage</span></h1>
        <p>Total levels: <strong>${db.levels.length}</strong></p>
        
        <h2>API Endpoints:</h2>
        <ul>
          <li><code>GET /api/levels</code> - List all levels</li>
          <li><code>GET /api/levels/:id</code> - Get level info</li>
          <li><code>GET /api/levels/:id/download</code> - Download level</li>
          <li><code>POST /api/levels/upload</code> - Upload level</li>
          <li><code>DELETE /api/levels/:id</code> - Delete level</li>
          <li><code>GET /api/stats</code> - Server statistics</li>
        </ul>
        
        <div class="stats">
          <h3>Recent Levels:</h3>
          ${db.levels.slice(-5).reverse().map(l => 
            `<div class="level">
              📦 <strong>${l.name}</strong> by ${l.author}<br>
              <small>${l.objects_count} objects | ${(l.size / 1024).toFixed(1)} KB | ⬇️ ${l.downloads || 0}</small>
            </div>`
          ).join('') || '<p>No levels yet. Upload one!</p>'}
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.send('<h1>Error loading database</h1>');
  }
});

// Запуск
app.listen(PORT, () => {
  console.log(`\n🚀 Level Server running on port ${PORT}`);
  console.log(`📦 Storage: GitHub Gist (ID: ${GIST_ID.substring(0, 8)}...)`);
  console.log(`💾 Database file: levels_database.json\n`);
});
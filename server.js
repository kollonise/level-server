const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Папки для хранения
const UPLOADS_DIR = process.env.RENDER ? path.join('/tmp', 'uploads') : 'uploads';
const DATA_FILE = path.join(UPLOADS_DIR, 'levels_data.json');

// Загружаем данные при старте
let levelsData = { levels: [] };

async function loadData() {
  try {
    await fs.mkdir(path.join(UPLOADS_DIR, 'levels'), { recursive: true });
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    levelsData = JSON.parse(data);
    console.log(`Loaded ${levelsData.levels.length} levels from storage`);
  } catch (error) {
    levelsData = { levels: [] };
    console.log('Starting with empty levels storage');
  }
}

async function saveData() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(levelsData, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Настройка multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(UPLOADS_DIR, 'levels');
    await fs.mkdir(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const id = uuidv4();
    cb(null, `${id}.mylevel`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ============ API Endpoints ============

// Получить список всех уровней
app.get('/api/levels', (req, res) => {
  const { limit = 50, offset = 0, sort = 'created_at' } = req.query;
  
  let sortedLevels = [...levelsData.levels];
  
  // Сортировка
  if (sort === 'created_at') {
    sortedLevels.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } else if (sort === 'downloads') {
    sortedLevels.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  } else if (sort === 'name') {
    sortedLevels.sort((a, b) => a.name.localeCompare(b.name));
  }
  
  // Пагинация
  const paginated = sortedLevels.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  // Убираем лишние поля для ответа
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
    total: levelsData.levels.length,
    limit: parseInt(limit),
    offset: parseInt(offset)
  });
});

// Получить информацию о конкретном уровне
app.get('/api/levels/:id', (req, res) => {
  const { id } = req.params;
  const level = levelsData.levels.find(l => l.id === id);
  
  if (!level) {
    return res.status(404).json({ error: 'Level not found' });
  }
  
  res.json(level);
});

// Скачать файл уровня
app.get('/api/levels/:id/download', async (req, res) => {
  const { id } = req.params;
  const level = levelsData.levels.find(l => l.id === id);
  
  if (!level) {
    return res.status(404).json({ error: 'Level not found' });
  }
  
  const filePath = path.join(UPLOADS_DIR, 'levels', level.filename);
  
  try {
    await fs.access(filePath);
    
    // Увеличиваем счетчик
    level.downloads = (level.downloads || 0) + 1;
    await saveData();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${level.name}.mylevel"`);
    
    const content = await fs.readFile(filePath, 'utf-8');
    res.send(content);
  } catch (error) {
    res.status(404).json({ error: 'File not found on server' });
  }
});

// Загрузить новый уровень
app.post('/api/levels/upload', upload.single('levelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const id = path.basename(req.file.filename, '.mylevel');
    const { name = 'Untitled', author = 'Anonymous', description = '' } = req.body;
    
    let objectsCount = 0;
    let levelName = name;
    
    try {
      const content = await fs.readFile(req.file.path, 'utf-8');
      const levelData = JSON.parse(content);
      objectsCount = levelData.objects?.length || 0;
      levelName = levelData.levelName || levelName;
    } catch (e) {
      console.warn('Could not parse JSON:', e.message);
    }
    
    const newLevel = {
      id,
      name: levelName,
      author,
      description,
      filename: req.file.filename,
      size: req.file.size,
      objects_count: objectsCount,
      downloads: 0,
      created_at: new Date().toISOString()
    };
    
    levelsData.levels.push(newLevel);
    await saveData();
    
    console.log(`Level uploaded: ${levelName} (${id})`);
    
    res.json({
      id,
      name: levelName,
      message: 'Level uploaded successfully',
      url: `/api/levels/${id}/download`
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Удалить уровень
app.delete('/api/levels/:id', async (req, res) => {
  const { id } = req.params;
  const index = levelsData.levels.findIndex(l => l.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Level not found' });
  }
  
  const level = levelsData.levels[index];
  const filePath = path.join(UPLOADS_DIR, 'levels', level.filename);
  
  try {
    await fs.unlink(filePath);
  } catch (e) {
    console.warn('File already deleted:', e.message);
  }
  
  levelsData.levels.splice(index, 1);
  await saveData();
  
  res.json({ message: 'Level deleted successfully' });
});

// Статистика
app.get('/api/stats', (req, res) => {
  const totalLevels = levelsData.levels.length;
  const totalSize = levelsData.levels.reduce((sum, l) => sum + (l.size || 0), 0);
  const totalDownloads = levelsData.levels.reduce((sum, l) => sum + (l.downloads || 0), 0);
  const totalObjects = levelsData.levels.reduce((sum, l) => sum + (l.objects_count || 0), 0);
  
  res.json({
    total_levels: totalLevels,
    total_size: totalSize,
    total_downloads: totalDownloads,
    total_objects: totalObjects
  });
});

// Корневая страница
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Level Server</title>
      <style>
        body { font-family: Arial; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        ul { background: #f5f5f5; padding: 20px; border-radius: 5px; }
        li { margin: 10px 0; }
        code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
        .stats { background: #e8f5e9; padding: 15px; border-radius: 5px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <h1>🎮 Level Server is Running!</h1>
      <p>Total levels: <strong>${levelsData.levels.length}</strong></p>
      
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
        ${levelsData.levels.slice(-5).reverse().map(l => 
          `<p>📦 <strong>${l.name}</strong> by ${l.author} (${l.objects_count} objects)</p>`
        ).join('') || '<p>No levels yet. Upload one!</p>'}
      </div>
    </body>
    </html>
  `);
});

// Запуск
async function start() {
  await loadData();
  
  app.listen(PORT, () => {
    console.log(`\n🚀 Level Server running on port ${PORT}`);
    console.log(`📁 Storage: ${path.join(UPLOADS_DIR, 'levels')}`);
    console.log(`💾 Data file: ${DATA_FILE}`);
    console.log(`📊 Total levels: ${levelsData.levels.length}\n`);
  });
}

start();
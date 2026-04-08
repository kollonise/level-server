const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const fs = require('fs').promises;
const path = require('path');

const UPLOADS_DIR = process.env.RENDER ? '/tmp/uploads' : 'uploads';
const DB_PATH = process.env.RENDER ? '/tmp/levels.db' : 'levels.db';

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(path.join(UPLOADS_DIR, 'levels'), { recursive: true });
    cb(null, path.join(UPLOADS_DIR, 'levels'));
  },
  filename: (req, file, cb) => {
    const id = uuidv4();
    cb(null, `${id}.mylevel`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS levels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT,
      description TEXT,
      filename TEXT NOT NULL,
      size INTEGER,
      objects_count INTEGER,
      downloads INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ============ API Endpoints ============

// Получить список всех уровней
app.get('/api/levels', (req, res) => {
  const { limit = 50, offset = 0, sort = 'created_at' } = req.query;
  
  db.all(
    `SELECT id, name, author, description, size, objects_count, downloads, created_at 
     FROM levels 
     ORDER BY ${sort} DESC 
     LIMIT ? OFFSET ?`,
    [parseInt(limit), parseInt(offset)],
    (err, rows) => {
      if (err) {
        console.error('Ошибка получения списка:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      db.get('SELECT COUNT(*) as total FROM levels', (err, count) => {
        res.json({
          levels: rows,
          total: count.total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      });
    }
  );
});

// Получить информацию о конкретном уровне
app.get('/api/levels/:id', (req, res) => {
  const { id } = req.params;
  
  db.get(
    'SELECT * FROM levels WHERE id = ?',
    [id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Level not found' });
      }
      
      res.json(row);
    }
  );
});

// Скачать файл уровня
app.get('/api/levels/:id/download', async (req, res) => {
  const { id } = req.params;
  
  db.get(
    'SELECT filename, name FROM levels WHERE id = ?',
    [id],
    async (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Level not found' });
      }
      
      const filePath = path.join('uploads/levels', row.filename);
      
      try {
        await fs.access(filePath);
        
        // Увеличиваем счетчик скачиваний
        db.run('UPDATE levels SET downloads = downloads + 1 WHERE id = ?', [id]);
        
        res.download(filePath, `${row.name}.mylevel`);
      } catch {
        res.status(404).json({ error: 'File not found on server' });
      }
    }
  );
});

// Загрузить новый уровень (с файлом)
app.post('/api/levels/upload', upload.single('levelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const id = path.basename(req.file.filename, '.mylevel');
    const { name, author, description } = req.body;
    
    // Читаем JSON чтобы получить количество объектов
    let objectsCount = 0;
    let levelName = name || 'Untitled';
    
    try {
      const content = await fs.readFile(req.file.path, 'utf-8');
      const levelData = JSON.parse(content);
      objectsCount = levelData.objects?.length || 0;
      levelName = levelData.levelName || levelName;
    } catch (e) {
      console.warn('Не удалось прочитать JSON:', e.message);
    }
    
    // Сохраняем в БД
    db.run(
      `INSERT INTO levels (id, name, author, description, filename, size, objects_count) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, levelName, author, description, req.file.filename, req.file.size, objectsCount],
      (err) => {
        if (err) {
          console.error('Ошибка сохранения в БД:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({
          id: id,
          name: levelName,
          message: 'Level uploaded successfully',
          url: `/api/levels/${id}/download`
        });
      }
    );
  } catch (error) {
    console.error('Ошибка загрузки:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Удалить уровень
app.delete('/api/levels/:id', async (req, res) => {
  const { id } = req.params;
  
  db.get(
    'SELECT filename FROM levels WHERE id = ?',
    [id],
    async (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Level not found' });
      }
      
      // Удаляем файл
      const filePath = path.join('uploads/levels', row.filename);
      try {
        await fs.unlink(filePath);
      } catch (e) {
        console.warn('Файл уже удален:', e.message);
      }
      
      // Удаляем из БД
      db.run('DELETE FROM levels WHERE id = ?', [id], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({ message: 'Level deleted' });
      });
    }
  );
});

// Статистика сервера
app.get('/api/stats', (req, res) => {
  db.get(`
    SELECT 
      COUNT(*) as total_levels,
      SUM(size) as total_size,
      SUM(downloads) as total_downloads,
      SUM(objects_count) as total_objects
    FROM levels
  `, (err, stats) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    
    res.json(stats);
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`\n🚀 Сервер уровней запущен на http://localhost:${PORT}`);
  console.log(`📁 Файлы хранятся в: ${path.resolve('uploads/levels')}`);
  console.log(`💾 База данных: ${path.resolve('levels.db')}`);
  console.log('\n📋 Доступные endpoint-ы:');
  console.log(`   GET    /api/levels              - список уровней`);
  console.log(`   GET    /api/levels/:id          - информация об уровне`);
  console.log(`   GET    /api/levels/:id/download - скачать уровень`);
  console.log(`   POST   /api/levels/upload       - загрузить уровень`);
  console.log(`   DELETE /api/levels/:id          - удалить уровень`);
  console.log(`   GET    /api/stats               - статистика`);
  console.log('\n🌐 Веб-интерфейс: http://localhost:3000\n');
});
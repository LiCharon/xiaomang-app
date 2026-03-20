const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// MongoDB Atlas 连接字符串
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://2146986718_db_user:***REMOVED-CREDENTIAL***@cluster0.k9bodbs.mongodb.net/ai-project-assistant?appName=Cluster0';

// 中间件
app.use(cors());
app.use(express.json());

// MongoDB 连接
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB 连接成功'))
  .catch(err => console.error('❌ MongoDB 连接失败:', err.message));

// 路由
const authRoutes = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
const employeeRoutes = require('./routes/employees');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const aiRoutes = require('./routes/ai');

app.use('/api/auth', authRoutes);
app.use('/api/employees', authMiddleware, employeeRoutes);
app.use('/api/projects', authMiddleware, projectRoutes);
app.use('/api/tasks', authMiddleware, taskRoutes);
app.use('/api/ai', authMiddleware, aiRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    mode: 'mongodb',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
});

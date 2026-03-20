const express = require('express');
const cors = require('cors');
require('dotenv').config();

const mongoose = require('mongoose');
const { connectToDatabase } = require('./lib/db');

const authRoutes = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
const employeeRoutes = require('./routes/employees');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const aiRoutes = require('./routes/ai');

const app = express();

app.use(cors());
app.use(express.json());

app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/employees', authMiddleware, employeeRoutes);
app.use('/api/projects', authMiddleware, projectRoutes);
app.use('/api/tasks', authMiddleware, taskRoutes);
app.use('/api/ai', authMiddleware, aiRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mode: 'mongodb',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error('Unhandled server error:', error);
  return res.status(500).json({
    error: error.message || 'Internal server error'
  });
});

module.exports = app;

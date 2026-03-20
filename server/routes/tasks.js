const express = require('express');
const router = express.Router();
const Task = require('../models/Task');

// 获取所有任务
router.get('/', async (req, res) => {
  try {
    const { employeeId, projectId, status, date } = req.query;
    const filter = {};
    
    if (employeeId) filter.ownerId = employeeId;
    if (projectId) filter.platformName = projectId;
    if (status) filter.status = status;
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      filter['collaborationPeriod.start'] = { $lte: endOfDay };
      filter['collaborationPeriod.end'] = { $gte: startOfDay };
    }
    
    const tasks = await Task.find(filter)
      .populate('ownerId', 'name email department')
      .sort({ 'collaborationPeriod.start': 1, createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个任务
router.get('/:id', async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('ownerId', 'name email department');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建任务
router.post('/', async (req, res) => {
  try {
    const task = new Task(req.body);
    await task.save();
    const populated = await Task.findById(task._id)
      .populate('ownerId', 'name email department');
    res.status(201).json(populated);
  } catch (err) {
    console.error('创建任务失败:', err);
    res.status(400).json({
      error: err.message,
      details: err.errors || null
    });
  }
});

// 批量创建任务
router.post('/batch', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: '请提供任务数组' });
    }
    const createdTasks = await Task.insertMany(tasks);
    const ids = createdTasks.map(task => task._id);
    const populated = await Task.find({ _id: { $in: ids } })
      .populate('ownerId', 'name email department');
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 更新任务
router.put('/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    )
      .populate('ownerId', 'name email department');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除任务
router.delete('/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ message: '任务已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取今日任务（按员工分组）
router.get('/today/grouped', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const tasks = await Task.find({
      'collaborationPeriod.start': { $lte: tomorrow },
      'collaborationPeriod.end': { $gte: today }
    })
      .populate('ownerId', 'name email department')
      .sort({ ownerId: 1, 'collaborationPeriod.start': 1 });
    
    // 按负责人分组
    const grouped = {};
    tasks.forEach(task => {
      const ownerKey = task.ownerId?._id?.toString() || 'unknown';
      if (!grouped[ownerKey]) {
        grouped[ownerKey] = {
          employee: task.ownerId,
          tasks: []
        };
      }
      grouped[ownerKey].tasks.push(task);
    });
    
    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

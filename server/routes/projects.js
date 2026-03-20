const express = require('express');
const router = express.Router();
const Project = require('../models/Project');

// 获取所有项目
router.get('/', async (req, res) => {
  try {
    const projects = await Project.find()
      .populate('managerId', 'name email')
      .sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个项目
router.get('/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('managerId', 'name email');
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建项目
router.post('/', async (req, res) => {
  try {
    const project = new Project(req.body);
    await project.save();
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 更新项目
router.put('/:id', async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除项目
router.delete('/:id', async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ message: '项目已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

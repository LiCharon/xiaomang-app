const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

// 获取所有员工
router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个员工
router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: '员工不存在' });
    res.json(employee);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建员工
router.post('/', async (req, res) => {
  try {
    const employee = new Employee(req.body);
    await employee.save();
    res.status(201).json(employee);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 更新员工
router.put('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!employee) return res.status(404).json({ error: '员工不存在' });
    res.json(employee);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除员工
router.delete('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return res.status(404).json({ error: '员工不存在' });
    res.json({ message: '员工已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

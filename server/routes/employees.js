const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

function isManager(user) {
  if (!user) return false;
  if (user.role === 'manager' || user.isAdmin === true) return true;

  const managerEmails = String(process.env.MANAGER_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (managerEmails.length === 0) {
    return true;
  }

  return managerEmails.includes(String(user.email || '').toLowerCase());
}

function ensureManager(req, res, next) {
  if (!isManager(req.user)) {
    return res.status(403).json({ error: '仅经理可操作员工管理' });
  }
  next();
}

router.use(ensureManager);

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

// 创建员工（写入 employees 集合）
router.post('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const account = String(req.body.account || '').trim();
    const password = String(req.body.password || '').trim();

    if (!name || !account || !password) {
      return res.status(400).json({ error: 'name、account、password 均为必填项' });
    }

    const exists = await Employee.findOne({ account });
    if (exists) {
      return res.status(409).json({ error: '该账号已存在' });
    }

    const employee = await Employee.create({
      name,
      account,
      password,
      status: 'active'
    });

    res.status(201).json(employee);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 更新员工
router.put('/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = String(req.body.name || '').trim();
    if (req.body.account !== undefined) updates.account = String(req.body.account || '').trim();
    if (req.body.password !== undefined) updates.password = String(req.body.password || '').trim();
    if (req.body.status !== undefined) updates.status = String(req.body.status || '').trim();

    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
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

const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');

function normalizePayload(body) {
  return {
    name: String(body.name || '').trim(),
    occupation: String(body.occupation || '').trim(),
    contact: String(body.contact || '').trim(),
    ipPositioning: String(body.ipPositioning || '').trim(),
    contentNeeds: String(body.contentNeeds || '').trim(),
    benchmarkAccounts: String(body.benchmarkAccounts || '').trim(),
    notes: String(body.notes || '').trim()
  };
}

router.get('/', async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: '客户名称必填' });
    }
    const customer = await Customer.create(payload);
    res.status(201).json(customer);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: '客户名称已存在，请勿重复创建' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: '客户名称必填' });
    }
    const customer = await Customer.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true
    });
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json(customer);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: '客户名称已存在，请更换名称' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    res.json({ message: '客户已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

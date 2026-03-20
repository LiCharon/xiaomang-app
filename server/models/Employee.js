const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  account: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['active', 'disabled'],
    default: 'active'
  },
  // 兼容历史字段
  email: { type: String, default: '', trim: true },
  department: { type: String, default: '', trim: true },
  avatar: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Employee', employeeSchema);

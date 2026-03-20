const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  contact: { type: String, default: '' },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  platformName: { type: String, required: true },
  collaborationPeriod: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  notes: { type: String, default: '' },
  contentRequirements: { type: [String], default: [] },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed'],
    default: 'pending'
  },
  aiAnalysis: { type: String, default: '' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Task', taskSchema);

const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: { type: String, required: true, trim: true },
  customerOccupation: { type: String, default: '', trim: true },
  contact: { type: String, default: '', trim: true },
  ipPositioning: { type: String, default: '', trim: true },
  contentDirection: { type: String, default: '', trim: true },
  benchmarkAccounts: { type: String, default: '', trim: true },
  notes: { type: String, default: '', trim: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  platformName: { type: String, required: true },
  collaborationPeriod: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
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

taskSchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('Task', taskSchema);

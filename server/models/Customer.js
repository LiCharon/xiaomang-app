const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  occupation: { type: String, default: '', trim: true },
  contact: { type: String, default: '', trim: true },
  ipPositioning: { type: String, default: '', trim: true },
  contentNeeds: { type: String, default: '', trim: true },
  benchmarkAccounts: { type: String, default: '', trim: true },
  notes: { type: String, default: '', trim: true },
  createdAt: { type: Date, default: Date.now }
});

customerSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Customer', customerSchema);

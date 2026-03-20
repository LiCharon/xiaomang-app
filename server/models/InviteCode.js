const mongoose = require('mongoose');

const inviteCodeSchema = new mongoose.Schema({
  codeHash: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['manager'],
    default: 'manager'
  },
  status: {
    type: String,
    enum: ['active', 'disabled', 'exhausted'],
    default: 'active'
  },
  maxUses: {
    type: Number,
    default: 1,
    min: 1
  },
  usedCount: {
    type: Number,
    default: 0,
    min: 0
  },
  expiresAt: {
    type: Date,
    default: null
  },
  note: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

inviteCodeSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('InviteCode', inviteCodeSchema);

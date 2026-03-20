require('dotenv').config();
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const InviteCode = require('../models/InviteCode');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function run() {
  const plainCode = String(process.argv[2] || '').trim();
  const maxUsesInput = Number(process.argv[3] || 1);
  const daysInput = Number(process.argv[4] || 30);

  if (!plainCode) {
    throw new Error('请传入邀请码明文：node scripts/create-manager-invite-code.js <code> [maxUses=1] [expireDays=30]');
  }

  if (!MONGO_URI) {
    throw new Error('未配置 MONGO_URI / MONGODB_URI');
  }

  await mongoose.connect(MONGO_URI);

  const codeHash = await bcrypt.hash(plainCode, 10);
  const expiresAt = Number.isFinite(daysInput) && daysInput > 0
    ? new Date(Date.now() + daysInput * 24 * 60 * 60 * 1000)
    : null;

  const invite = await InviteCode.create({
    codeHash,
    type: 'manager',
    status: 'active',
    maxUses: Number.isFinite(maxUsesInput) && maxUsesInput > 0 ? Math.floor(maxUsesInput) : 1,
    usedCount: 0,
    expiresAt,
    note: 'manager register invite code'
  });

  console.log('✅ 邀请码已创建');
  console.log('id:', invite._id.toString());
  console.log('maxUses:', invite.maxUses);
  console.log('expiresAt:', invite.expiresAt ? invite.expiresAt.toISOString() : 'never');

  await mongoose.disconnect();
}

run()
  .catch(async (error) => {
    console.error('❌ 创建邀请码失败:', error.message);
    try {
      await mongoose.disconnect();
    } catch (_err) {
      // ignore
    }
    process.exit(1);
  });

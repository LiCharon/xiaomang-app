const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const InviteCode = require('../models/InviteCode');

const router = express.Router();
const TOKEN_EXPIRES_IN = '7d';
const LEGACY_MANAGER_INVITE_CODE = String(process.env.MANAGER_INVITE_CODE || '').trim();

function getJwtSecretOrSendError(res) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(500).json({ error: '服务端缺少 JWT_SECRET 配置' });
    return null;
  }
  return jwtSecret;
}

function signToken(user, jwtSecret) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email
    },
    jwtSecret,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

function sanitizeUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function isInviteCodeExpired(inviteCode) {
  if (!inviteCode?.expiresAt) return false;
  return new Date(inviteCode.expiresAt).getTime() < Date.now();
}

async function verifyAndConsumeInviteCode(rawInviteCode) {
  const plainCode = String(rawInviteCode || '').trim();
  if (!plainCode) {
    return { valid: false, status: 400, error: '邀请码不能为空' };
  }

  const candidates = await InviteCode.find({
    type: 'manager',
    status: 'active'
  }).sort({ createdAt: -1 });

  for (const item of candidates) {
    const matched = await bcrypt.compare(plainCode, item.codeHash);
    if (!matched) continue;

    if (isInviteCodeExpired(item)) {
      item.status = 'disabled';
      await item.save();
      return { valid: false, status: 403, error: '邀请码已过期' };
    }

    if (item.usedCount >= item.maxUses) {
      item.status = 'exhausted';
      await item.save();
      return { valid: false, status: 403, error: '邀请码已失效' };
    }

    item.usedCount += 1;
    if (item.usedCount >= item.maxUses) {
      item.status = 'exhausted';
    }
    await item.save();

    return { valid: true };
  }

  if (LEGACY_MANAGER_INVITE_CODE && plainCode === LEGACY_MANAGER_INVITE_CODE) {
    return { valid: true };
  }

  return { valid: false, status: 403, error: '邀请码无效' };
}

router.post('/register', async (req, res) => {
  try {
    const jwtSecret = getJwtSecretOrSendError(res);
    if (!jwtSecret) return;

    const { name, email, password, inviteCode } = req.body;

    if (!name || !email || !password || !inviteCode) {
      return res.status(400).json({ error: '姓名、邮箱、密码和邀请码均为必填项' });
    }

    const inviteResult = await verifyAndConsumeInviteCode(inviteCode);
    if (!inviteResult.valid) {
      return res.status(inviteResult.status || 403).json({ error: inviteResult.error || '邀请码无效' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度不能少于 6 位' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash
    });

    const token = signToken(user, jwtSecret);
    return res.status(201).json({
      message: '注册成功',
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const jwtSecret = getJwtSecretOrSendError(res);
    if (!jwtSecret) return;

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const token = signToken(user, jwtSecret);
    res.json({
      message: '登录成功',
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  try {
    const jwtSecret = getJwtSecretOrSendError(res);
    if (!jwtSecret) return;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ error: '未登录' });
    }

    const payload = jwt.verify(token, jwtSecret);
    const user = await User.findById(payload.userId);
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
});

module.exports = router;

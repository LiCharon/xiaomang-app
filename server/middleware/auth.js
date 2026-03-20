const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || '***REMOVED-JWT-SECRET***';

module.exports = async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return res.status(401).json({ error: '未授权访问，请先登录' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.userId).select('-passwordHash');

    if (!user) {
      return res.status(401).json({ error: '登录用户不存在' });
    }

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: '登录已失效，请重新登录' });
  }
};

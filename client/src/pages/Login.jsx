import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';

const DEFAULT_INVITE_CODE = '';

function Login({ onAuthSuccess }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login'); // login | invite-register
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    inviteCode: DEFAULT_INVITE_CODE
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const redirectTo = location.state?.from?.pathname || '/';

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError('');
  };

  const handleLogin = async () => {
    const response = await authAPI.login({
      email: formData.email,
      password: formData.password
    });
    onAuthSuccess(response.data);
    navigate(redirectTo, { replace: true });
  };

  const handleInviteRegister = async () => {
    const response = await authAPI.register({
      name: formData.name,
      email: formData.email,
      password: formData.password,
      inviteCode: formData.inviteCode
    });
    onAuthSuccess(response.data);
    navigate(redirectTo, { replace: true });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      if (mode === 'invite-register') {
        await handleInviteRegister();
      } else {
        await handleLogin();
      }
    } catch (err) {
      setError(err.response?.data?.error || '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-shell">
        <div className="auth-showcase">
          <div className="auth-chip">Project OS</div>
          <h1 className="auth-showcase-title">让项目管理回归清晰与秩序。</h1>
          <p className="auth-showcase-text">
            统一管理任务、员工与项目，界面更克制，信息更聚焦，操作路径保持顺手。
          </p>
          <div className="auth-showcase-list">
            <div>轻量任务管理</div>
            <div>统一项目视图</div>
            <div>团队成员协作</div>
          </div>
        </div>

        <div className="auth-card">
          <div className="auth-heading">{mode === 'invite-register' ? '邀请码注册' : '登录'}</div>
          <div className="auth-subheading">
            {mode === 'invite-register' ? '输入邀请码后自动注册并登录' : '使用经理账号进入工作台'}
          </div>

          {error && <div className="error-message">{error}</div>}

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === 'invite-register' && (
              <div className="form-group">
                <label className="form-label form-label-required">姓名</label>
                <input
                  className="form-input"
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="请输入姓名"
                  required
                  autoFocus
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label form-label-required">邮箱</label>
              <input
                className="form-input"
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="you@example.com"
                required
                autoFocus={mode !== 'invite-register'}
              />
            </div>

            <div className="form-group">
              <label className="form-label form-label-required">密码</label>
              <input
                className="form-input"
                type="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                placeholder="请输入密码"
                required
              />
            </div>

            {mode === 'invite-register' && (
              <div className="form-group">
                <label className="form-label form-label-required">邀请码</label>
                <input
                  className="form-input"
                  type="text"
                  name="inviteCode"
                  value={formData.inviteCode}
                  onChange={handleChange}
                  placeholder="请输入邀请码"
                  required
                />
              </div>
            )}

            <div className="auth-actions">
              <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
                {loading
                  ? (mode === 'invite-register' ? '注册并登录中...' : '登录中...')
                  : (mode === 'invite-register' ? '注册并登录' : '登录')}
              </button>
            </div>
          </form>

          <div className="auth-footer-note" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>
              {mode === 'invite-register'
                ? '已有账号？直接登录'
                : '没有账号？可用邀请码自动注册'}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setError('');
                setMode(mode === 'invite-register' ? 'login' : 'invite-register');
              }}
            >
              {mode === 'invite-register' ? '切换登录' : '邀请码注册'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;

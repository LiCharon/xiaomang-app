import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';

function Login({ onAuthSuccess }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const redirectTo = location.state?.from?.pathname || '/';

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await authAPI.login(formData);
      onAuthSuccess(response.data);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || '登录失败，请重试');
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
          <div className="auth-heading">登录</div>
          <div className="auth-subheading">使用你的账号进入工作台</div>

          {error && <div className="error-message">{error}</div>}

          <form className="auth-form" onSubmit={handleSubmit}>
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
                autoFocus
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

            <div className="auth-actions">
              <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
                {loading ? '登录中...' : '登录'}
              </button>
            </div>
          </form>

          <div className="auth-footer-note">
            还没有账号？<Link to="/register" className="auth-link">立即注册</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;

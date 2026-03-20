import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';

function Register({ onAuthSuccess }) {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (formData.password !== formData.confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    try {
      setLoading(true);
      const response = await authAPI.register({
        name: formData.name,
        email: formData.email,
        password: formData.password
      });
      onAuthSuccess(response.data);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-shell">
        <div className="auth-showcase">
          <div className="auth-chip">New Account</div>
          <h1 className="auth-showcase-title">创建一个全新的项目工作空间。</h1>
          <p className="auth-showcase-text">
            注册后即可直接进入任务、员工和项目管理页面，所有数据仍保持在同一套后端能力之上。
          </p>
          <div className="auth-showcase-list">
            <div>账号数据存入 MongoDB</div>
            <div>自动保持登录状态</div>
            <div>不影响原有业务接口</div>
          </div>
        </div>

        <div className="auth-card">
          <div className="auth-heading">注册</div>
          <div className="auth-subheading">创建你的账户并开始使用</div>

          {error && <div className="error-message">{error}</div>}

          <form className="auth-form" onSubmit={handleSubmit}>
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
                placeholder="至少 6 位"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label form-label-required">确认密码</label>
              <input
                className="form-input"
                type="password"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                placeholder="再次输入密码"
                required
              />
            </div>

            <div className="auth-actions">
              <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
                {loading ? '注册中...' : '创建账号'}
              </button>
            </div>
          </form>

          <div className="auth-footer-note">
            已有账号？<Link to="/login" className="auth-link">返回登录</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Register;

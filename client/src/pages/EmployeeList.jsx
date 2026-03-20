import React, { useState, useEffect } from 'react';
import { employeeAPI } from '../services/api';

const AVATAR_CLASSES = ['avatar-indigo', 'avatar-violet', 'avatar-pink', 'avatar-teal', 'avatar-orange'];
function getAvatarClass(name) {
  if (!name) return 'avatar-indigo';
  return AVATAR_CLASSES[name.charCodeAt(0) % AVATAR_CLASSES.length];
}

function EmployeeList() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', account: '', password: '', status: 'active' });
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchEmployees(); }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const response = await employeeAPI.getAll();
      setEmployees(response.data);
    } catch (error) {
      console.error('获取员工失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const openDrawer = (emp = null) => {
    if (emp) {
      setFormData({
        name: emp.name || '',
        account: emp.account || '',
        password: emp.password || '',
        status: emp.status || 'active'
      });
      setEditingId(emp._id);
    } else {
      setFormData({ name: '', account: '', password: '', status: 'active' });
      setEditingId(null);
    }
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
    setFormData({ name: '', account: '', password: '', status: 'active' });
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      if (editingId) {
        await employeeAPI.update(editingId, formData);
      } else {
        await employeeAPI.create(formData);
      }
      closeDrawer();
      fetchEmployees();
    } catch (error) {
      console.error('保存员工失败:', error);
      alert(error?.response?.data?.error || '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除这个员工吗？')) return;
    try {
      await employeeAPI.delete(id);
      fetchEmployees();
    } catch (error) {
      console.error('删除员工失败:', error);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">员工管理（经理入口）</h1>
          <div className="page-subtitle">在 employees 集合维护员工账号：name / account / password / status</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-primary" onClick={() => openDrawer()}>
            ＋ 添加员工
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : employees.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">👥</div>
            <p>暂无员工，点击右上角添加</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>员工</th>
                  <th>账号</th>
                  <th>状态</th>
                  <th>加入时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp._id}>
                    <td>
                      <div className="avatar-cell">
                        <div className={`avatar ${getAvatarClass(emp.name)}`}>
                          {emp.name?.[0]}
                        </div>
                        <span className="table-cell-primary">{emp.name}</span>
                      </div>
                    </td>
                    <td style={{ color: '#64748b', fontSize: '0.85rem' }}>{emp.account || '—'}</td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.6rem',
                        borderRadius: 20,
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        background: emp.status === 'active' ? '#10b98118' : '#ef444418',
                        color: emp.status === 'active' ? '#059669' : '#dc2626',
                      }}>
                        {emp.status === 'active' ? 'active' : 'disabled'}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                      {emp.createdAt ? new Date(emp.createdAt).toLocaleDateString('zh-CN') : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => openDrawer(emp)}>
                          编辑
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(emp._id)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <div className="drawer">
            <div className="drawer-header">
              <div className="drawer-title">{editingId ? '编辑员工账号' : '添加员工账号'}</div>
              <button className="drawer-close" onClick={closeDrawer}>✕</button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div className="drawer-body">
                <div className="form-group">
                  <label className="form-label form-label-required">姓名</label>
                  <input
                    type="text"
                    name="name"
                    className="form-input"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="请输入姓名"
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label form-label-required">账号（account）</label>
                  <input
                    type="text"
                    name="account"
                    className="form-input"
                    value={formData.account}
                    onChange={handleChange}
                    placeholder="请输入员工登录账号"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label form-label-required">密码</label>
                  <input
                    type="text"
                    name="password"
                    className="form-input"
                    value={formData.password}
                    onChange={handleChange}
                    placeholder="请输入密码"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">状态</label>
                  <select
                    name="status"
                    className="form-select"
                    value={formData.status}
                    onChange={handleChange}
                  >
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                  </select>
                </div>
              </div>
              <div className="drawer-footer">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : (editingId ? '保存修改' : '添加员工')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

export default EmployeeList;

import React, { useState, useEffect } from 'react';
import { employeeAPI } from '../services/api';

const AVATAR_CLASSES = ['avatar-indigo', 'avatar-violet', 'avatar-pink', 'avatar-teal', 'avatar-orange'];
function getAvatarClass(name) {
  if (!name) return 'avatar-indigo';
  return AVATAR_CLASSES[name.charCodeAt(0) % AVATAR_CLASSES.length];
}

const DEPT_COLORS = {
  '技术部': '#6366f1',
  '产品部': '#f59e0b',
  '设计部': '#ec4899',
  '运营部': '#14b8a6',
};
function deptColor(dept) {
  return DEPT_COLORS[dept] || '#94a3b8';
}

function EmployeeList() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', email: '', department: '' });
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
      setFormData({ name: emp.name, email: emp.email, department: emp.department || '' });
      setEditingId(emp._id);
    } else {
      setFormData({ name: '', email: '', department: '' });
      setEditingId(null);
    }
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
    setFormData({ name: '', email: '', department: '' });
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
      alert('保存失败，请重试');
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

  const handleBatchAdd = async () => {
    const sampleEmployees = [
      { name: '张三', email: 'zhangsan@example.com', department: '技术部' },
      { name: '李四', email: 'lisi@example.com', department: '产品部' },
      { name: '王五', email: 'wangwu@example.com', department: '设计部' },
      { name: '赵六', email: 'zhaoliu@example.com', department: '运营部' }
    ];
    try {
      for (const emp of sampleEmployees) {
        await employeeAPI.create(emp);
      }
      fetchEmployees();
    } catch (error) {
      console.error('批量添加失败:', error);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">员工管理</h1>
          <div className="page-subtitle">管理团队成员信息</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleBatchAdd}>
            📥 添加测试员工
          </button>
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
                  <th>邮箱</th>
                  <th>部门</th>
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
                    <td style={{ color: '#64748b', fontSize: '0.85rem' }}>{emp.email}</td>
                    <td>
                      {emp.department ? (
                        <span style={{
                          display: 'inline-block',
                          padding: '0.2rem 0.6rem',
                          borderRadius: 20,
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          background: deptColor(emp.department) + '18',
                          color: deptColor(emp.department),
                        }}>
                          {emp.department}
                        </span>
                      ) : <span style={{ color: '#94a3b8' }}>—</span>}
                    </td>
                    <td style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                      {emp.createdAt ? new Date(emp.createdAt).toLocaleDateString('zh-CN') : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => openDrawer(emp)}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(emp._id)}
                        >
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

      {/* Drawer */}
      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <div className="drawer">
            <div className="drawer-header">
              <div className="drawer-title">{editingId ? '编辑员工' : '添加员工'}</div>
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
                  <label className="form-label form-label-required">邮箱</label>
                  <input
                    type="email"
                    name="email"
                    className="form-input"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="请输入邮箱"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">部门</label>
                  <input
                    type="text"
                    name="department"
                    className="form-input"
                    value={formData.department}
                    onChange={handleChange}
                    placeholder="如：技术部、产品部"
                    list="dept-suggestions"
                  />
                  <datalist id="dept-suggestions">
                    <option value="技术部" />
                    <option value="产品部" />
                    <option value="设计部" />
                    <option value="运营部" />
                    <option value="市场部" />
                  </datalist>
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

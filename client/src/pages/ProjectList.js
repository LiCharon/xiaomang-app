import React, { useState, useEffect } from 'react';
import { projectAPI } from '../services/api';

function getStatusInfo(status) {
  switch (status) {
    case 'active':    return { label: '进行中', cls: 'status-active' };
    case 'completed': return { label: '已完成', cls: 'status-completed' };
    case 'archived':  return { label: '已归档', cls: 'status-archived' };
    default:          return { label: status,   cls: '' };
  }
}

function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', description: '', status: 'active' });
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchProjects(); }, []);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const response = await projectAPI.getAll();
      setProjects(response.data);
    } catch (error) {
      console.error('获取项目失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const openDrawer = (proj = null) => {
    if (proj) {
      setFormData({ name: proj.name, description: proj.description || '', status: proj.status || 'active' });
      setEditingId(proj._id);
    } else {
      setFormData({ name: '', description: '', status: 'active' });
      setEditingId(null);
    }
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
    setFormData({ name: '', description: '', status: 'active' });
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      if (editingId) {
        await projectAPI.update(editingId, formData);
      } else {
        await projectAPI.create(formData);
      }
      closeDrawer();
      fetchProjects();
    } catch (error) {
      console.error('保存项目失败:', error);
      alert('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除这个项目吗？')) return;
    try {
      await projectAPI.delete(id);
      fetchProjects();
    } catch (error) {
      console.error('删除项目失败:', error);
    }
  };

  const handleBatchAdd = async () => {
    const sampleProjects = [
      { name: 'AI 项目助手开发', description: '开发一个智能项目任务管理与桌宠提醒系统', status: 'active' },
      { name: '官网重构',       description: '对公司官网进行全新改版',               status: 'active' },
      { name: '移动端适配',     description: '完成所有页面的移动端适配工作',          status: 'active' }
    ];
    try {
      for (const proj of sampleProjects) {
        await projectAPI.create(proj);
      }
      fetchProjects();
    } catch (error) {
      console.error('批量添加失败:', error);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">项目管理</h1>
          <div className="page-subtitle">管理所有项目信息</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleBatchAdd}>
            📥 添加测试项目
          </button>
          <button className="btn btn-primary" onClick={() => openDrawer()}>
            ＋ 添加项目
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📁</div>
            <p>暂无项目，点击右上角添加</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>项目名称</th>
                  <th>描述</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {projects.map(proj => {
                  const { label, cls } = getStatusInfo(proj.status);
                  return (
                    <tr key={proj._id}>
                      <td>
                        <div className="avatar-cell">
                          <div style={{
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            background: 'linear-gradient(135deg, #6366f1, #818cf8)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '0.8rem',
                            fontWeight: 700,
                            color: 'white',
                            flexShrink: 0,
                          }}>
                            {proj.name?.[0]}
                          </div>
                          <span className="table-cell-primary">{proj.name}</span>
                        </div>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        {proj.description ? (
                          <span className="table-cell-sub" style={{ color: '#64748b' }}>
                            {proj.description.substring(0, 50)}{proj.description.length > 50 ? '…' : ''}
                          </span>
                        ) : <span style={{ color: '#94a3b8' }}>—</span>}
                      </td>
                      <td>
                        <span className={`status-badge ${cls}`}>{label}</span>
                      </td>
                      <td style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                        {proj.createdAt ? new Date(proj.createdAt).toLocaleDateString('zh-CN') : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openDrawer(proj)}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(proj._id)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
              <div className="drawer-title">{editingId ? '编辑项目' : '添加项目'}</div>
              <button className="drawer-close" onClick={closeDrawer}>✕</button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div className="drawer-body">
                <div className="form-group">
                  <label className="form-label form-label-required">项目名称</label>
                  <input
                    type="text"
                    name="name"
                    className="form-input"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="请输入项目名称"
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">项目描述</label>
                  <textarea
                    name="description"
                    className="form-textarea"
                    value={formData.description}
                    onChange={handleChange}
                    placeholder="请输入项目描述（选填）"
                    style={{ minHeight: 100 }}
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
                    <option value="active">进行中</option>
                    <option value="completed">已完成</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
              </div>
              <div className="drawer-footer">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : (editingId ? '保存修改' : '添加项目')}
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

export default ProjectList;

import React, { useEffect, useState } from 'react';
import { customerAPI } from '../services/api';

function CustomerList() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    occupation: '',
    contact: '',
    ipPositioning: '',
    contentNeeds: '',
    benchmarkAccounts: '',
    notes: ''
  });

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const response = await customerAPI.getAll();
      setCustomers(response.data);
    } catch (error) {
      console.error('获取客户失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const openDrawer = (customer = null) => {
    if (customer) {
      setEditingId(customer._id);
      setFormData({
        name: customer.name || '',
        occupation: customer.occupation || '',
        contact: customer.contact || '',
        ipPositioning: customer.ipPositioning || '',
        contentNeeds: customer.contentNeeds || '',
        benchmarkAccounts: customer.benchmarkAccounts || '',
        notes: customer.notes || ''
      });
    } else {
      setEditingId(null);
      setFormData({
        name: '',
        occupation: '',
        contact: '',
        ipPositioning: '',
        contentNeeds: '',
        benchmarkAccounts: '',
        notes: ''
      });
    }
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      alert('客户名称必填');
      return;
    }

    try {
      setSaving(true);
      if (editingId) {
        await customerAPI.update(editingId, formData);
      } else {
        await customerAPI.create(formData);
      }
      closeDrawer();
      fetchCustomers();
    } catch (error) {
      console.error('保存客户失败:', error);
      alert(error?.response?.data?.error || '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除该客户档案吗？')) return;
    try {
      await customerAPI.delete(id);
      fetchCustomers();
    } catch (error) {
      console.error('删除客户失败:', error);
      alert(error?.response?.data?.error || '删除失败，请重试');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">客户档案</h1>
          <div className="page-subtitle">由项目经理维护客户基础信息与内容需求档案</div>
        </div>
        <button className="btn btn-primary" onClick={() => openDrawer()}>
          ＋ 新建客户档案
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : customers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📇</div>
            <p>暂无客户档案，点击右上角新建</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>客户名称</th>
                  <th>职业</th>
                  <th>联系方式</th>
                  <th>个人IP定位</th>
                  <th>内容需求</th>
                  <th>对标账号</th>
                  <th>备注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer._id}>
                    <td>
                      <div className="table-cell-primary">{customer.name}</div>
                    </td>
                    <td>{customer.occupation || '—'}</td>
                    <td>{customer.contact || '—'}</td>
                    <td>{customer.ipPositioning || '—'}</td>
                    <td style={{ maxWidth: 220 }}>
                      <div className="table-cell-sub">{customer.contentNeeds || '—'}</div>
                    </td>
                    <td style={{ maxWidth: 220 }}>
                      <div className="table-cell-sub">{customer.benchmarkAccounts || '—'}</div>
                    </td>
                    <td style={{ maxWidth: 220 }}>
                      <div className="table-cell-sub">{customer.notes || '—'}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => openDrawer(customer)}>
                          编辑
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(customer._id)}>
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
              <div className="drawer-title">{editingId ? '编辑客户档案' : '新建客户档案'}</div>
              <button className="drawer-close" onClick={closeDrawer}>✕</button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div className="drawer-body">
                <div className="form-group">
                  <label className="form-label form-label-required">客户名称</label>
                  <input
                    name="name"
                    className="form-input"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="请输入客户名称"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">职业</label>
                  <input
                    name="occupation"
                    className="form-input"
                    value={formData.occupation}
                    onChange={handleChange}
                    placeholder="请输入职业"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">联系电话</label>
                  <input
                    name="contact"
                    className="form-input"
                    value={formData.contact}
                    onChange={handleChange}
                    placeholder="请输入联系电话"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">个人IP定位</label>
                  <textarea
                    name="ipPositioning"
                    className="form-textarea"
                    value={formData.ipPositioning}
                    onChange={handleChange}
                    placeholder="例如：职场成长、母婴测评、科技测评等"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">内容需求</label>
                  <textarea
                    name="contentNeeds"
                    className="form-textarea"
                    value={formData.contentNeeds}
                    onChange={handleChange}
                    placeholder="填写内容需求或创意方向"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">对标账号</label>
                  <textarea
                    name="benchmarkAccounts"
                    className="form-textarea"
                    value={formData.benchmarkAccounts}
                    onChange={handleChange}
                    placeholder="填写对标账号信息"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">备注信息</label>
                  <textarea
                    name="notes"
                    className="form-textarea"
                    value={formData.notes}
                    onChange={handleChange}
                    placeholder="补充说明"
                  />
                </div>
              </div>
              <div className="drawer-footer">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : (editingId ? '保存修改' : '创建档案')}
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

export default CustomerList;

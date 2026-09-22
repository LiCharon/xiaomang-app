import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { customerAPI } from '../services/api';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
}

function getIpStatusInfo(status) {
  switch (status) {
    case 'confirmed': return { label: '已确认', className: 'ip-status-confirmed' };
    case 'needs_review': return { label: '待确认', className: 'ip-status-review' };
    case 'draft': return { label: '草稿', className: 'ip-status-draft' };
    default: return { label: '未开始', className: 'ip-status-not-started' };
  }
}

function CustomerList() {
  const location = useLocation();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(location.state?.message || '');

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

  return (
    <div>
      <div className="customer-list-toolbar">
        <Link className="btn btn-primary" to="/manager/customers/ip-profile/new">
          ＋ 新建 IP 档案
        </Link>
      </div>

      {notice && <div className="ip-message success customer-list-message">{notice}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : customers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📇</div>
            <p>暂无客户档案，点击右上角开始采集 IP 信息</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>客户</th>
                  <th>联系方式</th>
                  <th>IP 档案</th>
                  <th>最近更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => {
                  const summary = customer.ipProfileSummary || {};
                  const status = getIpStatusInfo(summary.status);
                  const completion = summary.completion || { completed: 0, total: 3, percentage: 0 };
                  return (
                  <tr key={customer._id}>
                    <td>
                      <div className="table-cell-primary">{customer.name}</div>
                      <div className="table-cell-sub">{customer.occupation || '尚未填写职业身份'}</div>
                    </td>
                    <td>{customer.contact || '—'}</td>
                    <td>
                      <div className="customer-ip-summary">
                        <span className={`ip-status ${status.className}`}>{status.label}</span>
                        <span className="table-cell-sub">{completion.completed}/{completion.total} 组 · {summary.profileVersion ? `v${summary.profileVersion}` : '未确认'}</span>
                      </div>
                    </td>
                    <td>{formatDate(summary.updatedAt || customer.updatedAt || customer.createdAt)}</td>
                    <td>
                      <div className="customer-row-actions">
                        <Link className="btn btn-primary btn-sm" to={`/manager/customers/${customer._id}/ip-profile`}>
                          打开 IP 助手
                        </Link>
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

    </div>
  );
}

export default CustomerList;

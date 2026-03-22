import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { taskAPI } from '../services/api';

const AVATAR_CLASSES = ['avatar-indigo', 'avatar-violet', 'avatar-pink', 'avatar-teal', 'avatar-orange'];

function getAvatarClass(name) {
  if (!name) return 'avatar-indigo';
  const idx = name.charCodeAt(0) % AVATAR_CLASSES.length;
  return AVATAR_CLASSES[idx];
}

function getStatusInfo(status) {
  switch (status) {
    case 'pending':
      return { label: '待处理', cls: 'status-pending' };
    case 'in_progress':
      return { label: '进行中', cls: 'status-in_progress' };
    case 'completed':
      return { label: '已完成', cls: 'status-completed' };
    default:
      return { label: status, cls: '' };
  }
}

function getPriorityInfo(priority) {
  switch (priority) {
    case 'high':
      return { label: '高', cls: 'priority-high' };
    case 'medium':
      return { label: '中', cls: 'priority-medium' };
    case 'low':
      return { label: '低', cls: 'priority-low' };
    default:
      return { label: priority, cls: '' };
  }
}

function isOverdue(collaborationPeriod) {
  if (!collaborationPeriod?.end) return false;
  return new Date(collaborationPeriod.end) < new Date();
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN');
}

function TaskList() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', employeeId: '', date: '' });
  const [detailTask, setDetailTask] = useState(null);

  useEffect(() => {
    fetchTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.employeeId) params.employeeId = filter.employeeId;
      if (filter.date) params.date = filter.date;
      const response = await taskAPI.getAll(params);
      setTasks(response.data);
    } catch (error) {
      console.error('获取任务失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除这个任务吗？')) return;
    try {
      await taskAPI.delete(id);
      fetchTasks();
    } catch (error) {
      console.error('删除任务失败:', error);
    }
  };

  const handleStatusChange = async (id, newStatus) => {
    try {
      await taskAPI.update(id, { status: newStatus });
      fetchTasks();
      if (detailTask && detailTask._id === id) {
        setDetailTask((prev) => ({ ...prev, status: newStatus }));
      }
    } catch (error) {
      console.error('更新任务状态失败:', error);
    }
  };

  const pending = tasks.filter((t) => t.status === 'pending').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const completed = tasks.filter((t) => t.status === 'completed').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">任务列表</h1>
          <div className="page-subtitle">管理和追踪所有项目任务</div>
        </div>
        <Link to="/tasks/new" className="btn btn-primary">
          <span>＋</span> 新建任务
        </Link>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon stat-icon-yellow">⏳</div>
          <div>
            <div className="stat-value">{pending}</div>
            <div className="stat-label">待处理</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-blue">🔄</div>
          <div>
            <div className="stat-value">{inProgress}</div>
            <div className="stat-label">进行中</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-green">✅</div>
          <div>
            <div className="stat-value">{completed}</div>
            <div className="stat-label">已完成</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <select
            className="form-select"
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          >
            <option value="">全部状态</option>
            <option value="pending">待处理</option>
            <option value="in_progress">进行中</option>
            <option value="completed">已完成</option>
          </select>

          <input
            type="date"
            className="form-input"
            value={filter.date}
            onChange={(e) => setFilter({ ...filter, date: e.target.value })}
          />

          <button className="btn btn-secondary" onClick={fetchTasks}>
            刷新
          </button>

          {(filter.status || filter.date) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setFilter({ status: '', employeeId: '', date: '' })}
            >
              清除筛选
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading">
            <span className="loading-spinner" />
            加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <p>暂无任务</p>
            <Link to="/tasks/new" className="btn btn-primary">
              创建第一个任务
            </Link>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>客户 / 任务信息</th>
                  <th>负责人</th>
                  <th>目标平台</th>
                  <th>任务周期</th>
                  <th>优先级</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const { label: priorityLabel, cls: priorityCls } = getPriorityInfo(task.priority);
                  const { cls: statusCls } = getStatusInfo(task.status);
                  const overdue = isOverdue(task.collaborationPeriod) && task.status !== 'completed';
                  const ownerName = task.ownerId?.name;

                  return (
                    <tr key={task._id}>
                      <td style={{ maxWidth: 320 }}>
                        <div className="table-cell-primary">{task.customerName}</div>
                        <div className="table-cell-sub">
                          联系方式：{task.contact || '—'}
                        </div>
                        <div className="table-cell-sub">
                          内容需求：{task.contentDirection || '—'}
                        </div>
                        <div className="table-cell-sub">
                          对标账号：{task.benchmarkAccounts || '—'}
                        </div>
                        <div className="table-cell-sub">
                          备注：{task.notes || '—'}
                        </div>
                      </td>
                      <td>
                        {ownerName ? (
                          <div className="avatar-cell">
                            <div className={`avatar ${getAvatarClass(ownerName)}`}>
                              {ownerName[0]}
                            </div>
                            <span style={{ fontSize: '0.875rem' }}>{ownerName}</span>
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td>{task.platformName || <span style={{ color: '#94a3b8' }}>—</span>}</td>
                      <td>
                        {task.collaborationPeriod ? (
                          <span style={{ color: overdue ? '#ef4444' : 'inherit', fontWeight: overdue ? 500 : 400 }}>
                            {formatDate(task.collaborationPeriod.start)} ~ {formatDate(task.collaborationPeriod.end)}
                            {overdue && <span style={{ fontSize: '0.72rem', marginLeft: 4 }}>逾期</span>}
                          </span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className={`priority-badge ${priorityCls}`}>{priorityLabel}</span>
                      </td>
                      <td>
                        <select
                          className={`status-select status-badge ${statusCls}`}
                          value={task.status}
                          onChange={(e) => handleStatusChange(task._id, e.target.value)}
                        >
                          <option value="pending">待处理</option>
                          <option value="in_progress">进行中</option>
                          <option value="completed">已完成</option>
                        </select>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setDetailTask(task)}>
                            查看详情
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(task._id)}>
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

      {detailTask && (
        <>
          <div className="drawer-overlay" onClick={() => setDetailTask(null)} />
          <div className="task-detail-modal">
            <div className="task-detail-header">
              <div>
                <div className="task-detail-title">任务详情</div>
                <div className="task-detail-subtitle">{detailTask.customerName || '未命名任务'}</div>
              </div>
              <button className="drawer-close" onClick={() => setDetailTask(null)}>✕</button>
            </div>

            <div className="task-detail-body">
              <div className="task-detail-grid">
                <div className="task-detail-item">
                  <div className="task-detail-label">客户名称</div>
                  <div className="task-detail-value">{detailTask.customerName || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">职业</div>
                  <div className="task-detail-value">{detailTask.customerOccupation || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">联系方式</div>
                  <div className="task-detail-value">{detailTask.contact || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">负责人</div>
                  <div className="task-detail-value">{detailTask.ownerId?.name || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">目标平台</div>
                  <div className="task-detail-value">{detailTask.platformName || '—'}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">任务周期</div>
                  <div className="task-detail-value">
                    {formatDate(detailTask.collaborationPeriod?.start)} ~ {formatDate(detailTask.collaborationPeriod?.end)}
                  </div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">优先级</div>
                  <div className="task-detail-value">{getPriorityInfo(detailTask.priority).label}</div>
                </div>
                <div className="task-detail-item">
                  <div className="task-detail-label">状态</div>
                  <div className="task-detail-value">{getStatusInfo(detailTask.status).label}</div>
                </div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">个人IP定位</div>
                <div className="task-detail-value">{detailTask.ipPositioning || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">内容需求 / 创意方向</div>
                <div className="task-detail-value">{detailTask.contentDirection || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">对标账号</div>
                <div className="task-detail-value">{detailTask.benchmarkAccounts || '—'}</div>
              </div>

              <div className="task-detail-item">
                <div className="task-detail-label">备注</div>
                <div className="task-detail-value">{detailTask.notes || '—'}</div>
              </div>
            </div>

            <div className="task-detail-footer">
              <button className="btn btn-secondary" onClick={() => setDetailTask(null)}>
                关闭
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default TaskList;

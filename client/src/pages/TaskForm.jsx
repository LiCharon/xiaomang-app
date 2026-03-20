import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { taskAPI, employeeAPI } from '../services/api';

function TaskForm() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [errors, setErrors] = useState({});

  const [formData, setFormData] = useState({
    customerName: '',
    contact: '',
    ownerId: '',
    platformName: '',
    collaborationStart: '',
    collaborationEnd: '',
    notes: '',
    contentRequirements: ['', '', ''],
    priority: 'medium',
    status: 'pending'
  });

  useEffect(() => {
    fetchOptions();
  }, []);

  const fetchOptions = async () => {
    try {
      const empRes = await employeeAPI.getAll();
      setEmployees(empRes.data);
    } catch (error) {
      console.error('获取选项失败:', error);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name.startsWith('contentRequirements[')) {
      const index = Number(name.match(/\[(\d+)\]/)?.[1]);
      if (!Number.isNaN(index)) {
        const nextRequirements = [...formData.contentRequirements];
        nextRequirements[index] = value;
        setFormData({ ...formData, contentRequirements: nextRequirements });
        return;
      }
    }

    setFormData({ ...formData, [name]: value });
    if (errors[name]) setErrors({ ...errors, [name]: '' });
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.customerName.trim()) newErrors.customerName = '请输入客户名称';
    if (!formData.ownerId) newErrors.ownerId = '请选择负责人';
    if (!formData.platformName) newErrors.platformName = '请选择目标平台';
    if (!formData.collaborationStart || !formData.collaborationEnd) {
      newErrors.collaborationPeriod = '请选择任务周期起止时间';
    }
    return newErrors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const newErrors = validate();
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    try {
      setLoading(true);
      const payload = {
        ...formData,
        collaborationPeriod: {
          start: formData.collaborationStart,
          end: formData.collaborationEnd
        }
      };
      await taskAPI.create(payload);
      navigate('/');
    } catch (error) {
      console.error('创建任务失败:', error);
      setErrors({ _general: '创建任务失败，请重试' });
    } finally {
      setLoading(false);
    }
  };

  const handleBatchImport = async () => {
    const today = new Date();
    const sampleTasks = [
      {
        customerName: '上海睿启科技',
        contact: 'marketing@rqtech.cn',
        ownerId: employees[0]?._id,
        platformName: '抖音',
        collaborationPeriod: {
          start: today.toISOString().split('T')[0],
          end: new Date(today.getTime() + 7 * 86400000).toISOString().split('T')[0]
        },
        notes: '重点推广新品发布期内容',
        contentRequirements: ['短视频 12 条', '品牌号直播 2 场', '达人联动脚本'],
        priority: 'high',
        status: 'pending'
      },
      {
        customerName: '成都星河文化',
        contact: '138****2210',
        ownerId: employees[1]?._id || employees[0]?._id,
        platformName: '小红书',
        collaborationPeriod: {
          start: today.toISOString().split('T')[0],
          end: new Date(today.getTime() + 14 * 86400000).toISOString().split('T')[0]
        },
        notes: '客户要求周报机制',
        contentRequirements: ['栏目策划 1 套', '拍摄方案 2 份', '剪辑样片 3 版'],
        priority: 'medium',
        status: 'pending'
      },
      {
        customerName: '杭州墨羽工作室',
        contact: 'moyu@studio.com',
        ownerId: employees[2]?._id || employees[0]?._id,
        platformName: 'TikTok',
        collaborationPeriod: {
          start: new Date(today.getTime() + 2 * 86400000).toISOString().split('T')[0],
          end: new Date(today.getTime() + 10 * 86400000).toISOString().split('T')[0]
        },
        notes: '需支持多平台同步发布',
        contentRequirements: ['长图文 5 篇', '选题会议 2 次', '运营方案 1 份'],
        priority: 'low',
        status: 'pending'
      }
    ];
    try {
      setLoading(true);
      await taskAPI.createBatch(sampleTasks);
      navigate('/');
    } catch (error) {
      console.error('批量导入失败:', error);
      setErrors({ _general: '批量导入失败，请重试' });
    } finally {
      setLoading(false);
    }
  };

  const canBatchImport = employees.length > 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">新建任务</h1>
          <div className="page-subtitle">根据客户需求快速创建执行任务</div>
        </div>
      </div>

      {errors._general && (
        <div className="error-message">{errors._general}</div>
      )}

      <div className="task-form-layout">
        <form className="task-form-grid" onSubmit={handleSubmit} noValidate>
          <div className="card task-form-card">
            <div className="task-form-card-header">
              <div className="task-form-card-title">客户基础信息</div>
            </div>

            <div className="task-form-card-body">
              <div className="form-group">
                <label className="form-label form-label-required">客户名称</label>
                <input
                  type="text"
                  name="customerName"
                  className={`form-input${errors.customerName ? ' is-error' : ''}`}
                  value={formData.customerName}
                  onChange={handleChange}
                  placeholder="请输入客户名称"
                />
                {errors.customerName && <div className="form-error-text">⚠ {errors.customerName}</div>}
              </div>

              <div className="form-group">
                <label className="form-label form-label-required">负责人</label>
                <select
                  name="ownerId"
                  className={`form-select${errors.ownerId ? ' is-error' : ''}`}
                  value={formData.ownerId}
                  onChange={handleChange}
                >
                  <option value="">请选择负责人</option>
                  {employees.map(emp => (
                    <option key={emp._id} value={emp._id}>
                      {emp.name}{emp.department ? ` · ${emp.department}` : ''}
                    </option>
                  ))}
                </select>
                {errors.ownerId && <div className="form-error-text">⚠ {errors.ownerId}</div>}
              </div>

              <div className="form-group">
                <label className="form-label">联系方式</label>
                <input
                  type="text"
                  name="contact"
                  className="form-input"
                  value={formData.contact}
                  onChange={handleChange}
                  placeholder="手机号 / 邮箱 / 微信号"
                />
              </div>

              <div className="form-group">
                <label className="form-label form-label-required">任务周期</label>
                <div className="form-date-range">
                  <input
                    type="date"
                    name="collaborationStart"
                    className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                    value={formData.collaborationStart}
                    onChange={handleChange}
                  />
                  <span className="form-date-separator">至</span>
                  <input
                    type="date"
                    name="collaborationEnd"
                    className={`form-input${errors.collaborationPeriod ? ' is-error' : ''}`}
                    value={formData.collaborationEnd}
                    onChange={handleChange}
                  />
                </div>
                {errors.collaborationPeriod && (
                  <div className="form-error-text">⚠ {errors.collaborationPeriod}</div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label form-label-required">目标平台</label>
                <select
                  name="platformName"
                  className={`form-select${errors.platformName ? ' is-error' : ''}`}
                  value={formData.platformName}
                  onChange={handleChange}
                >
                  <option value="">请选择目标平台</option>
                  <option value="抖音">抖音</option>
                  <option value="小红书">小红书</option>
                  <option value="视频号">视频号</option>
                  <option value="TikTok">TikTok</option>
                </select>
                {errors.platformName && <div className="form-error-text">⚠ {errors.platformName}</div>}
              </div>

              <div className="form-group">
                <label className="form-label">备注</label>
                <textarea
                  name="notes"
                  className="form-textarea"
                  value={formData.notes}
                  onChange={handleChange}
                  placeholder="填写额外需求说明"
                />
              </div>
            </div>

            <div className="task-form-card-footer">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? '提交中…' : '保存'}
              </button>
            </div>
          </div>

          <div className="card task-form-card">
            <div className="task-form-card-header">
              <div className="task-form-card-title">内容需求录入</div>
            </div>

            <div className="task-form-card-body">
              <div className="form-group">
                <label className="form-label">内容需求</label>
                <textarea
                  name="contentRequirements[0]"
                  className="form-textarea"
                  value={formData.contentRequirements[0]}
                  onChange={handleChange}
                  placeholder="填写内容需求或创意方向"
                />
              </div>

              <div className="task-form-multi">
                <div className="form-group">
                  <label className="form-label">内容需求</label>
                  <textarea
                    name="contentRequirements[1]"
                    className="form-textarea"
                    value={formData.contentRequirements[1]}
                    onChange={handleChange}
                    placeholder="对标账号"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">内容需求</label>
                  <textarea
                    name="contentRequirements[2]"
                    className="form-textarea"
                    value={formData.contentRequirements[2]}
                    onChange={handleChange}
                    placeholder="其他需要同步的内容"
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">优先级</label>
                  <select
                    name="priority"
                    className="form-select"
                    value={formData.priority}
                    onChange={handleChange}
                  >
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="task-form-card-footer">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? '提交中…' : '保存'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TaskForm;

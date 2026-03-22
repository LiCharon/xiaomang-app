import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { taskAPI, employeeAPI, customerAPI } from '../services/api';

function TaskForm() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [errors, setErrors] = useState({});

  const [formData, setFormData] = useState({
    customerId: '',
    customerName: '',
    customerOccupation: '',
    contact: '',
    ipPositioning: '',
    contentDirection: '',
    benchmarkAccounts: '',
    ownerId: '',
    platformName: '',
    collaborationStart: '',
    collaborationEnd: '',
    notes: '',
    priority: 'medium',
    status: 'pending'
  });

  useEffect(() => {
    fetchOptions();
  }, []);

  const fetchOptions = async () => {
    try {
      const [empRes, customerRes] = await Promise.all([
        employeeAPI.getAll(),
        customerAPI.getAll()
      ]);
      setEmployees(empRes.data);
      setCustomers(customerRes.data);
    } catch (error) {
      console.error('获取选项失败:', error);
    }
  };

  const applyCustomerToForm = (customer) => {
    if (!customer) return;
    setFormData((prev) => ({
      ...prev,
      customerId: customer._id,
      customerName: customer.name || '',
      customerOccupation: customer.occupation || '',
      contact: customer.contact || '',
      ipPositioning: customer.ipPositioning || '',
      contentDirection: customer.contentNeeds || '',
      benchmarkAccounts: customer.benchmarkAccounts || '',
      notes: customer.notes || ''
    }));
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'customerId') {
      if (!value) {
        setFormData((prev) => ({
          ...prev,
          customerId: '',
          customerName: '',
          customerOccupation: '',
          contact: '',
          ipPositioning: '',
          contentDirection: '',
          benchmarkAccounts: '',
          notes: ''
        }));
        return;
      }

      const selected = customers.find((item) => item._id === value);
      applyCustomerToForm(selected);
      return;
    }

    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }));
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.customerName.trim()) newErrors.customerName = '请选择客户或填写客户名称';
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">新建任务</h1>
          <div className="page-subtitle">选择客户后自动带入联系方式、备注、内容需求和对标账号</div>
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
                <label className="form-label">选择客户档案</label>
                <select
                  name="customerId"
                  className="form-select"
                  value={formData.customerId}
                  onChange={handleChange}
                >
                  <option value="">请选择客户（可先在客户模块创建）</option>
                  {customers.map((customer) => (
                    <option key={customer._id} value={customer._id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </div>

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
                <label className="form-label">职业</label>
                <input
                  type="text"
                  name="customerOccupation"
                  className="form-input"
                  value={formData.customerOccupation}
                  onChange={handleChange}
                  placeholder="客户职业"
                />
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
                  {employees.map((emp) => (
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
                <label className="form-label">个人IP定位</label>
                <textarea
                  name="ipPositioning"
                  className="form-textarea"
                  value={formData.ipPositioning}
                  onChange={handleChange}
                  placeholder="客户个人IP定位"
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
                <label className="form-label">内容需求或创意方向</label>
                <textarea
                  name="contentDirection"
                  className="form-textarea"
                  value={formData.contentDirection}
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
                  placeholder="填写对标账号"
                />
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

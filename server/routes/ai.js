const express = require('express');
const https = require('https');
const Task = require('../models/Task');

// Coze API 配置
const COZE_BOT_ID = process.env.COZE_BOT_ID || '7615157976437112858';
const COZE_ACCESS_TOKEN = process.env.COZE_ACCESS_TOKEN || 'pat_xvkEG1rPLvP8wfnX4zlNRDdhRfEN8sXBeDnKpHJez7dHowiskl0JxmrmXBbAUSeY';

// 调用 Coze AI 分析任务
async function callCozeAI(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      bot_id: COZE_BOT_ID,
      user_id: `user_${Date.now()}`,
      additional_messages: [{
        role: 'user',
        content: prompt,
        content_type: 'text'
      }],
      stream: false,
      auto_save_history: true
    });

    const options = {
      hostname: 'api.coze.cn',
      path: '/v3/chat',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COZE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0 && result.data) {
            resolve(result.data);
          } else {
            reject(new Error(result.msg || 'API调用失败'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const router = express.Router();

// AI 分析单个任务
router.post('/analyze-task/:taskId', async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId)
      .populate('employeeId', 'name')
      .populate('projectId', 'name');
    
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const prompt = `请分析以下任务，并为执行任务的员工生成一条清晰的今日工作提醒：

任务信息：
- 任务标题：${task.title}
- 任务描述：${task.description || '无'}
- 所属项目：${task.projectId?.name || '未知'}
- 截止日期：${task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '未设置'}
- 优先级：${task.priority || '普通'}

请用简洁、友好的语气生成提醒内容，字数控制在50-100字之间。`;

    const result = await callCozeAI(prompt);
    
    // 更新任务的 AI 分析结果
    task.aiAnalysis = result;
    await task.save();
    
    res.json({ taskId: task._id, analysis: result });
  } catch (err) {
    console.error('AI分析失败:', err.message);
    res.status(500).json({ error: 'AI分析失败: ' + err.message });
  }
});

// AI 批量分析今日任务并生成提醒
router.post('/analyze-today', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 获取今日所有任务
    const tasks = await Task.find({
      dueDate: { $gte: today, $lt: tomorrow },
      status: { $ne: 'completed' }
    })
      .populate('employeeId', 'name email')
      .populate('projectId', 'name');

    if (tasks.length === 0) {
      return res.json({ message: '今日暂无任务', results: [] });
    }

    // 按员工分组任务
    const tasksByEmployee = {};
    tasks.forEach(task => {
      const empId = task.employeeId?._id?.toString() || 'unknown';
      if (!tasksByEmployee[empId]) {
        tasksByEmployee[empId] = {
          employee: task.employeeId,
          tasks: []
        };
      }
      tasksByEmployee[empId].tasks.push(task);
    });

    const results = [];

    // 对每个员工生成任务汇总提醒
    for (const [empId, group] of Object.entries(tasksByEmployee)) {
      const taskList = group.tasks.map((t, i) => 
        `${i + 1}. ${t.title} ${t.description ? '- ' + t.description : ''}`
      ).join('\n');

      const prompt = `请为以下员工生成今日工作提醒汇总：

员工姓名：${group.employee?.name || '未知'}
今日任务列表：
${taskList}

请用简洁、友好的语气生成提醒内容，格式如下：
- 先问候
- 列出今日任务要点
- 适当鼓励

字数控制在100-200字之间。`;

      try {
        const analysis = await callCozeAI(prompt);
        results.push({
          employeeId: empId,
          employeeName: group.employee?.name,
          tasks: group.tasks.map(t => t._id),
          analysis: analysis
        });
      } catch (e) {
        console.error(`员工 ${empId} 分析失败:`, e.message);
        results.push({
          employeeId: empId,
          employeeName: group.employee?.name,
          error: e.message
        });
      }
    }

    res.json({ date: today.toISOString(), results });
  } catch (err) {
    console.error('批量AI分析失败:', err.message);
    res.status(500).json({ error: '批量AI分析失败: ' + err.message });
  }
});

// 获取员工的今日任务提醒
router.get('/reminder/:employeeId', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tasks = await Task.find({
      employeeId: req.params.employeeId,
      dueDate: { $gte: today, $lt: tomorrow },
      status: { $ne: 'completed' }
    })
      .populate('projectId', 'name')
      .sort({ priority: -1, dueDate: 1 });

    if (tasks.length === 0) {
      return res.json({
        message: '今日暂无任务',
        tasks: [],
        reminder: '今日暂无待办任务，享受轻松的一天吧！🌟'
      });
    }

    // 如果有 AI 分析结果，直接返回
    const analyzedTasks = tasks.filter(t => t.aiAnalysis);
    if (analyzedTasks.length > 0) {
      return res.json({
        tasks: tasks,
        reminder: analyzedTasks[0].aiAnalysis
      });
    }

    // 没有分析结果，生成简单提醒
    const taskSummary = tasks.map((t, i) => 
      `${i + 1}. ${t.title}`
    ).join('、');

    res.json({
      tasks: tasks,
      reminder: `今日你有 ${tasks.length} 个任务：${taskSummary}。加油！💪`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

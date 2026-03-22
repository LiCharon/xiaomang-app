const express = require('express');
const https = require('https');
const Task = require('../models/Task');

function isAiConfigured() {
  return Boolean(process.env.COZE_BOT_ID && process.env.COZE_ACCESS_TOKEN);
}

async function callCozeAI(prompt) {
  const cozeBotId = process.env.COZE_BOT_ID;
  const cozeAccessToken = process.env.COZE_ACCESS_TOKEN;

  if (!cozeBotId || !cozeAccessToken) {
    throw new Error('Missing COZE_BOT_ID or COZE_ACCESS_TOKEN environment variable');
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      bot_id: cozeBotId,
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
        Authorization: `Bearer ${cozeAccessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
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

function buildTaskSummary(task) {
  const period = `${task?.collaborationPeriod?.start ? new Date(task.collaborationPeriod.start).toLocaleDateString('zh-CN') : '未设置'} - ${task?.collaborationPeriod?.end ? new Date(task.collaborationPeriod.end).toLocaleDateString('zh-CN') : '未设置'}`;
  return `客户：${task.customerName || '未知'}｜平台：${task.platformName || '未知'}｜周期：${period}｜内容需求：${task.contentDirection || '无'}｜对标账号：${task.benchmarkAccounts || '无'}｜备注：${task.notes || '无'}`;
}

const router = express.Router();

router.post('/analyze-task/:taskId', async (req, res) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({ error: 'AI 功能未启用' });
    }

    const task = await Task.findById(req.params.taskId).populate('ownerId', 'name email');
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const prompt = `请根据以下任务生成一条今日执行提醒（50~100字，简洁可执行）：\n${buildTaskSummary(task)}`;
    const result = await callCozeAI(prompt);

    task.aiAnalysis = result;
    await task.save();

    res.json({ taskId: task._id, analysis: result });
  } catch (err) {
    console.error('AI分析失败:', err.message);
    res.status(500).json({ error: `AI分析失败: ${err.message}` });
  }
});

router.post('/analyze-today', async (req, res) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({ error: 'AI 功能未启用' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tasks = await Task.find({
      'collaborationPeriod.start': { $lte: tomorrow },
      'collaborationPeriod.end': { $gte: today },
      status: { $ne: 'completed' }
    }).populate('ownerId', 'name email');

    if (tasks.length === 0) {
      return res.json({ message: '今日暂无任务', results: [] });
    }

    const tasksByEmployee = {};
    tasks.forEach((task) => {
      const ownerKey = task.ownerId?._id?.toString() || 'unknown';
      if (!tasksByEmployee[ownerKey]) {
        tasksByEmployee[ownerKey] = {
          employee: task.ownerId,
          tasks: []
        };
      }
      tasksByEmployee[ownerKey].tasks.push(task);
    });

    const results = [];

    for (const [empId, group] of Object.entries(tasksByEmployee)) {
      const taskList = group.tasks.map((t, i) => `${i + 1}. ${buildTaskSummary(t)}`).join('\n');
      const prompt = `请为员工 ${group.employee?.name || '未知'} 生成今日任务提醒（100~200字，先问候，再列执行重点，再鼓励）：\n${taskList}`;

      try {
        const analysis = await callCozeAI(prompt);
        results.push({
          employeeId: empId,
          employeeName: group.employee?.name,
          tasks: group.tasks.map((t) => t._id),
          analysis
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
    res.status(500).json({ error: `批量AI分析失败: ${err.message}` });
  }
});

router.get('/reminder/:employeeId', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tasks = await Task.find({
      ownerId: req.params.employeeId,
      'collaborationPeriod.start': { $lte: tomorrow },
      'collaborationPeriod.end': { $gte: today },
      status: { $ne: 'completed' }
    })
      .populate('ownerId', 'name email')
      .sort({ priority: -1, 'collaborationPeriod.end': 1 });

    if (tasks.length === 0) {
      return res.json({
        message: '今日暂无任务',
        tasks: [],
        reminder: '今日暂无待办任务，享受轻松的一天吧！'
      });
    }

    const analyzedTasks = tasks.filter((t) => t.aiAnalysis);
    if (analyzedTasks.length > 0) {
      return res.json({ tasks, reminder: analyzedTasks[0].aiAnalysis });
    }

    const taskSummary = tasks
      .map((t, i) => `${i + 1}. ${t.customerName}（${t.platformName || '未设平台'}）｜需求：${t.contentDirection || '无'}｜对标：${t.benchmarkAccounts || '无'}｜备注：${t.notes || '无'}`)
      .join('；');

    res.json({
      tasks,
      reminder: `今日你有 ${tasks.length} 个任务：${taskSummary}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

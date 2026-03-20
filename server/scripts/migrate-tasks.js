/* eslint-disable no-console */
const mongoose = require('mongoose');
require('dotenv').config();

const Task = require('../models/Task');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ 缺少 MONGO_URI 环境变量');
  process.exit(1);
}

const mapOldToNew = (doc) => {
  const title = doc.title || '';
  const description = doc.description || '';
  const dueDate = doc.dueDate ? new Date(doc.dueDate) : null;
  const period = doc.collaborationPeriod || null;

  const resolvedPeriod = period?.start && period?.end
    ? { start: new Date(period.start), end: new Date(period.end) }
    : dueDate
      ? { start: dueDate, end: dueDate }
      : null;

  return {
    customerName: doc.customerName || title,
    contact: doc.contact || '',
    ownerId: doc.ownerId || doc.employeeId || null,
    platformName: doc.platformName || doc.platformId || doc.projectId || '',
    collaborationPeriod: resolvedPeriod,
    notes: doc.notes || description,
    contentRequirements: Array.isArray(doc.contentRequirements)
      ? doc.contentRequirements
      : description
        ? [description]
        : [],
    status: doc.status || 'pending',
    priority: doc.priority || (doc.workload && String(doc.workload).includes('高') ? 'high' : doc.workload && String(doc.workload).includes('低') ? 'low' : 'medium'),
    aiAnalysis: doc.aiAnalysis || '',
    createdAt: doc.createdAt || new Date()
  };
};

const shouldMigrate = (doc) => {
  return !doc.customerName && (doc.title || doc.employeeId || doc.projectId || doc.platformId || doc.dueDate);
};

const migrate = async () => {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB 连接成功');

  const collection = Task.collection;
  const cursor = collection.find({});
  const ops = [];
  let total = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!shouldMigrate(doc)) continue;

    const mapped = mapOldToNew(doc);
    total += 1;
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: mapped,
          $unset: {
            title: '',
            description: '',
            employeeId: '',
            projectId: '',
            platformId: '',
            dueDate: '',
            workload: ''
          }
        }
      }
    });

    if (ops.length >= 200) {
      await collection.bulkWrite(ops);
      ops.length = 0;
    }
  }

  if (ops.length) {
    await collection.bulkWrite(ops);
  }

  console.log(`✅ 迁移完成，共处理 ${total} 条旧任务数据`);
  await mongoose.disconnect();
};

migrate().catch((error) => {
  console.error('❌ 迁移失败:', error);
  mongoose.disconnect();
  process.exit(1);
});

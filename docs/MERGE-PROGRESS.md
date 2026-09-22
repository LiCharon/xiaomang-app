# 系统合并进度

目标：统一一个 React SPA、一个 Express 服务、一个本地数据库，保留全部员工端与经理端业务；准备腾讯云部署。

## 已完成
- 原项目全量备份：../xiaomang-merge-backups/20260922-165556，含校验值 manifest.json；Unix socket 为运行时文件，tar 未归档。
- 新工作目录：../xiaomang，保留经理站 Git 历史；当前两个原目录及经理站未提交改动保留在原处与备份。
- 初步拆分 apps/web 与 apps/server；拷贝经理站当前页面、路由与模型供转换，尚未接入运行。
- 前端入口实际是 src/main.tsx，旧 HANDOFF 的 src/app/main.tsx 已过时。

## 必须闭环
- 数据库目标等待用户确认：建议本地 MongoDB；源库只读迁移，迁移前确认其他写入者。
- 经理站 CJS/Mongoose 转 ESM/原生 MongoDB；统一鉴权，员工管理接口必须显式要求 manager。
- /api/customers 列表响应冲突：现有定位功能为 {items}，经理站为数组，需统一调用契约。
- 将经理页面接入统一路由与 AuthProvider，并统一样式。
- 员工密码写入改为 bcrypt；迁移密码只在目标副本进行并核对登录。
- taskStore 聚合保留 customerId，但 normalizeTask 丢弃它；合并测试必须覆盖经理建任务→员工读任务→客户选题库。
- 本地 Docker CLI 已有，daemon 未启动；未发现 mongod/mongodump。
- 数据迁移、逐集合计数与内容哈希对账、原有测试/路由验证、合并后浏览器验收。
- Docker Compose、备份恢复、腾讯云部署说明及最终 HANDOFF。

当前骨架未经构建验收，不能视为合并完成。经理原始代码暂存 legacy-*，完成转换后应删除这些运行树中的迁移副本。

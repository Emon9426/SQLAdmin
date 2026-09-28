# SQLAdmin

面向 VS Code 的 Oracle 数据库开发插件 —— 目标是在 VS Code 中提供对标 **Oracle SQL Developer** 的核心开发体验：

- 🔌 连接管理（Oracle 12.1+ thin 模式纯 JS 直连；可选 thick 模式支持 11.2+）
- ⌨️ SQL 工作台（执行、多结果集、DBMS_OUTPUT、执行计划、补全、格式化）
- 📊 结果网格 + **结果内编辑**（单元格编辑、行增删、ROWID 定位、延迟行锁）
- 💾 事务管理（提交 / 回滚 / 待提交变更预览）
- 📤 查询结果导出（CSV / XLSX / JSON / INSERT / HTML，全量流式）
- 🗂 DB 对象浏览器（表、视图、存储过程、包、触发器、序列等，含 DDL 查看）
- 🐞 PL/SQL 调试（断点、单步、变量、调用栈 —— 自研 DAP 适配器，分阶段交付）
- 🐘 预留 PostgreSQL 支持（驱动抽象层，pg/MIT）

> **当前阶段：需求与原型设计（v0.1 草案）**

## 设计文档

| 文档 | 说明 |
| --- | --- |
| [需求文档（含可行性分析）](docs/requirements.html) | 可行性分析、许可证合规矩阵、功能/非功能需求、里程碑 |
| [原型设计文档](docs/prototype-design.html) | 界面原型（线框图）、交互流程、命令与快捷键、视觉规范 |

（HTML 文档请用浏览器打开阅读）

## 技术栈（选型结论，详见需求文档第 3 章）

- TypeScript + VS Code Extension API（WebView / TreeView / Debug Adapter Protocol）
- `oracledb`（node-oracledb，Apache-2.0 OR UPL-1.0）— Oracle 驱动，thin 模式免安装客户端
- `pg`（MIT）— PostgreSQL 驱动（预留）
- `sql-formatter`（MIT）、自研 SQL 语句切分器、`exceljs`（MIT）导出等

## 里程碑（摘要）

M0 工程骨架 → M1 连接+查询（alpha）→ M2 结果编辑+导出+对象树 → M3 对象详情+补全+执行计划 → M4 PL/SQL 调试 → M5 PostgreSQL 实装 + 发布

## 仓库

- 远端：<https://github.com/Emon9426/SQLAdmin>

## 许可证

项目许可证待定（建议 Apache-2.0）。所有第三方依赖的许可证合规结论见需求文档 §3.3 合规矩阵；**严禁**引入或复用 Oracle SQL Developer、Oracle 官方 VS Code 插件等专有软件的任何代码与资产。

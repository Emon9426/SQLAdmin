# Changelog

所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.1.0] - 2026-09-29

首个发布（对应需求文档 M0–M3 范围）。

### 新增

- **连接管理（F1）**：Oracle（thin 默认/thick 可选）与 Mock 演示连接；基本 / TNS 别名（本机 tnsnames.ora 自动解析）/ 连接串三种寻址；密码 SecretStorage 保存；只读连接；SYSDBA/SYSOPER
- **SQL 工作台（F2）**：Ctrl+Enter 当前语句 / Ctrl+Shift+Enter 脚本执行；PL/SQL 块感知语句切分；绑定变量提示；DBMS_OUTPUT 回收；SQL/PLSQL 语法高亮文法；补全（关键字/表/列）；格式化（sql-formatter plsql 方言）
- **结果网格与编辑（F3）**：单元格编辑（类型校验）、行增删、待提交变更集与 DML 预览；提交/回滚仅在变更集非空时可用；连接断开/错误默认回滚；单表可编辑性判定（JOIN/聚合只读）
- **导出（F4）**：CSV / XLSX / JSON / INSERT / HTML；已加载行与全量流式两种范围
- **对象浏览器（F5）**：Schema → 表/视图/过程/函数/包/触发器/序列/同义词/类型；表数据打开（可编辑）；DDL 只读视图；SELECT/INSERT 骨架生成
- **驱动抽象（F7 预留）**：IDbDriver 接口 + PostgreSQL 注册位
- **测试**：59 单元测试 + 15 VS Code 集成测试（@vscode/test-electron，Mock 驱动实机）

### 已知限制

- PL/SQL 调试（F6）计划 M4 交付
- PostgreSQL 驱动（F7-03）计划 v1.0（M5）交付
- 实际执行计划（F2-12 实际计划部分）依赖数据库权限，暂只提供预估计划的接口位

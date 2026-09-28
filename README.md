# SQLAdmin — Oracle Database Tools for VS Code

在 VS Code 中完成 Oracle 日常开发：连接数据库、执行 SQL、**结果内直接编辑并提交/回滚**、导出、浏览数据库对象——对标 Oracle SQL Developer 的核心工作流，并内置**无需数据库的 Mock 演示连接**。

![Version](https://img.shields.io/badge/version-0.1.0-blue) ![License](https://img.shields.io/badge/license-Apache--2.0-green) ![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-purple)

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🔌 连接管理 | 基本（主机/端口/服务名）、**TNS 别名（自动解析本机 tnsnames.ora）**、连接串三种寻址模式；连接/用户名/密码可保存（密码仅存 VS Code 安全存储，永不明文落盘）；只读连接保护；SYSDBA/SYSOPER 角色 |
| ⌨️ SQL 工作台 | `Ctrl+Enter` 执行当前语句（光标定位/选区），`Ctrl+Shift+Enter` 脚本执行；PL/SQL 块感知的语句切分；绑定变量提示；DBMS_OUTPUT 自动回收；SQL/PLSQL 语法高亮 |
| 📊 结果网格 + 编辑 | 双击单元格直接编辑（类型校验）、行增删；**待提交变更集**（预览将执行的 DML）；提交/回滚按钮仅在存在数据变更时可用；连接断开/出错**默认回滚**；JOIN/聚合结果自动只读 |
| 💾 事务管理 | `Ctrl+Alt+C` 提交 / `Ctrl+Alt+R` 回滚；状态栏事务徽标实时显示未提交更改数 |
| 📤 导出 | CSV / XLSX / JSON / INSERT 语句 / HTML 报表；支持已加载行或**全量流式重查**导出 |
| 🗂 对象浏览器 | 连接 → Schema → 表/视图/过程/函数/包/触发器/序列/同义词/类型；表数据一键打开（可编辑）；DDL 只读视图（带 SQL 高亮）；SELECT/INSERT 骨架生成 |
| 🧹 格式化 | `Shift+Alt+F` 文档格式化 / `Ctrl+K Ctrl+F` 选区格式化（PL/SQL 方言、缩进/大小写可配） |
| 🐘 架构预留 | 驱动抽象层（IDbDriver）+ PostgreSQL 注册位（v1.0 实装） |
| 🧪 Mock 演示连接 | 内置内存 HR 示例库（14 员工/6 部门），无需 Oracle 即可体验全部功能 |

> **路线图**（见 [docs/requirements.html](docs/requirements.html)）：PL/SQL 调试（M4，自研 DAP 适配器）、执行计划、PostgreSQL 实装（M5）。

## 🚀 快速开始

### 1. 无数据库？30 秒体验

命令面板（`Ctrl+Shift+P`）→ **SQLAdmin: 创建演示连接 (Mock, 无需数据库)** ——自动创建连接、打开工作台并预填示例查询，按 `Ctrl+Enter` 即可看到结果网格。

### 2. 连接 Oracle

1. 活动栏点击 SQLAdmin 图标 → **新建连接**
2. 选择连接模式：
   - **基本**：主机 + 端口(1521) + 服务名（如 `XEPDB1`）
   - **TNS 别名**：自动定位本机 `tnsnames.ora`（查找顺序：`TNS_ADMIN` → `%ORACLE_HOME%\network\admin` → `~\.oracle\network\admin`，可在设置 `sqladmin.tns.customPath` 指定），列出全部别名供选择
   - **连接串**：Easy Connect（`host:1521/service`）或完整描述符
3. 输入用户名/密码 → 选择密码保存策略 → **测试连接** → 保存

Oracle 驱动为 [node-oracledb](https://node-oracledb.readthedocs.io/) **thin 模式**（纯 JavaScript，免安装 Oracle 客户端，支持 Oracle 12.1+）。如需连接 **Oracle 11.2** 或使用客户端高级特性，在设置中切换 `sqladmin.oracle.mode = thick`（需本机安装 Oracle Client / Instant Client）。

### 3. 日常使用

```
Ctrl+Enter          执行光标处语句（或选区）
Ctrl+Shift+Enter    整个脚本顺序执行
Ctrl+Alt+N          新建工作台
Ctrl+Alt+C / R      提交 / 回滚
Ctrl+Alt+V          预览待提交更改（生成的 DML）
Ctrl+Alt+E          导出结果
Shift+Alt+F         格式化 SQL
```

编辑数据：执行单表查询 → 结果网格中**双击单元格**修改（数字列自动校验）、工具栏 `＋ 行`/`－ 删行` → 预览更改 → 提交/回滚。所有修改先进入待提交变更集，**不会立即写库**。

## ⚙️ 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `sqladmin.defaultFetchRows` | 500 | 结果网格每批拉取行数 |
| `sqladmin.results.nullText` | `(NULL)` | NULL 显示文本 |
| `sqladmin.export.batchSize` | 5000 | 流式导出批大小 |
| `sqladmin.tns.customPath` | — | tnsnames.ora 自定义路径 |
| `sqladmin.oracle.mode` | thin | thin（免客户端）/ thick（需 Oracle Client） |
| `sqladmin.oracle.clientLibDir` | — | thick 模式客户端库目录 |
| `sqladmin.format.tabSize` | 2 | 格式化缩进宽度 |
| `sqladmin.format.uppercaseKeywords` | true | 格式化时关键字大写 |

## 🔒 安全

- 密码仅存于 VS Code **SecretStorage**，连接配置/导出内容永不含明文密码
- 只读连接（新建连接时可选）禁用结果编辑
- 生产环境建议使用最小权限账号

## 🧪 测试

```bash
npm install
npm run compile        # 类型检查 + 打包
npm test               # 59 个单元测试 + 15 个 VS Code 集成测试（Mock 驱动）
npm run package:vsix   # 打包 vsix
```

集成测试通过 `@vscode/test-electron` 在独立 VS Code 实例中运行，全流程（连接/查询/编辑/提交/回滚/导出/对象浏览/DDL/格式化）跑在 Mock 驱动上，无需真实 Oracle。

## 📄 许可证

[Apache-2.0](LICENSE)。第三方组件：[oracledb](https://github.com/oracle/node-oracledb)（Apache-2.0/UPL-1.0）、[exceljs](https://github.com/exceljs/exceljs)（MIT）、[sql-formatter](https://github.com/sql-formatter-org/sql-formatter)（MIT）。

## 🔗 链接

- 需求与可行性分析：[docs/requirements.html](docs/requirements.html)
- 原型设计：[docs/prototype-design.html](docs/prototype-design.html)
- 仓库：<https://github.com/Emon9426/SQLAdmin>

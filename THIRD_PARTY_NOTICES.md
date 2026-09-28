# Third-Party Notices

SQLAdmin 使用的第三方组件及其许可证（随版本更新维护，新增依赖须先登记）。

| 组件 | 版本范围 | 许可证 | 用途 | 交付方式 |
| --- | --- | --- | --- | --- |
| [oracledb](https://github.com/oracle/node-oracledb) | ^6.10.0 | Apache-2.0 OR UPL-1.0 | Oracle 数据库驱动（thin 默认 / thick 可选） | node_modules 随 vsix 分发 |
| [exceljs](https://github.com/exceljs/exceljs) | ^4.4.0 | MIT | XLSX 流式导出 | 打包进 dist/extension.js |
| [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) | ^15.2.0 | MIT | SQL 格式化（plsql 方言） | 打包进 dist/extension.js |
| [codicons](https://github.com/microsoft/vscode-codicons)（经由 VS Code ThemeIcon） | — | MIT | 树/状态栏图标 | VS Code 内置，不单独分发 |

许可全文见各组件仓库及随包 LICENSE/NOTICE 文件（node_modules/oracledb/{LICENSE.txt, NOTICE.txt, THIRD_PARTY_LICENSES.txt}）。

SQLAdmin 自身以 Apache-2.0 发布（见 [LICENSE](LICENSE)）。

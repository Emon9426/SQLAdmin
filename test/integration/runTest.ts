/**
 * 集成测试入口：通过 @vscode/test-electron 启动独立 VS Code 实例加载扩展。
 * 全部流程跑在 Mock 驱动上（本机无 Oracle，模拟测试，需求 §8）。
 */
const path = require('path');

async function main() {
  // out/test/integration → 项目根需上溯三级
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const { runTests } = require('@vscode/test-electron');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-gpu', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('INTEGRATION TEST FAILED:', e);
    process.exit(1);
  }
}

main();

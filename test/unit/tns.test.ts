/** tnsnames.ora 解析测试（F1-05） */
import * as assert from 'assert';
import { parseTnsNames } from '../../src/core/tns';

const SAMPLE = `# tnsnames.ora Network Configuration File
ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-server-01)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = orcl.example.com)
    )
  )

DEV_REMOTE,DEV_ALIAS =
  (DESCRIPTION =
    (ADDRESS_LIST =
      (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.5)(PORT = 1522))
    )
    (CONNECT_DATA =
      (SID = devdb)
    )
  )

XE =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = XEPDB1))
  )
`;

describe('tns · tnsnames.ora 解析', () => {
  const entries = parseTnsNames(SAMPLE);

  it('解析全部别名定义', () => {
    assert.strictEqual(entries.length, 3);
  });

  it('提取 HOST/PORT/SERVICE_NAME', () => {
    const orcl = entries.find((e) => e.aliases.includes('ORCL'))!;
    assert.strictEqual(orcl.host, 'db-server-01');
    assert.strictEqual(orcl.port, 1521);
    assert.strictEqual(orcl.service, 'orcl.example.com');
  });

  it('一行多别名展开', () => {
    const dev = entries.find((e) => e.aliases.includes('DEV_REMOTE'))!;
    assert.deepStrictEqual(dev.aliases, ['DEV_REMOTE', 'DEV_ALIAS']);
    assert.strictEqual(dev.host, '10.0.0.5');
    assert.strictEqual(dev.sid, 'devdb');
  });

  it('注释行被忽略', () => {
    assert.ok(!entries.some((e) => e.aliases.some((a) => a.includes('tnsnames.ora'))));
  });

  it('嵌套括号完整保留在 description 中', () => {
    const xe = entries.find((e) => e.aliases.includes('XE'))!;
    assert.ok(xe.description.includes('SERVICE_NAME'));
    assert.ok((xe.description.match(/\(/g) ?? []).length === (xe.description.match(/\)/g) ?? []).length);
  });

  it('空内容返回空数组', () => {
    assert.strictEqual(parseTnsNames('').length, 0);
    assert.strictEqual(parseTnsNames('# only a comment\n').length, 0);
  });
});

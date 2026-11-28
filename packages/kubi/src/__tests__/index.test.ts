import { runProviderTestSuite } from '@computesdk/test-utils';
import { kubi } from '../index';

runProviderTestSuite({
  name: 'kubi',
  provider: kubi({}),
  // Files go through Kubi's own files API; folders, existence and removal through commands.
  supportsFilesystem: true,
  skipIntegration: !process.env.KUBI_API_KEY,
  // getUrl opens a port, which needs a key with the `network` permission.
  supportsGetUrl: process.env.KUBI_TEST_PORTS === '1',
  ...(process.env.KUBI_TEST_PORTS === '1' && { ports: [3000, 8080] }),
});

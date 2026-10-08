const { spawnSync } = require('child_process');

const localSiteUrl = process.env.BLB_LOCAL_SITE_URL || 'http://bible.localhost:8000';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const result = spawnSync(
  npx,
  ['playwright', 'test', 'tests/browser/local-site.spec.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, BLB_LOCAL_SITE_URL: localSiteUrl }
  }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
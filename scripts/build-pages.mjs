import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
const appDir = path.join(root, 'app');
const apiDir = path.join(appDir, 'api');
const backupDir = path.join(appDir, '_api_disabled');
const nextDir = path.join(root, '.next');

function moveApiOut() {
  if (!fs.existsSync(apiDir)) return false;
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  fs.renameSync(apiDir, backupDir);
  return true;
}

function restoreApi() {
  if (!fs.existsSync(backupDir)) return;
  if (fs.existsSync(apiDir)) {
    fs.rmSync(apiDir, { recursive: true, force: true });
  }
  fs.renameSync(backupDir, apiDir);
}

const moved = moveApiOut();
try {
  if (!process.env.GITHUB_ACTIONS) {
    process.env.GITHUB_ACTIONS = 'true';
  }
  if (fs.existsSync(nextDir)) {
    fs.rmSync(nextDir, { recursive: true, force: true });
  }
  execSync('npx next build', { stdio: 'inherit' });
} finally {
  if (moved) restoreApi();
}

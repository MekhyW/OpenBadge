import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const gradlePath = fileURLToPath(new URL('../android/app/build.gradle', import.meta.url));
const content = readFileSync(gradlePath, 'utf8');

const versionCodeMatch = content.match(/versionCode\s+(\d+)/);
const versionNameMatch = content.match(/versionName\s+"([\d.]+)"/);

if (!versionCodeMatch || !versionNameMatch) {
  throw new Error('versionCode/versionName not found in android/app/build.gradle');
}

const oldVersionCode = Number(versionCodeMatch[1]);
const newVersionCode = oldVersionCode + 1;

const oldVersionName = versionNameMatch[1];
const nameParts = oldVersionName.split('.').map(Number);
nameParts[nameParts.length - 1] += 1;
const newVersionName = nameParts.join('.');

const updated = content
  .replace(/versionCode\s+\d+/, `versionCode ${newVersionCode}`)
  .replace(/versionName\s+"[\d.]+"/, `versionName "${newVersionName}"`);

writeFileSync(gradlePath, updated);

console.log(`versionCode: ${oldVersionCode} -> ${newVersionCode}`);
console.log(`versionName: ${oldVersionName} -> ${newVersionName}`);

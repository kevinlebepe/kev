// Fixes the exam address into the build. Set EXAMGUARD_APP_URL when building
// installers for an organisation, for example https://exams.example.ac.za.
import { mkdirSync, writeFileSync } from 'node:fs';

const appUrl = process.env.EXAMGUARD_APP_URL || 'http://localhost:5173';
new URL(appUrl);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/app-config.json', JSON.stringify({ appUrl }, null, 2) + '\n');
console.log(`Exam address in this build: ${appUrl}`);
